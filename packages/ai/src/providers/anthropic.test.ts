import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type {
  Event,
  Msg,
  Provider,
  StreamRequest,
  ToolSpec,
} from "../types.js";
import { anthropic } from "./anthropic.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function sseResponse(parts: string[], status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One named Anthropic stream event. */
function event(type: string, data: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function mockFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

type RequestInput = Pick<StreamRequest, "model"> & Partial<StreamRequest>;

async function collect(
  provider: Provider,
  input: RequestInput,
): Promise<Event[]> {
  const request: StreamRequest = {
    model: input.model,
    system: input.system ?? "",
    messages: input.messages ?? [],
    tools: input.tools ?? [],
    signal: input.signal ?? new AbortController().signal,
  };
  const events: Event[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

function makeProvider(response: Response) {
  const { fetchImpl, calls } = mockFetch(() => response);
  const provider = anthropic({
    apiKey: "sk-ant-test",
    fetch: fetchImpl,
  });
  return { provider, calls };
}

async function collectError(
  provider: Provider,
  input: RequestInput,
): Promise<ProviderError> {
  const caught = await collect(provider, input).catch(
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(ProviderError);
  return caught as ProviderError;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("anthropic stream", () => {
  it("streams text deltas and merges message usage", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("message_start", {
          message: {
            usage: { input_tokens: 12, cache_read_input_tokens: 5 },
          },
        }),
        event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "Hel" },
        }),
        event("ping"),
        event("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: "lo" },
        }),
        event("content_block_stop", { index: 0 }),
        event("message_delta", {
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 9 },
        }),
        event("message_stop"),
      ]),
    );

    expect(await collect(provider, { model: "claude-test" })).toEqual([
      { t: "text", delta: "Hel" },
      { t: "text", delta: "lo" },
      {
        t: "done",
        usage: { inputTokens: 12, outputTokens: 9, cacheReadTokens: 5 },
        stop: "end",
      },
    ]);
  });

  it("buffers input_json_delta into one tool call", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("message_start", { message: { usage: { input_tokens: 7 } } }),
        event("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":' },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"a.ts"}' },
        }),
        event("content_block_stop", { index: 0 }),
        event("message_delta", {
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 4 },
        }),
        event("message_stop"),
      ]),
    );

    expect(await collect(provider, { model: "claude-test" })).toEqual([
      {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: "toolu_1",
          name: "read",
          args: { path: "a.ts" },
        },
      },
      {
        t: "done",
        usage: { inputTokens: 7, outputTokens: 4 },
        stop: "tool",
      },
    ]);
  });

  it("emits parallel tool calls in block order", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("content_block_start", {
          index: 1,
          content_block: { type: "tool_use", id: "toolu_b", name: "bash", input: {} },
        }),
        event("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: "toolu_a", name: "read", input: {} },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
        }),
        event("content_block_delta", {
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
        }),
        event("content_block_stop", { index: 0 }),
        event("content_block_stop", { index: 1 }),
        event("message_delta", { delta: { stop_reason: "tool_use" } }),
        event("message_stop"),
      ]),
    );

    const events = await collect(provider, { model: "claude-test" });
    expect(
      events
        .filter((item) => item.t === "toolCall")
        .map((item) => (item.t === "toolCall" ? item.call.name : "")),
    ).toEqual(["read", "bash"]);
  });

  it("maps thinking deltas and max_tokens", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "pondering" },
        }),
        event("content_block_stop", { index: 0 }),
        event("message_delta", { delta: { stop_reason: "max_tokens" } }),
      ]),
    );

    expect(await collect(provider, { model: "claude-test" })).toEqual([
      { t: "thinking", delta: "pondering" },
      { t: "done", usage: { inputTokens: 0, outputTokens: 0 }, stop: "length" },
    ]);
  });

  it("captures thinking signatures and redacted thoughts", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("content_block_start", {
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "thinking_delta", thinking: "reasoning" },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "signature_delta", signature: "sig-abc" },
        }),
        event("content_block_stop", { index: 0 }),
        event("content_block_start", {
          index: 1,
          content_block: { type: "redacted_thinking", data: "opaque" },
        }),
        event("content_block_stop", { index: 1 }),
      ]),
    );

    expect(await collect(provider, { model: "claude-test" })).toEqual([
      { t: "thinking", delta: "reasoning" },
      { t: "thinking", delta: "", signature: "sig-abc" },
      { t: "thinking", delta: "", redacted: "opaque" },
      { t: "done", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("anthropic request", () => {
  it("maps the transcript, tools and auth headers", async () => {
    const { provider, calls } = makeProvider(sseResponse([]));

    const messages: Msg[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hidden", signature: "sig-think" },
          { type: "text", text: "checking" },
          { type: "toolCall", id: "toolu_1", name: "read", args: { path: "a.ts" } },
        ],
      },
      { role: "tool", callId: "toolu_1", content: "body" },
      { role: "tool", callId: "toolu_2", content: "boom", isError: true },
      { role: "user", content: "thanks" },
    ];
    const tools: ToolSpec[] = [
      {
        name: "read",
        description: "Read a file",
        schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    await collect(provider, {
      model: "claude-test",
      system: "be brief",
      messages,
      tools,
    });

    const call = calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2026-10-21");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(String(call?.init?.body)) as {
      model: string;
      max_tokens: number;
      stream: boolean;
      system: string;
      messages: unknown[];
      tools: unknown[];
    };

    expect(body.model).toBe("claude-test");
    expect(body.max_tokens).toBe(64000);
    expect(body.stream).toBe(true);
    expect(body.system).toBe("be brief");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden", signature: "sig-think" },
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "body" },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "boom",
            is_error: true,
          },
          { type: "text", text: "thanks" },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        name: "read",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ]);
  });

  it("supports bearer auth and omits an empty system prompt", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const provider = anthropic({
      apiKey: "oauth-token",
      auth: "bearer",
      maxTokens: 1024,
      fetch: fetchImpl,
    });

    await collect(provider, { model: "claude-test", system: "  " });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oauth-token");
    expect(headers["x-api-key"]).toBeUndefined();

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      system?: unknown;
      max_tokens: number;
      tools?: unknown;
    };
    expect(body.system).toBeUndefined();
    expect(body.max_tokens).toBe(1024);
    expect(body.tools).toBeUndefined();
  });

  it("replays redacted thoughts and drops unsigned ones", async () => {
    const { provider, calls } = makeProvider(sseResponse([]));

    await collect(provider, {
      model: "claude-test",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "unsigned" },
            { type: "thinking", text: "", redacted: "opaque" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: unknown[];
    };
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "opaque" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("anthropic errors", () => {
  it("surfaces HTTP errors with status and retryability", async () => {
    const unauthorized = makeProvider(
      jsonResponse({ type: "error", error: { message: "invalid x-api-key" } }, 401),
    );
    const authError = await collectError(unauthorized.provider, {
      model: "claude-test",
    });
    expect(authError.status).toBe(401);
    expect(authError.retryable).toBe(false);
    expect(authError.message).toContain("invalid x-api-key");

    const overloaded = makeProvider(new Response("busy", { status: 529 }));
    const overloadError = await collectError(overloaded.provider, {
      model: "claude-test",
    });
    expect(overloadError.status).toBe(529);
    expect(overloadError.retryable).toBe(true);
  });

  it("turns a mid-stream error event into a retryable ProviderError", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("message_start", { message: { usage: { input_tokens: 1 } } }),
        event("error", {
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
      ]),
    );

    const error = await collectError(provider, { model: "claude-test" });
    expect(error.code).toBe("protocol");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("overloaded_error");
  });

  it("rejects malformed tool input", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("content_block_start", {
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
        }),
        event("content_block_delta", {
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{" },
        }),
        event("content_block_stop", { index: 0 }),
      ]),
    );

    const error = await collectError(provider, { model: "claude-test" });
    expect(error.code).toBe("protocol");
    expect(error.message).toContain("malformed tool input");
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("anthropic models", () => {
  it("lists models with display names and overrides, then caches", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        data: [
          {
            id: "claude-sonnet-5-5",
            display_name: "Claude Sonnet 4.5",
            type: "model",
          },
        ],
        has_more: false,
      }),
    );
    const provider = anthropic({
      apiKey: "sk-ant-test",
      fetch: fetchImpl,
      modelInfo: {
        "claude-sonnet-5-5": {
          contextWindow: 200_000,
          maxOutputTokens: 64_000,
          pricing: { input: 3, output: 15 },
        },
      },
    });

    expect(await provider.models()).toEqual([
      {
        id: "claude-sonnet-5-5",
        provider: "anthropic",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        pricing: { input: 3, output: 15 },
      },
    ]);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models");

    await provider.models();
    expect(calls).toHaveLength(1);
  });
});