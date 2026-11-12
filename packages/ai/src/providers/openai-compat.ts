/**
 * OpenAI-compatible provider.
 *
 * One adapter covers OpenAI, OpenCode Zen, OpenRouter, Ollama, LM Studio and
 * vLLM — anything that speaks `POST {baseUrl}/chat/completions` with SSE
 * streaming. Only `baseUrl`, auth and model metadata differ.
 *
 * Normalised here, so no caller has to think about it:
 * - tool-call arguments streamed as partial JSON, buffered per tool-call index
 *   and emitted as one complete `toolCall` event with parsed arguments;
 * - usage, including prompt-cache hits, which OpenAI sends in a final chunk;
 * - stop reasons (`stop`, `tool_calls`, `function_call`, `length`, ...).
 */

import { ProviderError } from "../errors.js";
import { parseSse } from "../sse.js";
import type {
  Event,
  ModelInfo,
  Msg,
  Provider,
  StopReason,
  StreamRequest,
  ToolCall,
  ToolSpec,
  Usage,
} from "../types.js";

const DEFAULT_CHAT_PATH = "/chat/completions";
const DEFAULT_MODELS_PATH = "/models";
const MODELS_TIMEOUT_MS = 15_000;

export interface OpenAICompatOptions {
  /** Provider id used in `"provider/model"` refs, e.g. `"openai"` or `"opencode"`. */
  id: string;
  /** API root, e.g. `"https://api.openai.com/v1"`. A trailing slash is fine. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>` when present. Omit for local servers. */
  apiKey?: string;
  /** Extra headers merged over the defaults (OpenRouter wants `HTTP-Referer`). */
  headers?: Record<string, string>;
  /** Defaults to `/chat/completions`. */
  chatPath?: string;
  /** Defaults to `/models`. */
  modelsPath?: string;
  /** Extra fields merged into every chat request body (temperature, routing, …). */
  body?: Record<string, unknown>;
  /**
   * Ask for a final usage chunk via `stream_options.include_usage`.
   * Defaults to true; disable for servers that reject unknown fields.
   */
  includeUsage?: boolean;
  /** Static metadata merged over `/models` results, keyed by wire model id. */
  modelInfo?: Record<string, Partial<ModelInfo>>;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Wire types: only the fields this adapter reads.
// ---------------------------------------------------------------------------

interface WireToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireDelta {
  content?: string | null;
  /** DeepSeek / vLLM style reasoning channel. */
  reasoning?: string | null;
  /** OpenRouter / OpenCode style reasoning channel. */
  reasoning_content?: string | null;
  tool_calls?: WireToolCall[];
  /** Legacy single-function-call shape, still emulated by some servers. */
  function_call?: { name?: string; arguments?: string };
}

interface WireChoice {
  delta?: WireDelta;
  finish_reason?: string | null;
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface WireChunk {
  choices?: WireChoice[];
  usage?: WireUsage;
}

interface WireToolCallOut {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: WireToolCallOut[];
  tool_call_id?: string;
}

interface PendingCall {
  id?: string;
  name?: string;
  args: string;
}

// ---------------------------------------------------------------------------
// Pure translations.
// ---------------------------------------------------------------------------

function toWireMessages(system: string, messages: Msg[]): WireMessage[] {
  const wire: WireMessage[] = [];
  if (system.trim().length > 0) wire.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "tool") {
      wire.push({
        role: "tool",
        tool_call_id: message.callId,
        content: message.content,
      });
      continue;
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    const calls = message.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );

    const assistant: WireMessage = {
      role: "assistant",
      // `thinking` blocks are dropped: they are not valid input for the model
      // and would be re-billed as tokens.
      content: text.length > 0 ? text : calls.length > 0 ? null : "",
    };

    if (calls.length > 0) {
      assistant.tool_calls = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
      }));
    }

    wire.push(assistant);
  }

  return wire;
}

function toWireTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    },
  }));
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool";
    case "length":
      return "length";
    default:
      // "stop", "content_filter" and anything unrecognised.
      return "end";
  }
}

function mapUsage(usage: WireUsage): Usage {
  const mapped: Usage = {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) mapped.cacheReadTokens = cached;
  return mapped;
}

function accumulateCall(
  pending: Map<number, PendingCall>,
  index: number,
  id: string | undefined,
  fn: { name?: string; arguments?: string } | undefined,
): void {
  const call = pending.get(index) ?? { args: "" };
  if (id) call.id = id;
  if (fn?.name) call.name = fn.name;
  if (typeof fn?.arguments === "string") call.args += fn.arguments;
  pending.set(index, call);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Failure helpers.
// ---------------------------------------------------------------------------

function parseChunk(provider: string, data: string): WireChunk {
  try {
    return JSON.parse(data) as WireChunk;
  } catch (error) {
    throw new ProviderError(
      `${provider}: malformed stream chunk — ${data.slice(0, 200)}`,
      { provider, code: "protocol", cause: error },
    );
  }
}

function parseToolArgs(provider: string, raw: string): unknown {
  const text = raw.trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProviderError(
      `${provider}: malformed tool arguments — ${text.slice(0, 200)}`,
      { provider, code: "protocol", cause: error },
    );
  }
}

function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (text.length === 0) return "";
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string") return message.slice(0, 500);
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return text.slice(0, 500);
}

async function httpError(
  provider: string,
  response: Response,
): Promise<ProviderError> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // Body already consumed or unreadable; the status is still useful.
  }
  const detail = extractErrorMessage(body);
  const status = response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status);
  return new ProviderError(
    `${provider}: HTTP ${status}${detail ? ` — ${detail}` : ""}`,
    {
      provider,
      code: "http",
      status: response.status,
      body: body.slice(0, 2_000),
    },
  );
}

function networkError(
  provider: string,
  error: unknown,
  signal?: AbortSignal,
): unknown {
  // Let callers observe real aborts instead of wrapping them.
  if (signal?.aborted) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${provider}: request failed — ${message}`, {
    provider,
    code: "network",
    cause: error,
  });
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export function openaiCompat(options: OpenAICompatOptions): Provider {
  const {
    id,
    baseUrl,
    apiKey,
    headers = {},
    chatPath = DEFAULT_CHAT_PATH,
    modelsPath = DEFAULT_MODELS_PATH,
    body: extraBody = {},
    includeUsage = true,
    modelInfo: modelOverrides = {},
    fetch: doFetch = globalThis.fetch,
  } = options;

  const endpoint = (path: string): string =>
    `${baseUrl.replace(/\/+$/, "")}${path}`;

  const headersFor = (accept: string): Record<string, string> => ({
    accept,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...headers,
  });

  const listModels = async (): Promise<ModelInfo[]> => {
    let response: Response;
    try {
      response = await doFetch(endpoint(modelsPath), {
        headers: headersFor("application/json"),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(id, error);
    }

    if (!response.ok) throw await httpError(id, response);

    const payload = (await response.json()) as {
      data?: Array<Record<string, unknown>>;
    };
    const entries = Array.isArray(payload.data) ? payload.data : [];

    return entries.flatMap((entry) => {
      const modelId = typeof entry.id === "string" ? entry.id : undefined;
      if (!modelId) return [];

      // Providers disagree on the field name; take whatever is advertised.
      const contextWindow = firstNumber(
        entry.context_length,
        entry.context_window,
        entry.max_model_len,
        entry.max_context_length,
      );

      const merged: ModelInfo = {
        ...(typeof entry.name === "string" ? { name: entry.name } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...modelOverrides[modelId],
        // Identity stays authoritative whatever the override says.
        id: modelId,
        provider: id,
      };
      return [merged];
    });
  };

  let modelsPromise: Promise<ModelInfo[]> | undefined;

  async function* stream(request: StreamRequest): AsyncGenerator<Event> {
    const { model, system, messages, tools, signal } = request;

    const payload: Record<string, unknown> = {
      model,
      messages: toWireMessages(system, messages),
      stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      ...(tools.length > 0 ? { tools: toWireTools(tools) } : {}),
      ...extraBody,
    };

    let response: Response;
    try {
      response = await doFetch(endpoint(chatPath), {
        method: "POST",
        headers: {
          ...headersFor("text/event-stream"),
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      throw networkError(id, error, signal);
    }

    if (!response.ok) throw await httpError(id, response);
    if (!response.body) {
      throw new ProviderError(`${id}: response has no body`, {
        provider: id,
        code: "protocol",
      });
    }

    const pending = new Map<number, PendingCall>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let reportedStop: StopReason | undefined;

    for await (const message of parseSse(response.body)) {
      if (message.data === "[DONE]") break;
      if (message.data.trim().length === 0) continue; // keep-alive

      const chunk = parseChunk(id, message.data);

      // Usage arrives in its own chunk with `choices: []`, after the last delta.
      if (chunk.usage) usage = mapUsage(chunk.usage);

      const choice = chunk.choices?.[0]; // n > 1 is not supported; first choice wins.
      if (!choice) continue;

      const delta = choice.delta;
      if (delta) {
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (typeof thinking === "string" && thinking.length > 0) {
          yield { t: "thinking", delta: thinking };
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { t: "text", delta: delta.content };
        }

        for (const call of delta.tool_calls ?? []) {
          accumulateCall(pending, call.index ?? 0, call.id, call.function);
        }
        if (delta.function_call) {
          accumulateCall(pending, 0, undefined, delta.function_call);
        }
      }

      if (choice.finish_reason) {
        reportedStop = mapStopReason(choice.finish_reason);
      }
    }

    let emitted = 0;
    const ordered = [...pending.entries()].sort(([a], [b]) => a - b);
    for (const [index, call] of ordered) {
      if (!call.name) continue; // incomplete call, nothing usable to execute
      emitted += 1;
      yield {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: call.id ?? `call_${index}`,
          name: call.name,
          args: parseToolArgs(id, call.args),
        },
      };
    }

    yield {
      t: "done",
      usage,
      // Some servers report "stop" even when they emitted tool calls.
      stop: emitted > 0 ? "tool" : (reportedStop ?? "end"),
    };
  }

  return {
    id,
    models: () => (modelsPromise ??= listModels()),
    stream,
  };
}