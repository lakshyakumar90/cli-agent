/**
 * Counting tokens.
 *
 * The count is an estimate until the provider says otherwise: the real
 * number arrives with the usage of a response, and the difference between
 * the two is remembered, so the next estimate is closer.
 *
 * The quick count is four characters a token, which is always available and
 * costs nothing. The exact count uses a real tokenizer, but loading one
 * takes about a second, so it is only asked for when the answer matters:
 * when the conversation is close to the limit and something is about to be
 * thrown away.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";

/** How the count was made. */
export type CountingMethod = "tokenizer" | "heuristic";

export interface TokenCount {
  /** The number of tokens. */
  tokens: number;
  /** How it was counted. */
  method: CountingMethod;
}

/** The tokenizer, once it has been loaded. */
let encoding: Tiktoken | undefined;

/**
 * The exact count, with a real tokenizer.
 *
 * The first call loads the tokenizer, which takes about a second; after
 * that it is kept. cl100k_base is used for every model: it is right for the
 * OpenAI models, and for the others it is a better guess than counting
 * characters.
 */
export function countTokensWithTokenizer(text: string): TokenCount {
  if (text.length === 0) return { tokens: 0, method: "tokenizer" };

  if (encoding === undefined) {
    try {
      encoding = getEncoding("cl100k_base");
    } catch {
      return { tokens: estimateByCharacters(text), method: "heuristic" };
    }
  }

  try {
    return { tokens: encoding.encode(text).length, method: "tokenizer" };
  } catch {
    return { tokens: estimateByCharacters(text), method: "heuristic" };
  }
}

/** The quick count: four characters a token. */
export function countTokens(text: string): TokenCount {
  return { tokens: estimateByCharacters(text), method: "heuristic" };
}

/** The tokens in some text, as a number. */
export function estimateText(text: string): number {
  return estimateByCharacters(text);
}

/**
 * The heuristic: four characters to a token.
 *
 * It is what a provider's own rule of thumb says, and it is close enough
 * for words and code, which is most of a prompt.
 */
export function estimateByCharacters(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * The correction from the real usage.
 *
 * The provider says how many tokens it actually used; the ratio between the
 * two is how far off the estimate was, and it is applied to the next one.
 * The old ratio is kept, so one unusual turn does not throw the estimate
 * away.
 */
export function correctRatio(
  previous: number | undefined,
  estimated: number,
  real: number,
): number {
  if (estimated <= 0 || real <= 0) return previous ?? 1;

  const observed = real / estimated;
  if (previous === undefined) return observed;
  return previous * 0.5 + observed * 0.5;
}
