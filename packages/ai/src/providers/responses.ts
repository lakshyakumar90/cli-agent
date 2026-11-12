/**
 * OpenAI Responses API provider (`POST {baseUrl}/responses`, SSE).
 *
 * Shares OpenAI's identity/auth with the chat-completions adapter, but not its
 * wire format: `input` is a flat list of typed items, tools are flattened, the
 * system prompt is `instructions`, and the stream is a sequence of named
 * `response.*` events.
 *
 * Normalised here, so callers never see the difference:
 * - tool arguments, streamed as partial JSON through
 *   `response.function_call_arguments.delta` and completed by the `function_call`
 *   item, are buffered per item and emitted as one parsed `toolCall`;
 * - usage from `response.completed` (`input_tokens`, `output_tokens`, cached and
 *   cache-write details);
 * - stop reasons from `response.completed` / `response.incomplete`
 *   (`max_output_tokens` -> `length`, any tool call -> `tool`).
 *
 * `store` defaults to false so a session can be replayed locally rather than
 * relying on server-side state.
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
  Usage,
} from "../types.js";

const DEFAULT_RESPONSES_PATH = "/responses";
const DEFAULT_MODELS_PATH = "/models";
const MODELS_TIMEOUT_MS = 15_000;

export interface ResponsesOptions {
  /** Provider id used in `"provider/model"` refs. */
  id: string;
  /** API root, e.g. `"https://api.openai.com/v1"`. A trailing slash is fine. */
  baseUrl: string;
  /** API key, sent as `Authorization: Bearer`. */
  apiKey?: string;
  /** OAuth access token, also sent as `Authorization: Bearer`. Wins over `apiKey`. */
  accessToken?: string;
  /** Extra headers merged last (`chatgpt-account-id`, `originator`, …). */
  headers?: Record<string, string>;
  /** Defaults to `/responses`. */
  responsesPath?: string;
  /** Defaults to `/models`. */
  modelsPath?: string;
  /** Extra fields merged into every request body. */
  body?: Record<string, unknown>;
  /** Server-side retention. Defaults to false. */
  store?: boolean;
  /** Ask the server to stream encrypted reasoning (`reasoning.encrypted_content`). */
  includeEncryptedReasoning?: boolean;
  /** Shorthand for `reasoning: { effort }` (`low` … `xhigh`). */
  reasoningEffort?: string;
  /** Defaults to true when tools are present. */
  parallelToolCalls?: boolean;
  /**
   * `"endpoint"` (default) calls `/models`; `"overrides"` returns only
   * `modelInfo`, for backends without a compatible model list.
   */
  modelsMode?: "endpoint" | "overrides";
  /** Static metadata merged over the model list, keyed by wire model id. */
  modelInfo?: Record<string, Partial<ModelInfo>>;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Wire types: only the fields this adapter reads.
// ---------------------------------------------------------------------------

interface WireInputItem {
  type: "message";
  role: "user" | "assistant";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
}

interface WireFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface WireFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

type WireInput = WireInputItem | WireFunctionCallItem | WireFunctionCallOutputItem;

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface WireItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  /** Raw JSON string, not a parsed object. */
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface WireResponse {
  id?: string;
  status?: string;
  output?: WireItem[];
  usage?: WireUsage;
  incomplete_details?: { reason?: string };
  error?: { code?: string; message?: string };
}

interface WireEvent {
  type?: string;
  delta?: string;
  text?: string;
  item_id?: string;
  call_id?: string;
  /** Full argument JSON on `response.function_call_arguments.done`. */
  arguments?: string;
  item?: WireItem;
  response?: WireResponse;
  error?: { code?: string; message?: string };
}

interface PendingCall {
  /** Provider call id, matched against `function_call_output.call_id`. */
  callId?: string;
  name?: string;
  args: string;
}

// ---------------------------------------------------------------------------
// Pure translations.
// ---------------------------------------------------------------------------

function toWireInput(messages: Msg[]): WireInput[] {
  const input: WireInput[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      if (message.content.length === 0) continue;
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.callId,
        output: message.content,
      });
      continue;
    }

    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    // `thinking` blocks are dropped: encrypted reasoning cannot be reconstructed
    // from plain text, and the API rejects unsigned reasoning items.
    if (text.length > 0) {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      });
    }

    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.args ?? {}),
      });
    }
  }

  return input;
}

function toWireTools(tools: StreamRequest["tools"]) {
  return tools.map((tool) => ({
    // Responses flattens the function definition; there is no `function` wrapper.
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
    strict: false,
  }));
}

function mapUsage(usage: WireUsage): Usage {
  const mapped: Usage = {
    inputTokens: usage.input_tokens ?? 0,
    // OpenAI already counts reasoning tokens inside `output_tokens`.
    outputTokens: usage.output_tokens ?? 0,
  };
  const cached = usage.input_tokens_details?.cached_tokens;
  if (cached !== undefined) mapped.cacheReadTokens = cached;
  const written = usage.input_tokens_details?.cache_write_tokens;
  if (written !== undefined) mapped.cacheWriteTokens = written;
  return mapped;
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

function parseEvent(provider: string, data: string): WireEvent {
  try {
    return JSON.parse(data) as WireEvent;
  } catch (error) {
    throw new ProviderError(
      `${provider}: malformed stream event — ${data.slice(0, 200)}`,
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
    // Not JSON: fall back to the raw body.
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
    // Body unreadable; the status is still actionable.
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
  if (signal?.aborted) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(`${provider}: request failed — ${message}`, {
    provider,
    code: "network",
    cause: error,
  });
}

/** Failure codes the backend itself marks as transient. */
const RETRYABLE_CODES = new Set([
  "rate_limit_exceeded",
  "slow_down",
  "server_is_overloaded",
  "internal_error",
]);

function responseFailure(
  provider: string,
  code: string | undefined,
  message: string | undefined,
): ProviderError {
  return new ProviderError(
    `${provider}: ${code ?? "error"}${message ? ` — ${message}` : ""}`,
    {
      provider,
      code: "protocol",
      retryable: code !== undefined && RETRYABLE_CODES.has(code),
    },
  );
}

function incompleteStop(reason: string | undefined): StopReason {
  return reason === "max_output_tokens" ? "length" : "end";
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export function openaiResponses(options: ResponsesOptions): Provider {
  const {
    id,
    baseUrl,
    apiKey,
    accessToken,
    headers = {},
    responsesPath = DEFAULT_RESPONSES_PATH,
    modelsPath = DEFAULT_MODELS_PATH,
    body: extraBody = {},
    store = false,
    includeEncryptedReasoning = false,
    reasoningEffort,
    parallelToolCalls = true,
    modelsMode = "endpoint",
    modelInfo: modelOverrides = {},
    fetch: doFetch = globalThis.fetch,
  } = options;

  const root = baseUrl.replace(/\/+$/, "");
  const endpoint = (path: string): string => `${root}${path}`;

  const token = accessToken ?? apiKey;
  const headersFor = (accept: string): Record<string, string> => ({
    accept,
    "content-type": "application/json",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...headers,
  });

  const listModels = async (): Promise<ModelInfo[]> => {
    if (modelsMode === "overrides") {
      return Object.entries(modelOverrides).map(([modelId, info]) => ({
        ...info,
        id: modelId,
        provider: id,
      }));
    }

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
      return [
        {
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...modelOverrides[modelId],
          id: modelId,
          provider: id,
        },
      ];
    });
  };

  let modelsPromise: Promise<ModelInfo[]> | undefined;

  async function* stream(request: StreamRequest): AsyncGenerator<Event> {
    const { model, system, messages, tools, signal } = request;

    const payload: Record<string, unknown> = {
      model,
      input: toWireInput(messages),
      stream: true,
      store,
      ...(system.trim().length > 0 ? { instructions: system } : {}),
      ...(tools.length > 0
        ? {
            tools: toWireTools(tools),
            tool_choice: "auto",
            parallel_tool_calls: parallelToolCalls,
          }
        : {}),
      ...(includeEncryptedReasoning
        ? { include: ["reasoning.encrypted_content"] }
        : {}),
      ...(reasoningEffort === undefined
        ? {}
        : { reasoning: { effort: reasoningEffort } }),
      ...extraBody,
    };

    let response: Response;
    try {
      response = await doFetch(endpoint(responsesPath), {
        method: "POST",
        headers: headersFor("text/event-stream"),
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

    /** Calls opened by `output_item.added`, keyed by item id (or call id). */
    const pending = new Map<string, PendingCall>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let sawTextDelta = false;
    let emittedCalls = 0;
    let incompleteReason: string | undefined;
    let finished = false;

    const pendingKey = (event: WireEvent): string =>
      event.item?.id ??
      event.item_id ??
      event.call_id ??
      `call_${pending.size}`;

    const pendingFor = (event: WireEvent): PendingCall => {
      const key = pendingKey(event);
      const call = pending.get(key) ?? { args: "" };
      if (event.call_id !== undefined) call.callId = event.call_id;
      if (event.item?.call_id !== undefined) call.callId = event.item.call_id;
      if (event.item?.name !== undefined) call.name = event.item.name;
      pending.set(key, call);
      return call;
    };

    function* emitCall(call: PendingCall): Generator<Event> {
      // A nameless call cannot be dispatched, and dropping it would leave the
      // transcript waiting for a tool result the model expects.
      if (call.name === undefined) {
        throw new ProviderError(`${id}: tool call without a name`, {
          provider: id,
          code: "protocol",
        });
      }
      emittedCalls += 1;
      const callId = call.callId ?? `call_${emittedCalls}`;
      yield {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: callId,
          name: call.name,
          args: parseToolArgs(id, call.args),
        },
      };
    }

    for await (const message of parseSse(response.body)) {
      const data = message.data.trim();
      if (data.length === 0 || data === "[DONE]") continue;

      const event = parseEvent(id, data);
      const type = event.type ?? message.event;

      if (type === "response.failed") {
        const failure = event.response?.error ?? event.error;
        throw responseFailure(id, failure?.code, failure?.message);
      }

      if (type === "error") {
        const failure = event.error;
        throw responseFailure(id, failure?.code, failure?.message);
      }

      switch (type) {
        case "response.output_text.delta":
          if (event.delta !== undefined && event.delta.length > 0) {
            sawTextDelta = true;
            yield { t: "text", delta: event.delta };
          }
          break;

        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta !== undefined && event.delta.length > 0) {
            yield { t: "thinking", delta: event.delta };
          }
          break;

        case "response.output_item.added":
          if (event.item?.type === "function_call") {
            pendingFor(event);
          }
          break;

        case "response.function_call_arguments.delta":
          if (event.delta !== undefined) {
            const call = pendingFor(event);
            call.args += event.delta;
          }
          break;

        case "response.function_call_arguments.done":
          if (event.arguments !== undefined) {
            pendingFor(event).args = event.arguments;
          }
          break;

        case "response.output_item.done": {
          const item = event.item;
          if (item?.type === "function_call" && item.name !== undefined) {
            // The finished item may be keyed by its own id, the item id from the
            // added event, or the call id, depending on the backend.
            const keys = [item.id, event.item_id, item.call_id].filter(
              (key): key is string => typeof key === "string",
            );
            const key = keys.find((candidate) => pending.has(candidate));
            const call =
              (key === undefined ? undefined : pending.get(key)) ?? {
                args: item.arguments ?? "",
                ...(item.call_id === undefined
                  ? {}
                  : { callId: item.call_id }),
                name: item.name,
              };
            if (key !== undefined) pending.delete(key);
            // Some servers only deliver the arguments on the finished item.
            if (item.arguments !== undefined && item.arguments.length > 0) {
              call.args = item.arguments;
            }
            yield* emitCall(call);
          } else if (item?.type === "message" && !sawTextDelta) {
            // Fallback for servers that send only completed message items.
            const text = (item.content ?? [])
              .filter((part) => part.type === "output_text" && part.text)
              .map((part) => part.text)
              .join("");
            if (text.length > 0) yield { t: "text", delta: text };
          }
          break;
        }

        case "response.completed":
        case "response.incomplete": {
          const finishedResponse = event.response;
          if (finishedResponse?.usage !== undefined) {
            usage = mapUsage(finishedResponse.usage);
          }
          if (type === "response.incomplete") {
            incompleteReason = finishedResponse?.incomplete_details?.reason;
            if (incompleteReason === "content_filter") {
              throw new ProviderError(`${id}: response blocked by content filter`, {
                provider: id,
                code: "protocol",
                retryable: false,
              });
            }
          }
          finished = true;
          break;
        }

        default:
          // `response.created`, `response.in_progress`, content-part events and
          // future additions carry nothing this layer needs.
          break;
      }
    }

    // Any call that never got a finished item is still usable.
    for (const call of pending.values()) yield* emitCall(call);

    if (!finished && emittedCalls === 0) {
      throw new ProviderError(`${id}: stream ended before response.completed`, {
        provider: id,
        code: "protocol",
        retryable: true,
      });
    }

    yield {
      t: "done",
      usage,
      stop:
        emittedCalls > 0
          ? "tool"
          : incompleteReason === undefined
            ? "end"
            : incompleteStop(incompleteReason),
    };
  }

  return {
    id,
    models: () => (modelsPromise ??= listModels()),
    stream,
  };
}