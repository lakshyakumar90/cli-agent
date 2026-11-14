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

/** USD per 1M tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Prompt-cache reads. Falls back to the input rate when unknown. */
  cacheRead?: number;
  /** Prompt-cache writes. Falls back to the input rate when unknown. */
  cacheWrite?: number;
}

/**
 * A price that applies to some requests only: a long-context rate, or a
 * promotional price that ends on a date.
 *
 * Tiers are matched in order — the first one that fits wins — so put the
 * narrowest tier first.
 */
export interface PricingTier {
  /** Applies when the request's input is at most this many tokens. */
  maxInputTokens?: number;
  /** Applies from this date (inclusive), `YYYY-MM-DD`. */
  from?: string;
  /** Applies until this date (inclusive), `YYYY-MM-DD`. */
  until?: string;
  pricing: ModelPricing;
}

/** Model metadata, used by the registry, the model picker and Phase 5 budgets. */
export interface ModelInfo {
  /** Wire id sent to the provider, e.g. "claude-sonnet-4-5". */
  id: string;
  /** Provider id serving this model, e.g. "anthropic". */
  provider: string;
  /** Human label for the model picker. */
  name?: string;
  /** Context window in tokens. Optional: many OpenAI-compatible servers advertise only ids. */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** USD per 1M tokens. */
  pricing?: ModelPricing;
  /** Prices that apply to some requests only (long context, promotions). */
  pricingTiers?: PricingTier[];
  supports?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  /**
   * How the provider counts cached tokens in `Usage.inputTokens`:
   * - `"included"` (default): the prompt total, with the cache counts as
   *   subsets of it — OpenAI, Gemini and Codex report it this way;
   * - `"excluded"`: only uncached input — Anthropic reports it this way.
   */
  cachedTokens?: "included" | "excluded";
  /** The vendor has deprecated the model; it may be removed without notice. */
  deprecated?: boolean;
  /** Free-form note, e.g. a promotional price that ends on a date. */
  note?: string;
}

/** One piece of an assistant turn. */
export type Block =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      text: string;
      /**
       * Provider-issued proof of this thought (Anthropic `signature_delta`,
       * Gemini `thoughtSignature`). Providers that require signed reasoning
       * reject a replay that drops it, so it travels with the block.
       */
      signature?: string;
      /**
       * Opaque payload for a thought the provider refuses to show (Anthropic
       * `redacted_thinking`). It must be echoed back verbatim, but has no text.
       */
      redacted?: string;
    }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: any;
      /** Signature of the call's part, when the provider sends one. */
      signature?: string;
    };

export type ToolCall = Extract<Block, { type: "toolCall" }>;

/**
 * A conversation message.
 * `tool` messages reference the `toolCall` id they answer, so the transcript
 * stays valid for providers that require a result per call.
 */
export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: Block[]; usage?: Usage }
  | {
      role: "tool";
      callId: string;
      content: string;
      isError?: boolean;
      /**
       * Keep this result in the context.
       *
       * A skill's instructions are still needed long after the tool that
       * loaded them has been forgotten.
       */
      keep?: boolean;
    };

/** Why the model stopped generating. */
export type StopReason = "end" | "tool" | "length";

/** Streaming events emitted by every provider adapter. */
export type Event =
  | { t: "text"; delta: string }
  | {
      t: "thinking";
      delta: string;
      /**
       * A signature arriving with (or just after) a thinking delta. It may come
       * on its own, with `delta` empty, in which case it belongs to the
       * thinking block the loop just built.
       */
      signature?: string;
      /** Payload of a provider-redacted thought; echo it back on replay. */
      redacted?: string;
    }
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