/**
 * Anthropic provider (`POST {baseUrl}/messages`, SSE).
 *
 * Anthropic's wire format differs from OpenAI's in ways this adapter hides:
 * - content is a list of typed blocks, not a message string;
 * - tool results are `user` messages containing `tool_result` blocks, and all
 *   results answering one assistant turn must share a single user message;
 * - `max_tokens` is mandatory;
 * - auth is `x-api-key` (or a bearer token for OAuth-style sign-ins).
 *
 * Streaming is a sequence of named events: `message_start`, `content_block_*`,
 * `message_delta`, `message_stop`, plus `ping` and `error`.
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
  ToolSpec,
  Usage,
} from "../types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MESSAGES_PATH = "/messages";
const DEFAULT_MODELS_PATH = "/models";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8_192;
const MODELS_TIMEOUT_MS = 15_000;
const MAX_MODEL_PAGES = 10;

export interface AnthropicOptions {
  /** Provider id used in `"provider/model"` refs. Defaults to `"anthropic"`. */
  id?: string;
  /** API root. Defaults to `"https://api.anthropic.com/v1"`. */
  baseUrl?: string;
  /** Sent as `x-api-key`, or as a bearer token when `auth` is `"bearer"`. */
  apiKey?: string;
  /**
   * `"x-api-key"` (default) for API keys, `"bearer"` for OAuth access tokens
   * handed out by subscription logins.
   */
  auth?: "x-api-key" | "bearer";
  /** Defaults to `"2023-06-01"`. */
  anthropicVersion?: string;
  /** Extra headers merged last (e.g. `anthropic-beta`). */
  headers?: Record<string, string>;
  /** Required by the API. Defaults to 8192; override per model if needed. */
  maxTokens?: number;
  /** Defaults to `/messages`. */
  messagesPath?: string;
  /** Defaults to `/models`. */
  modelsPath?: string;
  /** Extra fields merged into every request body (`thinking`, `temperature`, …). */
  body?: Record<string, unknown>;
  /** Static metadata merged over `/models` results, keyed by model id. */
  modelInfo?: Record<string, Partial<ModelInfo>>;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Wire types: only the fields this adapter reads.
// ---------------------------------------------------------------------------

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface WireContentBlockStart {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

interface WireDelta {
  type?: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
  signature?: string;
  stop_reason?: string | null;
}

interface WireStreamEvent {
  type?: string;
  index?: number;
  message?: { usage?: WireUsage };
  content_block?: WireContentBlockStart;
  delta?: WireDelta;
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

type WireContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface WireMessage {
  role: "user" | "assistant";
  content: WireContentBlock[];
}

interface PendingToolUse {
  id?: string;
  name?: string;
  /** Verbatim `input_json_delta` fragments, concatenated. */
  json: string;
  /** Fallback for servers that send the full input in `content_block_start`. */
  initial?: unknown;
}

// ---------------------------------------------------------------------------
// Pure translations.
// ---------------------------------------------------------------------------

/**
 * Convert the unified transcript into Anthropic messages.
 *
 * Consecutive user-side turns are merged so that parallel tool results land in
 * one message, which the API requires (a `tool_result` must directly answer an
 * assistant `tool_use`). Thinking blocks are dropped: replaying them correctly
 * requires their signatures, which the unified `Block` does not carry yet.
 */
function toWireMessages(messages: Msg[]): WireMessage[] {
  const wire: WireMessage[] = [];

  const push = (message: WireMessage): void => {
    const last = wire[wire.length - 1];
    if (last?.role === "user" && message.role === "user") {
      last.content.push(...message.content);
      return;
    }
    wire.push(message);
  };

  for (const message of messages) {
    if (message.role === "user") {
      if (message.content.length === 0) continue;
      push({ role: "user", content: [{ type: "text", text: message.content }] });
      continue;
    }

    if (message.role === "tool") {
      push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.callId,
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }

    const content: WireContentBlock[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) content.push({ type: "text", text: block.text });
      } else if (block.type === "toolCall") {
        content.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.args ?? {},
        });
      }
    }

    // The API rejects empty assistant content arrays.
    if (content.length > 0) push({ role: "assistant", content });
  }

  return wire;
}

function toWireTools(tools: ToolSpec[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema,
  }));
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool";
    case "max_tokens":
      return "length";
    default:
      // "end_turn", "stop_sequence", "refusal", "pause_turn", and unknown values.
      return "end";
  }
}

function parseEvent(provider: string, data: string): WireStreamEvent {
  try {
    return JSON.parse(data) as WireStreamEvent;
  } catch (error) {
    throw new ProviderError(
      `${provider}: malformed stream event — ${data.slice(0, 200)}`,
      { provider, code: "protocol", cause: error },
    );
  }
}

function parseToolInput(provider: string, tool: PendingToolUse): unknown {
  const json = tool.json.trim();
  if (json.length === 0) return tool.initial ?? {};
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new ProviderError(
      `${provider}: malformed tool input — ${json.slice(0, 200)}`,
      { provider, code: "protocol", cause: error },
    );
  }
}

function streamError(
  provider: string,
  error: WireStreamEvent["error"],
): ProviderError {
  const type = error?.type ?? "api_error";
  const retryable =
    type === "overloaded_error" ||
    type === "rate_limit_error" ||
    type === "api_error";
  return new ProviderError(
    `${provider}: ${type}${error?.message ? ` — ${error.message}` : ""}`,
    { provider, code: "protocol", retryable },
  );
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

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

export function anthropic(options: AnthropicOptions = {}): Provider {
  const {
    id = "anthropic",
    baseUrl = DEFAULT_BASE_URL,
    apiKey,
    auth = "x-api-key",
    anthropicVersion = DEFAULT_ANTHROPIC_VERSION,
    headers = {},
    maxTokens = DEFAULT_MAX_TOKENS,
    messagesPath = DEFAULT_MESSAGES_PATH,
    modelsPath = DEFAULT_MODELS_PATH,
    body: extraBody = {},
    modelInfo: modelOverrides = {},
    fetch: doFetch = globalThis.fetch,
  } = options;

  const endpoint = (path: string): string =>
    `${baseUrl.replace(/\/+$/, "")}${path}`;

  const headersFor = (accept: string): Record<string, string> => ({
    accept,
    "content-type": "application/json",
    "anthropic-version": anthropicVersion,
    ...(apiKey
      ? auth === "bearer"
        ? { authorization: `Bearer ${apiKey}` }
        : { "x-api-key": apiKey }
      : {}),
    ...headers,
  });

  const listModels = async (): Promise<ModelInfo[]> => {
    const models: ModelInfo[] = [];
    let afterId: string | undefined;

    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const path = afterId
        ? `${modelsPath}?after_id=${encodeURIComponent(afterId)}`
        : modelsPath;

      let response: Response;
      try {
        response = await doFetch(endpoint(path), {
          headers: headersFor("application/json"),
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
      } catch (error) {
        throw networkError(id, error);
      }

      if (!response.ok) throw await httpError(id, response);

      const payload = (await response.json()) as {
        data?: Array<Record<string, unknown>>;
        has_more?: boolean;
        last_id?: string | null;
      };
      const entries = Array.isArray(payload.data) ? payload.data : [];

      for (const entry of entries) {
        const modelId = typeof entry.id === "string" ? entry.id : undefined;
        if (!modelId) continue;

        const merged: ModelInfo = {
          ...(typeof entry.display_name === "string"
            ? { name: entry.display_name }
            : {}),
          ...modelOverrides[modelId],
          // Identity stays authoritative whatever the override says.
          id: modelId,
          provider: id,
        };
        models.push(merged);
      }

      if (!payload.has_more || typeof payload.last_id !== "string") break;
      afterId = payload.last_id;
    }

    return models;
  };

  let modelsPromise: Promise<ModelInfo[]> | undefined;

  async function* stream(request: StreamRequest): AsyncGenerator<Event> {
    const { model, system, messages, tools, signal } = request;

    const payload: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages: toWireMessages(messages),
      stream: true,
      ...(system.trim().length > 0 ? { system } : {}),
      ...(tools.length > 0 ? { tools: toWireTools(tools) } : {}),
      ...extraBody,
    };

    let response: Response;
    try {
      response = await doFetch(endpoint(messagesPath), {
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

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    const applyUsage = (wire: WireUsage | undefined): void => {
      if (!wire) return;
      if (wire.input_tokens !== undefined) usage.inputTokens = wire.input_tokens;
      if (wire.output_tokens !== undefined) {
        usage.outputTokens = wire.output_tokens;
      }
      if (wire.cache_read_input_tokens !== undefined) {
        usage.cacheReadTokens = wire.cache_read_input_tokens;
      }
      if (wire.cache_creation_input_tokens !== undefined) {
        usage.cacheWriteTokens = wire.cache_creation_input_tokens;
      }
    };

    const toolUses = new Map<number, PendingToolUse>();
    let reportedStop: StopReason | undefined;

    for await (const message of parseSse(response.body)) {
      if (message.data.trim().length === 0) continue;

      const event = parseEvent(id, message.data);
      const type = event.type ?? message.event;

      switch (type) {
        case "message_start":
          applyUsage(event.message?.usage);
          break;

        case "content_block_start": {
          const index = event.index ?? 0;
          const block = event.content_block;
          if (block?.type === "tool_use") {
            toolUses.set(index, {
              ...(block.id === undefined ? {} : { id: block.id }),
              ...(block.name === undefined ? {} : { name: block.name }),
              json: "",
              ...(block.input === undefined ? {} : { initial: block.input }),
            });
          } else if (block?.type === "text" && block.text) {
            // Some proxies deliver a whole block up front instead of deltas.
            yield { t: "text", delta: block.text };
          }
          break;
        }

        case "content_block_delta": {
          const delta = event.delta;
          if (!delta) break;

          if (delta.type === "text_delta" && delta.text) {
            yield { t: "text", delta: delta.text };
          } else if (delta.type === "thinking_delta" && delta.thinking) {
            yield { t: "thinking", delta: delta.thinking };
          } else if (delta.type === "input_json_delta") {
            const index = event.index ?? 0;
            const tool = toolUses.get(index) ?? { json: "" };
            tool.json += delta.partial_json ?? "";
            toolUses.set(index, tool);
          }
          // `signature_delta` and `citations_delta` carry nothing actionable yet.
          break;
        }

        case "content_block_stop": {
          const index = event.index ?? 0;
          const tool = toolUses.get(index);
          if (tool?.name) {
            toolUses.delete(index);
            yield {
              t: "toolCall",
              call: {
                type: "toolCall",
                id: tool.id ?? `tool_${index}`,
                name: tool.name,
                args: parseToolInput(id, tool),
              },
            };
          }
          break;
        }

        case "message_delta":
          if (event.delta?.stop_reason) {
            reportedStop = mapStopReason(event.delta.stop_reason);
          }
          applyUsage(event.usage);
          break;

        case "message_stop":
        case "ping":
          break;

        case "error":
          throw streamError(id, event.error);

        default:
          // Unknown event types are ignored so new API additions do not break runs.
          break;
      }
    }

    let emitted = 0;
    for (const tool of toolUses.values()) {
      if (!tool.name) continue;
      emitted += 1;
      yield {
        t: "toolCall",
        call: {
          type: "toolCall",
          id: tool.id ?? `tool_${emitted}`,
          name: tool.name,
          args: parseToolInput(id, tool),
        },
      };
    }

    yield {
      t: "done",
      usage,
      // Some proxies report end_turn despite emitting tool calls.
      stop: emitted > 0 ? "tool" : (reportedStop ?? "end"),
    };
  }

  return {
    id,
    models: () => (modelsPromise ??= listModels()),
    stream,
  };
}