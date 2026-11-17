/**
 * The tool blocks.
 *
 * A tool call is a line: what it was asked to do, and whether it worked.
 * The line folds, so a long output does not fill the screen.
 */

import { bold, cyan, dim, gray, green, magenta, red, yellow } from "./colors.js";
import { renderReplacement } from "./diff.js";

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
export { formatTokens } from "./frame.js";

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
  /** A short line about it, e.g. "12 lines". */
  summary?: string;
  /** A few words about it. */
  detail?: string;
  /** What kind of thing it was, so it can be told apart by colour. */
  kind?: "read" | "write" | "edit" | "bash" | "search" | "agent" | "think";
}

/**
 * The colour of a kind of block.
 *
 * The colours are what tell the actions apart at a glance: what was read,
 * what was changed, what was run.
 */
export function kindColor(
  kind: ToolBlock["kind"],
): (text: string) => string {
  switch (kind) {
    case "read":
      return cyan;
    case "write":
      return green;
    case "edit":
      return yellow;
    case "bash":
      return magenta;
    case "search":
      return cyan;
    case "agent":
      return cyan;
    case "think":
      return gray;
    default:
      return (text: string) => text;
  }
}

/** The kind of a tool, by what it does. */
export function kindOf(name: string): ToolBlock["kind"] {
  switch (name) {
    case "read":
      return "read";
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "bash":
      return "bash";
    case "grep":
    case "glob":
      return "search";
    case "task":
      return "agent";
    default:
      return undefined;
  }
}

/** A tool block, collapsed or expanded. */
export function renderToolBlock(block: ToolBlock): string {
  const mark = block.isError === true ? red("✗") : green("●");
  const paint = kindColor(block.kind);
  const name = paint(bold(block.name));
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
  if (block.detail !== undefined && block.detail.length > 0) {
    return block.detail;
  }
  if (block.summary !== undefined && block.summary.length > 0) {
    return block.summary;
  }

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
  if (typeof record.agent === "string") {
    const prompt = typeof record.prompt === "string" ? record.prompt : "";
    return `${record.agent}${prompt.length > 0 ? ` ${firstLine(prompt)}` : ""}`;
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
