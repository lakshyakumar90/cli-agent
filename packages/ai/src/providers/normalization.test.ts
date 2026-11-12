/**
 * The Phase 1 contract, checked the same way for every adapter.
 *
 * Each provider speaks a different wire format, but all of them must normalise
 * exactly three things so nothing above the provider layer can tell them apart:
 *
 * 1. tool-call arguments — a stream of partial JSON (or a single object) becomes
 *    one `toolCall` event with parsed arguments;
 * 2. usage — input/output tokens, plus cache reads where reported;
 * 3. stop reasons — `tool`, `length`, `end`.
 *
 * Adding an adapter means adding a case here.
 */

import { describe, expect, it } from "vitest";
import type { Event, Provider, StreamRequest, ToolSpec } from "../types.js";
import { anthropic } from "./anthropic.js";
import { antigravity } from "./antigravity.js";
import { codex } from "./codex.js";
import { gemini } from "./gemini.js";
import { openaiCompat } from "./openai-compat.js";

// ---------------------------------------------------------------------------
// Shared plumbing
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

function mockFetch(response: Response) {
  return (async () => response) as typeof globalThis.fetch;
}

const READ: ToolSpec = {
  name: "read",
  description: "Read a file",
  schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

type RequestInput = Pick<StreamRequest, "model"> & Partial<StreamRequest>;

async function collect(provider: Provider, input: RequestInput): Promise<Event[]> {
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

/** OpenAI chat-completions chunk. */
function chat(delta: Record<string, unknown>, finish: string | null = null) {
  return `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finish }],
  })}\n\n`;
}

/** OpenAI chat-completions usage chunk (no choices). */
function chatUsage(usage: Record<string, unknown>) {
  return `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

/** Anthropic named event. */
function evt(type: string, data: Record<string, unknown> = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** Gemini `GenerateContentResponse` chunk. */
function gem(data: Record<string, unknown>) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Cloud Code Assist chunk: the same body, wrapped in `response`. */
function cloud(data: Record<string, unknown>) {
  return `data: ${JSON.stringify({ response: data })}\n\n`;
}

interface Case {
  name: string;
  model: string;
  /** Wire stream that produces one tool call for `read`. */
  toolStream: string[];
  /** Wire stream that is cut off by the max-output limit. */
  lengthStream: string[];
  expectedUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  make: (fetchImpl: typeof globalThis.fetch) => Provider;
}

// ---------------------------------------------------------------------------
// One case per adapter
// ---------------------------------------------------------------------------

const CASES: Case[] = [
  {
    name: "openai chat completions",
    model: "gpt-5.5",
    toolStream: [
      chat({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"pa' } },
        ],
      }),
      chat({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
      chat({}, "tool_calls"),
      chatUsage({
        prompt_tokens: 11,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
      }),
      DONE,
    ],
    lengthStream: [chat({ content: "cut" }, "length"), DONE],
    expectedUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 },
    make: (fetch) =>
      openaiCompat({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        fetch,
      }),
  },
  {
    name: "anthropic",
    model: "claude-sonnet-5-5",
    toolStream: [
      evt("message_start", {
        message: { usage: { input_tokens: 11, cache_read_input_tokens: 3 } },
      }),
      evt("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "read" },
      }),
      evt("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"pa' },
      }),
      evt("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'th":"a.ts"}' },
      }),
      evt("content_block_stop", { index: 0 }),
      evt("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
      evt("message_stop"),
    ],
    lengthStream: [
      evt("message_start", { message: { usage: { input_tokens: 11 } } }),
      evt("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      evt("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: "cut" },
      }),
      evt("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5 } }),
      evt("message_stop"),
    ],
    expectedUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 },
    make: (fetch) => anthropic({ apiKey: "sk-ant-test", fetch }),
  },
  {
    name: "gemini",
    model: "gemini-3-pro",
    toolStream: [
      gem({
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.ts" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 3,
        },
      }),
    ],
    lengthStream: [
      gem({
        candidates: [{ content: { role: "model", parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 },
      }),
    ],
    expectedUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 },
    make: (fetch) => gemini({ apiKey: "AIza-test", fetch }),
  },
  {
    name: "antigravity",
    model: "gemini-3-pro",
    toolStream: [
      cloud({
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.ts" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 3,
        },
      }),
    ],
    lengthStream: [
      cloud({
        candidates: [{ content: { role: "model", parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 },
      }),
    ],
    expectedUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 },
    make: (fetch) =>
      antigravity({ accessToken: "google-token", project: "proj-1", fetch }),
  },
  {
    name: "codex (responses)",
    model: "gpt-5.5",
    toolStream: [
      evt("response.output_item.added", {
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read" },
      }),
      evt("response.function_call_arguments.delta", { item_id: "fc_1", delta: '{"pa' }),
      evt("response.function_call_arguments.delta", { item_id: "fc_1", delta: 'th":"a.ts"}' }),
      evt("response.output_item.done", {
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read",
          arguments: '{"path":"a.ts"}',
        },
      }),
      evt("response.completed", {
        response: {
          status: "completed",
          usage: {
            input_tokens: 11,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
      }),
    ],
    lengthStream: [
      evt("response.output_text.delta", { delta: "cut" }),
      evt("response.incomplete", {
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 11, output_tokens: 5 },
        },
      }),
    ],
    expectedUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 },
    make: (fetch) => codex({ accessToken: "chatgpt-token", accountId: "acct", fetch }),
  },
];

// ---------------------------------------------------------------------------
// The three invariants
// ---------------------------------------------------------------------------

describe.each(CASES)("normalisation: $name", (testCase) => {
  it("turns streamed arguments into one toolCall with parsed args", async () => {
    const provider = testCase.make(mockFetch(sseResponse(testCase.toolStream)));

    const events = await collect(provider, {
      model: testCase.model,
      tools: [READ],
    });

    const calls = events.filter((event) => event.t === "toolCall");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      t: "toolCall",
      call: { type: "toolCall", name: "read", args: { path: "a.ts" } },
    });

    const done = events.at(-1);
    expect(done?.t).toBe("done");
    if (done?.t !== "done") throw new Error("missing done event");
    expect(done.stop).toBe("tool");
    expect(done.usage).toEqual(testCase.expectedUsage);
  });

  it("reports length when the model hits the output limit", async () => {
    const provider = testCase.make(mockFetch(sseResponse(testCase.lengthStream)));

    const events = await collect(provider, { model: testCase.model });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "length" });
  });
});