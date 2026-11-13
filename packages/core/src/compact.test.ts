import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { compactMessages, splitMessages, SUMMARY_INSTRUCTION } from "./compact.js";
import { textOf } from "./budget.js";
describe("compaction", () => {
  const summariser: Provider = {
    id: "test",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      const first = request.messages[0];
      const asked = first === undefined ? "" : textOf(first);
      yield {
        t: "text",
        delta: asked.includes("old thing") ? "the summary" : "another summary",
      };
      yield {
        t: "done",
        usage: { inputTokens: 10, outputTokens: 2 },
        stop: "end",
      };
    },
  };

  it("summarises the old part and keeps the recent one", async () => {
    const messages = [
      { role: "user" as const, content: "the old thing" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
      { role: "user" as const, content: "the new thing" },
    ];

    const compacted = await compactMessages({
      provider: summariser,
      model: "test-model",
      messages,
      keep: 1,
      signal: new AbortController().signal,
    });

    expect(compacted).toHaveLength(2);
    expect(compacted?.[0]?.role).toBe("user");
    expect(compacted?.[0]?.content).toContain("Summary of earlier work:");
    expect(compacted?.[0]?.content).toContain("the summary");
    expect(compacted?.[1]).toEqual(messages[2]);
  });

  it("leaves a short conversation alone", async () => {
    const compacted = await compactMessages({
      provider: summariser,
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      keep: 6,
      signal: new AbortController().signal,
    });

    expect(compacted).toBeUndefined();
  });

  it("leaves the conversation alone when the summary fails", async () => {
    const failing: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        throw new Error("no");
      },
    };

    const compacted = await compactMessages({
      provider: failing,
      model: "test-model",
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
      keep: 1,
      signal: new AbortController().signal,
    });

    expect(compacted).toBeUndefined();
  });
});


describe("the summary prompt", () => {
  it("asks for the things the agent needs to keep", () => {
    for (const wanted of [
      "goal",
      "decisions",
      "files",
      "tests that fail",
      "open tasks",
      "preferences",
    ]) {
      expect(SUMMARY_INSTRUCTION).toContain(wanted);
    }
  });

  it("tells it to drop the bulk", () => {
    expect(SUMMARY_INSTRUCTION).toContain("Drop");
  });
});

