/**
 * The locally installed opencode CLI, driven as a provider.
 *
 * Some backends are only reachable through a tool that is already logged in
 * on the user's machine — opencode is one of them: its Zen API refuses
 * requests that its own CLI happily serves, because the CLI carries a
 * different session. This adapter runs the CLI and translates its JSONL
 * events into the unified events, so the agent loop cannot tell the
 * difference.
 *
 * The prompt is written to the child's **stdin**, never to the command line:
 * the CLI reads the message from stdin when no message argument is given, so
 * nothing user-authored ever reaches a shell.
 *
 * The CLI is driven through a **private server of our own** that lives as
 * long as the provider does. `opencode run --standalone` starts a fresh
 * server for every single turn, and that startup costs several seconds
 * before the model is even asked; one server for the whole session pays for
 * it once. The server is ours — the user's own background service and their
 * global configuration are never touched — and it is stopped when the
 * provider is closed.
 *
 * The server is asked where it listens, and that is all that is waited for:
 * the password line is only printed by a server that was given a password
 * to ask for, and waiting for a line that will not come costs the whole
 * timeout on every machine whose server has none. A server that cannot be
 * started at all is remembered, so that no turn pays for the attempt again.
 *
 * The agent the server serves is **defined in the configuration** we hand
 * it, not installed as a plugin. A plugin has to be resolved, activated and
 * registered before the server will answer, and that is where the OpenCode
 * of 2.2 loses ten seconds and sometimes the whole turn: a plugin that has
 * not finished activating answers "Location plugins did not finish
 * activating", and the models of the CLI cannot be read at all. A
 * configuration agent is there the moment the server is.
 *
 * The agent has a **prompt of its own** and **no native tool**: the tools
 * of the host are run by the host, under the permissions of the host. A
 * model that asks for a tool of the CLI anyway is refused by it — every
 * native tool of the agent is off — and the call is run by the host
 * instead. A model that writes the call as text is read as text.
 */

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "../errors.js";
import type {
  Event,
  ModelInfo,
  Msg,
  Provider,
  StopReason,
  StreamRequest,
  Usage,
  ToolSpec,
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
  /**
   * The OpenCode agent whose profile the host agent copies.
   * Defaults to `"build"`.
   */
  agent?: string;
  /** Kill the turn after this long. Defaults to 2 minutes. */
  timeoutMs?: number;
  /** How long the private server may take to come up. Defaults to 20s. */
  serverTimeoutMs?: number;
  /**
   * How long the catalog may keep being read while the CLI is cold.
   * Defaults to 45 seconds.
   */
  catalogBudgetMs?: number;
}

/** One JSONL event as the CLI writes it. */
interface CliEvent {
  type?: string;
  error?: { message?: string; status?: number; data?: { message?: string } };
  part?: {
    id?: string;
    type?: string;
    text?: string;
    reason?: string;
    tool?: string;
    state?: {
      status?: string;
      error?: string;
      output?: string;
      input?: unknown;
    };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
}

const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_SERVER_TIMEOUT_MS = 20_000;
const DEFAULT_CATALOG_BUDGET_MS = 45_000;
/**
 * How long the reader waits for the last of the output.
 *
 * The command runs through a shell, and the process the shell starts can
 * hold the pipe open long after the command itself is done. The reader must
 * not wait for that for ever: the output is already there, and the answer
 * must not be lost to a pipe that nobody closes.
 */
const DRAIN_MS = 500;
const TOOL_TAG = "<cli-agent-tool>";
/**
 * The wrapper some models put around the tool block.
 *
 * It is not part of the protocol, and it is not shown to the user.
 */
const TOOL_WRAPPER = /<\/?tool_calls?>\s*/g;

/**
 * The host agent, and the configuration that carries it.
 *
 * The agent is a plain entry in the OpenCode configuration: it has no native
 * tools at all, so the only tools the model can reach are the ones the host
 * offers through the text protocol. Nothing is installed, nothing is
 * resolved, and nothing has to activate before the server answers.
 */
interface Guard {
  /** The agent id the CLI is asked to use. */
  agent: string;
  /** The configuration content, as JSON. */
  config: string;
}

/** A private OpenCode server of our own. */
interface PrivateServer {
  /** Where the server listens. */
  url: string;
  /**
   * The password the server asks for, when it asks for one.
   *
   * Most servers do not ask for one: the line is only printed when the
   * server was given a password to ask for. Waiting for that line would
   * mean waiting for a timeout on every machine whose server has no
   * password, which is the normal case.
   */
  password?: string;
  /** The process it runs in. */
  child: ChildProcess;
}

/** The agent the host drives the CLI with. */
const HOST_AGENT = "cli-agent-host";

/**
 * The native tools of OpenCode, all of them off.
 *
 * The host runs the tools itself, under its own permission rules. A tool
 * that the CLI would run on its own would bypass them, so every one of them
 * is named and turned off.
 */
const NATIVE_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "list",
  "patch",
  "webfetch",
  "websearch",
  "task",
  "todowrite",
  "todoread",
] as const;

/**
 * The prompt of the host agent.
 *
 * The agent has a prompt of its own, and it is this one: the profile of the
 * agent of the machine is not copied, because that profile is written for
 * the tools of that machine, and the model that reads it will reach for
 * those instead of the tools of the host.
 */
const HOST_AGENT_PROMPT = `You are a coding agent driven by an external host program.

The host runs the tools itself, under its own permission checks. The tools
you can reach are the ones the host lists, with the names the host gives
them. None of the tools of this program are yours to use: when you ask for
one of them, the host runs it for you.

To use a tool, write this and nothing else, on one line:

<cli-agent-tool>{"name":"tool_name","args":{...}}</cli-agent-tool>

No Markdown fence, no explanation, no text before or after the block. Stop as
soon as the block is written: the next message will carry the result of the
call, and you will be asked to carry on.

Never write a result yourself, and never use a tool that is not in the list.
When you do not need a tool, answer the user in plain text.`;

/**
 * The configuration the private server is started with.
 *
 * The user's own configuration is kept and added to: their model, their
 * provider and their plugins still apply. The host agent is added on top.
 */
export function guardedConfig(source: string): Guard {
  let config: Record<string, unknown> = {};
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    const value: unknown = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
    config = value as Record<string, unknown>;
  }

  const agents = (config.agent ?? {}) as Record<string, unknown>;
  const tools: Record<string, boolean> = { "*": false };
  for (const tool of NATIVE_TOOLS) tools[tool] = false;

  const inherited =
    typeof agents[source] === "object" && agents[source] !== null
      ? (agents[source] as Record<string, unknown>)
      : {};

  const agent = {
    // The profile of the named agent is kept: the model, and the rest of
    // what the user configured for it.
    ...inherited,
    id: HOST_AGENT,
    description: "Driven by an external host",
    mode: "primary",
    // The prompt is the one of the host, never the one of the machine: the
    // prompt of the machine tells the model about tools that are not ours,
    // and the model will reach for those instead of the ones we offer.
    prompt: HOST_AGENT_PROMPT,
    // No native tool is reachable: the host offers its own.
    tools,
  };

  return {
    agent: HOST_AGENT,
    config: JSON.stringify({
      ...config,
      agent: { ...agents, [HOST_AGENT]: agent },
    }),
  };
}

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

/**
 * The folders the opencode CLI is installed into.
 *
 * Each package manager puts it somewhere of its own, and a CLI that is
 * installed but not on the path is a different problem from one that is not
 * installed at all — so the agent looks, and says where it looked.
 */
export function opencodeSearchPaths(): string[] {
  const home = homedir();
  const paths: string[] = [];

  if (process.env.APPDATA !== undefined)
    paths.push(join(process.env.APPDATA, "npm"));
  if (process.env.LOCALAPPDATA !== undefined)
    paths.push(join(process.env.LOCALAPPDATA, "pnpm"));
  paths.push(join(home, ".bun", "bin"));
  paths.push(join(home, ".local", "bin"));
  paths.push("/usr/local/bin");
  paths.push("/opt/homebrew/bin");

  return [...new Set(paths)];
}

/** The names the executable has, on each platform. */
function opencodeNames(): string[] {
  return process.platform === "win32"
    ? ["opencode.cmd", "opencode.exe", "opencode.bat"]
    : ["opencode"];
}

/**
 * The opencode CLI, when it is installed somewhere the path does not have.
 *
 * The answer is the path to set `MYAGENT_OPENCODE_COMMAND` to, so the user
 * does not have to look for it themselves.
 */
export function findOpencodeCommand(): string | undefined {
  for (const directory of opencodeSearchPaths()) {
    for (const name of opencodeNames()) {
      const full = join(directory, name);
      try {
        if (existsSync(full)) return full;
      } catch {
        // A folder that cannot be read is a folder without the CLI.
      }
    }
  }
  return undefined;
}

/**
 * What to say when the CLI cannot be run at all.
 *
 * The user is told whether the program is missing or merely out of reach,
 * and where it was looked for: "install it" is the wrong advice for a
 * program that is installed and only the path is wrong.
 */
export function missingCommandAdvice(): string {
  const found = findOpencodeCommand();
  if (found !== undefined)
    return `The opencode CLI is installed at "${found}" but is not on the path — set MYAGENT_OPENCODE_COMMAND to it.`;
  return `The opencode CLI is not on the path. It was looked for in ${opencodeSearchPaths().join(", ")}. Install it, or set MYAGENT_OPENCODE_COMMAND to where it is.`;
}

/** Does this failure say that the program itself is not there? */
function saysMissingProgram(text: string): boolean {
  return (
    text.includes("is not recognized") ||
    text.includes("not recognized as an internal") ||
    text.includes("command not found") ||
    text.includes("No such file or directory") ||
    text.includes("cannot run")
  );
}

/** Does this failure say the CLI has no login for the model asked for? */
function saysSignedOut(text: string): boolean {
  return text.includes("no credentials for");
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

/**
 * What the CLI said on its error stream.
 *
 * The first line names the failure; the last lines are the stack. Both are
 * kept, because the first line is what tells one failure from another.
 */
function stderrDetail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const head = lines[0] ?? "";
  const tail = lines.slice(-2).join(" ").trim();
  if (head.length === 0) return "";
  return tail.length > 0 && tail !== head ? `${head} — ${tail}` : head;
}

/** Flatten the conversation into one prompt for the CLI. */
function toPrompt(system: string, messages: Msg[], tools: ToolSpec[]): string {
  const parts: string[] = [];

  if (system.trim().length > 0) {
    parts.push(`<system>\n${system}\n</system>`);
  }

  if (tools.length) {
    const listed = tools.map((tool) => ({
      ...tool,
      name: tool.name,
    }));
    // The example is a real tool of the list: a model that copies the
    // example asks for a tool that exists.
    const example = listed[0];
    const shape =
      example === undefined
        ? '{"name":"tool_name","args":{...}}'
        : `{"name":"${example.name}","args":{...}}`;

    parts.push(`<external-tools>
The host runs these tools for you, under its own permission checks. The tools of this program are not yours to use: when you ask for one of them, the host runs it for you.

To use a tool, write this and nothing else, on one line:

<cli-agent-tool>${shape}</cli-agent-tool>

The rules:
- One block per tool call. Two blocks in a row are allowed.
- No Markdown fence, no explanation, no text before or after the block.
- The name is the name of the tool in the list below, and nothing else.
- Stop as soon as the blocks are written: the next message will carry the results.
- Never write a result yourself.
- Use only the names of the list below.

The tools:
${JSON.stringify(listed)}
</external-tools>`);
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
      .filter((block) => block.type !== "thinking")
      .map((block) =>
        block.type === "text"
          ? block.text
          : `${TOOL_TAG}${JSON.stringify({
              id: block.id,
              name: block.name,
              args: block.args,
            })}</cli-agent-tool>`,
      )
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

/**
 * JSON that a model wrote, read as leniently as it can be.
 *
 * A model that puts a Windows path in a string of JSON writes "\L" and
 * "\c", and those are not escapes JSON knows. The backslash is what it
 * meant, so it is kept.
 */
function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    try {
      return JSON.parse(repaired);
    } catch {
      return undefined;
    }
  }
}

/**
 * The call the model asked for, as a call of the host.
 *
 * A model that is asked for a tool it cannot reach sends the call in the
 * way it knows: a call of its own, with the name of the tool. The name is
 * the name of the host tool when it is one of ours, and the arguments are
 * the arguments of the call. A model that is not that careful puts the
 * whole call in the arguments of a call it made up — and it writes the
 * arguments as a string of JSON more often than not — and the call is read
 * out of them.
 */
function hostCall(
  tool: string | undefined,
  args: unknown,
  tools: ToolSpec[],
): { name: string; args: unknown } | undefined {
  const asObject = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === "string") {
      const parsed = parseLoose(value);
      if (parsed === undefined) return undefined;
      value = parsed;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
    return undefined;
  };

  const known = (name: string): string | undefined => {
    const wanted = name;
    return tools.some((one) => one.name === wanted) ? wanted : undefined;
  };

  // The name of the call is one of ours.
  if (tool !== undefined) {
    const name = known(tool);
    const arguments_ = asObject(args);
    if (name !== undefined && arguments_ !== undefined)
      return { name, args: arguments_ };
  }

  // The call is in the arguments of a call the model made up.
  const inner = asObject(args);
  if (inner !== undefined) {
    const wanted = inner.name ?? inner.tool;
    if (typeof wanted === "string") {
      const name = known(wanted);
      const arguments_ = asObject(
        inner.args ?? inner.arguments ?? inner.input ?? inner.parameters,
      );
      if (name !== undefined && arguments_ !== undefined)
        return { name, args: arguments_ };
    }
  }

  return undefined;
}

/**
 * How many characters at the end of some text could still be the beginning
 * of the tool tag.
 *
 * The text is held back by that much before it is shown, so that a tag
 * that arrives in pieces is never half shown to the user.
 */
function partialTagLength(text: string): number {
  const longest = Math.min(text.length, TOOL_TAG.length - 1);
  for (let length = longest; length > 0; length--) {
    if (TOOL_TAG.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

export function localOpencode(options: LocalOpencodeOptions = {}): Provider {
  const {
    id = "opencode",
    command = process.env.MYAGENT_OPENCODE_COMMAND || "opencode",
    args: extraArgs = [],
    cwd = process.cwd(),
    agent,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    serverTimeoutMs = DEFAULT_SERVER_TIMEOUT_MS,
    catalogBudgetMs = DEFAULT_CATALOG_BUDGET_MS,
  } = options;

  let guard: Guard | undefined;
  let server: PrivateServer | undefined;
  let serverPromise: Promise<PrivateServer | undefined> | undefined;
  /** Set when this OpenCode cannot serve a private server at all. */
  let noPrivateServer = false;
  /** Why the private server could not be started, when it could not. */
  let serverFailure: ProviderError | undefined;

  /** The host agent, made once and kept for as long as the provider lives. */
  const ensureGuard = (): Guard => {
    guard ??= guardedConfig(agent ?? "build");
    return guard;
  };

  /**
   * The private server, started once and shared by every turn.
   *
   * When the OpenCode on this machine cannot serve one — an older CLI with
   * no `serve` subcommand — the turns fall back to `--standalone`, which is
   * slower but works.
   */
  const ensureServer = async (): Promise<PrivateServer | undefined> => {
    if (noPrivateServer) return undefined;
    if (server !== undefined) {
      if (server.child.exitCode === null) return server;
      server = undefined;
    }
    serverPromise ??= (async () => {
      try {
        const started = await startServer(ensureGuard());
        server = started;
        started.child.once("exit", () => {
          if (server === started) {
            server = undefined;
            serverPromise = undefined;
          }
        });
        return started;
      } catch (error) {
        serverPromise = undefined;
        // A server that cannot be started is remembered, so every turn does
        // not pay for the attempt again. Waiting for a timeout on every
        // turn is what made the agent feel slow.
        noPrivateServer = true;
        serverFailure =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                `opencode: the private server could not be started — ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { provider: id, code: "protocol" },
              );
        return undefined;
      }
    })();
    return serverPromise;
  };

  /** Start the private server and wait for it to say where it listens. */
  async function startServer(made: Guard): Promise<PrivateServer> {
    const child = spawn(
      buildCommandLine(
        [command, ...extraArgs, "serve", "--port", "0"],
        id,
      ),
      {
        cwd,
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: made.config },
        // The npm shim is a .cmd file on Windows, which needs a shell to run.
        // Nothing user-authored is in the arguments; the prompt goes to stdin.
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let buffer = "";
    let url: string | undefined;
    let password: string | undefined;
    let stderr = "";
    let failure: ProviderError | undefined;
    let wake: (() => void) | undefined;

    const ready = new Promise<void>((resolve) => {
      wake = resolve;
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const listening = /server listening on (\S+)/.exec(line);
        if (listening) url = listening[1];
        const secret = /server password (\S+)/.exec(line);
        if (secret) password = secret[1];
        // The address is enough to talk to the server. The password line
        // is only printed by a server that was given a password to ask
        // for, and waiting for it would cost the whole timeout on every
        // machine whose server has none.
        if (url !== undefined) wake?.();
        index = buffer.indexOf("\n");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });

    child.on("error", (error) => {
      failure = new ProviderError(
        `opencode: cannot run "${command}" — ${error.message}. ${missingCommandAdvice()}`,
        { provider: id, code: "network", cause: error },
      );
      wake?.();
    });

    child.on("exit", () => {
      // The process is gone without saying where it listens: the reader
      // must not wait for a pipe that nobody closes.
      const detail = stderrDetail(stderr);
      const advice = saysMissingProgram(detail)
        ? ` ${missingCommandAdvice()}`
        : "";
      failure ??= new ProviderError(
        `opencode: the private server exited before it was ready${
          detail.length > 0 ? ` — ${detail}` : ""
        }${advice}`,
        { provider: id, code: "protocol", body: stderr.slice(0, 2000) },
      );
      wake?.();
    });

    child.on("close", (code) => {
      const detail = stderrDetail(stderr);
      failure ??= new ProviderError(
        `opencode: the private server exited with code ${code}${
          detail.length > 0 ? ` — ${detail}` : ""
        }`,
        { provider: id, code: "protocol", body: stderr.slice(0, 2000) },
      );
      wake?.();
    });

    const timer = setTimeout(() => {
      failure = new ProviderError(
        `opencode: the private server did not start within ${Math.round(
          serverTimeoutMs / 1000,
        )}s${serverFailure === undefined ? "" : ` — ${serverFailure.message}`}`,
        { provider: id, code: "network", retryable: false },
      );
      wake?.();
    }, serverTimeoutMs);
    timer.unref();

    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }

    if (url === undefined) {
      killTree(child);
      throw (
        failure ??
        new ProviderError("opencode: the private server did not start", {
          provider: id,
          code: "protocol",
        })
      );
    }

    return { url, ...(password === undefined ? {} : { password }), child };
  }

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
    environment: { config?: string; env?: Record<string, string> } = {},
  ): AsyncGenerator<string> {
    signal?.throwIfAborted();
    const child = spawn(
      buildCommandLine([command, ...extraArgs, ...cliArgs], id),
      {
        cwd,
        env: {
          ...process.env,
          ...(environment.config === undefined
            ? {}
            : { OPENCODE_CONFIG_CONTENT: environment.config }),
          ...(environment.env ?? {}),
        },
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
    let pendingLine = "";
    let closed = false;
    let exited = false;
    let drain: NodeJS.Timeout | undefined;

    const wake = (): void => {
      notify?.();
      notify = undefined;
    };

    /** The command is gone: what is left is what was written. */
    const scheduleClose = (): void => {
      if (drain !== undefined) clearTimeout(drain);
      drain = setTimeout(() => {
        drain = undefined;
        closed = true;
        wake();
      }, DRAIN_MS);
      drain.unref();
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) queue.push(line);
      if (exited) scheduleClose();
      wake();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });

    child.on("error", (error) => {
      failure = new ProviderError(
        `opencode: cannot run "${command}" — ${error.message}. ${missingCommandAdvice()}`,
        { provider: id, code: "network", cause: error },
      );
      wake();
    });

    child.on("exit", () => {
      exited = true;
      scheduleClose();
    });

    child.on("close", (code) => {
      if (drain !== undefined) {
        clearTimeout(drain);
        drain = undefined;
      }
      if (pendingLine) queue.push(pendingLine);
      pendingLine = "";
      closed = true;
      if (failure === undefined && code !== 0) {
        const detail = stderrDetail(stderr);
        // A program that is not there says so on its error stream, and the
        // advice that fits is different from the advice for a program that
        // is there and did not answer. A CLI with no login for the model
        // says so too, and the sign-in is the answer.
        const advice = saysMissingProgram(detail)
          ? ` ${missingCommandAdvice()}`
          : saysSignedOut(detail)
            ? " Run `opencode auth login` to sign in."
            : "";
        failure = new ProviderError(
          `opencode: exited with code ${code}${detail.length > 0 ? ` — ${detail}` : ""}${advice}`,
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
      failure = new ProviderError(
        `opencode: timed out after ${Math.round(timeoutMs / 1000)}s. Try again or choose another model.`,
        { provider: id, code: "network", retryable: false },
      );
      wake();
      killTree(child);
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      failure = new ProviderError("opencode: run aborted", {
        provider: id,
        code: "aborted",
      });
      wake();
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

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
      if (drain !== undefined) clearTimeout(drain);
      signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) killTree(child);
    }
  }

  /** The arguments and the environment a turn runs with. */
  async function transport(): Promise<{
    args: string[];
    env: Record<string, string>;
    config?: string;
  }> {
    const private_ = await ensureServer();
    if (private_ !== undefined) {
      return {
        args: ["--server", private_.url],
        // A server without a password asks for none; one with a password
        // is given it.
        env:
          private_.password === undefined
            ? {}
            : { OPENCODE_PASSWORD: private_.password },
      };
    }
    // No private server: the CLI runs its own, for this turn only.
    const made = ensureGuard();
    return { args: ["--standalone"], env: {}, config: made.config };
  }
  async function* stream(request: StreamRequest): AsyncGenerator<Event> {
    const { model, system, messages, signal } = request;

    const connection = await transport();
    const cliArgs = [
      "run",
      ...connection.args,
      "--model",
      model,
      "--format",
      "json",
      "--thinking",
      "--agent",
      ensureGuard().agent,
    ];

    const prompt = toPrompt(system, messages, request.tools);
    // The prompt that goes to the CLI, written down when it is asked for:
    // a model that answers the wrong thing is usually a model that was
    // asked the wrong question.
    if (process.env.MYAGENT_DEBUG_PROMPT !== undefined) {
      try {
        writeFileSync(process.env.MYAGENT_DEBUG_PROMPT, prompt, "utf8");
      } catch {
        // The prompt that cannot be written down is still the one that is
        // sent.
      }
    }

    let usage: Usage | undefined;
    let stop: StopReason | undefined;
    const snapshots = new Map<string, string>();
    /** Whether the model said or asked for anything at all. */
    let answered = false;
    /** The calls the model asked for in the way of the CLI. */
    const nativeCalls: Array<{
      type: "toolCall";
      id: string;
      name: string;
      args: unknown;
      signature: string;
    }> = [];
    /** The text of the answer that has arrived and is not yet decided. */
    let pendingText = "";
    /** The tool protocol, as the model wrote it. */
    let toolBuffer = "";
    /** Whether the model has started to ask for tools. */
    let inToolProtocol = false;

    try {
      for await (const line of run(
        cliArgs,
        prompt,
        signal,
        connection,
      )) {
        const event = parseLine(line);
        if (event === undefined) continue;

        if (event.type === "error")
          throw new ProviderError(
            `opencode: ${event.error?.message ?? event.error?.data?.message ?? "request failed"}`,
            {
              provider: id,
              code: "protocol",
              status: event.error?.status,
              retryable: false,
            },
          );
        const part = event.part;
        if (part === undefined) continue;
        if (part.type === "tool") {
          // The model asked for a tool of the CLI. The CLI has none it may
          // run — the agent of the host has every native tool turned off —
          // so the call was refused and nothing ran. The call is ours to
          // make: it is translated, and the host runs it under its own
          // permissions.
          const ran =
            part.state?.status === "completed" && part.state?.error === undefined;
          const call = ran
            ? undefined
            : hostCall(part.tool, part.state?.input, request.tools);
          if (call !== undefined) {
            answered = true;
            const signature = `${call.name}:${JSON.stringify(call.args)}`;
            // The CLI refuses the call and tells the model so, and the
            // model asks again. The same call is asked for again and again,
            // and it is only run once.
            if (!nativeCalls.some((one) => one.signature === signature)) {
              nativeCalls.push({
                type: "toolCall",
                id: randomUUID(),
                name: call.name,
                args: call.args,
                signature,
              });
            }
            continue;
          }
          throw new ProviderError(
            `opencode: the model reached for the native tool "${
              part.tool ?? "?"
            }" of the CLI instead of the tools of the host${
              part.state?.error === undefined
                ? ""
                : ` — ${String(part.state.error).slice(0, 200)}`
            }. The host runs the tools under its own permissions, so this turn is stopped.`,
            { provider: id, code: "protocol" },
          );
        }

        if (
          (part.type === "text" || part.type === "reasoning") &&
          typeof part.text === "string"
        ) {
          // OpenCode parts are source-backed snapshots, not token deltas. Only
          // compare snapshots of the same identified part; repeated prose in
          // other parts is legitimate output and must remain intact.
          const key =
            part.id === undefined ? undefined : `${part.type}:${part.id}`;
          const previous = key === undefined ? "" : (snapshots.get(key) ?? "");
          if (!part.text.startsWith(previous))
            throw new Error("OpenCode revised an already emitted part");
          const delta = part.text.slice(previous.length);
          if (key !== undefined) snapshots.set(key, part.text);
          if (delta) {
            if (part.type === "reasoning") yield { t: "thinking", delta };
            else if (inToolProtocol) toolBuffer += delta;
            else {
              answered = true;
              pendingText += delta;
              // The model may write a sentence before it asks for a tool,
              // and the block of the tool may arrive in pieces. The text is
              // held back only as far as it could still be the beginning of
              // the block, so nothing of the protocol is ever shown.
              const tagAt = pendingText.indexOf(TOOL_TAG);
              if (tagAt >= 0) {
                const before = pendingText.slice(0, tagAt);
                // Some models wrap the block in a tag of their own; the
                // wrapper is not something the user needs to see.
                const spoken = before.replace(TOOL_WRAPPER, "");
                if (spoken.trim().length > 0) yield { t: "text", delta: spoken };
                toolBuffer = pendingText.slice(tagAt);
                pendingText = "";
                inToolProtocol = true;
                continue;
              }
              const hold = partialTagLength(pendingText);
              if (pendingText.length > hold) {
                yield {
                  t: "text",
                  delta: pendingText.slice(0, pendingText.length - hold),
                };
                pendingText = pendingText.slice(pendingText.length - hold);
              }
            }
          }
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

    // The text that was held back is the answer, when no tool was asked for.
    if (pendingText.length > 0) yield { t: "text", delta: pendingText };

    if (inToolProtocol) {
      const pattern = /<cli-agent-tool>([\s\S]*?)<\/cli-agent-tool>/g;
      const matches = [...toolBuffer.matchAll(pattern)];
      const rest = toolBuffer.replace(pattern, "").replace(TOOL_WRAPPER, "").trim();
      // An opening tag that was never closed: the model was cut off in the
      // middle of a call, and there is nothing to run.
      if (rest.includes(TOOL_TAG))
        throw new ProviderError("opencode: malformed external tool response", {
          provider: id,
          code: "protocol",
        });
      if (!matches.length)
        throw new ProviderError("opencode: malformed external tool response", {
          provider: id,
          code: "protocol",
        });
      // Whatever the model wrote around the calls is the answer so far.
      if (rest.length > 0) yield { t: "text", delta: rest };
      // Validate every call before allowing any execution.
      const calls = matches.map((match) => {
        let value: { name?: string; args?: unknown };
        try {
          value = JSON.parse(match[1]!);
        } catch {
          throw new ProviderError("opencode: invalid tool JSON", {
            provider: id,
            code: "protocol",
          });
        }
        // The tools carry a prefix of their own inside OpenCode, so that a
        // native tool of the same name can never be reached by mistake.
        const name =
          typeof value?.name === "string"
            ? value.name
            : undefined;
        if (
          !value ||
          name === undefined ||
          !request.tools.some((tool) => tool.name === name) ||
          !value.args ||
          typeof value.args !== "object" ||
          Array.isArray(value.args)
        )
          throw new ProviderError("opencode: invalid external tool call", {
            provider: id,
            code: "protocol",
          });
        return {
          type: "toolCall" as const,
          id: randomUUID(),
          name,
          args: value.args,
        };
      });
      for (const call of calls) yield { t: "toolCall", call };
      stop = "tool";
    }
    // The calls the model made in the way of the CLI are ours to run.
    for (const call of nativeCalls) yield { t: "toolCall", call };
    if (nativeCalls.length > 0) stop = "tool";
    if (!answered)
      throw new ProviderError(
        "opencode: completed without an answer. Try again or choose another model.",
        { provider: id, code: "protocol" },
      );
    yield {
      t: "done",
      usage: usage ?? { inputTokens: 0, outputTokens: 0 },
      stop: stop ?? "end",
    };
  }

  /** The catalog, once it has been read. */
  let catalog: ModelInfo[] | undefined;
  /** The read of the catalog, while it is going on. */
  let catalogPromise: Promise<ModelInfo[]> | undefined;

  /**
   * Is this the OpenCode that has not woken up yet?
   *
   * OpenCode of 2.2 answers "Location plugins did not finish activating"
   * while the plugins of the machine are still waking up. It is not a
   * failure of the CLI: the same command answers a moment later.
   */
  function isColdCatalog(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes("Location plugins did not finish activating") ||
        error.message.includes("ServiceUnavailableError"))
    );
  }

  /** Is the OpenCode itself missing? */
  function isMissingCommand(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes("cannot run") ||
        error.message.includes("is not recognized") ||
        error.message.includes("not found") ||
        error.message.includes("ENOENT"))
    );
  }

  /** How long the catalog may keep being read, in total. */
  const catalogBudget = catalogBudgetMs;

  /** Read the list of models from one OpenCode. */
  async function readCatalog(
    connection: { args: string[]; env: Record<string, string>; config?: string },
    signal: AbortSignal | undefined,
  ): Promise<ModelInfo[]> {
    const started = Date.now();
    let delay = 400;
    for (let attempt = 0; ; attempt++) {
      const found: ModelInfo[] = [];
      try {
        for await (const line of run(
          ["models", ...connection.args],
          undefined,
          signal,
          connection,
        )) {
          const trimmed = line.trim();
          if (!/^[\w.-]+\/[\w./:#-]+$/.test(trimmed)) continue;
          found.push({ id: trimmed, provider: id });
        }
        return found;
      } catch (error) {
        // The plugins of the machine can take a while to wake up, and the
        // catalog cannot be read before they do. A read-only retry uses the
        // service that is warming up; a failure that does not go away is
        // never hidden, and an inference or quota error is never retried.
        if (
          signal?.aborted ||
          !isColdCatalog(error) ||
          Date.now() - started > catalogBudget
        )
          throw error;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref();
        });
        delay = Math.min(delay * 2, 4_000);
      }
    }
  }

  const readModels = async (signal?: AbortSignal): Promise<ModelInfo[]> => {
    // The service of the machine answers the list quickest: it has been
    // running, and its providers are awake. The private server of ours is
    // the fallback, for a machine where that service is not there.
    try {
      return await readCatalog({ args: [], env: {} }, signal);
    } catch (error) {
      // The OpenCode itself is not there: no other OpenCode can answer
      // either, and saying so straight away is kinder than waiting.
      if (isMissingCommand(error)) throw error;
      try {
        return await readCatalog(await transport(), signal);
      } catch {
        throw error;
      }
    }
  };

  const models = async (signal?: AbortSignal): Promise<ModelInfo[]> => {
    if (catalog !== undefined) return catalog;
    // The read is shared: two callers must not start two reads, and the
    // one that is already going on is the one to wait for.
    catalogPromise ??= readModels(signal)
      .then((found) => {
        catalog = found;
        return found;
      })
      .finally(() => {
        catalogPromise = undefined;
      });
    return catalogPromise;
  };

  /**
   * Start the private server now, in the background.
   *
   * The server takes a moment to come up, and it is the same server for
   * every turn. Starting it when the provider is made means the wait
   * happens while the user is still typing, instead of after they press
   * Enter. The catalog is read at the same time, so the list of models is
   * there when the picker is opened.
   */
  const warm = (): void => {
    void ensureServer().catch(() => undefined);
    void models().catch(() => undefined);
  };

  /**
   * Stop the private server and let the configuration go.
   *
   * The server is a process of our own: it must not outlive the session.
   */
  const close = async (): Promise<void> => {
    if (server !== undefined) {
      killTree(server.child);
      server = undefined;
    }
    serverPromise = undefined;
    guard = undefined;
  };

  return { id, models, stream, warm, close };
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

function parseLine(line: string): CliEvent | undefined {
  const trimmed = line.trim();
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
