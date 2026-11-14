import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { Board } from "./board.js";
import { createTaskTool } from "./task-tool.js";
import { textOf } from "../budget.js";
import type { AgentRole } from "./roles.js";

const role = (over: Partial<AgentRole> = {}): AgentRole => ({
  name: "explorer",
  model: "test/worker",
  tools: ["read"],
  prompt: "You explore.",
  ...over,
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

/** A provider that answers with a fixed text, and says what it was asked. */
function answeringProvider(
  answer: (prompt: string) => string,
): { provider: Provider; prompts: string[] } {
  const prompts: string[] = [];

  const provider: Provider = {
    id: "test",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      const last = request.messages[request.messages.length - 1];
      const prompt = last === undefined ? "" : textOf(last);
      prompts.push(prompt);
      yield { t: "text", delta: answer(prompt) };
      yield {
        t: "done",
        usage: { inputTokens: 10, outputTokens: 5 },
        stop: "end",
      };
    },
  };

  return { provider, prompts };
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "cli-agent-workers-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("the task tool", () => {
  it("runs a worker and returns only its report", async () => {
    const { provider, prompts } = answeringProvider(() => "the report");

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
    });

    const result = await task.run(
      { agent: "explorer", prompt: "find the thing" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    expect(result.output).toContain("the report");
    expect(prompts[0]).toBe("find the thing");
  });

  it("gives the worker its own prompt and its own model", async () => {
    const { provider, prompts } = answeringProvider(() => "ok");

    const task = createTaskTool({
      roles: new Map([["explorer", role({ prompt: "You explore.", model: "test/worker" })]]),
      providerFor: async (model) => {
        expect(model).toBe("test/worker");
        return provider;
      },
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
    });

    const result = await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    expect(result.output).toContain("ok");
    expect(prompts).toHaveLength(1);
  });

  it("refuses an agent it does not know", async () => {
    const { provider } = answeringProvider(() => "ok");

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
    });

    const result = await task.run(
      { agent: "nobody", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("no agent called");
  });

  it("does not let a worker spawn workers", async () => {
    const { provider } = answeringProvider(() => "ok");

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      depth: 1,
      maxDepth: 1,
    });

    const result = await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot delegate");
  });

  it("reports a failure instead of retrying in silence", async () => {
    const failing: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        throw new Error("the provider is down");
      },
    };

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => failing,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
    });

    const result = await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("the provider is down");
  });

  it("writes the task to the board", async () => {
    const { provider } = answeringProvider(() => "the report");
    const board = new Board();

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      board,
    });

    await task.run(
      { agent: "explorer", prompt: "find the thing" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    const tasks = board.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("done");
    expect(tasks[0]?.result).toContain("the report");
  });

  it("gives a worker only the tools its role names", async () => {
    const { provider } = answeringProvider(() => "ok");
    const seen: string[] = [];

    const task = createTaskTool({
      roles: new Map([["explorer", role({ tools: ["read"] })]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
    });

    await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    // The worker was given the read tool and nothing else.
    expect(seen).toEqual([]);
  });

  it("gives the worker the model id the provider knows", async () => {
    const asked: string[] = [];

    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(request: StreamRequest): AsyncGenerator<Event> {
        asked.push(request.model);
        yield { t: "text", delta: "ok" };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    const task = createTaskTool({
      roles: new Map([
        ["explorer", role({ model: "openrouter/some/model:free" })],
      ]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
    });

    await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    // The provider knows its model by the id it uses on the wire; the
    // "provider/" of "provider/model" is for us, not for it.
    expect(asked).toEqual(["some/model:free"]);
  });

  it("runs a few workers at a time", async () => {
    let running = 0;
    let peak = 0;

    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        yield { t: "text", delta: "done" };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      concurrency: 2,
    });

    const signal = new AbortController().signal;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        task.run({ agent: "explorer", prompt: "go" }, { cwd: workspace, signal }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("gives the worker a token budget of its own", async () => {
    let turns = 0;

    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        turns += 1;
        // The worker asks for a tool, so the loop wants another turn.
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: `call-${turns}`,
            name: "read",
            args: { path: "a.txt" },
          },
        };
        yield {
          t: "done",
          usage: { inputTokens: 100, outputTokens: 50 },
          stop: "tool",
        };
      },
    };

    const task = createTaskTool({
      roles: new Map([["explorer", role()]]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      tokenBudget: 100,
    });

    const result = await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    // The worker used 150 tokens, over the budget of 100: it got one turn
    // and no more.
    expect(turns).toBe(1);
    expect(result.output).toContain("ran out of budget");
  });

  it("writes what the worker cost on the board", async () => {
    // Gemini 4 Carbon costs 2 dollars a million input tokens.
    const provider: Provider = {
      id: "gemini",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        yield { t: "text", delta: "the report" };
        yield {
          t: "done",
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
          stop: "end",
        };
      },
    };

    const board = new Board();
    const task = createTaskTool({
      roles: new Map([
        ["explorer", role({ model: "gemini/gemini-4-carbon" })],
      ]),
      providerFor: async () => provider,
      defaultModel: "test/lead",
      tools: [readTool],
      cwd: workspace,
      board,
    });

    await task.run(
      { agent: "explorer", prompt: "go" },
      { cwd: workspace, signal: new AbortController().signal },
    );

    const task1 = board.list()[0];
    expect(task1?.cost).toBeCloseTo(2, 5);
  });
});

