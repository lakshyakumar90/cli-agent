/**
 * Unified provider types.
 *
 * Every adapter (OpenAI-compatible, Anthropic, Gemini, …) translates its wire
 * format into these shapes, so nothing above this layer ever imports a vendor
 * SDK. Everything here is plain JSON, which is what makes sessions saveable
 * and replayable in Phase 6.
 */

/** Token counts and cost for a single model response. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  cacheReadTokens?: number;
  /** Tokens written to the provider's prompt cache, when reported. */
  cacheWriteTokens?: number;
  /** Total cost in USD, when the model table has pricing for this model. */
  costUSD?: number;
}

/**
 * A JSON Schema describing a tool's argument object.
 * Permissive on purpose: adapters pass it straight through to the provider.
 */
export type JSONSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema | JSONSchema[];
  enum?: unknown[];
  additionalProperties?: boolean | JSONSchema;
  default?: unknown;
  [keyword: string]: unknown;
};

/** A tool as advertised to the model. The executable side lives in @cli-agent/tools. */
export interface ToolSpec {
  name: string;
  description: string;
  schema: JSONSchema;
}

/** Model metadata, used by the registry, the model picker and Phase 5 budgets. */
export interface ModelInfo {
  /** Wire id sent to the provider, e.g. "claude-sonnet-4-5". */
  id: string;
  /** Provider id serving this model, e.g. "anthropic". */
  provider: string;
  /** Human label for the model picker. */
  name?: string;
  contextWindow: number;
  maxOutputTokens?: number;
  /** USD per 1M tokens. */
  pricing?: { input: number; output: number };
  supports?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
}

/** One piece of an assistant turn. */
export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id: string; name: string; args: any };

export type ToolCall = Extract<Block, { type: "toolCall" }>;

/**
 * A conversation message.
 * `tool` messages reference the `toolCall` id they answer, so the transcript
 * stays valid for providers that require a result per call.
 */
export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: Block[]; usage?: Usage }
  | { role: "tool"; callId: string; content: string; isError?: boolean };

/** Why the model stopped generating. */
export type StopReason = "end" | "tool" | "length";

/** Streaming events emitted by every provider adapter. */
export type Event =
  | { t: "text"; delta: string }
  | { t: "thinking"; delta: string }
  | { t: "toolCall"; call: ToolCall }
  | { t: "done"; usage: Usage; stop: StopReason };

/** Arguments shared by every `Provider.stream` implementation. */
export interface StreamRequest {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

/**
 * The only surface the agent loop knows about.
 * Implementations must stream — never buffer a full response.
 */
export interface Provider {
  /** Stable id used in "provider/model" refs, e.g. "anthropic". */
  id: string;
  models(): Promise<ModelInfo[]>;
  stream(req: StreamRequest): AsyncIterable<Event>;
}