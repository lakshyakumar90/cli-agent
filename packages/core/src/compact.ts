/**
 * Compaction.
 *
 * When the conversation no longer fits, the old part of it is summarised and
 * replaced by the summary. What is kept is the summary and the last few
 * messages, so the model still knows what just happened and still knows
 * what it was asked to do.
 */

import type { Msg, Provider } from "@cli-agent/ai";
import { textOf } from "./budget.js";
import { estimateText } from "./tokens.js";

/** How many messages are kept as they are. */
export const DEFAULT_KEEP = 6;

export interface CompactOptions {
  /** The provider that does the summarising. */
  provider: Provider;
  /** The model to summarise with. */
  model: string;
  /** The conversation. */
  messages: Msg[];
  /**
   * The budget the conversation has to fit in.
   *
   * It decides how much is kept: the most recent messages that fit in a
   * quarter of it, at least one and at most `keep` of them.
   */
  budget?: number;
  /** The most messages to keep as they are. */
  keep?: number;
  /** Cancels the summarising. */
  signal: AbortSignal;
  /** What the summary is for. */
  instruction?: string;
}

/**
 * What the summary has to keep.
 *
 * The agent keeps working after the compaction, so the summary has to carry
 * what it needs and drop what it does not: the goal, the decisions, the
 * files that were touched, the tests that fail, the open tasks and what the
 * user said they want.
 */
export const SUMMARY_INSTRUCTION = `Summarise this conversation for the agent that will keep working.

Keep, in this order:
- the goal: what the user asked for, in their terms
- the decisions that were made, and why
- the files that were touched, and what changed in them
- the tests that fail, and the error they fail with
- the open tasks
- the preferences the user stated: the style they want, the tools to use,
  what to avoid

Drop: the file contents, the logs, the tool output, and the chatter.`;

/**
 * The conversation, made smaller.
 *
 * Returns nothing when there is nothing to summarise, or when the model could
 * not summarise it — the conversation is then left alone.
 */
export async function compactMessages(
  options: CompactOptions,
): Promise<Msg[] | undefined> {
  const {
    provider,
    model,
    messages,
    budget,
    keep = DEFAULT_KEEP,
    signal,
    instruction = SUMMARY_INSTRUCTION,
  } = options;

  const split = splitMessages(messages, budget, keep);
  if (split === undefined) return undefined;

  const { older, recent } = split;
  const transcript = older
    .map((message) => `${message.role}: ${textOf(message)}`)
    .join("\n\n");

  let summary = "";
  try {
    for await (const event of provider.stream({
      model,
      system:
        "You summarise a conversation for an agent that will keep working. Be factual and brief: a dozen lines at most.",
      messages: [{ role: "user", content: `${instruction}\n\n${transcript}` }],
      tools: [],
      signal,
    })) {
      if (event.t === "text") summary += event.delta;
    }
  } catch {
    return undefined;
  }

  const trimmed = summary.trim();
  if (trimmed.length === 0) return undefined;

  return [
    {
      role: "user",
      content: `Summary of earlier work:\n\n${trimmed}`,
    },
    ...recent,
  ];
}

/**
 * Which messages are summarised and which are kept.
 *
 * The split is by size, not by count: one enormous message is worth
 * summarising even when there are only two of them.
 */
export function splitMessages(
  messages: Msg[],
  budget: number | undefined,
  keep: number,
): { older: Msg[]; recent: Msg[] } | undefined {
  if (messages.length <= 1) return undefined;

  // A quarter of the budget is what the recent messages may use.
  const target =
    budget === undefined ? Number.POSITIVE_INFINITY : Math.floor(budget * 0.25);

  let size = 0;
  let kept = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const tokens = estimateText(textOf(messages[index] as Msg));

    // One message is always kept, so there is something to answer with.
    if (size + tokens > target && kept >= 1) break;

    size += tokens;
    kept += 1;
    if (kept >= keep) break;
  }

  if (kept >= messages.length) return undefined;

  return {
    older: messages.slice(0, messages.length - kept),
    recent: messages.slice(messages.length - kept),
  };
}

