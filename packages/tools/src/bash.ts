/**
 * bash — run a command.
 *
 * The output is capped so a runaway command cannot fill the model's context:
 * the head and the tail are kept and the middle is replaced by a note about
 * how much was left out.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type Tool } from "./types.js";
import { resolvePath } from "./paths.js";
import { findOnPath, hasProgram } from "./exec.js";

/** The most output that is kept. */
export const DEFAULT_MAX_OUTPUT = 30_000;
/** How long a command may run. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** The longest a command may run, however long it asks for. */
export const MAX_TIMEOUT_MS = 600_000;

export interface BashOptions {
  /** The most characters of output that are kept. */
  maxOutput?: number;
  /** How long a command may run. */
  timeoutMs?: number;
  /** The shell to run in. Defaults to the platform's. */
  shell?: Shell;
  /**
   * Run the command inside a sandbox.
   *
   * The tool runs commands with the user's own rights, which is enough for
   * a trusted session and nothing like enough for an untrusted one. Docker,
   * bubblewrap and sandbox-exec are the real answers; this is where they go.
   */
  sandbox?: Sandbox;
}

/**
 * A sandbox: it turns a command into the command line that runs it inside.
 */
export interface Sandbox {
  /** The program and its arguments. */
  wrap(command: string, cwd: string): [string, string[]];
}

/**
 * Run the command in a container.
 *
 * The workspace is mounted at /work and is the only writable place. The
 * image has to carry the tools the project needs.
 */
export function dockerSandbox(
  options: { image?: string; extraArgs?: string[] } = {},
): Sandbox {
  const { image = "node:22-alpine", extraArgs = [] } = options;

  return {
    wrap(command: string, cwd: string): [string, string[]] {
      return [
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "-v",
          `${cwd}:/work`,
          "-w",
          "/work",
          ...extraArgs,
          image,
          "sh",
          "-c",
          command,
        ],
      ];
    },
  };
}

/**
 * Run the command in a bubblewrap sandbox.
 *
 * The filesystem is read-only except for the workspace, and the process gets
 * its own namespaces.
 */
export function bubblewrapSandbox(
  options: { extraArgs?: string[] } = {},
): Sandbox {
  const { extraArgs = [] } = options;

  return {
    wrap(command: string, cwd: string): [string, string[]] {
      return [
        "bwrap",
        [
          "--ro-bind",
          "/",
          "/",
          "--bind",
          cwd,
          cwd,
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--unshare-all",
          ...extraArgs,
          "sh",
          "-c",
          command,
        ],
      ];
    },
  };
}

/** The shells a command can run in. */
export type Shell = "bash" | "powershell" | "cmd";

export function createBashTool(options: BashOptions = {}): Tool {
  const {
    maxOutput = DEFAULT_MAX_OUTPUT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    shell = detectShell(),
    sandbox,
  } = options;

  return defineTool({
    name: "bash",
    effect: "execute",
    description:
      "Run a shell command and return its output. Long commands are stopped; very long output is shortened.",
    schema: z.object({
      command: z.string().describe("The command to run."),
      timeout: z
        .number()
        .int()
        .min(1)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe("How long the command may run, in milliseconds."),
      cwd: z
        .string()
        .optional()
        .describe("The directory to run in. Defaults to the working directory."),
    }),
    async run(args, ctx) {
      const cwd = args.cwd === undefined ? ctx.cwd : resolvePath(ctx.cwd, args.cwd);
      const limit = Math.min(args.timeout ?? timeoutMs, MAX_TIMEOUT_MS);

      const [command, commandArgs] =
        sandbox === undefined
          ? shellCommand(shell, args.command)
          : sandbox.wrap(args.command, cwd);

      return new Promise((resolve) => {
        const child = spawn(command, commandArgs, {
          cwd,
          env: { ...process.env, ...shellEnv(shell) },
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so the whole tree can be stopped at once.
          detached: process.platform !== "win32",
        });

        let output = "";
        let timedOut = false;
        let killed = false;

        const collect = (chunk: Buffer): void => {
          const text = chunk.toString("utf8");
          output += text;
          ctx.onOutput?.(text);
        };

        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);

        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, limit);

        const onAbort = (): void => {
          killed = true;
          killTree(child);
        };
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", (error) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolve({
            output: `cannot run the command: ${error.message}`,
            isError: true,
          });
        });

        child.on("close", (code, signal) => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);

          if (timedOut) {
            resolve({
              output: `the command timed out after ${Math.round(limit / 1000)}s\n${shorten(output, maxOutput)}`,
              isError: true,
            });
            return;
          }

          if (killed) {
            resolve({
              output: `the command was stopped\n${shorten(output, maxOutput)}`,
              isError: true,
            });
            return;
          }

          const body = shorten(output, maxOutput);
          const status =
            code === 0
              ? ""
              : `\n(the command exited with ${code ?? `signal ${signal}`})`;
          resolve({
            output: body.length > 0 ? `${body}${status}` : status.trim(),
            ...(code === 0 ? {} : { isError: true }),
          });
        });
      });
    },
  });
}

/**
 * Stop a command and everything it started.
 *
 * Killing the shell is not enough: the command it is running would go on
 * without it.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Keep the head and the tail of a long output, and say what was left out.
 */
export function shorten(output: string, maxOutput: number): string {
  if (output.length <= maxOutput) return output;

  const head = Math.floor(maxOutput / 2);
  const tail = maxOutput - head;
  const omitted = output.length - maxOutput;
  return `${output.slice(0, head)}\n\n... ${omitted} characters omitted ...\n\n${output.slice(-tail)}`;
}

/** The shell to use when none is named. */
export function detectShell(): Shell {
  if (process.platform === "win32") {
    // Git Bash understands the commands a model writes. The bash.exe in
    // System32 is the WSL stub, which needs a distribution to work.
    if (resolveBash() !== undefined) return "bash";
    if (hasProgram("pwsh.exe")) return "powershell";
    if (hasProgram("powershell.exe")) return "powershell";
    return "cmd";
  }
  return "bash";
}

/** The bash to run in: Git Bash if it is installed, else one on PATH. */
export function resolveBash(): string | undefined {
  if (process.platform !== "win32") {
    return findOnPath("bash") ?? "/bin/bash";
  }

  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const gitBash = join(programFiles, "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) return gitBash;

  const found = findOnPath("bash.exe");
  if (found !== undefined && !/system32/i.test(found)) return found;
  return undefined;
}

/** The command and its arguments for a shell. */
export function shellCommand(shell: Shell, command: string): [string, string[]] {
  switch (shell) {
    case "powershell":
      return [
        hasProgram("pwsh.exe") ? "pwsh.exe" : "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
      ];
    case "cmd":
      return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]];
    case "bash":
    default:
      return [resolveBash() ?? "bash", ["-c", command]];
  }
}

/** The environment a shell needs to behave. */
function shellEnv(shell: Shell): NodeJS.ProcessEnv {
  if (shell === "bash") {
    // Git Bash reads its PATH from the Windows PATH, but it also needs to know
    // where it lives to find its own tools.
    return { MSYSTEM: "MINGW64", CHERE_INVOKING: "1" };
  }
  return {};
}

