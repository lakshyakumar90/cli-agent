/**
 * The model table.
 *
 * One place that knows what each model costs and what it can do, so later
 * phases can budget tokens and pick a model without hard-coding vendor
 * knowledge. Prices are per **million** tokens, in USD.
 *
 * The numbers here were read from the vendors' own pricing and model pages
 * (see the source note on each group). They are a snapshot: vendors change
 * prices, and promotional rates expire, so entries carry the dates those
 * rates apply to. Anything not published is left out rather than guessed.
 *
 * Keys are `"vendor/model"`. `lookupModel` also accepts a provider id, so a
 * provider that fronts another vendor's models (`opencode` serving OpenAI
 * models, `antigravity` serving Gemini models) still finds the right entry.
 */

import type {
  ModelInfo,
  ModelPricing,
  PricingTier,
  Usage,
} from "./types.js";

/** A table row: everything about a model except its id and provider. */
export type ModelEntry = Omit<Partial<ModelInfo>, "id" | "provider">;

/**
 * Which vendor a provider id usually serves. Used only as a fallback when a
 * provider has no entry of its own for a model id.
 */
export const PROVIDER_FAMILY: Record<string, string> = {
  opencode: "openai",
  antigravity: "gemini",
  lmstudio: "openai",
  vllm: "openai",
  ollama: "openai",
};

/**
 * Known models, keyed by `"vendor/model"`.
 *
 * Sources (read 2026-11-12):
 * - Anthropic: platform.claude.com/docs/en/models/overview and
 *   platform.claude.com/docs/en/about-claude/pricing
 * - OpenAI: platform.openai.com/docs/models/<model> and
 *   platform.openai.com/docs/pricing
 * - Google: ai.google.dev/gemini-api/docs/models and
 *   ai.google.dev/gemini-api/docs/pricing
 */
export const MODEL_TABLE: Record<string, ModelEntry> = {
  // -------------------------------------------------------------------------
  // Anthropic. 1M-token context and 128K max output on the current lineup;
  // prompt-cache reads are 5% of the input rate (2.5% on Fable) and a 5-minute
  // cache write costs 1.25x the input rate.
  // -------------------------------------------------------------------------
  "anthropic/claude-fable-5-2": {
    name: "Claude Fable 5.2",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
  },
  "anthropic/claude-opus-5-5": {
    name: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
  },
  "anthropic/claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
  },
  "anthropic/claude-haiku-5-5": {
    name: "Claude Haiku 5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    // Priced by prompt length: over 100K input tokens costs more, and the
    // whole request is billed at the higher rate.
    pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    pricingTiers: [
      {
        maxInputTokens: 100_000,
        pricing: {
          input: 0.1,
          output: 0.5,
          cacheRead: 0.01,
          cacheWrite: 0.125,
        },
      },
      {
        pricing: {
          input: 0.5,
          output: 2.5,
          cacheRead: 0.05,
          cacheWrite: 0.625,
        },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
  },
  "anthropic/claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
  },
  "anthropic/claude-sonnet-4-5": {
    name: "Claude Sonnet 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
    deprecated: true,
    note: "Retires from the Claude API on 2026-11-30; use claude-sonnet-5-5.",
  },
  "anthropic/claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    supports: { tools: true, vision: true, reasoning: true },
    cachedTokens: "excluded",
  },

  // -------------------------------------------------------------------------
  // OpenAI. 1,050,000-token context, 128K max output. Prompts over 272K
  // input tokens are billed at 2x the input rate and 1.5x the output rate.
  // -------------------------------------------------------------------------
  "openai/gpt-6-astra": {
    name: "GPT-6 Astra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      },
      {
        pricing: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      },
      {
        pricing: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-6.1-terra": {
    name: "GPT-6.1 Terra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
      },
      {
        pricing: { input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-6-luna": {
    name: "GPT-6 Luna",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: {
          input: 0.1,
          output: 0.5,
          cacheRead: 0.01,
          cacheWrite: 0.125,
        },
      },
      {
        pricing: {
          input: 0.2,
          output: 0.75,
          cacheRead: 0.02,
          cacheWrite: 0.25,
        },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-6-sol": {
    name: "GPT-6 Sol",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      },
      {
        pricing: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      },
      {
        pricing: { input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
    note: "Promotional price through 2026-11-30; OpenAI has not published the rate after that date.",
  },
  "openai/gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
      },
      {
        pricing: { input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: {
          input: 0.2,
          output: 1.2,
          cacheRead: 0.02,
          cacheWrite: 0.25,
        },
      },
      {
        pricing: {
          input: 0.4,
          output: 1.8,
          cacheRead: 0.04,
          cacheWrite: 0.5,
        },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-5.5": {
    name: "GPT-5.5",
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    pricingTiers: [
      {
        maxInputTokens: 272_000,
        pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      },
      {
        pricing: { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "openai/gpt-5.3-codex": {
    name: "GPT-5.3 Codex",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 2.1875 },
    supports: { tools: true, vision: true, reasoning: true },
    deprecated: true,
    note: "Deprecated by OpenAI; the Codex backend serves gpt-5.5 instead.",
  },

  // -------------------------------------------------------------------------
  // Google Gemini. 1,048,576-token input, 65,536 max output. Gemini 4 also
  // does long decodes up to 1M output tokens.
  // -------------------------------------------------------------------------
  "gemini/gemini-4-carbon": {
    name: "Gemini 4 Carbon",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { input: 2, output: 10, cacheRead: 0.1 },
    pricingTiers: [
      {
        until: "2026-11-30",
        pricing: { input: 2, output: 10, cacheRead: 0.1 },
      },
      {
        from: "2026-12-01",
        pricing: { input: 4, output: 20, cacheRead: 0.2 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "gemini/gemini-4-argon": {
    name: "Gemini 4 Argon",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { input: 2, output: 10, cacheRead: 0.1 },
    pricingTiers: [
      {
        until: "2026-11-30",
        pricing: { input: 2, output: 10, cacheRead: 0.1 },
      },
      {
        from: "2026-12-01",
        pricing: { input: 4, output: 20, cacheRead: 0.2 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "gemini/gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { input: 0.75, output: 3.75, cacheRead: 0.075 },
    pricingTiers: [
      {
        until: "2026-12-31",
        pricing: { input: 0.75, output: 3.75, cacheRead: 0.075 },
      },
      {
        from: "2027-01-01",
        pricing: { input: 1.5, output: 7.5, cacheRead: 0.15 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "gemini/gemini-3.1-pro-preview": {
    name: "Gemini 3.1 Pro (preview)",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { input: 2, output: 12, cacheRead: 0.2 },
    pricingTiers: [
      {
        maxInputTokens: 200_000,
        pricing: { input: 2, output: 12, cacheRead: 0.2 },
      },
      {
        pricing: { input: 4, output: 18, cacheRead: 0.4 },
      },
    ],
    supports: { tools: true, vision: true, reasoning: true },
  },
  "gemini/gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash-Lite",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { input: 0.25, output: 1.5, cacheRead: 0.025 },
    supports: { tools: true, vision: true, reasoning: true },
    note: "Audio input costs $0.50/MTok.",
  },

  // -------------------------------------------------------------------------
  // Codex (ChatGPT subscription). The backend bills the subscription, not the
  // API, so there is no per-token price; the context windows are the ones the
  // Codex CLI reports for these models.
  // -------------------------------------------------------------------------
  "codex/gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    contextWindow: 500_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-6.1-terra": {
    name: "GPT-6.1 Terra",
    contextWindow: 500_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-6-astra": {
    name: "GPT-6 Astra",
    contextWindow: 272_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-6-sol": {
    name: "GPT-6 Sol",
    contextWindow: 272_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-6-luna": {
    name: "GPT-6 Luna",
    contextWindow: 272_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    contextWindow: 272_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    contextWindow: 272_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
  "codex/gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    contextWindow: 272_000,
    supports: { tools: true, vision: true, reasoning: true },
    note: "Included in the ChatGPT subscription; not billed per token.",
  },
};

/**
 * Table keys to try for a `(provider, model)` pair, most specific first.
 *
 * - the provider's own entry (`"openai/gpt-5.5"`);
 * - the provider's family entry, for providers that front another vendor
 *   (`"opencode/gpt-5.5"` -> `"openai/gpt-5.5"`);
 * - the vendor hint inside the model id, for routers whose ids carry it
 *   (`"openrouter/anthropic/claude-opus-5-5"` -> `"anthropic/claude-opus-5-5"`).
 */
export function tableKeys(provider: string, model: string): string[] {
  const keys = [`${provider}/${model}`];

  const family = PROVIDER_FAMILY[provider];
  if (family !== undefined && family !== provider) {
    keys.push(`${family}/${model}`);
  }

  const slash = model.indexOf("/");
  if (slash > 0) {
    keys.push(`${model.slice(0, slash)}/${model.slice(slash + 1)}`);
  }

  return keys;
}

/** Model metadata for a `(provider, model)` pair, or `undefined` if unknown. */
export function lookupModel(
  provider: string,
  model: string,
): ModelInfo | undefined {
  for (const key of tableKeys(provider, model)) {
    const entry = MODEL_TABLE[key];
    if (entry !== undefined) {
      return { ...entry, id: model, provider };
    }
  }
  return undefined;
}

/** Every model in the table, as `ModelInfo` values. */
export function listModels(): ModelInfo[] {
  return Object.entries(MODEL_TABLE).map(([key, entry]) => {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    return { ...entry, id: model, provider };
  });
}

/** The table entries a provider can serve, keyed by model id. */
export function modelsForProvider(provider: string): ModelInfo[] {
  const family = PROVIDER_FAMILY[provider];
  const models: ModelInfo[] = [];

  for (const [key, entry] of Object.entries(MODEL_TABLE)) {
    const slash = key.indexOf("/");
    const vendor = key.slice(0, slash);
    const model = key.slice(slash + 1);

    const serves = vendor === provider || (family !== undefined && vendor === family);
    if (!serves) continue;

    models.push({ ...entry, id: model, provider });
  }

  return models;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface PriceOptions {
  /** Input tokens in the request; selects long-context tiers. */
  inputTokens?: number;
  /** Date used for time-limited pricing. Defaults to now. */
  at?: Date | string;
}

/**
 * The price that applies to a request: the first tier that matches, else the
 * model's base price.
 */
export function priceFor(
  info: ModelInfo,
  options: PriceOptions = {},
): ModelPricing | undefined {
  const at = toDay(options.at);
  const inputTokens = options.inputTokens;
  const tiers = info.pricingTiers ?? [];

  // A size-based tier cannot be chosen without knowing the request's size, so
  // the base price (the standard rate) is used rather than a guess.
  const sizeTier = tiers.find((tier) => tier.maxInputTokens !== undefined);
  if (sizeTier !== undefined && inputTokens === undefined) {
    return info.pricing;
  }

  for (const tier of tiers) {
    if (tierMatches(tier, inputTokens, at)) return tier.pricing;
  }
  return info.pricing;
}

function tierMatches(
  tier: PricingTier,
  inputTokens: number | undefined,
  at: string | undefined,
): boolean {
  if (tier.maxInputTokens !== undefined) {
    if (inputTokens === undefined || inputTokens > tier.maxInputTokens) {
      return false;
    }
  }
  if (tier.from !== undefined && at !== undefined && at < tier.from) return false;
  if (tier.until !== undefined && at !== undefined && at > tier.until) return false;
  return true;
}

/** `Date` or `YYYY-MM-DD` to `YYYY-MM-DD`. */
function toDay(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * Cost of one response in USD, or `undefined` when the model has no price.
 *
 * Cached tokens are billed at their own rate. How they relate to
 * `Usage.inputTokens` differs per provider, which is what
 * `ModelInfo.cachedTokens` records.
 */
export function estimateCost(
  usage: Usage,
  info: ModelInfo,
  options: PriceOptions = {},
): number | undefined {
  const pricing = priceFor(info, {
    ...options,
    inputTokens: options.inputTokens ?? usage.inputTokens,
  });
  if (pricing === undefined) return undefined;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;

  // Anthropic counts only uncached input in `input_tokens`; everyone else
  // reports the whole prompt, with the cached part inside it.
  const uncachedInput =
    (info.cachedTokens ?? "included") === "included"
      ? Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
      : usage.inputTokens;

  const perMillion = (tokens: number, rate: number | undefined): number =>
    rate === undefined ? 0 : (tokens / 1_000_000) * rate;

  return (
    perMillion(uncachedInput, pricing.input) +
    perMillion(cacheRead, pricing.cacheRead ?? pricing.input) +
    perMillion(cacheWrite, pricing.cacheWrite ?? pricing.input) +
    perMillion(usage.outputTokens, pricing.output)
  );
}
