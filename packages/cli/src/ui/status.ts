/**
 * The status line, and the tool blocks.
 *
 * The status line says where the agent is: the model, what it has spent,
 * what it cost, and how much it may do on its own.
 */

import type { Usage } from "@cli-agent/ai";
import { estimateCost } from "@cli-agent/ai";
import type { ModelInfo } from "@cli-agent/ai";
import { bold, cyan, dim, gray, green, red, yellow } from "./colors.js";
import { renderReplacement } from "./diff.js";

export interface StatusInput {
  /** The model the agent is using. */
  model: string;
  /** What the last turn used. */
  usage?: Usage;
  /** What the model table says the model costs. */
  info?: ModelInfo;
  /** How much the agent may do without asking. */
  permissionMode: string;
  /** How many turns have run. */
  turns?: number;
}

/** The status line. */
export function renderStatus(input: StatusInput): string {
  const parts: string[] = [cyan(input.model)];

  if (input.usage !== undefined) {
    parts.push(
      dim(
        `${formatTokens(input.usage.inputTokens)} in / ${formatTokens(
          input.usage.outputTokens,
        )} out`,
      ),
    );

    const cost =
      input.info === undefined
        ? undefined
        : estimateCost(input.usage, input.info);
    if (cost !== undefined) parts.push(dim(`$${cost.toFixed(4)}`));
  }

  if (input.turns !== undefined) parts.push(dim(`${input.turns} turns`));

  parts.push(permissionLabel(input.permissionMode));

  return parts.join(dim(" · "));
}

/** The permission mode, in colour. */
export function permissionLabel(mode: string): string {
  switch (mode) {
    case "yolo":
      return red(mode);
    case "auto-edit":
      return yellow(mode);
    case "plan":
      return gray(mode);
    default:
      return green(mode);
  }
}

/** Token counts, in a readable shape. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** One tool call, as the terminal shows it. */
export interface ToolBlock {
  /** The id of the call, so its result can be found. */
  id: string;
  /** The tool that ran. */
  name: string;
  /** What it was asked to do. */
  args?: unknown;
  /** What it said, when it has finished. */
  output?: string;
  /** Did it fail? */
  isError?: boolean;
  /** Is the output shown? */
  expanded: boolean;
  /** The old and new text, when the tool was an edit. */
  replacement?: { oldString: string; newString: string };
}

/** A tool block, collapsed or expanded. */
export function renderToolBlock(block: ToolBlock): string {
  const mark = block.isError === true ? red("✗") : green("●");
  const name = bold(block.name);
  const summary = toolSummary(block);
  const header = `${mark} ${name}${summary.length > 0 ? dim(` ${summary}`) : ""}`;

  if (!block.expanded) return header;

  const parts = [header];
  const result = renderToolResult(block);
  if (result.length > 0) parts.push(indent(result));
  return parts.join("\n");
}

/**
 * What the tool produced: the diff of an edit, or its output.
 *
 * This is what goes under the header, so the header is not printed twice.
 */
export function renderToolResult(block: ToolBlock): string {
  if (block.replacement !== undefined) {
    return renderReplacement(block.replacement.oldString, block.replacement.newString);
  }
  return block.output ?? "";
}

/** The one line that says what the tool was asked to do. */
export function toolSummary(block: ToolBlock): string {
  const args = block.args;
  if (args === undefined || args === null) return "";

  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;

  if (typeof record.path === "string") return record.path;
  if (typeof record.command === "string") return record.command;
  if (typeof record.pattern === "string") return record.pattern;
  if (typeof record.old_string === "string") {
    return `old: ${firstLine(record.old_string)}`;
  }

  const keys = Object.keys(record);
  return keys.length > 0 ? keys.join(", ") : "";
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 40 ? `${line.slice(0, 37)}...` : line;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
