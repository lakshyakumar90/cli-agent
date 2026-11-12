/**
 * Google Gemini provider.
 *
 * Speaks `streamGenerateContent` over SSE — the wire format shared by the
 * Gemini API and the Antigravity / Gemini CLI backend in ./antigravity.ts, so
 * both share this one implementation.
 *
 * What this adapter hides:
 * - roles are `user` / `model`, not `assistant`;
 * - content is a list of typed `parts` (text, thought, functionCall,
 *   functionResponse) rather than a message string;
 * - tool results are `functionResponse` parts in a `user` turn, keyed by
 *   function *name*, while the unified transcript keys them by call id;
 * - `system` lives in `systemInstruction`, not in the message list;
 * - Gemini 3 models return thought signatures (`thoughtSignature`) that must be
 *   replayed verbatim with the tool call on the next turn.
 */

import { ProviderError } from "../errors.js";
import { parseSse } from "../sse.js";
import type {
  Event,
  JSONSchema,
  ModelInfo,
  Msg,
  Provider,
  StopReason,
  StreamRequest,
  ToolSpec,
  Usage,
} from "../types.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MODELS_TIMEOUT_MS = 15_000;
const MAX_MODEL_PAGES = 10;
const MODELS_PAGE_SIZE = 200;

/** Which dialect of the Gemini wire format the endpoint speaks. */
export type GeminiWire =
  /** Public API: `POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse`. */
  | "gemini"
  /**
   * Cloud Code Assist (Antigravity / Gemini CLI): the model travels in the body
   * and the response chunks arrive wrapped in `{ response: … }`.
   */
  | "cloudcode";

export interface GeminiOptions {
  /** Provider id used in `"provider/model"` refs. Defaults to `"gemini"`. */
  id?: string;
  /** API root. Defaults to `"https://generativelanguage.googleapis.com/v1beta"`. */
  baseUrl?: string;
  /** API key, sent as `x-goog-api-key` (default) or as a `key` query param. */
  apiKey?: string;
  /** OAuth access token, sent as `Authorization: Bearer` when `auth` is `"bearer"`. */
  accessToken?: string;
  /**
   * `"header"` (default) sends `x-goog-api-key`, `"query"` sends `?key=`,
   * `"bearer"` sends an OAuth token. Proxies that only accept one form differ;
   * all three are supported.
   */
  auth?: "header" | "query" | "bearer";
  /** Extra headers merged last. */
  headers?: Record<string, string>;
  /** Merged into `generationConfig` (`temperature`, `thinkingConfig`, …). */
  generation?: Record<string, unknown>;
  /** Sent verbatim as `safetySettings`. */
  safetySettings?: Array<Record<string, unknown>>;
  /** Cloud Code Assist only: the Google Cloud project id. */
  project?: string;
  /** Extra fields merged at the top level of the inner request body. */
  body?: Record<string, unknown>;
  /** Static metadata merged over `/models` results, keyed by model id. */
  modelInfo?: Record<string, Partial<ModelInfo>>;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** Options for {@link createGeminiProvider}, which also picks the wire dialect. */
export interface GeminiProviderOptions extends GeminiOptions {
  wire?: GeminiWire;
}

// ---------------------------------------------------------------------------
// Wire types: only the fields this adapter reads.
// ---------------------------------------------------------------------------

interface WirePart {
  text?: string;
  /** `true` on internal reasoning parts. */
  thought?: boolean;
  /** Opaque, must be echoed back with the same part. */
  thoughtSignature?: string;
  functionCall?: { name?: string; args?: unknown };
  functionResponse?: { name?: string; response?: unknown };
}

interface WireUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface WireResponse {
  candidates?: Array<{
    content?: { role?: string; parts?: WirePart[] };
    finishReason?: string;
  }>;
  usageMetadata?: WireUsageMetadata;
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  error?: { code?: number; message?: string; status?: string };
  /** Cloud Code Assist wraps every chunk in `{ response: … }`. */
  response?: WireResponse;
}

/** A `contents` entry this adapter builds. */
interface OutgoingContent {
  role: "user" | "model";
  parts: WirePart[];
}

// ---------------------------------------------------------------------------
// Pure translations.
// ---------------------------------------------------------------------------

/** JSON Schema keywords Gemini's OpenAPI-style subset rejects. */
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "additionalProperties",
]);

/**
 * Strip keywords Gemini rejects, recursively.
 *
 * `properties` is special-cased: its keys are user-chosen property names, so a
 * property literally called `additionalProperties` must survive.
 */
function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(source)) {
    if (key === "properties" && child !== null && typeof child === "object") {
      const properties: Record<string, unknown> = {};
      for (const [name, schema] of Object.entries(
        child as Record<string, unknown>,
      )) {
        properties[name] = cleanSchema(schema);
      }
      result[key] = properties;
      continue;
    }
    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    result[key] = cleanSchema(child);
  }

  return result;
}

function toWireTools(tools: ToolSpec[]) {
  return tools.map((tool) => {
    const schema = cleanSchema(tool.schema) as Record<string, unknown>;
    return {
      name: tool.name,
      description: tool.description,
      // A parameterless tool must omit `parameters` entirely.
      ...(Object.keys(schema).length > 0 ? { parameters: schema } : {}),
    };
  });
}

/**
 * Convert the unified transcript into Gemini `contents`.
 *
 * Consecutive same-role entries are merged into one content, which Gemini
 * requires: parallel tool results must share a single `user` turn. Thinking
 * blocks are only replayed when signed, because unsigned thoughts are rejected
 * by Gemini 3 models.
 */
function toWireContents(messages: Msg[]): OutgoingContent[] {
  const contents: OutgoingContent[] = [];
  /** Call id → function name, needed because `functionResponse` is keyed by name. */
  const toolNames = new Map<string, string>();

  const push = (role: OutgoingContent["role"], parts: WirePart[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last?.role === role) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const message of messages) {
    if (message.role === "user") {
      if (message.content.length === 0) continue;
      push("user", [{ text: message.content }]);
      continue;
    }

    if (message.role === "tool") {
      push("user", [
        {
          functionResponse: {
            name: toolNames.get(message.callId) ?? message.callId,
            response: message.isError
              ? { error: message.content }
              : { result: message.content },
          },
        },
      ]);
      continue;
    }

    const parts: WirePart[] = [];
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.length > 0) parts.push({ text: block.text });
        continue;
      }

      if (block.type === "thinking") {
        if (block.signature !== undefined) {
          parts.push({
            text: block.text,
            thought: true,
            thoughtSignature: block.signature,
          });
        }
        continue;
      }

      toolNames.set(block.id, block.name);
      parts.push({
        functionCall: { name: block.name, args: block.args ?? {} },
        ...(block.signature === undefined
          ? {}
          : { thoughtSignature: block.signature }),
      });
    }

    push("model", parts);
  }

  return contents;
}

function mapFinishReason(reason: string): StopReason {
  return reason === "MAX_TOKENS" ? "length" : "end";
}

/** Finish reasons that mean the model produced nothing usable. */
const FATAL_FINISH_REASONS: Record<string, string> = {
  SAFETY: "response blocked by safety filters",
  RECITATION: "response blocked for recitation",
  BLOCKLIST: "response blocked by the blocklist filter",
  PROHIBITED_CONTENT: "response blocked for prohibited content",
  SPII: "response blocked for sensitive personal information",
  MALFORMED_FUNCTION_CALL: "model produced a malformed tool call",
};

function parseChunk(provider: string, data: string): WireResponse {
  try {
    return JSON.parse(data) as WireResponse;
  } catch (error) {
    throw new ProviderError(
      `${provider}: malformed stream chunk — ${data.slice(0, 200)}`,
      { provider, code: "protocol", cause: error },
    );
  }
}

/** Cloud Code Assist nests the real payload one level down. */
function unwrap(payload: WireResponse): WireResponse {
  const inner = payload.response;
  return inner !== null && typeof inner === "object" ? inner : payload;
}

function chunkError(
  provider: string,
  error: NonNullable<WireResponse["error"]>,
): ProviderError {
  const status = error.code;
  return new ProviderError(
    `${provider}: ${error.status ?? "error"}${error.message ? ` — ${error.message}` : ""}`,
    {
      provider,
      code: "protocol",
      retryable: status === 429 || (status ?? 0) >= 500,
    },
  );
}

function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (text.length === 0) return "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") {
      return parsed.error.message.slice(0, 500);
    }
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

function appendQuery(url: string, query: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Shared implementation for the public Gemini API and Cloud Code Assist.
 * `antigravity()` is just a preset of this function.
 */
export function createGeminiProvider(
  options: GeminiProviderOptions = {},
): Provider {
  const {
    wire = "gemini",
    id = wire === "cloudcode" ? "antigravity" : "gemini",
    baseUrl = DEFAULT_BASE_URL,
    apiKey,
    accessToken,
    auth = wire === "cloudcode" ? "bearer" : "header",
    headers = {},
    generation = {},
    safetySettings,
    project,
    body: extraBody = {},
    modelInfo: modelOverrides = {},
    fetch: doFetch = globalThis.fetch,
  } = options;

  const root = baseUrl.replace(/\/+$/, "");

  const headersFor = (accept: string): Record<string, string> => ({
    accept,
    "content-type": "application/json",
    ...(auth === "header" && apiKey !== undefined
      ? { "x-goog-api-key": apiKey }
      : {}),
    ...(auth === "bearer" && accessToken !== undefined
      ? { authorization: `Bearer ${accessToken}` }
      : {}),
    ...headers,
  });

  /** Attach the API key as a query param when the endpoint expects it there. */
  const withQueryAuth = (url: string): string =>
    auth === "query" && apiKey !== undefined
      ? appendQuery(url, `key=${encodeURIComponent(apiKey)}`)
      : url;

  const streamUrl = (model: string): string => {
    const path =
      wire === "cloudcode"
        ? `${root}:streamGenerateContent`
        : `${root}/models/${encodeURIComponent(model)}:streamGenerateContent`;
    return withQueryAuth(appendQuery(path, "alt=sse"));
  };

  const toModelInfo = (
    modelId: string,
    entry: Record<string, unknown>,
  ): ModelInfo => {
    const name = readString(entry.displayName) ?? readString(entry.name);
    const contextWindow =
      readNumber(entry.inputTokenLimit) ??
      readNumber(entry.contextWindow) ??
      readNumber(entry.maxTokens);
    const maxOutputTokens =
      readNumber(entry.outputTokenLimit) ?? readNumber(entry.maxOutputTokens);
    return {
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...modelOverrides[modelId],
      id: modelId,
      provider: id,
    };
  };

  async function listModels(): Promise<ModelInfo[]> {
    if (wire === "cloudcode") {
      let response: Response;
      try {
        response = await doFetch(`${root}:fetchAvailableModels`, {
          method: "POST",
          headers: headersFor("application/json"),
          body: JSON.stringify(project === undefined ? {} : { project }),
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
      } catch (error) {
        throw networkError(id, error);
      }
      if (!response.ok) throw await httpError(id, response);

      const payload = (await response.json()) as {
        models?: unknown;
      };
      const entries = new Map<string, Record<string, unknown>>();

      if (Array.isArray(payload.models)) {
        for (const entry of payload.models) {
          if (entry === null || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          const key = readString(record.id) ?? readString(record.name);
          if (key) entries.set(key, record);
        }
      } else if (payload.models !== null && typeof payload.models === "object") {
        for (const [key, entry] of Object.entries(
          payload.models as Record<string, unknown>,
        )) {
          if (entry !== null && typeof entry === "object") {
            entries.set(key, entry as Record<string, unknown>);
          }
        }
      }

      return [...entries].map(([modelId, entry]) =>
        toModelInfo(modelId.replace(/^models\//, ""), entry),
      );
    }

    const models: ModelInfo[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const query =
        `pageSize=${MODELS_PAGE_SIZE}` +
        (pageToken === undefined
          ? ""
          : `&pageToken=${encodeURIComponent(pageToken)}`);

      let response: Response;
      try {
        response = await doFetch(withQueryAuth(appendQuery(`${root}/models`, query)), {
          headers: headersFor("application/json"),
          signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
        });
      } catch (error) {
        throw networkError(id, error);
      }
      if (!response.ok) throw await httpError(id, response);

      const payload = (await response.json()) as {
        models?: Array<Record<string, unknown>>;
        nextPageToken?: string;
      };
      const entries = Array.isArray(payload.models) ? payload.models : [];

      for (const entry of entries) {
        const wireName = readString(entry.name);
        if (!wireName) continue;
        // Embedding and image models cannot drive a chat turn.
        const methods = entry.supportedGenerationMethods;
        if (
          Array.isArray(methods) &&
          !methods.includes("generateContent")
        ) {
          continue;
        }
        models.push(toModelInfo(wireName.replace(/^models\//, ""), entry));
      }

      if (payload.nextPageToken === undefined) break;
      pageToken = payload.nextPageToken;
    }

    return models;
  }

  let modelsPromise: Promise<ModelInfo[]> | undefined;

  async function* stream(request: StreamRequest): AsyncGenerator<Event> {
    const { model, system, messages, tools, signal } = request;

    const inner: Record<string, unknown> = {
      contents: toWireContents(messages),
      ...(system.trim().length > 0
        ? { systemInstruction: { parts: [{ text: system }] } }
        : {}),
      ...(tools.length > 0
        ? { tools: [{ functionDeclarations: toWireTools(tools) }] }
        : {}),
      ...(Object.keys(generation).length > 0
        ? { generationConfig: generation }
        : {}),
      ...(safetySettings === undefined ? {} : { safetySettings }),
      ...extraBody,
    };

    const payload =
      wire === "cloudcode"
        ? {
            model,
            ...(project === undefined ? {} : { project }),
            request: inner,
          }
        : inner;

    let response: Response;
    try {
      response = await doFetch(streamUrl(model), {
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
    const applyUsage = (metadata: WireUsageMetadata | undefined): void => {
      if (!metadata) return;
      if (metadata.promptTokenCount !== undefined) {
        usage.inputTokens = metadata.promptTokenCount;
      }
      if (
        metadata.candidatesTokenCount !== undefined ||
        metadata.thoughtsTokenCount !== undefined
      ) {
        // Thinking tokens are billed as output, so they belong in the total.
        usage.outputTokens =
          (metadata.candidatesTokenCount ?? 0) +
          (metadata.thoughtsTokenCount ?? 0);
      }
      if (metadata.cachedContentTokenCount !== undefined) {
        usage.cacheReadTokens = metadata.cachedContentTokenCount;
      }
    };

    let finishReason: string | undefined;
    let calls = 0;

    for await (const message of parseSse(response.body)) {
      const data = message.data.trim();
      if (data.length === 0 || data === "[DONE]") continue;

      const chunk = unwrap(parseChunk(id, data));

      if (chunk.error !== undefined) throw chunkError(id, chunk.error);

      const blockReason = chunk.promptFeedback?.blockReason;
      if (blockReason !== undefined) {
        const detail = chunk.promptFeedback?.blockReasonMessage;
        throw new ProviderError(
          `${id}: prompt blocked — ${blockReason}${detail ? ` — ${detail}` : ""}`,
          { provider: id, code: "protocol", retryable: false },
        );
      }

      applyUsage(chunk.usageMetadata);

      for (const candidate of chunk.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall?.name !== undefined) {
            calls += 1;
            yield {
              t: "toolCall",
              call: {
                type: "toolCall",
                // Gemini has no call ids; synthesise stable-enough ones so tool
                // results can be matched back by the loop.
                id: `call_${calls}`,
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
                ...(part.thoughtSignature === undefined
                  ? {}
                  : { signature: part.thoughtSignature }),
              },
            };
            continue;
          }

          if (part.text !== undefined) {
            if (part.thought === true) {
              yield {
                t: "thinking",
                delta: part.text,
                ...(part.thoughtSignature === undefined
                  ? {}
                  : { signature: part.thoughtSignature }),
              };
            } else {
              yield { t: "text", delta: part.text };
            }
            continue;
          }

          // A signature can arrive on its own part, after the thought it signs.
          if (part.thoughtSignature !== undefined) {
            yield {
              t: "thinking",
              delta: "",
              signature: part.thoughtSignature,
            };
          }
        }

        if (candidate.finishReason !== undefined) {
          finishReason = candidate.finishReason;
        }
      }
    }

    if (finishReason !== undefined) {
      const fatal = FATAL_FINISH_REASONS[finishReason];
      if (fatal !== undefined) {
        throw new ProviderError(`${id}: ${fatal}`, {
          provider: id,
          code: "protocol",
          retryable: false,
        });
      }
    }

    yield {
      t: "done",
      usage,
      stop:
        calls > 0
          ? "tool"
          : finishReason === undefined
            ? "end"
            : mapFinishReason(finishReason),
    };
  }

  return {
    id,
    models: () => (modelsPromise ??= listModels()),
    stream,
  };
}

/** The public Gemini API, authenticated with an API key. */
export function gemini(options: GeminiOptions = {}): Provider {
  return createGeminiProvider({ ...options, wire: "gemini" });
}