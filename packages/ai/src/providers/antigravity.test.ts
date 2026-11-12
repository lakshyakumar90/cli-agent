import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type { Event, Provider, StreamRequest } from "../types.js";
import { antigravity, discoverProject } from "./antigravity.js";

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

function request(input: Partial<StreamRequest> & { model: string }): StreamRequest {
  return {
    model: input.model,
    system: input.system ?? "",
    messages: input.messages ?? [],
    tools: input.tools ?? [],
    signal: input.signal ?? new AbortController().signal,
  };
}

async function collect(provider: Provider, input: {
  model: string;
  messages?: StreamRequest["messages"];
  system?: string;
}): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of provider.stream(request(input))) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// Streaming / Cloud Code wrapping
// ---------------------------------------------------------------------------

describe("antigravity", () => {
  it("wraps the request in {model, project, request} and unwraps response chunks", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      sseResponse([
        `data: ${JSON.stringify({
          response: {
            candidates: [
              { content: { role: "model", parts: [{ text: "hi" }] } },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
          },
        })}\n\n`,
      ]),
    );
    const provider = antigravity({
      accessToken: "ya29.token",
      project: "proj-1",
      fetch: fetchImpl,
    });

    const events = await collect(provider, {
      model: "gemini-3-pro",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(events).toEqual([
      { t: "text", delta: "hi" },
      { t: "done", usage: { inputTokens: 5, outputTokens: 2 }, stop: "end" },
    ]);

    const call = calls[0];
    expect(call?.url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ya29.token");

    const body = JSON.parse(String(call?.init?.body)) as {
      model: string;
      project: string;
      request: { contents: unknown[] };
    };
    expect(body.model).toBe("gemini-3-pro");
    expect(body.project).toBe("proj-1");
    expect(body.request.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
    ]);
  });

  it("still reads unwrapped chunks, for backends that stop nesting them", async () => {
    const { fetchImpl } = mockFetch(() =>
      sseResponse([
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "plain" }] } }],
        })}\n\n`,
      ]),
    );
    const provider = antigravity({ accessToken: "ya29.token", fetch: fetchImpl });

    expect(await collect(provider, { model: "gemini-3-pro" })).toEqual([
      { t: "text", delta: "plain" },
      { t: "done", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end" },
    ]);
  });

  it("loads models from fetchAvailableModels", async () => {
    const { fetchImpl, calls } = mockFetch((url) => {
      expect(url).toBe(
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
      );
      return jsonResponse({
        models: {
          "gemini-3-pro": {
            displayName: "Gemini 3 Pro",
            maxTokens: 1_048_576,
            maxOutputTokens: 65_536,
          },
          "gemini-3-flash": {
            displayName: "Gemini 3 Flash",
            maxTokens: 1_048_576,
          },
        },
      });
    });
    const provider = antigravity({
      accessToken: "ya29.token",
      project: "proj-1",
      fetch: fetchImpl,
      modelInfo: { "gemini-3-pro": { pricing: { input: 2, output: 12 } } },
    });

    expect(await provider.models()).toEqual([
      {
        id: "gemini-3-pro",
        provider: "antigravity",
        name: "Gemini 3 Pro",
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        pricing: { input: 2, output: 12 },
      },
      {
        id: "gemini-3-flash",
        provider: "antigravity",
        name: "Gemini 3 Flash",
        contextWindow: 1_048_576,
      },
    ]);
    // The project is echoed so the backend scopes the model list to the tier.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      project: "proj-1",
    });
  });
});

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

describe("antigravity discoverProject", () => {
  it("returns the account's project and tier", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResponse({
        cloudaicompanionProject: "proj-9",
        allowedTiers: [
          { id: "standard-tier", name: "Standard" },
          { id: "free-tier", name: "Free", isDefault: true },
        ],
      }),
    );

    expect(
      await discoverProject({ accessToken: "ya29.token", fetch: fetchImpl }),
    ).toEqual({ project: "proj-9", tier: "Free" });

    expect(calls[0]?.url).toBe(
      "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    );
  });

  it("rejects an expired token with a non-retryable HTTP error", async () => {
    const { fetchImpl } = mockFetch(
      () => jsonResponse({ error: { message: "invalid_grant" } }, 401),
    );

    const error = await discoverProject({
      accessToken: "stale",
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(401);
    expect((error as ProviderError).retryable).toBe(false);
  });
});