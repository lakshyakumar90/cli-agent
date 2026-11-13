import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { createTools, withPermissions, parseRules } from "@cli-agent/tools";
import { run } from "./loop.js";
import { createState } from "./types.js";
import { createSampleRepo, SAMPLE_TEST_COMMAND } from "./sample-repo.js";

// ---------------------------------------------------------------------------
// The agent, scripted: it reads the test, fixes the code, runs the test.
// ---------------------------------------------------------------------------

interface ScriptedStep {
  text?: string;
  calls?: Array<{ name: string; args: unknown }>;
}

/** A provider that plays back the steps of the scenario. */
function scriptedAgent(steps: ScriptedStep[]): Provider & {
  requests: StreamRequest[];
} {
  const requests: StreamRequest[] = [];
  let index = 0;

  return {
    id: "scripted",
    requests,
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      requests.push(request);
      const step = steps[index];
      index += 1;
      if (step === undefined) {
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
        return;
      }

      if (step.text !== undefined) {
        yield { t: "text", delta: step.text };
      }
      for (const [index, call] of (step.calls ?? []).entries()) {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: `call-${index}`,
            name: call.name,
            args: call.args,
          },
        };
      }
      yield {
        t: "done",
        usage: { inputTokens: 10, outputTokens: 5 },
        stop: step.calls === undefined ? "end" : "tool",
      };
    },
  };
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-scenario-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the agent in a real project", () => {
  it("fixes a failing test with read, edit and bash", async () => {
    const repo = await createSampleRepo(directory);

    const provider = scriptedAgent([
      // 1. Read the test that fails.
      {
        calls: [{ name: "read", args: { path: "sum.test.mjs" } }],
      },
      // 2. Read the code it points at.
      {
        calls: [{ name: "read", args: { path: "sum.mjs" } }],
      },
      // 3. Fix it.
      {
        calls: [
          {
            name: "edit",
            args: {
              path: "sum.mjs",
              old_string: "a + b - 1",
              new_string: "a + b",
            },
          },
        ],
      },
      // 4. Run the test.
      {
        calls: [{ name: "bash", args: { command: SAMPLE_TEST_COMMAND } }],
      },
      // 5. Say it is done.
      { text: "The test passes now." },
    ]);

    const tools = withPermissions(createTools(), {
      mode: "ask",
      // The commands the agent needs are allowed; everything else asks.
      rules: parseRules(`bash(${SAMPLE_TEST_COMMAND}) allow`),
      workspace: repo.dir,
      ask: async () => "allow",
    });

    const state = createState(provider, {
      model: "test-model",
      tools,
      system: "You are a coding agent.",
      cwd: repo.dir,
    });

    const events = [];
    for await (const event of run(
      state,
      "The test fails. Fix it.",
      new AbortController().signal,
    )) {
      events.push(event);
    }

    // It read, it edited, it ran the test.
    const calls = events
      .filter((event) => event.t === "toolStart")
      .map((event) => (event.t === "toolStart" ? event.call.name : ""));
    expect(calls).toEqual(["read", "read", "edit", "bash"]);

    // The bug is fixed.
    const source = await readFile(repo.source, "utf8");
    expect(source).toContain("a + b");
    expect(source).not.toContain("a + b - 1");

    // And the test passes now.
    const testRun = events.find(
      (event) => event.t === "toolEnd" && event.call.name === "bash",
    );
    expect(testRun).toMatchObject({ t: "toolEnd" });
    if (testRun?.t === "toolEnd") {
      expect(testRun.output).toContain("pass 1");
      expect(testRun.output).toContain("fail 0");
    }

    expect(events.at(-1)).toMatchObject({ t: "done", reason: "end" });
  });

  it("cannot write outside the workspace without permission", async () => {
    const repo = await createSampleRepo(directory);

    const provider = scriptedAgent([
      {
        calls: [
          {
            name: "write",
            args: { path: "../escaped.txt", content: "nope" },
          },
        ],
      },
      { text: "I could not write outside the workspace." },
    ]);

    const asked: string[] = [];
    const tools = withPermissions(createTools(), {
      mode: "ask",
      workspace: repo.dir,
      ask: async (request) => {
        asked.push(request.subject ?? "");
        return "deny";
      },
    });

    const state = createState(provider, {
      model: "test-model",
      tools,
      cwd: repo.dir,
    });

    const events = [];
    for await (const event of run(
      state,
      "Write a file outside the workspace.",
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(asked).toHaveLength(1);
    const toolEnd = events.find((event) => event.t === "toolEnd");
    expect(toolEnd).toMatchObject({ isError: true });
    if (toolEnd?.t === "toolEnd") {
      expect(toolEnd.output).toContain("permission denied");
    }
  });

  it("cannot change anything in plan mode", async () => {
    const repo = await createSampleRepo(directory);

    const provider = scriptedAgent([
      {
        calls: [
          {
            name: "edit",
            args: {
              path: "sum.mjs",
              old_string: "a + b - 1",
              new_string: "a + b",
            },
          },
        ],
      },
      { text: "I can only read in plan mode." },
    ]);

    const tools = withPermissions(createTools(), {
      mode: "plan",
      workspace: repo.dir,
    });

    const state = createState(provider, {
      model: "test-model",
      tools,
      cwd: repo.dir,
    });

    const events = [];
    for await (const event of run(
      state,
      "Fix the bug.",
      new AbortController().signal,
    )) {
      events.push(event);
    }

    const toolEnd = events.find((event) => event.t === "toolEnd");
    expect(toolEnd).toMatchObject({ isError: true });

    // The file is untouched.
    const source = await readFile(repo.source, "utf8");
    expect(source).toContain("a + b - 1");
  });
});

