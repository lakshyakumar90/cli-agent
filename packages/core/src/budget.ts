/**
 * The budget.
 *
 * How much of the model's context window the conversation may use, and when
 * it has to be made smaller.
 */

import { estimateCost, lookupModel, type Usage } from "@cli-agent/ai";
import type { Context } from "./context.js";
import { countTokens, countTokensWithTokenizer } from "./tokens.js";

/** When compaction starts, as a share of the budget. */
export const DEFAULT_THRESHOLD = 0.8;

export interface Budget {
  /** The model's context window, when the model table knows it. */
  contextWindow?: number;
  /** What is kept back for the answer. */
  outputReserve: number;
  /** What the conversation may use. */
  total?: number;
  /** When compaction starts, as a share of the budget. */
  threshold: number;
}

export interface BudgetOptions {
  /** The provider the model belongs to. */
  provider: string;
  /** The model id. */
  model: string;
  /**
   * The context window to assume, when the model table does not know the
   * model (a local model, or one that is newer than the table).
   */
  contextWindow?: number;
  /** What to keep back for the answer. Defaults to the model's own limit. */
  outputReserve?: number;
  /** When compaction starts. Defaults to 80%. */
  threshold?: number;
}

/**
 * The budget for a model.
 *
 * The context window minus what is kept back for the answer. A model the
 * table does not know has no budget, and nothing is compacted.
 */
export function budgetFor(options: BudgetOptions): Budget {
  const { provider, model, threshold = DEFAULT_THRESHOLD } = options;

  const info = lookupModel(provider, model);
  const contextWindow = options.contextWindow ?? info?.contextWindow;

  const outputReserve =
    options.outputReserve ??
    info?.maxOutputTokens ??
    (contextWindow === undefined ? 0 : Math.floor(contextWindow * 0.1));

  const total =
    contextWindow === undefined ? undefined : contextWindow - outputReserve;

  return {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    outputReserve,
    ...(total === undefined ? {} : { total }),
    threshold,
  };
}

/** Has the conversation outgrown the budget? */
export function shouldCompact(used: number, budget: Budget): boolean {
  if (budget.total === undefined || budget.total <= 0) return false;
  return used >= budget.total * budget.threshold;
}

/**
 * What one turn costs, in US dollars.
 *
 * A model the table does not know has no price, so its cost is zero: a
 * budget on such a model counts the tokens, not the money.
 */
export function costOf(
  provider: string,
  model: string,
  usage: Usage,
): number {
  const info = lookupModel(provider, model);
  if (info === undefined) return 0;
  return estimateCost(usage, info) ?? 0;
}

/**
 * The tokens a request costs.
 *
 * The system prompt, the conversation and the tool definitions: everything
 * the provider will read. The quick count is four characters a token; the
 * precise count uses a real tokenizer, and costs a second to load, so it is
 * only asked for when the answer matters.
 */
export function estimateRequest(
  context: Context,
  correction: number = 1,
  options: { precise?: boolean } = {},
): number {
  const count = options.precise === true ? countTokensWithTokenizer : countTokens;

  let tokens = count(context.system).tokens;

  for (const message of context.messages) {
    tokens += count(textOf(message)).tokens;
  }

  for (const tool of context.tools) {
    tokens += count(
      `${tool.name} ${tool.description} ${JSON.stringify(tool.schema)}`,
    ).tokens;
  }

  return Math.ceil(tokens * correction);
}

/** The text of a message. */
export function textOf(message: Context["messages"][number]): string {
  if (message.role === "user" || message.role === "tool") return message.content;
  return message.content
    .map((block) => {
      switch (block.type) {
        case "text":
        case "thinking":
          return block.text;
        case "toolCall":
          return `${block.name} ${JSON.stringify(block.args)}`;
      }
    })
    .join("\n");
}
