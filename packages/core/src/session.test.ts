 import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { run } from "./loop.js";
import { createState, type AgentEvent, type AgentState } from "./types.js";
import { textOf } from "./budget.js";

/**
 * A provider that answers, and summarises when it is asked to.
 *
 * The summary says what the task was, the way a real one would.
 */
function provider(): Provider & { requests: StreamRequest[] } {
  const requests: StreamRequest[] = [];

  return {
    id: "test",
    requests,
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      requests.push(request);

      const first = request.messages[0];
      const prompt = first === undefined ? "" : textOf(first);

      if (prompt.includes("Summarise this conversation")) {
        yield {
          t: "text",
          delta:
            "the goal: fix the failing test\n" +
            "the decision: change sum.mjs\n" +
            "the files touched: sum.mjs\n" +
            "the failing test: sum.test.mjs\n" +
            "the open task: run the tests again",
        };
      } else {
        yield { t: "text", delta: "the task is to fix the failing test" };
      }

      yield {
        t: "done",
        usage: { inputTokens: 100, outputTokens: 10 },
        stop: "end",
      };
    },
  };
}

describe("a long session", () => {
  it("auto-compacts and the agent still remembers the task", async () => {
    const backend = provider();

    // A conversation that has grown long: many turns of small messages.
    const messages: AgentState["messages"] = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push({ role: "user", content: `question ${index}` });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: `answer ${index}` }],
      });
    }

    const state: AgentState = {
      ...createState(backend, { model: "test-model" }),
      // A small window, so the conversation does not fit.
      limits: { contextWindow: 1_200, outputReserve: 200 },
      messages,
    };

    const events: AgentEvent[] = [];
    for await (const event of run(
      state,
      "keep going",
      new AbortController().signal,
    )) {
      events.push(event);
    }

    // It compacted on its own.
    const compacted = events.find((event) => event.t === "compacted");
    expect(compacted).toBeDefined();

    // The transcript now starts with the summary.
    const first = state.messages[0];
    expect(String(first?.content ?? "")).toContain("the goal: fix the failing test");
    expect(String(first?.content ?? "")).toContain("sum.mjs");

    // And the model still knows what the task is: the summary is what it
    // was sent.
    const last = backend.requests[backend.requests.length - 1];
    const sent = last?.messages.map((message) => textOf(message)).join("\n");
    expect(sent).toContain("the goal: fix the failing test");
  }, 30_000);

  it("keeps the tool result in the transcript short", async () => {
    const backend: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: "c1",
            name: "read",
            args: { path: "big.txt" },
          },
        };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    const state: AgentState = {
      ...createState(backend, { model: "test-model" }),
      limits: { maxToolLines: 10 },
      messages: [],
      tools: [
        {
          name: "read",
          description: "Reads a file.",
          schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never,
          effect: "read",
          async run() {
            return {
              output: Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"),
            };
          },
        },
      ],
    };

    for await (const _event of run(
      state,
      "read it",
      new AbortController().signal,
    )) {
      // consume
    }

    const result = state.messages.find((message) => message.role === "tool");
    expect(result?.content).toContain("lines omitted");
    expect(result?.content.length).toBeLessThan(500);
  }, 30_000);
});

