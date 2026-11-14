/**
 * What the command line says.
 *
 *   agent                       interactive
 *   agent -p "do the thing"     print mode
 *   agent --json -p "..."       the events as JSON lines
 *   agent --rpc                 JSON lines in, JSON lines out
 */

import type { PermissionMode, PermissionRule } from "@cli-agent/tools";

export type CliMode = "interactive" | "print" | "json" | "rpc";

export interface CliOptions {
  /** What the command does. */
  mode: CliMode;
  /** The prompt, for the modes that take one. */
  prompt?: string;
  /** The "provider/model" ref to use. */
  model: string;
  /** The directory the agent works in. */
  cwd: string;
  /** How much the agent may do without asking. */
  permissionMode: PermissionMode;
  /** The rules, most specific first. */
  rules: PermissionRule[];
  /** Show the tool activity as well as the answer. */
  verbose: boolean;
  /** Carry on with the last session of this directory. */
  continueLast: boolean;
  /** Open a session: named, or the newest one. */
  resume?: string;
}

/** The model used when nothing says otherwise. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";

/** What the command line said, or what is wrong with it. */
export type ParseResult =
  | { ok: true; options: CliOptions }
  | { ok: false; error: string; help?: boolean };

const HELP = `agent — a coding agent

  agent                          start an interactive session
  agent -p "prompt"              print the answer and exit
  agent --json -p "prompt"       the events as JSON lines
  agent --rpc                    read JSON lines, write JSON lines

Options:
  -p, --print <prompt>          the prompt to run
      --model <provider/model>   the model to use (default: ${DEFAULT_MODEL})
      --cwd <dir>                the directory to work in
      --mode <mode>              ask | auto-edit | yolo | plan
      --allow <rule>             allow a call, e.g. "bash(git status) allow"
      --deny <rule>              refuse a call
      --ask <rule>               always ask about a call
      --json                     write the events as JSON lines
      --rpc                      read and write JSON lines
      --continue                 carry on with the last session here
      --resume [id]              open a session (the newest one when none is named)
  -v, --verbose                  show the tool activity
  -h, --help                     this text
`;

/** Read the command line. */
export function parseArgs(argv: string[]): ParseResult {
  const options: CliOptions = {
    mode: "interactive",
    model: process.env.MYAGENT_MODEL?.trim() || DEFAULT_MODEL,
    cwd: process.cwd(),
    permissionMode: "ask",
    rules: [],
    verbose: false,
    continueLast: false,
  };

  let json = false;
  let rpc = false;
  let print: string | undefined;
  let resume: string | undefined;
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;

    switch (argument) {
      case "-h":
      case "--help":
        return { ok: false, error: "", help: true };

      case "-p":
      case "--print": {
        const value = argv[index + 1];
        if (value === undefined) {
          return { ok: false, error: `${argument} needs a prompt` };
        }
        print = value;
        index += 1;
        break;
      }

      case "--json":
        json = true;
        break;

      case "--continue":
        options.continueLast = true;
        break;

      case "--resume": {
        // The session to open; the newest one when nothing is named.
        const value = argv[index + 1];
        if (value !== undefined && !value.startsWith("-")) {
          resume = value;
          index += 1;
        }
        options.resume = resume ?? "";
        break;
      }

      case "--rpc":
        rpc = true;
        break;

      case "--model": {
        const value = argv[index + 1];
        if (value === undefined) {
          return { ok: false, error: "--model needs a provider/model" };
        }
        options.model = value;
        index += 1;
        break;
      }

      case "--cwd": {
        const value = argv[index + 1];
        if (value === undefined) {
          return { ok: false, error: "--cwd needs a directory" };
        }
        options.cwd = value;
        index += 1;
        break;
      }

      case "--mode": {
        const value = argv[index + 1];
        if (value === undefined || !isPermissionMode(value)) {
          return {
            ok: false,
            error: "--mode needs one of: ask, auto-edit, yolo, plan",
          };
        }
        options.permissionMode = value;
        index += 1;
        break;
      }

      case "--allow":
      case "--deny":
      case "--ask": {
        const value = argv[index + 1];
        if (value === undefined) {
          return { ok: false, error: `${argument} needs a rule` };
        }
        const rule = parseRuleArgument(value);
        if (rule === undefined) {
          return {
            ok: false,
            error: `${argument} needs a rule like "bash(git status) allow"`,
          };
        }
        options.rules.push(rule);
        index += 1;
        break;
      }

      case "-v":
      case "--verbose":
        options.verbose = true;
        break;

      default:
        if (argument.startsWith("-")) {
          return { ok: false, error: `unknown option: ${argument}` };
        }
        rest.push(argument);
    }
  }

  if (rpc && json) {
    return { ok: false, error: "--json and --rpc cannot be used together" };
  }

  // A prompt can also come as the last argument.
  const prompt = print ?? (rest.length > 0 ? rest.join(" ") : undefined);

  options.mode = rpc ? "rpc" : json ? "json" : prompt === undefined ? "interactive" : "print";
  if (prompt !== undefined) options.prompt = prompt;

  return { ok: true, options };
}
/** Is this one of the permission modes? */
export function isPermissionMode(value: string): value is PermissionMode {
  return (
    value === "ask" ||
    value === "auto-edit" ||
    value === "yolo" ||
    value === "plan"
  );
}

/**
 * A rule from the command line: "bash(git status) allow", or just the tool
 * and the action, e.g. "read allow".
 */
export function parseRuleArgument(value: string): PermissionRule | undefined {
  const match = /^(.+?)\s+(allow|deny|ask)$/i.exec(value.trim());
  if (match === null) return undefined;

  const [, subject, action] = match;
  const tool = (subject as string).trim();

  const withPattern = /^([A-Za-z_][\w-]*)\((.*)\)$/.exec(tool);
  if (withPattern !== null) {
    return {
      tool: (withPattern[1] as string).toLowerCase(),
      pattern: withPattern[2] as string,
      action: (action as string).toLowerCase() as PermissionRule["action"],
    };
  }

  if (!/^[A-Za-z_][\w-]*$/.test(tool)) return undefined;
  return {
    tool: tool.toLowerCase(),
    action: (action as string).toLowerCase() as PermissionRule["action"],
  };
}

export { HELP };
