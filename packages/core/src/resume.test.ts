import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { CheckpointStore } from "./checkpoints.js";
import { run } from "./loop.js";
import { SessionStore } from "./sessions.js";
import { createState, type AgentState } from "./types.js";

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-agent-resume-"));
  cwd = await mkdtemp(join(tmpdir(), "cli-agent-work-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/**
 * A provider that answers with a tool call the first time and a sentence
 * the second.
 */
function provider(seen: string[]): Provider {
  return {
    id: "test",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      seen.push(request.messages.map((message) => message.role).join(","));

      if (request.messages.some((message) => message.role === "tool")) {
        yield { t: "text", delta: "all done" };
      } else {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: "call-1",
            name: "echo",
            args: { text: "hello" },
          },
        };
      }

      yield {
        t: "done",
        usage: { inputTokens: 10, outputTokens: 5 },
        stop: "end",
      };
    },
  };
}

function echoTool() {
  return {
    name: "echo",
    description: "Echoes the text back.",
    schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never,
    effect: "read" as const,
    async run(args: { text: string }) {
      return { output: `echo: ${args.text}` };
    },
  };
}

describe("quitting and resuming", () => {
  it("picks the conversation up where it was left", async () => {
    const seen: string[] = [];
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "test-model" });

    // The first session: it asks for a tool, and the tool answers.
    const first: AgentState = {
      ...createState(provider(seen), {
        model: "test-model",
        tools: [echoTool()],
        journal: store,
        checkpoints: new CheckpointStore(),
        cwd,
      }),
      messages: [],
    };

    for await (const _event of run(
      first,
      "say hello",
      new AbortController().signal,
    )) {
      // consume
    }

    // The conversation was written down.
    const transcript = await store.transcript(id);
    expect(transcript.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    // Now the agent quits and comes back.
    const second: AgentState = {
      ...createState(provider(seen), {
        model: "test-model",
        tools: [echoTool()],
        journal: store,
        checkpoints: new CheckpointStore(),
        cwd,
      }),
      messages: await store.transcript(id),
    };

    for await (const _event of run(
      second,
      "and again",
      new AbortController().signal,
    )) {
      // consume
    }

    // The second session knew what had happened: the model saw the tool
    // result from before.
    expect(seen[0]).toBe("user");
    expect(seen[1]).toContain("tool");
    expect(seen[1]).toContain("user");
  });

  it("writes every message down as it happens", async () => {
    const store = new SessionStore({ root, cwd });
    await store.create({ model: "test-model" });

    const state: AgentState = {
      ...createState(provider([]), {
        model: "test-model",
        tools: [echoTool()],
        journal: store,
        cwd,
      }),
      messages: [],
    };

    for await (const _event of run(
      state,
      "say hello",
      new AbortController().signal,
    )) {
      // consume
    }

    const entries = await store.read(store.id as string);
    expect(entries).toHaveLength(4);
    expect(entries[0]?.parent).toBeNull();
    expect(entries[1]?.parent).toBe(entries[0]?.id);
    expect(entries[3]?.parent).toBe(entries[2]?.id);
  });

  it("snapshots a file before a tool changes it", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const file = join(cwd, "a.txt");
    await writeFile(file, "before", "utf8");

    const checkpoints = new CheckpointStore();
    const store = new SessionStore({ root, cwd });
    await store.create({ model: "test-model" });

    const writer = {
      name: "write",
      description: "Writes a file.",
      schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never,
      effect: "write" as const,
      async run(args: { path: string; content: string }) {
        await writeFile(join(cwd, args.path), args.content, "utf8");
        return { output: "written" };
      },
    };

    let asked = false;
    const state: AgentState = {
      ...createState(
        {
          id: "test",
          models: async () => [],
          async *stream(): AsyncGenerator<Event> {
            if (!asked) {
              asked = true;
              yield {
                t: "toolCall",
                call: {
                  type: "toolCall",
                  id: "call-1",
                  name: "write",
                  args: { path: "a.txt", content: "after" },
                },
              };
            } else {
              yield { t: "text", delta: "written" };
            }
            yield {
              t: "done",
              usage: { inputTokens: 1, outputTokens: 1 },
              stop: "end",
            };
          },
        },
        {
          model: "test-model",
          tools: [writer],
          journal: store,
          checkpoints,
          cwd,
        },
      ),
      messages: [],
    };

    for await (const _event of run(
      state,
      "write it",
      new AbortController().signal,
    )) {
      // consume
    }

    expect(await readFile(file, "utf8")).toBe("after");

    // Undo puts it back.
    await checkpoints.undo();
    expect(await readFile(file, "utf8")).toBe("before");
  });
});
