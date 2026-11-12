import { describe, expect, it } from "vitest";
import type { Event, Provider, StreamRequest } from "../types.js";
import { CODEX_BASE_URL, CODEX_ORIGINATOR, codex } from "./codex.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function sseResponse(parts: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function event(type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function mockFetch(response: Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({ url, init });
    return response;
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

function makeProvider(options: Record<string, unknown> = {}) {
  const { fetchImpl, calls } = mockFetch(
    sseResponse([
      event("response.output_text.delta", { delta: "ok" }),
      event("response.completed", {
        response: {
          status: "completed",
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      }),
    ]),
  );
  const provider = codex({
    accessToken: "chatgpt-token",
    accountId: "acct_123",
    fetch: fetchImpl,
    ...options,
  });
  return { provider, calls };
}

function payload(calls: Array<{ init?: RequestInit }>): Record<string, unknown> {
  return JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Preset
// ---------------------------------------------------------------------------

describe("codex preset", () => {
  it("posts to the ChatGPT backend with account and originator headers", async () => {
    const { provider, calls } = makeProvider();

    const events = await collect(provider, { model: "gpt-5.5" });

    expect(events.at(-1)).toMatchObject({ t: "done", stop: "end" });
    expect(calls[0]?.url).toBe(`${CODEX_BASE_URL}/responses`);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer chatgpt-token");
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    expect(headers.originator).toBe(CODEX_ORIGINATOR);
  });

  it("never stores server-side and replays encrypted reasoning", async () => {
    const { provider, calls } = makeProvider();

    await collect(provider, {
      model: "gpt-5.5",
      system: "you are codex",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(payload(calls)).toMatchObject({
      model: "gpt-5.5",
      store: false,
      include: ["reasoning.encrypted_content"],
      instructions: "you are codex",
    });
  });

  it("lets the caller override headers and reasoning effort", async () => {
    const { provider, calls } = makeProvider({
      originator: "my_agent",
      reasoningEffort: "high",
      headers: { "x-extra": "1" },
    });

    await collect(provider, { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.originator).toBe("my_agent");
    expect(headers["x-extra"]).toBe("1");
    expect(payload(calls)).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("uses the static catalog, since the Codex model list has its own shape", async () => {
    const { provider } = makeProvider();

    const models = await provider.models();
    const ids = models.map((model) => model.id);

    expect(ids).toContain("gpt-5.5");
    expect(models.every((model) => model.provider === "codex")).toBe(true);
    expect(models.every((model) => model.contextWindow === 272_000)).toBe(true);
  });

  it("merges caller-supplied model metadata over the built-in table", async () => {
    const { provider } = makeProvider();

    const models = await codex({
      modelInfo: { "gpt-5.5": { name: "Renamed" } },
    }).models();

    const model = models.find((entry) => entry.id === "gpt-5.5");
    expect(model?.name).toBe("Renamed");
    // The rest of the built-in entry survives the merge.
    expect(model?.contextWindow).toBe(272_000);
    expect(models.every((entry) => entry.provider === "codex")).toBe(true);
  });
});