import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type {
  Event,
  Msg,
  Provider,
  StreamRequest,
  ToolSpec,
} from "../types.js";
import { gemini } from "./gemini.js";

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

/** One `GenerateContentResponse` chunk. */
function chunk(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
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

async function collect(provider: Provider, input: RequestInput): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of provider.stream(request(input))) events.push(event);
  return events;
}

async function collectUntilError(
  provider: Provider,
  input: RequestInput,
): Promise<{ events: Event[]; error: unknown }> {
  const events: Event[] = [];
  try {
    for await (const event of provider.stream(request(input))) events.push(event);
  } catch (error) {
    return { events, error };
  }
  return { events, error: undefined };
}

function makeProvider(response: Response) {
  const { fetchImpl, calls } = mockFetch(() => response);
  const provider = gemini({ apiKey: "AIza-test", fetch: fetchImpl });
  return { provider, calls };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("gemini stream", () => {
  it("streams text, separates thoughts and sums thinking into output tokens", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          candidates: [
            { content: { role: "model", parts: [{ text: "Hmm", thought: true }] } },
          ],
          usageMetadata: { promptTokenCount: 10 },
        }),
        chunk({
          candidates: [
            { content: { role: "model", parts: [{ text: "Hel" }, { text: "lo" }] } },
          ],
        }),
        chunk({
          candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 6,
            thoughtsTokenCount: 4,
          },
        }),
      ]),
    );

    expect(await collect(provider, { model: "gemini-3-pro" })).toEqual([
      { t: "thinking", delta: "Hmm" },
      { t: "text", delta: "Hel" },
      { t: "text", delta: "lo" },
      { t: "done", usage: { inputTokens: 10, outputTokens: 10 }, stop: "end" },
    ]);
  });

  it("maps functionCall parts to tool calls and keeps thought signatures", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: { name: "read", args: { path: "a.ts" } },
                    thoughtSignature: "sig-1",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
        }),
      ]),
    );

    expect(await collect(provider, { model: "gemini-3-pro" })).toEqual([
      {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: "call_1",
          name: "read",
          args: { path: "a.ts" },
          signature: "sig-1",
        },
      },
      { t: "done", usage: { inputTokens: 3, outputTokens: 2 }, stop: "tool" },
    ]);
  });

  it("emits a signature that arrives on its own part", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          candidates: [
            { content: { parts: [{ text: "hmm", thought: true }] } },
          ],
        }),
        chunk({
          candidates: [
            { content: { parts: [{ thoughtSignature: "sig-tail" }] } },
          ],
        }),
      ]),
    );

    expect(await collect(provider, { model: "gemini-3-pro" })).toEqual([
      { t: "thinking", delta: "hmm" },
      { t: "thinking", delta: "", signature: "sig-tail" },
      { t: "done", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end" },
    ]);
  });

  it("maps MAX_TOKENS to a length stop", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          candidates: [
            { content: { parts: [{ text: "trunc" }] }, finishReason: "MAX_TOKENS" },
          ],
        }),
      ]),
    );

    const events = await collect(provider, { model: "gemini-3-pro" });
    expect(events.at(-1)).toEqual({
      t: "done",
      usage: { inputTokens: 0, outputTokens: 0 },
      stop: "length",
    });
  });

  it("surfaces a safety block after the partial text", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({
          candidates: [
            { content: { parts: [{ text: "partial" }] }, finishReason: "SAFETY" },
          ],
        }),
      ]),
    );

    const { events, error } = await collectUntilError(provider, {
      model: "gemini-3-pro",
    });
    expect(events).toEqual([{ t: "text", delta: "partial" }]);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("protocol");
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toContain("safety");
  });

  it("rejects a malformed chunk", async () => {
    const { provider } = makeProvider(sseResponse(["data: {oops\n\n"]));

    const { error } = await collectUntilError(provider, { model: "gemini-3-pro" });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("protocol");
    expect((error as ProviderError).message).toContain("malformed stream chunk");
  });
});

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

describe("gemini request", () => {
  it("translates the transcript, tools and auth header", async () => {
    const { provider, calls } = makeProvider(sseResponse([]));

    const messages: Msg[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm", signature: "sig-a" },
          { type: "thinking", text: "unsigned" },
          { type: "text", text: "checking" },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            args: { path: "a.ts" },
            signature: "sig-call",
          },
          { type: "toolCall", id: "call_2", name: "bash", args: { cmd: "ls" } },
        ],
      },
      { role: "tool", callId: "call_1", content: "body" },
      { role: "tool", callId: "call_2", content: "boom", isError: true },
      { role: "user", content: "thanks" },
    ];
    const tools: ToolSpec[] = [
      {
        name: "read",
        description: "Read a file",
        schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
      { name: "list", description: "List files", schema: {} },
    ];

    await collect(provider, {
      model: "gemini-3-pro",
      system: "be brief",
      messages,
      tools,
    });

    const call = calls[0];
    expect(call?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse",
    );
    expect(call?.init?.method).toBe("POST");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("AIza-test");
    expect(headers.accept).toBe("text/event-stream");

    const body = JSON.parse(String(call?.init?.body)) as {
      contents: unknown[];
      systemInstruction: unknown;
      tools: unknown[];
    };

    expect(body.systemInstruction).toEqual({
      parts: [{ text: "be brief" }],
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [
          { text: "hmm", thought: true, thoughtSignature: "sig-a" },
          { text: "checking" },
          {
            functionCall: { name: "read", args: { path: "a.ts" } },
            thoughtSignature: "sig-call",
          },
          { functionCall: { name: "bash", args: { cmd: "ls" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read", response: { result: "body" } } },
          { functionResponse: { name: "bash", response: { error: "boom" } } },
          { text: "thanks" },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
          { name: "list", description: "List files" },
        ],
      },
    ]);
  });

  it("supports query-string auth and omits an empty system prompt", async () => {
    const { fetchImpl, calls } = mockFetch(() => sseResponse([]));
    const provider = gemini({
      apiKey: "AIza-query",
      auth: "query",
      generation: { temperature: 0, thinkingConfig: { thinkingLevel: "low" } },
      fetch: fetchImpl,
    });

    await collect(provider, { model: "gemini-3-flash", system: "   " });

    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse&key=AIza-query",
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBeUndefined();

    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      systemInstruction?: unknown;
      tools?: unknown;
      generationConfig?: unknown;
    };
    expect(body.systemInstruction).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(body.generationConfig).toEqual({
      temperature: 0,
      thinkingConfig: { thinkingLevel: "low" },
    });
  });
});

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

describe("gemini errors", () => {
  it("surfaces HTTP errors with status and retryability", async () => {
    const forbidden = makeProvider(
      jsonResponse(
        { error: { code: 403, message: "API key not valid", status: "PERMISSION_DENIED" } },
        403,
      ),
    );
    const forbiddenError = await collectUntilError(forbidden.provider, {
      model: "gemini-3-pro",
    });
    const authError = forbiddenError.error as ProviderError;
    expect(authError.status).toBe(403);
    expect(authError.retryable).toBe(false);
    expect(authError.message).toContain("API key not valid");

    const busy = makeProvider(new Response("busy", { status: 503 }));
    const busyError = (await collectUntilError(busy.provider, {
      model: "gemini-3-pro",
    })).error as ProviderError;
    expect(busyError.status).toBe(503);
    expect(busyError.retryable).toBe(true);
  });

  it("reports a blocked prompt", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({ promptFeedback: { blockReason: "SAFETY", blockReasonMessage: "unsafe" } }),
      ]),
    );

    const { error } = await collectUntilError(provider, { model: "gemini-3-pro" });
    expect((error as ProviderError).message).toContain("prompt blocked");
    expect((error as ProviderError).message).toContain("unsafe");
    expect((error as ProviderError).retryable).toBe(false);
  });

  it("turns an in-stream error chunk into a ProviderError", async () => {
    const { provider } = makeProvider(
      sseResponse([
        chunk({ error: { code: 429, message: "quota exceeded", status: "RESOURCE_EXHAUSTED" } }),
      ]),
    );

    const { error } = await collectUntilError(provider, { model: "gemini-3-pro" });
    expect((error as ProviderError).code).toBe("protocol");
    expect((error as ProviderError).retryable).toBe(true);
    expect((error as ProviderError).message).toContain("quota exceeded");
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("gemini models", () => {
  it("paginates, drops non-chat models and applies overrides", async () => {
    const { fetchImpl, calls } = mockFetch((url) =>
      url.includes("pageToken=p2")
        ? jsonResponse({
            models: [
              {
                name: "models/gemini-3-flash",
                displayName: "Gemini 3 Flash",
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
            ],
          })
        : jsonResponse({
            models: [
              {
                name: "models/gemini-3-pro",
                displayName: "Gemini 3 Pro",
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
              {
                name: "models/text-embedding-004",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
            nextPageToken: "p2",
          }),
    );
    const provider = gemini({
      apiKey: "AIza-test",
      fetch: fetchImpl,
      modelInfo: { "gemini-3-pro": { pricing: { input: 2, output: 12 } } },
    });

    expect(await provider.models()).toEqual([
      {
        id: "gemini-3-pro",
        provider: "gemini",
        name: "Gemini 3 Pro",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        pricing: { input: 2, output: 12 },
      },
      {
        id: "gemini-3-flash",
        provider: "gemini",
        name: "Gemini 3 Flash",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
      },
    ]);
    expect(calls).toHaveLength(2);

    await provider.models();
    expect(calls).toHaveLength(2);
  });
});