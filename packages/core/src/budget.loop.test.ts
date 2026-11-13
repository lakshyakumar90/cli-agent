import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { run } from "./loop.js";
import { createState, type AgentEvent, type AgentState } from "./types.js";
import { textOf } from "./budget.js";

/**
 * A provider that answers, and summarises when it is asked to.
 */
function provider(): Provider {
  return {
    id: "test",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      const first = request.messages[0];
      const prompt = first === undefined ? "" : textOf(first);

      if (prompt.includes("Summarise this conversation")) {
        yield { t: "text", delta: "the summary of what happened" };
      } else {
        yield { t: "text", delta: "an answer" };
      }

      yield {
        t: "done",
        usage: { inputTokens: 100, outputTokens: 10 },
        stop: "end",
      };
    },
  };
}

describe("the budget in the loop", () => {
  it("compacts when the conversation outgrows the budget", async () => {
    const state: AgentState = {
      ...createState(provider(), { model: "test-model" }),
      // A tiny window, so the conversation is too big straight away.
      limits: { contextWindow: 400, outputReserve: 100 },
      messages: [
        { role: "user", content: "x".repeat(2_000) },
        { role: "assistant", content: [{ type: "text", text: "y".repeat(500) }] },
      ],
    };

    const events: AgentEvent[] = [];
    for await (const event of run(
      state,
      "keep going",
      new AbortController().signal,
    )) {
      events.push(event);
    }

    // The conversation was summarised before the turn.
    const compacted = events.find((event) => event.t === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.t === "compacted") {
      expect(compacted.budget).toBe(300);
    }

    // The summary is now the first message.
    expect(state.messages[0]?.content).toContain(
      "the summary of what happened",
    );
  });

  it("leaves a conversation that fits alone", async () => {
    const state: AgentState = {
      ...createState(provider(), { model: "test-model" }),
      limits: { contextWindow: 100_000, outputReserve: 1_000 },
      messages: [{ role: "user", content: "a short question" }],
    };

    const events: AgentEvent[] = [];
    for await (const event of run(
      state,
      "keep going",
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events.some((event) => event.t === "compacted")).toBe(false);
    expect(state.messages[0]?.content).toBe("a short question");
  });

  it("corrects the estimate with the usage the provider reports", async () => {
    const state: AgentState = {
      ...createState(provider(), { model: "test-model" }),
      limits: { contextWindow: 100_000, outputReserve: 1_000 },
    };

    for await (const _event of run(
      state,
      "hello",
      new AbortController().signal,
    )) {
      // consume
    }

    expect(state.tokens?.ratio).toBeGreaterThan(0);
  });
});

