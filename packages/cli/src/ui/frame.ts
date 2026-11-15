/**
 * The frame of the session.
 *
 * The header says where the agent is: the model, the directory, and how
 * to change them. The footer says what is left: the context, the cost, and
 * the shortcuts.
 *
 * They are drawn as boxes, the way a program that means it looks.
 */

import type { Usage } from "@cli-agent/ai";
import type { ModelInfo } from "@cli-agent/ai";
import { bold, cyan, dim, green, red, yellow } from "./colors.js";

/** The characters the box is drawn with. */
const BOX = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
} as const;

/** How wide the header is. */
const HEADER_WIDTH = 64;

/**
 * A box with something in it.
 *
 * The box is as wide as the longest line, so nothing is cut off, and the
 * width is measured without the colours, so the lines up.
 */
export function box(lines: string[], width = HEADER_WIDTH): string {
  const longest = lines.reduce((most, line) => Math.max(most, visible(line)), 0);
  const inner = Math.max(width - 2, longest + 1);

  const out: string[] = [];

  out.push(
    `${dim(BOX.topLeft)}${dim(BOX.horizontal.repeat(inner))}${dim(BOX.topRight)}`,
  );

  for (const line of lines) {
    const text = visible(line);
    const pad = Math.max(0, inner - text - 1);
    out.push(
      `${dim(BOX.vertical)} ${line}${" ".repeat(pad)}${dim(BOX.vertical)}`,
    );
  }

  out.push(
    `${dim(BOX.bottomLeft)}${dim(BOX.horizontal.repeat(inner))}${dim(BOX.bottomRight)}`,
  );

  return out.join("\n");
}

/** How long a piece of text looks without the escapes. */
function visible(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "").length;
}

/** The header of the session. */
export function renderHeader(options: {
  model: string;
  cwd: string;
  /** The version of the agent, when there is one. */
  version?: string;
}): string {
  const title =
    options.version === undefined
      ? bold("agent")
      : `${bold("agent")} ${dim(`v${options.version}`)}`;

  return box([
    `${title}  ${dim("— a coding agent")}`,
    `${dim("model:")} ${cyan(options.model)}   ${dim("/model to change")}`,
    `${dim("directory:")} ${options.cwd}`,
  ]);
}

/** What is left of the context, as a share. */
export interface ContextLeft {
  /** The tokens the conversation takes. */
  used: number;
  /** The tokens the window holds. */
  total: number;
}

/** The share of the context that is left, from 0 to 1. */
export function contextShare(left: ContextLeft | undefined): number | undefined {
  if (left === undefined || left.total <= 0) return undefined;
  return Math.max(0, Math.min(1, 1 - left.used / left.total));
}

/** The frames of the spinner. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The spinner, at a point in its turn. */
export function spinnerFrame(step: number): string {
  const frame = SPINNER[step % SPINNER.length];
  return frame ?? "⠋";
}
