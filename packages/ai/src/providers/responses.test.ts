import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type { Event, Provider, StreamRequest, ToolSpec } from "../types.js";
import { openaiResponses } from "./responses.js";

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

/** One named Responses event, in the shape OpenAI sends them. */
function event(type: string, data: Record<string, unknown> = {}): string {
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

function request(input: RequestInput): StreamRequest {
  return {
    model: input.model,
    system: input.system ?? "",
    messages: input.messages ?? [],
    tools: input.tools ?? [],
    signal: input.signal ?? new AbortController().signal,
  };
}

async function collect(
  provider: Provider,
  input: RequestInput,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of provider.stream(request(input))) events.push(event);
  return events;
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

const READ_TOOL: ToolSpec = {
  name: "read",
  description: "Read a file",
  schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

function makeProvider(response: Response, options: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = mockFetch(() => response);
  const provider = openaiResponses({
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
    fetch: fetchImpl,
    ...options,
  });
  return { provider, calls };
}

function body(calls: Array<{ init?: RequestInit }>): Record<string, unknown> {
  const raw = calls[0]?.init?.body;
  expect(typeof raw).toBe("string");
  return JSON.parse(raw as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Text, reasoning, usage
// ---------------------------------------------------------------------------

describe("responses stream", () => {
  it("streams text and maps usage from response.completed", async () => {
    const { provider, calls } = makeProvider(
      sseResponse([
        event("response.created", { response: { id: "resp_1" } }),
        event("response.output_text.delta", { delta: "Hel" }),
        event("response.output_text.delta", { delta: "lo" }),
        event("response.completed", {
          response: {
            status: "completed",
            usage: {
              input_tokens: 21,
              output_tokens: 9,
              total_tokens: 30,
              input_tokens_details: {
                cached_tokens: 15,
                cache_write_tokens: 2,
              },
              output_tokens_details: { reasoning_tokens: 4 },
            },
          },
        }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });

    expect(events.filter((e) => e.t === "text")).toEqual([
      { t: "text", delta: "Hel" },
      { t: "text", delta: "lo" },
    ]);
    // Reasoning tokens are already inside output_tokens; do not double count.
    expect(events.at(-1)).toEqual({
      t: "done",
      usage: {
        inputTokens: 21,
        outputTokens: 9,
        cacheReadTokens: 15,
        cacheWriteTokens: 2,
      },
      stop: "end",
    });
    expect(body(calls)).toMatchObject({
      model: "gpt-5.5",
      stream: true,
      store: false,
    });
  });

  it("forwards reasoning summaries as thinking", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.reasoning_summary_text.delta", { delta: "plan " }),
        event("response.reasoning_text.delta", { delta: "more" }),
        event("response.completed", { response: { status: "completed" } }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });
    expect(events.filter((e) => e.t === "thinking")).toEqual([
      { t: "thinking", delta: "plan " },
      { t: "thinking", delta: "more" },
    ]);
  });

  it("falls back to the completed message item when no deltas arrive", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_item.done", {
          item: {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "whole " },
              { type: "output_text", text: "answer" },
            ],
          },
        }),
        event("response.completed", { response: { status: "completed" } }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });
    expect(events.filter((e) => e.t === "text")).toEqual([
      { t: "text", delta: "whole answer" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tool calls: partial JSON argument streaming
// ---------------------------------------------------------------------------

describe("responses tool calls", () => {
  it("joins split argument JSON into one parsed toolCall", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_item.added", {
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "read",
          },
        }),
        event("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: '{"pa',
        }),
        event("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: 'th":"src/',
        }),
        event("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: 'index.ts"}',
        }),
        event("response.output_item.done", {
          item: {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "read",
            arguments: '{"path":"src/index.ts"}',
          },
        }),
        event("response.completed", {
          response: {
            status: "completed",
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        }),
      ]),
    );

    const events = await collect(provider, {
      model: "gpt-5.5",
      tools: [READ_TOOL],
    });

    const calls_ = events.filter((e) => e.t === "toolCall");
    expect(calls_).toEqual([
      {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: "call_abc",
          name: "read",
          args: { path: "src/index.ts" },
        },
      },
    ]);
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "tool" });
  });

  it("uses accumulated deltas when the finished item omits arguments", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_item.added", {
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" },
        }),
        event("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: '{"dir":',
        }),
        event("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: '"src"}',
        }),
        event("response.output_item.done", {
          item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" },
        }),
        event("response.completed", { response: { status: "completed" } }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });
    expect(events.filter((e) => e.t === "toolCall")).toEqual([
      {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: "call_1",
          name: "ls",
          args: { dir: "src" },
        },
      },
    ]);
  });

  it("accepts a backend that only sends the finished item", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_item.done", {
          item: {
            type: "function_call",
            id: "fc_9",
            call_id: "call_9",
            name: "read",
            arguments: '{"path":"a.ts"}',
          },
        }),
        event("response.completed", { response: { status: "completed" } }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });
    expect(events.filter((e) => e.t === "toolCall")).toEqual([
      {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: "call_9",
          name: "read",
          args: { path: "a.ts" },
        },
      },
    ]);
  });

  it("rejects malformed tool arguments instead of guessing", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_item.added", {
          item: { type: "function_call", id: "fc_1", call_id: "c1", name: "read" },
        }),
        event("response.function_call_arguments.delta", {
          item_id: "fc_1",
          delta: '{"path":',
        }),
        event("response.output_item.done", {
          item: { type: "function_call", id: "fc_1", call_id: "c1", name: "read" },
        }),
      ]),
    );

    const error = await collectError(provider, { model: "gpt-5.5" });
    expect(error.code).toBe("protocol");
    expect(error.message).toContain("malformed tool arguments");
  });
});

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

describe("responses stop reasons", () => {
  it("maps incomplete max_output_tokens to length", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_text.delta", { delta: "partial" }),
        event("response.incomplete", {
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 5, output_tokens: 100 },
          },
        }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "length" });
  });

  it("maps any emitted tool call to tool even when no deltas were seen", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.output_item.done", {
          item: { type: "function_call", id: "fc_1", call_id: "c1", name: "ls", arguments: "{}" },
        }),
        event("response.incomplete", {
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        }),
      ]),
    );

    const events = await collect(provider, { model: "gpt-5.5" });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "tool" });
  });

  it("throws on a content-filtered response", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.incomplete", {
          response: {
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          },
        }),
      ]),
    );

    const error = await collectError(provider, { model: "gpt-5.5" });
    expect(error.message).toContain("content filter");
    expect(error.retryable).toBe(false);
  });

  it("surfaces response.failed with backend retryability", async () => {
    const { provider } = makeProvider(
      sseResponse([
        event("response.failed", {
          response: {
            status: "failed",
            error: { code: "server_is_overloaded", message: "try later" },
          },
        }),
      ]),
    );

    const error = await collectError(provider, { model: "gpt-5.5" });
    expect(error.code).toBe("protocol");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("server_is_overloaded");
  });

  it("treats a stream that never completes and never calls a tool as broken", async () => {
    const { provider } = makeProvider(
      sseResponse(["[DONE]"]),
      {},
    );

    const error = await collectError(provider, { model: "gpt-5.5" });
    expect(error.message).toContain("ended before response.completed");
    expect(error.retryable).toBe(true);
  });

  it("reports HTTP failures with status and body", async () => {
    const { provider } = makeProvider(
      jsonResponse({ error: { message: "bad token" } }, 401),
    );

    const error = await collectError(provider, { model: "gpt-5.5" });
    expect(error.code).toBe("http");
    expect(error.status).toBe(401);
    expect(error.message).toContain("bad token");
  });
});

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("responses request", () => {
  it("translates the transcript into typed input items", async () => {
    const { provider, calls } = makeProvider(
      sseResponse([event("response.completed", { response: {} })]),
    );

    await collect(provider, {
      model: "gpt-5.5",
      system: "be brief",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "I should look", signature: "sig" },
            { type: "text", text: "Looking." },
            { type: "toolCall", id: "call_1", name: "ls", args: { dir: "." } },
          ],
        },
        { role: "tool", callId: "call_1", content: "a.ts" },
      ],
    });

    const payload = body(calls);
    expect(payload.instructions).toBe("be brief");
    // Unsigned reasoning cannot be replayed, so the thinking block is dropped
    // while the assistant text and the call survive.
    expect(payload.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "list files" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Looking." }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "ls",
        arguments: '{"dir":"."}',
      },
      { type: "function_call_output", call_id: "call_1", output: "a.ts" },
    ]);
  });

  it("flattens tools and opts into reasoning + encryption", async () => {
    const { provider, calls } = makeProvider(
      sseResponse([event("response.completed", { response: {} })]),
      { includeEncryptedReasoning: true, reasoningEffort: "medium" },
    );

    await collect(provider, {
      model: "gpt-5.5",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [READ_TOOL],
    });

    expect(body(calls)).toMatchObject({
      tools: [
        {
          type: "function",
          name: "read",
          description: "Read a file",
          parameters: READ_TOOL.schema,
          strict: false,
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
    });
  });

  it("sends the token as a bearer header and merges extra headers", async () => {
    const { provider, calls } = makeProvider(
      sseResponse([event("response.completed", { response: {} })]),
      { accessToken: "oauth-token", headers: { originator: "codex_cli_rs" } },
    );

    await collect(provider, { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer oauth-token");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers.accept).toBe("text/event-stream");
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("responses models", () => {
  it("lists models from the endpoint and merges overrides", async () => {
    const { provider, calls } = makeProvider(
      jsonResponse({ data: [{ id: "gpt-5.5" }, { id: "gpt-5.5-mini" }] }),
      { modelInfo: { "gpt-5.5": { contextWindow: 272_000 } } },
    );

    const models = await provider.models();
    expect(models).toEqual([
      { id: "gpt-5.5", provider: "openai", contextWindow: 272_000 },
      { id: "gpt-5.5-mini", provider: "openai" },
    ]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
  });

  it("skips the network in overrides mode and caches the list", async () => {
    const { provider, calls } = makeProvider(jsonResponse({ data: [] }), {
      modelsMode: "overrides",
      modelInfo: {
        "gpt-5.5": { name: "GPT-5.5", contextWindow: 272_000 },
      },
    });

    expect(await provider.models()).toEqual([
      {
        id: "gpt-5.5",
        provider: "openai",
        name: "GPT-5.5",
        contextWindow: 272_000,
      },
    ]);
    await provider.models();
    expect(calls).toHaveLength(0);
  });
});