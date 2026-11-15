/**
 * The frame of the session.
 *
 * The header says where the agent is. The welcome says what it can do. The
 * field is where the answer goes, and the line under it says what is left.
 *
 * They are drawn as a program draws them: a rule, a field, a line of facts.
 */

import type { Usage } from "@cli-agent/ai";
import type { ModelInfo } from "@cli-agent/ai";
import { estimateCost } from "@cli-agent/ai";
import { bold, cyan, dim, gray, green, red, yellow } from "./colors.js";

/** The characters the frame is drawn with. */
const FRAME = {
  horizontal: "─",
  corner: "╭",
  cornerEnd: "╮",
  cornerBottom: "╰",
  cornerBottomEnd: "╯",
  vertical: "│",
} as const;

/** How wide the frame is when the terminal does not say. */
export const DEFAULT_WIDTH = 76;

/** The width of the terminal, when it says. */
export function terminalWidth(): number {
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 20 ? columns : DEFAULT_WIDTH;
}

/** A horizontal rule. */
export function rule(width = terminalWidth(), character = FRAME.horizontal): string {
  return dim(character.repeat(Math.max(4, width)));
}

/**
 * A box with something in it.
 *
 * The box is as wide as the longest line, so nothing is cut off, and the
 * width is measured without the colours, so the lines up.
 */
export function box(
  lines: string[],
  options: { title?: string; hint?: string; width?: number } = {},
): string {
  const { title, hint } = options;
  const width = options.width ?? DEFAULT_WIDTH;

  const body = title === undefined ? lines : [bold(title), "", ...lines];
  const longest = body.reduce((most, line) => Math.max(most, visible(line)), 0);
  const inner = Math.max(width - 2, longest + 1);

  const out: string[] = [];

  out.push(
    `${dim(FRAME.corner)}${dim(FRAME.horizontal.repeat(inner))}${dim(FRAME.cornerEnd)}`,
  );

  for (const line of body) {
    const text = visible(line);
    const pad = Math.max(0, inner - text - 1);
    out.push(
      `${dim(FRAME.vertical)} ${line}${" ".repeat(pad)}${dim(FRAME.vertical)}`,
    );
  }

  if (hint !== undefined) {
    out.push(`${dim(FRAME.vertical)}${" ".repeat(inner)}${dim(FRAME.vertical)}`);
    out.push(
      `${dim(FRAME.vertical)} ${dim(hint)}${" ".repeat(
        Math.max(0, inner - 1 - visible(hint)),
      )}${dim(FRAME.vertical)}`,
    );
  }

  out.push(
    `${dim(FRAME.cornerBottom)}${dim(FRAME.horizontal.repeat(inner))}${dim(FRAME.cornerBottomEnd)}`,
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
  const name = bold("agent");
  const version =
    options.version === undefined ? "" : dim(` (v${options.version})`);

  return [
    `${cyan(">_")} ${name}${version}`,
    `  ${options.cwd}`,
  ].join("\n");
}

/** One of the commands the welcome offers. */
export interface WelcomeCommand {
  /** The command, e.g. "/model". */
  name: string;
  /** What it does. */
  description: string;
}

/**
 * The welcome.
 *
 * What the agent can do, and the commands that are worth knowing.
 */
export function renderWelcome(commands: WelcomeCommand[]): string {
  const lines = [
    dim("To get started, describe a task or try one of these commands:"),
    "",
  ];

  const widest = commands.reduce(
    (most, command) => Math.max(most, command.name.length),
    0,
  );

  for (const command of commands) {
    lines.push(
      `${cyan(command.name.padEnd(widest))}  ${dim(command.description)}`,
    );
  }

  return lines.join("\n");
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

/**
 * The line under the field.
 *
 * What is where on the left, what to press on the right.
 */
export function renderFooter(options: {
  model: string;
  cwd?: string;
  usage?: Usage;
  info?: ModelInfo;
  turns?: number;
  /** The context that is left. */
  left?: ContextLeft;
  /** The permission mode. */
  permissionMode?: string;
  /** What to press. */
  hints?: string[];
  /** How wide the line is. */
  width?: number;
}): string {
  const left: string[] = [cyan(options.model)];
  if (options.cwd !== undefined) left.push(dim(options.cwd));
  if (options.permissionMode !== undefined) {
    left.push(dim(options.permissionMode));
  }

  const right: string[] = [];

  if (options.usage !== undefined) {
    right.push(
      dim(
        `${formatTokens(options.usage.inputTokens)} in / ${formatTokens(
          options.usage.outputTokens,
        )} out`,
      ),
    );

    const cost =
      options.info === undefined
        ? undefined
        : estimateCost(options.usage, options.info);
    if (cost !== undefined) right.push(dim(`$${cost.toFixed(4)}`));
  }

  const share = contextShare(options.left);
  if (share !== undefined) {
    const percent = Math.round(share * 100);
    const paint = percent <= 15 ? red : percent <= 35 ? yellow : green;
    right.push(paint(`${percent}% left`));
  }

  if (options.turns !== undefined && options.turns > 0) {
    right.push(dim(`${options.turns} turns`));
  }

  for (const hint of options.hints ?? []) right.push(dim(hint));

  const text = right.join(dim(" · "));
  const width = options.width ?? terminalWidth();
  const gap = Math.max(1, width - visible(left.join(dim(" · "))) - visible(text) - 2);

  return ` ${left.join(dim(" · "))}${" ".repeat(gap)}${text}`;
}

/** Token counts, in a readable shape. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** The frames of the spinner. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The spinner, at a point in its turn. */
export function spinnerFrame(step: number): string {
  const frame = SPINNER[step % SPINNER.length];
  return frame ?? "⠋";
}
