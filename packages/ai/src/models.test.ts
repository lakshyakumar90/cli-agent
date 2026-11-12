import { describe, expect, it } from "vitest";
import {
  estimateCost,
  listModels,
  lookupModel,
  modelsForProvider,
  priceFor,
  tableKeys,
} from "./models.js";
import type { Usage } from "./types.js";

const usage = (over: Partial<Usage> = {}): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  ...over,
});

describe("model table", () => {
  it("finds a model by provider and id", () => {
    const info = lookupModel("anthropic", "claude-opus-5-5");

    expect(info).toMatchObject({
      id: "claude-opus-5-5",
      provider: "anthropic",
      name: "Claude Opus 5.5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(info?.pricing).toMatchObject({ input: 4, output: 20 });
    expect(info?.supports).toMatchObject({ tools: true, vision: true, reasoning: true });
  });

  it("falls back to the vendor family for providers that resell models", () => {
    // OpenCode Zen serves OpenAI models under its own provider id.
    const info = lookupModel("opencode", "gpt-5.5");

    expect(info?.provider).toBe("opencode");
    expect(info?.pricing).toMatchObject({ input: 5, output: 30 });
  });

  it("reads the vendor hint inside a router's model id", () => {
    const info = lookupModel("openrouter", "anthropic/claude-sonnet-5-5");

    expect(info?.name).toBe("Claude Sonnet 5.5");
    expect(info?.pricing).toMatchObject({ input: 2, output: 10 });
  });

  it("returns nothing for a model it does not know", () => {
    expect(lookupModel("openai", "gpt-4-turbo")).toBeUndefined();
    expect(lookupModel("made-up", "made-up")).toBeUndefined();
  });

  it("orders the lookup candidates most specific first", () => {
    expect(tableKeys("opencode", "gpt-5.5")).toEqual([
      "opencode/gpt-5.5",
      "openai/gpt-5.5",
    ]);
    expect(tableKeys("openrouter", "anthropic/claude-opus-5-5")).toEqual([
      "openrouter/anthropic/claude-opus-5-5",
      "anthropic/claude-opus-5-5",
    ]);
  });

  it("lists the models a provider can serve", () => {
    const codex = modelsForProvider("codex").map((model) => model.id);
    expect(codex).toContain("gpt-6.1-sol");
    expect(codex).toContain("gpt-6-astra");
    // Codex-only ids are not offered to other providers.
    expect(codex).not.toContain("gpt-5.5-codex");

    // OpenCode Zen serves the OpenAI family, with OpenAI's context window —
    // not the narrower one the Codex backend reports for the same model id.
    const opencode = modelsForProvider("opencode");
    expect(opencode.map((model) => model.id)).toContain("gpt-5.5");
    expect(opencode.find((model) => model.id === "gpt-6.1-sol")?.contextWindow).toBe(
      1_050_000,
    );
    expect(
      modelsForProvider("codex").find((model) => model.id === "gpt-6.1-sol")
        ?.contextWindow,
    ).toBe(500_000);
  });

  it("exposes every entry with its id and provider", () => {
    const all = listModels();
    expect(all.length).toBeGreaterThan(10);
    for (const model of all) {
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.provider.length).toBeGreaterThan(0);
    }
  });
});

describe("pricing", () => {
  it("uses the base price when no tier applies", () => {
    const info = lookupModel("openai", "gpt-5.5");
    expect(priceFor(info!, { inputTokens: 1_000 })).toMatchObject({
      input: 5,
      output: 30,
    });
  });

  it("switches to the long-context rate over 272K input tokens", () => {
    const info = lookupModel("openai", "gpt-5.5");

    expect(priceFor(info!, { inputTokens: 272_000 })?.input).toBe(5);
    expect(priceFor(info!, { inputTokens: 272_001 })?.input).toBe(10);
    expect(priceFor(info!, { inputTokens: 272_001 })?.output).toBe(45);
  });

  it("switches Anthropic Haiku to its long-prompt rate over 100K tokens", () => {
    const info = lookupModel("anthropic", "claude-haiku-5-5");

    expect(priceFor(info!, { inputTokens: 100_000 })?.input).toBe(0.1);
    expect(priceFor(info!, { inputTokens: 100_001 })?.input).toBe(0.5);
    expect(priceFor(info!, { inputTokens: 100_001 })?.output).toBe(2.5);
  });

  it("follows the date on a promotional price", () => {
    const info = lookupModel("gemini", "gemini-4-carbon");

    expect(priceFor(info!, { at: "2026-11-30" })?.input).toBe(2);
    expect(priceFor(info!, { at: "2026-12-01" })?.input).toBe(4);
    expect(priceFor(info!, { at: "2026-12-01" })?.output).toBe(20);
  });

  it("uses the base price when the tier needs a token count that is missing", () => {
    const info = lookupModel("gemini", "gemini-3.1-pro-preview");

    // No inputTokens: the tier that caps at 200K cannot be chosen, so the
    // base price (the <=200K rate) is used rather than a guess.
    expect(priceFor(info!)?.input).toBe(2);
    expect(priceFor(info!, { inputTokens: 250_000 })?.input).toBe(4);
    expect(priceFor(info!, { inputTokens: 250_000 })?.output).toBe(18);
  });

  it("has no price for a subscription model", () => {
    const info = lookupModel("codex", "gpt-6.1-sol");
    expect(priceFor(info!)).toBeUndefined();
  });
});

describe("cost estimation", () => {
  it("prices input and output tokens", () => {
    const info = lookupModel("openai", "gpt-5.5");
    const cost = estimateCost(
      usage({ inputTokens: 100_000, outputTokens: 1_000_000 }),
      info!,
    );
    // 100K at $5 + 1M at $30.
    expect(cost).toBeCloseTo(30.5, 10);
  });

  it("bills cached tokens at the cache rate when the provider counts them in the prompt", () => {
    const info = lookupModel("openai", "gpt-5.5");
    const cost = estimateCost(
      usage({ inputTokens: 100_000, cacheReadTokens: 20_000 }),
      info!,
    );
    // 80K uncached at $5 + 20K cached at $0.50.
    expect(cost).toBeCloseTo(0.41, 10);
  });

  it("bills Anthropic's uncached input separately from its cache reads", () => {
    const info = lookupModel("anthropic", "claude-sonnet-5-5");
    const cost = estimateCost(
      usage({ inputTokens: 1_000_000, cacheReadTokens: 200_000 }),
      info!,
    );
    // Anthropic's input_tokens excludes the cache: 1M at $2 + 200K at $0.10.
    expect(cost).toBeCloseTo(2.02, 10);
  });

  it("prices a long request at the long-context rate", () => {
    const info = lookupModel("openai", "gpt-5.5");
    const cost = estimateCost(
      usage({ inputTokens: 300_000, outputTokens: 0 }),
      info!,
    );
    // 300K at the $10 long-context rate.
    expect(cost).toBeCloseTo(3, 10);
  });

  it("has no estimate for a model without a price", () => {
    const info = lookupModel("codex", "gpt-6.1-sol");
    expect(
      estimateCost(usage({ inputTokens: 1_000, outputTokens: 1_000 }), info!),
    ).toBeUndefined();
  });
});
