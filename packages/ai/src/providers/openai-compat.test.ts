import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type {
  Event,
  Msg,
  Provider,
  StreamRequest,
  ToolSpec,
} from "../types.js";
import { openaiCompat } from "./openai-compat.js";

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

/** One streaming chunk in OpenAI's `chat.completion.chunk` shape. */
function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function usageChunk(input: number, output: number, cached?: number) {
  return `data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      ...(cached === undefined
        ? {}
        : { prompt_tokens_details: { cached_tokens: cached } }),
    },
  })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

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
  const provider = openaiCompat({
    id: "test",
    baseUrl: "https://example.com/v1",
    apiKey: "sk-test",
    fetch: fetchImpl,
  });
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("openaiCompat stream", () => {
  it("streams text deltas, skips keep-alives and reports usage", async () => {
    const { provider } = makeProvider(
      sseResponse([
        ": keep-alive\n\n",
        chunk({ role: "assistant", content: "Hel" }),
        // Split one SSE frame across two network chunks.
        chunk({ content: "lo" }).slice(0, 12),
        chunk({ content: "lo" }).slice(12),
        usageChunk(11, 2, 4),
        DONE,
      ]),
    );

    expect(await collect(provider, { model: "m" })).toEqual([
      { t: "text", delta: "Hel" },
      { t: "text", delta: "lo" },
      {
        t: "done",
        usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 4 },
        stop: "end",
      },
    ]);
  });

  it("buffers partial tool-call JSON and emits one complete call", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "read", arguments: '{"path":' },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }],
        }),
        chunk({}, "tool_calls"),
        usageChunk(3, 7),
        DONE,
      ]),
    );

    expect(await collect(provider, { model: "m" })).toEqual([
      {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: "call_a",
          name: "read",
          args: { path: "a.ts" },
        },
      },
      {
        t: "done",
        usage: { inputTokens: 3, outputTokens: 7 },
        stop: "tool",
      },
    ]);
  });

  it("treats stop as tool when calls were emitted anyway", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_b",
              function: { name: "todo", arguments: "{}" },
            },
          ],
        }),
        chunk({}, "stop"),
        DONE,
      ]),
    );

    const events = await collect(provider, { model: "m" });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "tool" });
  });

  it("maps reasoning to thinking and length to the length stop reason", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({ reasoning_content: "pondering" }),
        chunk({ content: "answer" }),
        chunk({}, "length"),
        DONE,
      ]),
    );

    expect(await collect(provider, { model: "m" })).toEqual([
      { t: "thinking", delta: "pondering" },
      { t: "text", delta: "answer" },
      { t: "done", usage: { inputTokens: 0, outputTokens: 0 }, stop: "length" },
    ]);
  });

  it("handles multiple tool calls by index in order", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          tool_calls: [
            {
              index: 1,
              id: "call_2",
              function: { name: "bash", arguments: '{"cmd":"ls"}' },
            },
            {
              index: 0,
              id: "call_1",
              function: { name: "read", arguments: '{"path":"b.ts"}' },
            },
          ],
        }),
        chunk({}, "tool_calls"),
        DONE,
      ]),
    );

    const events = await collect(provider, { model: "m" });
    const names = events
      .filter((event) => event.t === "toolCall")
      .map((event) => (event.t === "toolCall" ? event.call.name : ""));
    expect(names).toEqual(["read", "bash"]);
  });
});

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("openaiCompat request", () => {
  it("maps messages and tools to the wire format", async () => {
    const { provider, calls } = makeProvider(sseResponse([DONE]));

    const messages: Msg[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal reasoning" },
          { type: "text", text: "checking" },
          { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
        ],
      },
      { role: "tool", callId: "c1", content: "file body" },
    ];
    const tools: ToolSpec[] = [
      {
        name: "read",
        description: "Read a file",
        schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    await collect(provider, {
      model: "gpt-test",
      system: "be brief",
      messages,
      tools,
    });

    const call = calls[0];
    expect(call?.url).toBe("https://example.com/v1/chat/completions");
    expect(call?.init?.method).toBe("POST");
    expect(
      (call?.init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer sk-test");

    const body = JSON.parse(String(call?.init?.body)) as {
      model: string;
      stream: boolean;
      stream_options: unknown;
      messages: unknown[];
      tools: unknown[];
    };

    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read", arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "file body" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("omits Authorization and tools when unset", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([DONE]));
    const provider = openaiCompat({
      id: "ollama",
      baseUrl: "http://localhost:11434/v1/",
      fetch: fetchImpl,
    });

    await collect(provider, { model: "llama", system: "" });

    const call = calls[0];
    expect(call?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(
      (call?.init?.headers as Record<string, string>).authorization,
    ).toBeUndefined();
    const body = JSON.parse(String(call?.init?.body)) as {
      messages: unknown[];
      tools?: unknown;
    };
    // Empty system prompts are not sent as a message.
    expect(body.messages).toEqual([]);
    expect(body.tools).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("openaiCompat errors", () => {
  it("surfaces HTTP errors with status and retryability", async () => {
    const { provider } = makeProvider(
      jsonResponse({ error: { message: "invalid api key" } }, 401),
    );

    const error: unknown = await collect(provider, { model: "m" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderError);
    const providerError = error as ProviderError;
    expect(providerError.status).toBe(401);
    expect(providerError.code).toBe("http");
    expect(providerError.retryable).toBe(false);
    expect(providerError.message).toContain("invalid api key");
  });

  it("marks 429 and 5xx as retryable", async () => {
    for (const status of [429, 503]) {
      const { provider } = makeProvider(new Response("busy", { status }));
      const error = (await collect(provider, { model: "m" }).catch(
        (caught: unknown) => caught,
      )) as ProviderError;
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(true);
    }
  });

  it("rejects on malformed tool arguments", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          tool_calls: [
            { index: 0, id: "c1", function: { name: "read", arguments: "{" } },
          ],
        }),
        chunk({}, "tool_calls"),
        DONE,
      ]),
    );

    const error = (await collect(provider, { model: "m" }).catch(
      (caught: unknown) => caught,
    )) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.code).toBe("protocol");
    expect(error.message).toContain("malformed tool arguments");
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("openaiCompat models", () => {
  it("lists models, merges overrides and caches the result", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        data: [
          { id: "gpt-x", context_length: 8192 },
          { id: "local-model" },
        ],
      }),
    );
    const provider = openaiCompat({
      id: "test",
      baseUrl: "https://example.com/v1/",
      fetch: fetchImpl,
      modelInfo: {
        "local-model": {
          contextWindow: 100_000,
          pricing: { input: 1, output: 2 },
        },
      },
    });

    expect(await provider.models()).toEqual([
      { id: "gpt-x", provider: "test", contextWindow: 8192 },
      {
        id: "local-model",
        provider: "test",
        contextWindow: 100_000,
        pricing: { input: 1, output: 2 },
      },
    ]);
    expect(calls[0]?.url).toBe("https://example.com/v1/models");

    await provider.models();
    expect(calls).toHaveLength(1);
  });
});