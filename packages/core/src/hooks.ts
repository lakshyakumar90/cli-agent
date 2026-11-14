/**
 * Hooks.
 *
 * A hook is a shell command that runs when something happens. The command
 * is given the details on its standard input, and what it does with them
 * is up to it:
 *
 * - `PreToolUse` runs before a tool does its work. A command that exits
 *   with something other than zero stops the call, and what it printed is
 *   the reason the model is given.
 * - `PostToolUse` runs after the tool has done its work. It cannot stop
 *   anything, but what it prints is added to the result, so the model
 *   sees it.
 * - `SessionStart` runs once, when the session opens. What it prints
 *   becomes a note in the prompt.
 *
 * The hooks live in `.myagent/hooks.json`, or in the user's own file:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "bash", "command": "./scripts/no-rm-rf.sh" }
 *       ]
 *     }
 *   }
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  detectShell,
  killTree,
  shellCommand,
  type Shell,
} from "@cli-agent/tools";

/** When a hook runs. */
export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart";

/** The events there are. */
export const HOOK_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
];

/** One hook. */
export interface HookDefinition {
  /**
   * The tool it is for.
   *
   * A name matches that tool, `*` matches all of them, and anything that
   * looks like a regular expression is used as one.
   */
  matcher?: string;
  /** The command to run. */
  command: string;
  /** How long it may take. Default 30 seconds. */
  timeoutMs?: number;
}

/** The hooks of a project. */
export interface HooksConfig {
  /** The hooks, by the event they answer to. */
  hooks: Partial<Record<HookEvent, HookDefinition[]>>;
}

/** Where the hooks are looked for. */
export const HOOK_CONFIG_PATHS = [".myagent/hooks.json"] as const;

/**
 * The hooks that are configured.
 *
 * The project's file comes first, then the user's, so a project can have
 * hooks of its own without losing the rest.
 */
export async function readHooksConfig(
  cwd: string,
  options: { global?: boolean } = {},
): Promise<HooksConfig> {
  const paths: string[] = [];
  if (options.global !== false) {
    paths.push(join(homedir(), ".myagent", "hooks.json"));
  }
  for (const relative of HOOK_CONFIG_PATHS) {
    paths.push(join(cwd, relative));
  }

  const config: HooksConfig = { hooks: {} };

  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // No file, or a file that is not JSON: nothing to add.
      continue;
    }

    const hooks = (parsed as { hooks?: unknown })?.hooks;
    if (hooks === undefined || typeof hooks !== "object") continue;

    for (const [event, list] of Object.entries(
      hooks as Record<string, unknown>,
    )) {
      if (!HOOK_EVENTS.includes(event as HookEvent)) continue;
      if (!Array.isArray(list)) continue;

      const definitions = list
        .filter(
          (entry): entry is HookDefinition =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as HookDefinition).command === "string",
        )
        .map((entry) => ({
          ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
          command: entry.command,
          ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
        }));

      config.hooks[event as HookEvent] = [
        ...(config.hooks[event as HookEvent] ?? []),
        ...definitions,
      ];
    }
  }

  return config;
}

/**
 * The hooks that answer to an event.
 *
 * A hook without a matcher answers to every tool; a hook with one answers
 * to the tools it matches.
 */
export function matchHooks(
  config: HooksConfig,
  event: HookEvent,
  toolName?: string,
): HookDefinition[] {
  const list = config.hooks[event] ?? [];
  if (toolName === undefined) return list;

  return list.filter((hook) => matches(hook.matcher, toolName));
}

/** Does a matcher match a tool? */
export function matches(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined) return true;
  const trimmed = matcher.trim();
  if (trimmed.length === 0 || trimmed === "*") return true;
  if (trimmed === toolName) return true;

  try {
    return new RegExp(trimmed).test(toolName);
  } catch {
    // A matcher that is not a pattern is a name, and it did not match.
    return false;
  }
}

/** What a hook is told. */
export interface HookPayload {
  /** The event that happened. */
  event: HookEvent;
  /** The tool that is being called, when there is one. */
  tool?: string;
  /** What it is called with. */
  args?: unknown;
  /** The directory the agent is working in. */
  cwd: string;
  /** The session, when there is one. */
  sessionId?: string;
}

/** What a hook said. */
export interface HookOutcome {
  /** The command that ran. */
  command: string;
  /** What it printed. */
  output: string;
  /** The exit code, when it had one. */
  code?: number;
  /** It stopped the call. */
  blocked: boolean;
  /** It did not finish in time. */
  timedOut: boolean;
}

export interface HookRunnerOptions {
  /** The directory the hooks run in. */
  cwd: string;
  /** The shell to run them in. */
  shell?: Shell;
  /** Stops the hooks that are running. */
  signal?: AbortSignal;
}

/**
 * Runs the hooks.
 *
 * The hooks of one event run one after another, and the first one that
 * stops the call stops the rest: there is no point in asking the next one
 * about a call that is not going to happen.
 */
export class HookRunner {
  private readonly config: HooksConfig;
  private readonly options: HookRunnerOptions;

  constructor(config: HooksConfig, options: HookRunnerOptions) {
    this.config = config;
    this.options = options;
  }

  /** The hooks that are configured. */
  get definitions(): HooksConfig["hooks"] {
    return this.config.hooks;
  }

  /** Run the hooks of an event. */
  async run(
    event: HookEvent,
    payload: Omit<HookPayload, "event" | "cwd"> & { cwd?: string },
  ): Promise<HookOutcome[]> {
    const hooks = matchHooks(this.config, event, payload.tool);
    if (hooks.length === 0) return [];

    const outcomes: HookOutcome[] = [];

    for (const hook of hooks) {
      const outcome = await this.runOne(hook, {
        event,
        ...(payload.tool === undefined ? {} : { tool: payload.tool }),
        ...(payload.args === undefined ? {} : { args: payload.args }),
        ...(payload.sessionId === undefined
          ? {}
          : { sessionId: payload.sessionId }),
        cwd: payload.cwd ?? this.options.cwd,
      });

      outcomes.push(outcome);

      // A hook that stops the call stops the rest: the next one would be
      // asked about a call that is not going to happen.
      if (outcome.blocked) break;
    }

    return outcomes;
  }

  /** Run one hook. */
  private async runOne(
    hook: HookDefinition,
    payload: HookPayload,
  ): Promise<HookOutcome> {
    const shell = this.options.shell ?? detectShell();
    const [command, args] = shellCommand(shell, shellSafe(hook.command));
    const limit = hook.timeoutMs ?? 30_000;

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      let output = "";
      let timedOut = false;
      let killed = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });

      // The hook is told what happened, as JSON on its standard input.
      try {
        child.stdin?.end(JSON.stringify(payload));
      } catch {
        // A hook that does not read its input is fine.
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, limit);

      const onAbort = (): void => {
        killed = true;
        killTree(child);
      };
      this.options.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", onAbort);
        resolve({
          command: hook.command,
          output: `cannot run the hook: ${error.message}`,
          code: 1,
          blocked: true,
          timedOut: false,
        });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", onAbort);

        // A hook that stops the call is one that did not succeed: it
        // either failed or it did not finish.
        const blocked =
          timedOut || killed ? true : code !== 0 && code !== null;

        resolve({
          command: hook.command,
          output: output.trim(),
          ...(code === null ? {} : { code }),
          blocked,
          timedOut,
        });
      });
    });
  }
}

/** The reason a call was stopped, as the model reads it. */
export function blockReason(outcomes: HookOutcome[]): string {
  const parts = outcomes
    .filter((outcome) => outcome.blocked)
    .map((outcome) => {
      const reason = outcome.output.length > 0 ? outcome.output : "no reason given";
      return `${outcome.command}: ${reason}`;
    });

  return `the call was stopped by a hook.\n${parts.join("\n")}`;
}

/**
 * A command the shell can run.
 *
 * A path on Windows is written with backslashes, but the shell wants
 * forward slashes: `C:\hooks\check.sh` is `C:/hooks/check.sh` to bash.
 * Only the first word is touched, so the rest of the command is left
 * exactly as it was written.
 */
export function shellSafe(command: string): string {
  const match = /^("[^"]+"|'[^']+'|\S+)([\s\S]*)$/.exec(command);
  if (match === null) return command;

  const first = match[1] as string;
  const rest = match[2] as string;

  if (!/^[A-Za-z]:[\\/]/.test(first)) return command;

  return `${first.replace(/\\/g, "/")}${rest}`;
}
