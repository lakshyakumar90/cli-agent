import { describe, expect, it } from "vitest";
import { fixtureFetch, recordedStream } from "./fixtures.js";
import { anthropic } from "./providers/anthropic.js";
import { codex } from "./providers/codex.js";
import { gemini } from "./providers/gemini.js";
import { openaiCompat } from "./providers/openai-compat.js";
import type { Event, Provider, StreamRequest } from "./types.js";

/** A request that says hello. */
function hello(model: string): StreamRequest {
  return {
    model,
    system: "You are a coding agent.",
    messages: [{ role: "user", content: "Say hello in three words." }],
    tools: [],
    signal: new AbortController().signal,
  };
}

/** A request that asks for a tool. */
function withTool(model: string): StreamRequest {
  return {
    model,
    system: "You are a coding agent.",
    messages: [
      { role: "user", content: "Read the file a.ts and tell me what it says." },
    ],
    tools: [
      {
        name: "read",
        description: "Reads a file.",
        schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    signal: new AbortController().signal,
  };
}

async function collect(
  provider: Provider,
  request: StreamRequest,
): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of provider.stream(request)) collected.push(event);
  return collected;
}

describe("the Gemini adapter, on a recorded stream", () => {
  it("reads the answer out of it", async () => {
    const provider = gemini({
      apiKey: "test-key",
      fetch: fixtureFetch("gemini-stream"),
    });

    const events = await collect(provider, hello("gemini-2.5-flash"));

    const text = events
      .filter((event) => event.t === "text")
      .map((event) => (event.t === "text" ? event.delta : ""))
      .join("");

    expect(text.length).toBeGreaterThan(0);
    const done = events.at(-1);
    expect(done?.t).toBe("done");
    expect(done?.t === "done" ? done.usage.inputTokens : 0).toBeGreaterThan(0);
  });

  it("reads the tool call out of it", async () => {
    const provider = gemini({
      apiKey: "test-key",
      fetch: fixtureFetch("gemini-tool-call"),
    });

    const events = await collect(provider, withTool("gemini-2.5-flash"));

    const call = events.find((event) => event.t === "toolCall");
    expect(call).toBeDefined();
    expect(call?.t === "toolCall" ? call.call.name : "").toBe("read");
  });
});

describe("the OpenAI adapter, on a recorded stream", () => {
  it("reads the answer out of it", async () => {
    const provider = openaiCompat({
      id: "openrouter",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      fetch: fixtureFetch("openai-compat-stream"),
    });

    const events = await collect(provider, hello("some-model"));

    const text = events
      .filter((event) => event.t === "text")
      .map((event) => (event.t === "text" ? event.delta : ""))
      .join("");

    expect(text.length).toBeGreaterThan(0);
    expect(events.at(-1)?.t).toBe("done");
  });

  it("reads the tool call out of it", async () => {
    const provider = openaiCompat({
      id: "openrouter",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      fetch: fixtureFetch("openai-compat-tool-call"),
    });

    const events = await collect(provider, withTool("some-model"));

    const call = events.find((event) => event.t === "toolCall");
    expect(call?.t === "toolCall" ? call.call.name : "").toBe("read");
    expect(call?.t === "toolCall" ? call.call.args : undefined).toEqual({
      path: "a.ts",
    });
  });
});

describe("the Codex adapter, on a recorded stream", () => {
  it("reads the answer out of it", async () => {
    const provider = codex({
      accessToken: "test-token",
      accountId: "test-account",
      fetch: fixtureFetch("codex-stream"),
    });

    const events = await collect(provider, hello("gpt-6.1-sol"));

    const text = events
      .filter((event) => event.t === "text")
      .map((event) => (event.t === "text" ? event.delta : ""))
      .join("");

    expect(text.length).toBeGreaterThan(0);
    expect(events.at(-1)?.t).toBe("done");
  });

  it("reads the tool call out of it", async () => {
    const provider = codex({
      accessToken: "test-token",
      accountId: "test-account",
      fetch: fixtureFetch("codex-tool-call"),
    });

    const events = await collect(provider, withTool("gpt-6.1-sol"));

    const call = events.find((event) => event.t === "toolCall");
    expect(call).toBeDefined();
  });
});

describe("the Anthropic adapter, on the written stream", () => {
  it("reads the answer out of it", async () => {
    const provider = anthropic({
      apiKey: "test-key",
      fetch: fixtureFetch("anthropic-stream"),
    });

    const events = await collect(provider, hello("claude-sonnet-4-5"));

    const text = events
      .filter((event) => event.t === "text")
      .map((event) => (event.t === "text" ? event.delta : ""))
      .join("");

    expect(text).toBe("Hello there.");
    expect(events.at(-1)?.t).toBe("done");
  });
});

describe("the recordings themselves", () => {
  it("are the bodies the vendors sent", async () => {
    const stream = await recordedStream("gemini-stream");

    expect(stream.startsWith("data: ")).toBe(true);
    expect(stream).toContain("candidates");
  });

  it("are not empty", async () => {
    for (const name of [
      "gemini-stream",
      "gemini-tool-call",
      "openai-compat-stream",
      "openai-compat-tool-call",
      "codex-stream",
      "codex-tool-call",
      "anthropic-stream",
    ]) {
      const stream = await recordedStream(name);
      expect(stream.length, name).toBeGreaterThan(0);
    }
  });

  it("hold no keys", async () => {
    for (const name of [
      "gemini-stream",
      "openai-compat-stream",
      "codex-stream",
      "anthropic-stream",
    ]) {
      const stream = await recordedStream(name);
      expect(stream, name).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(stream, name).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
    }
  });
});
