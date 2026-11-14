import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { run } from "../loop.js";
import { createState } from "../types.js";
import { Board } from "./board.js";
import { createTaskTool } from "./task-tool.js";
import type { AgentRole } from "./roles.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cli-agent-multi-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const readTool: Tool = {
  name: "read",
  description: "Reads a file.",
  schema: z.object({ path: z.string() }),
  effect: "read",
  async run() {
    return { output: "the file" };
  },
};

const roles = new Map<string, AgentRole>([
  [
    "explorer",
    {
      name: "explorer",
      tools: ["read"],
      prompt: "You explore.",
    },
  ],
  [
    "reviewer",
    {
      name: "reviewer",
      tools: ["read"],
      prompt: "You review.",
    },
  ],
]);

/** The worker: it reads a lot and reports a little. */
function workerProvider(): Provider {
  let reads = 0;

  return {
    id: "worker",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      // It reads the files it was asked about...
      if (reads < 20) {
        reads += 1;
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: `read-${reads}`,
            name: "read",
            args: { path: `file-${reads}.ts` },
          },
        };
        yield {
          t: "done",
          usage: { inputTokens: 500, outputTokens: 20 },
          stop: "end",
        };
        return;
      }

      // ...and then reports.
      yield { t: "text", delta: "THE REPORT" };
      yield {
        t: "done",
        usage: { inputTokens: 500, outputTokens: 20 },
        stop: "end",
      };
    },
  };
}

/** The lead: it sends three explorers and a reviewer off in one turn. */
function leadProvider(): Provider {
  let turn = 0;

  return {
    id: "lead",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(): AsyncGenerator<Event> {
      turn += 1;

      if (turn === 1) {
        for (const [index, agent] of ["explorer", "explorer", "explorer"].entries()) {
          yield {
            t: "toolCall",
            call: {
              type: "toolCall",
              id: `call-${index}`,
              name: "task",
              args: { agent, prompt: `look into part ${index}` },
            },
          };
        }
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: "call-3",
            name: "task",
            args: { agent: "reviewer", prompt: "put it together" },
          },
        };
      } else {
        yield { t: "text", delta: "here is what I found" };
      }

      yield {
        t: "done",
        usage: { inputTokens: 100, outputTokens: 10 },
        stop: "end",
      };
    },
  };
}

describe("one prompt, many agents", () => {
  it("spawns three explorers and a reviewer, and the parent's context stays small", async () => {
    const board = new Board();

    const task = createTaskTool({
      roles,
      providerFor: async () => workerProvider(),
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      board,
      concurrency: 4,
    });

    const state = createState(leadProvider(), {
      model: "test/lead",
      tools: [task, readTool],
      cwd: workspace,
    });

    for await (const _event of run(
      state,
      "look into this and tell me what you find",
      new AbortController().signal,
    )) {
      // consume
    }

    // Four tasks ran, and the board knows about them.
    const tasks = board.list();
    expect(tasks).toHaveLength(4);
    expect(tasks.filter((task) => task.status === "done")).toHaveLength(4);

    // The parent's transcript holds the reports, not the reading.
    const transcript = state.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.role === "tool" ? message.content : ""))
      .join("\n");

    expect(transcript).toContain("THE REPORT");
    // The worker read twenty files; the parent never saw them.
    expect(transcript).not.toContain("file-19.ts");

    // The whole conversation is small: the reports, not the files.
    const size = JSON.stringify(state.messages).length;
    expect(size).toBeLessThan(20_000);
  });

  it("runs the workers at the same time", async () => {
    let running = 0;
    let peak = 0;

    const provider: Provider = {
      id: "worker",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
        yield { t: "text", delta: "report" };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    const task = createTaskTool({
      roles,
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      concurrency: 4,
    });

    const signal = new AbortController().signal;
    await Promise.all(
      ["a", "b", "c", "d"].map((prompt) =>
        task.run({ agent: "explorer", prompt }, { cwd: workspace, signal }),
      ),
    );

    expect(peak).toBeGreaterThan(1);
  });
});
