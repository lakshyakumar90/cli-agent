/**
 * The locally installed opencode CLI, driven as a provider.
 *
 * Some backends are only reachable through a tool that is already logged in
 * on the user's machine — opencode is one of them: its Zen API refuses
 * requests that its own CLI happily serves, because the CLI carries a
 * different session. This adapter runs `opencode run --format json` and
 * translates the CLI's JSONL events into the unified events, so the agent
 * loop cannot tell the difference.
 *
 * The prompt is written to the child's **stdin**, never to the command line:
 * the CLI reads the message from stdin when no message argument is given, so
 * nothing user-authored ever reaches a shell.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { ProviderError } from "../errors.js";
import type {
  Event,
  ModelInfo,
  Msg,
  Provider,
  StopReason,
  StreamRequest,
  Usage,
} from "../types.js";

export interface LocalOpencodeOptions {
  /** Provider id used in `"provider/model"` refs. Defaults to `"opencode"`. */
  id?: string;
  /** The executable to run. Defaults to `"opencode"`, resolved on PATH. */
  command?: string;
  /** Extra arguments placed before the subcommand. */
  args?: string[];
  /** Working directory for the CLI. Defaults to the current directory. */
  cwd?: string;
  /** opencode's own agent to run. Defaults to the CLI's own default. */
  agent?: string;
  /** Kill the turn after this long. Defaults to 10 minutes. */
  timeoutMs?: number;
}

/** One JSONL event as the CLI writes it. */
interface CliEvent {
  type?: string;
  part?: {
    type?: string;
    text?: string;
    reason?: string;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Characters a shell still interprets inside double quotes. The prompt never
 * reaches the command line, so only the executable, the flags and the model
 * id do — and a model id with one of these in it is a mistake worth
 * reporting rather than quoting around.
 */
const SHELL_UNSAFE = /[%!]/;

function quote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

/** Kill the CLI and everything it started. */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGTERM");
}

/** Flatten the conversation into one prompt for the CLI. */
function toPrompt(system: string, messages: Msg[]): string {
  const parts: string[] = [];

  if (system.trim().length > 0) {
    parts.push(`<system>\n${system}\n</system>`);
  }

  for (const message of messages) {
    if (message.role === "user") {
      parts.push(`<user>\n${message.content}\n</user>`);
      continue;
    }
    if (message.role === "tool") {
      parts.push(
        `<tool-result name="${message.callId}">\n${message.content}\n</tool-result>`,
      );
      continue;
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    parts.push(`<assistant>\n${text}\n</assistant>`);
  }

  return parts.join("\n\n");
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case "tool-calls":
    case "tool_call":
      return "tool";
    case "length":
    case "max-tokens":
      return "length";
    default:
      return "end";
  }
}

export function localOpencode(options: LocalOpencodeOptions = {}): Provider {
  const {
    id = "opencode",
    command = "opencode",
    args: extraArgs = [],
    cwd = process.cwd(),
    agent,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  /**
   * Run the CLI and yield its stdout, one line at a time.
   *
   * The CLI prints banners and logs as well as JSON, so lines are handed on
   * as they are and the caller decides what is meaningful.
   */
  async function* run(
    cliArgs: string[],
    stdin: string | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<string> {
    const child = spawn(
      buildCommandLine([command, ...extraArgs, ...cliArgs], id),
      {
        cwd,
        // The npm shim is a .cmd file on Windows, which needs a shell to run.
        // Nothing user-authored is in the arguments; the prompt goes to stdin.
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const queue: string[] = [];
    let notify: (() => void) | undefined;
    let failure: ProviderError | undefined;
    let stderr = "";
    let closed = false;

    const wake = (): void => {
      notify?.();
      notify = undefined;
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.length > 0) queue.push(line);
      }
      wake();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      failure = new ProviderError(
        `opencode: cannot run "${command}" — ${error.message}`,
        { provider: id, code: "network", cause: error },
      );
      wake();
    });

    child.on("close", (code) => {
      closed = true;
      if (failure === undefined && code !== 0) {
        const detail = stderr.trim().split("\n").slice(-3).join(" ").trim();
        failure = new ProviderError(
          `opencode: exited with code ${code}${detail.length > 0 ? ` — ${detail}` : ""}`,
          { provider: id, code: "protocol", body: stderr.slice(0, 2000) },
        );
      }
      wake();
    });

    if (stdin !== undefined) {
      // The CLI may exit before reading the prompt; the exit code covers it.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin, "utf8");
    } else {
      // Nothing to send: close the pipe so the CLI does not wait for input.
      child.stdin?.end();
    }

    const timer = setTimeout(() => {
      killTree(child);
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift() as string;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (closed) break;
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
      if (failure !== undefined) throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) killTree(child);
    }
  }

  async function* stream(request: StreamRequest): AsyncGenerator<Event> {
    const { model, system, messages, signal } = request;

    const cliArgs = ["run", "--model", model, "--format", "json"];
    if (agent !== undefined) cliArgs.push("--agent", agent);

    let usage: Usage | undefined;
    let stop: StopReason | undefined;

    try {
      for await (const line of run(cliArgs, toPrompt(system, messages), signal)) {
        const event = parseLine(line);
        if (event === undefined) continue;

        const part = event.part;
        if (part === undefined) continue;

        if (part.type === "text" && typeof part.text === "string") {
          yield { t: "text", delta: part.text };
          continue;
        }
        if (part.type === "reasoning" && typeof part.text === "string") {
          yield { t: "thinking", delta: part.text };
          continue;
        }
        if (part.type === "step-finish") {
          const tokens = part.tokens;
          usage = {
            inputTokens: tokens?.input ?? 0,
            outputTokens: tokens?.output ?? 0,
            ...(tokens?.cache?.read === undefined
              ? {}
              : { cacheReadTokens: tokens.cache.read }),
            ...(tokens?.cache?.write === undefined
              ? {}
              : { cacheWriteTokens: tokens.cache.write }),
          };
          stop = mapStopReason(part.reason);
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new ProviderError("opencode: run aborted", {
          provider: id,
          code: "aborted",
          cause: error,
        });
      }
      throw error;
    }

    yield {
      t: "done",
      usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      stop: stop ?? "end",
    };
  }

  const models = async (): Promise<ModelInfo[]> => {
    const found: ModelInfo[] = [];
    for await (const line of run(["models"], undefined, undefined)) {
      const trimmed = line.trim();
      // The CLI prints one "provider/model" per line.
      if (!/^[\w.-]+\/[\w./-]+$/.test(trimmed)) continue;
      found.push({ id: trimmed, provider: id });
    }
    return found;
  };

  return { id, models, stream };
}

/** Join the executable and its arguments into one shell-safe command line. */
function buildCommandLine(parts: string[], provider: string): string {
  for (const part of parts) {
    if (SHELL_UNSAFE.test(part)) {
      throw new ProviderError(
        `opencode: refusing to run "${part}" through a shell — the character is not allowed in a model id or path`,
        { provider, code: "protocol" },
      );
    }
  }
  return parts.map(quote).join(" ");
}

function parseLine(line: string): CliEvent | undefined {  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as CliEvent)
      : undefined;
  } catch {
    // Not every line the CLI prints is JSON.
    return undefined;
  }
}
