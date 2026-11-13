/**
 * Slash commands, and the shell escape.
 *
 * A line that starts with "/" is a command for the agent, not a message
 * for the model. A line that starts with "!" is a shell command.
 */

import type { PermissionMode } from "@cli-agent/tools";

/** The commands the agent understands. */
export const SLASH_COMMANDS = [
  { name: "/model", description: "show or change the model" },
  { name: "/login", description: "sign in to a provider" },
  { name: "/compact", description: "summarise the conversation" },
  { name: "/clear", description: "start a new conversation" },
  { name: "/resume", description: "go back to an earlier conversation" },
  { name: "/agents", description: "list or switch the agent" },
] as const;

export type SlashName = (typeof SLASH_COMMANDS)[number]["name"];

/** A command the user typed. */
export interface SlashCommand {
  /** The command, e.g. "/model". */
  name: string;
  /** What came after it. */
  args: string;
  /** The line as it was typed. */
  raw: string;
}

/** Is this line a command? */
export function parseSlash(line: string): SlashCommand | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const args = space === -1 ? "" : trimmed.slice(space + 1).trim();

  return { name: name.toLowerCase(), args, raw: trimmed };
}

/** Is this a command we know? */
export function isKnownSlash(command: SlashCommand): boolean {
  return SLASH_COMMANDS.some((known) => known.name === command.name);
}

/** A shell command the user typed with "!". */
export interface ShellEscape {
  /** The command to run. */
  command: string;
}

/** Is this line a shell command? */
export function parseShellEscape(line: string): ShellEscape | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("!")) return undefined;

  const command = trimmed.slice(1).trim();
  if (command.length === 0) return undefined;
  return { command };
}

/** The permission modes, in the order Shift+Tab cycles them. */
export const PERMISSION_CYCLE: PermissionMode[] = [
  "ask",
  "auto-edit",
  "yolo",
  "plan",
];

/** The next permission mode. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  const index = PERMISSION_CYCLE.indexOf(mode);
  const next = PERMISSION_CYCLE[(index + 1) % PERMISSION_CYCLE.length];
  return next ?? "ask";
}
