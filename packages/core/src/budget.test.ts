import { describe, expect, it } from "vitest";
import {
  budgetFor,
  estimateRequest,
  shouldCompact,
  textOf,
} from "./budget.js";
import {
  correctRatio,
  countTokens,
  countTokensWithTokenizer,
  estimateByCharacters,
  estimateText,
} from "./tokens.js";
import type { Context } from "./context.js";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";

describe("counting tokens", () => {
  it("counts quickly with four characters a token", () => {
    const text = "Hello there, this is a coding agent.";
    const count = countTokens(text);

    expect(count.method).toBe("heuristic");
    expect(count.tokens).toBe(Math.ceil(text.length / 4));
  });

  it("counts exactly with a tokenizer when it is asked to", () => {
    const count = countTokensWithTokenizer(
      "Hello there, this is a coding agent.",
    );

    expect(count.method).toBe("tokenizer");
    expect(count.tokens).toBeGreaterThan(0);
    // A dozen words is more than a handful of tokens, and fewer than the
    // characters.
    expect(count.tokens).toBeLessThan(45);
  });

  it("counts an empty text as nothing", () => {
    expect(countTokens("").tokens).toBe(0);
    expect(countTokensWithTokenizer("").tokens).toBe(0);
  });

  it("falls back to four characters a token", () => {
    expect(estimateByCharacters("abcdefgh")).toBe(2);
    expect(estimateByCharacters("")).toBe(0);
  });

  it("is close to the heuristic", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    const counted = estimateText(text);

    expect(counted).toBeGreaterThan(0);
    expect(
      Math.abs(counted - countTokensWithTokenizer(text).tokens) / counted,
    ).toBeLessThan(0.5);
  });

  it("corrects the estimate with the real usage", () => {
    expect(correctRatio(undefined, 100, 150)).toBeCloseTo(1.5, 5);
    expect(correctRatio(1, 100, 0)).toBe(1);
    expect(correctRatio(1, 0, 100)).toBe(1);
  });

  it("keeps half of the old correction", () => {
    expect(correctRatio(1, 100, 200)).toBeCloseTo(1.5, 5);
  });
});

describe("the budget", () => {
  it("is the context window minus what is kept back", () => {
    const budget = budgetFor({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });

    expect(budget.contextWindow).toBe(1_000_000);
    expect(budget.outputReserve).toBe(128_000);
    expect(budget.total).toBe(872_000);
    expect(budget.threshold).toBe(0.8);
  });

  it("has no budget for a model it does not know", () => {
    const budget = budgetFor({ provider: "made-up", model: "made-up" });

    expect(budget.total).toBeUndefined();
    expect(shouldCompact(1_000_000, budget)).toBe(false);
  });

  it("asks for compaction at eighty per cent", () => {
    const budget = budgetFor({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
    });

    expect(shouldCompact(697_599, budget)).toBe(false);
    expect(shouldCompact(697_600, budget)).toBe(true);
  });

  it("estimates what a request costs", () => {
    const context: Context = {
      model: "test-model",
      system: "You are a coding agent.",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
        },
      ],
      tools: [
        {
          name: "read",
          description: "Reads a file.",
          schema: { type: "object" },
        },
      ],
    };

    const estimate = estimateRequest(context);

    expect(estimate).toBeGreaterThan(0);
    // The correction is applied.
    expect(estimateRequest(context, 2)).toBe(estimate * 2);
  });

  it("reads the text of every kind of message", () => {
    expect(textOf({ role: "user", content: "hello" })).toBe("hello");
    expect(
      textOf({
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "toolCall", id: "c1", name: "read", args: { path: "a" } },
        ],
      }),
    ).toContain("read");
  });
});


