/**
 * Shrinking what the model has to read.
 *
 * A tool result can be enormous — a file, a build log, a search over a
 * whole repository — and the model rarely needs all of it. So a big result
 * keeps its head and its tail, and says how much was left out; and a result
 * that is many turns old is replaced by a one-line stub, because the model
 * has long since moved on from it.
 *
 * The transcript keeps the truth: only what is sent to the model is
 * shortened.
 */

import type { Msg } from "@cli-agent/ai";

export interface ShrinkOptions {
  /** The most lines a tool result may have. */
  maxLines?: number;
  /** The most characters a tool result may have. */
  maxChars?: number;
  /** How many turns a tool result stays readable. */
  keepTurns?: number;
}

/** The most lines a tool result may have. */
export const DEFAULT_MAX_LINES = 60;
/** The most characters a tool result may have. */
export const DEFAULT_MAX_CHARS = 4_000;
/** How many turns a tool result stays readable. */
export const DEFAULT_KEEP_TURNS = 3;

/** The marker that says what was left out. */
export function omittedMarker(lines: number): string {
  return `... ${lines} lines omitted ...`;
}

/**
 * Shorten a long text, keeping the head and the tail.
 *
 * The head is what the tool said first and the tail is what it said last;
 * the middle is usually the part that does not need reading.
 */
export function shrinkText(
  text: string,
  options: ShrinkOptions = {},
): string {
  const {
    maxLines = DEFAULT_MAX_LINES,
    maxChars = DEFAULT_MAX_CHARS,
  } = options;

  if (text.length === 0) return text;

  const lines = text.split("\n");
  if (lines.length <= maxLines && text.length <= maxChars) return text;

  const headLines = Math.max(1, Math.floor(maxLines / 2));
  const tailLines = Math.max(1, maxLines - headLines);

  let head = lines.slice(0, headLines).join("\n");
  let tail = lines.slice(lines.length - tailLines).join("\n");

  // The character cap applies to what is left.
  if (head.length + tail.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    head = head.slice(0, half);
    tail = tail.slice(-half);
  }

  const omitted = Math.max(0, lines.length - headLines - tailLines);
  return `${head}\n${omittedMarker(omitted)}\n${tail}`;
}

/**
 * The messages as they are sent to the model.
 *
 * A tool result that is more than `keepTurns` turns old is replaced by a
 * one-line stub: the model does not need the output of a file it read ten
 * turns ago, and it does need the space.
 */
export function stubOldToolResults(
  messages: Msg[],
  options: ShrinkOptions = {},
): Msg[] {
  const { keepTurns = DEFAULT_KEEP_TURNS } = options;
  if (keepTurns < 0) return messages;

  // How many turns are after each message.
  let turnsAfter = 0;
  const ages: number[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    ages[index] = turnsAfter;
    if (messages[index]?.role === "assistant") turnsAfter += 1;
  }

  return messages.map((message, index) => {
    if (message.role !== "tool") return message;
    if ((ages[index] as number) <= keepTurns) return message;

    return {
      role: "tool",
      callId: message.callId,
      content: `[dropped: the result of this tool call is no longer shown]`,
      ...(message.isError === true ? { isError: true } : {}),
    };
  });
}
