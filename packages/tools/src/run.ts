/**
 * Running a program and collecting what it says.
 */

import { spawn } from "node:child_process";

export interface CommandResult {
  /** Everything the program wrote, stdout and stderr together. */
  output: string;
  /** The exit code, or undefined when it was killed. */
  code?: number;
  /** True when the program had to be stopped. */
  timedOut: boolean;
}

export interface CommandOptions {
  /** The directory to run in. */
  cwd?: string;
  /** How long it may run. */
  timeoutMs?: number;
}

/** Run a program and wait for it. */
export function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const { cwd, timeoutMs = 30_000 } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(cwd === undefined ? {} : { cwd }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ output: error.message, timedOut: false });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, ...(code === null ? {} : { code }), timedOut });
    });
  });
}
