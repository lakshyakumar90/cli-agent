/**
 * The interactive session.
 *
 * A prompt, an answer, and the things that hang off them: tool blocks that
 * fold, a status line, slash commands, @-completion, ! for the shell, Esc to
 * interrupt, and Shift+Tab to change how much the agent may do on its own.
 */

import { createInterface, emitKeypressEvents, type Interface as Readline } from "node:readline";
import type { Msg, Provider, Usage } from "@cli-agent/ai";
import { lookupModel, type ModelInfo } from "@cli-agent/ai";
import type { AgentState } from "@cli-agent/core";
import { run } from "@cli-agent/core";
import type { CheckpointStore, SessionStore } from "@cli-agent/core";
import type { AgentRole } from "@cli-agent/core";
import { createBashTool } from "@cli-agent/tools";
import type { PermissionMode } from "@cli-agent/tools";
import { bold, cyan, dim, green, red, yellow } from "./colors.js";
import { completePath, wordAt } from "./complete.js";
import { MarkdownStream } from "./markdown.js";
import {
  isKnownSlash,
  nextPermissionMode,
  parseShellEscape,
  parseSlash,
} from "./slash.js";
import {
  permissionLabel,
  renderStatus,
  renderToolBlock,
  renderToolResult,
  type ToolBlock,
} from "./status.js";

export interface InteractiveOptions {
  /** The state the loop keeps. */
  state: AgentState;
  /** Where the terminal is. */
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The input, for the key handling. */
  input: NodeJS.ReadableStream;
  /** The model ref, so /model can change it. */
  model: string;
  /** How much the agent may do without asking. */
  permissionMode: PermissionMode;
  /** The directory the agent works in. */
  cwd: string;
  /** Builds a provider for a new model. */
  onModel?: (ref: string) => Promise<Provider | undefined>;
  /** Signs in to a provider. */
  onLogin?: (provider: string) => Promise<string | undefined>;
  /** The conversations that can be resumed. */
  sessions?: {
    list(): Promise<Array<{ id: string; model: string; updatedAt: string }>>;
    load(id: string): Promise<{ messages: Msg[]; model: string } | undefined>;
    save(session: {
      id: string;
      model: string;
      createdAt: string;
      updatedAt: string;
      messages: Msg[];
    }): Promise<void>;
  };
  /** The id of this session, for saving it. */
  sessionId?: string;
  /** Where the conversation is written down. */
  store?: SessionStore;
  /** The snapshots that make an edit undoable. */
  checkpoints?: CheckpointStore;
  /** The agents that can be switched to. */
  agents?: Array<{ name: string; model: string; description?: string }>;
  /** The roles the agent can delegate to. */
  roles?: Map<string, AgentRole>;
}

/** The key that folds the last tool block. */
const FOLD_KEY = "t";

export class InteractiveUi {
  private readonly options: InteractiveOptions;
  private readonly rl: Readline;
  private readonly blocks: ToolBlock[] = [];

  private permissionMode: PermissionMode;
  private model: string;
  private usage?: Usage;
  private turns = 0;
  private turn?: AbortController;
  private working = false;
  private pumping = false;
  private closed = false;
  private readonly pending: string[] = [];
  private createdAt = new Date().toISOString();

  constructor(options: InteractiveOptions) {
    this.options = options;
    this.permissionMode = options.permissionMode;
    this.model = options.model;

    this.rl = createInterface({
      input: options.input,
      output: options.out,
      terminal: true,
      history: [],
      prompt: "",
    });

    this.rl.on("SIGINT", () => {
      if (this.working) {
        this.turn?.abort();
        return;
      }
      this.rl.close();
    });

    emitKeypressEvents(options.input as NodeJS.ReadStream);
    (options.input as NodeJS.ReadStream).on("keypress", this.onKeypress);
  }

  /** Run until the user leaves. */
  async run(): Promise<number> {
    return new Promise<number>((resolve) => {
      this.rl.on("line", (line) => {
        this.pending.push(line);
        void this.pump();
      });

      this.rl.on("close", () => {
        this.closed = true;
        void this.drain().then(() => resolve(0));
      });

      this.rl.setPrompt(this.promptText());
      this.rl.prompt();
    });
  }

  /**
   * Take the next line the user typed and do something with it.
   *
   * The lines are queued rather than handled where they arrive, so a line
   * typed during a turn waits for it instead of racing it.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (this.pending.length > 0) {
        const line = (this.pending.shift() ?? "").trim();
        if (line.length > 0) await this.handleLine(line);

        if (!this.closed) {
          this.rl.setPrompt(this.promptText());
          this.rl.prompt();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Wait for the turn that is running, then finish. */
  private async drain(): Promise<void> {
    while (this.working) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** What the user typed, and what it means. */
  private async handleLine(line: string): Promise<void> {
    const slash = parseSlash(line);
    if (slash !== undefined) {
      await this.handleSlash(slash.name, slash.args);
      return;
    }

    const shell = parseShellEscape(line);
    if (shell !== undefined) {
      await this.runShell(shell.command);
      return;
    }

    await this.ask(line);
  }

  // -------------------------------------------------------------------------
  // The slash commands
  // -------------------------------------------------------------------------

  private async handleSlash(name: string, args: string): Promise<void> {
    // Leaving is not a command the guide lists, but a session needs a way
    // out of it.
    if (name === "/exit" || name === "/quit") {
      this.closed = true;
      this.rl.close();
      return;
    }

    if (!isKnownSlash({ name, args, raw: name })) {
      this.write(`${red(`unknown command: ${name}`)}\n`);
      this.write(dim("try /help for the list\n"));
      return;
    }

    switch (name) {
      case "/model":
        await this.switchModel(args);
        return;
      case "/login":
        await this.login(args);
        return;
      case "/compact":
        await this.compact();
        return;
      case "/clear":
        this.options.state.messages = [];
        this.blocks.length = 0;
        this.usage = undefined;
        this.turns = 0;
        this.write(dim("the conversation is empty now\n"));
        return;
      case "/resume":
        await this.resume(args);
        return;
      case "/agents":
        await this.switchAgent(args);
        return;
      case "/fork":
        await this.fork(args);
        return;
      case "/tree":
        await this.tree();
        return;
      case "/undo":
        await this.undo(args);
        return;
      default:
        return;
    }
  }

  /** Branch the conversation from an earlier message. */
  private async fork(args: string): Promise<void> {
    const store = this.options.store;
    const sessionId = this.options.sessionId;
    if (store === undefined || sessionId === undefined) {
      this.write(dim("this session is not being written down\n"));
      return;
    }

    const entries = await store.read(sessionId);
    if (entries.length === 0) {
      this.write(dim("there is nothing to fork from\n"));
      return;
    }

    // Without an entry named, fork from the last one.
    const from =
      args.length > 0
        ? entries.find((entry) => entry.id === args)
        : entries[entries.length - 1];

    if (from === undefined) {
      this.write(`${red(`no message called ${args}`)}\n`);
      return;
    }

    const forked = await store.fork(sessionId, from.id, { model: this.model });
    if (forked === undefined) {
      this.write(`${red("could not fork from that message")}\n`);
      return;
    }

    this.options.sessionId = forked;
    this.write(`${green("forked")} ${dim(`${sessionId} -> ${forked}`)}\n`);
  }

  /** The branches of this conversation. */
  private async tree(): Promise<void> {
    const store = this.options.store;
    const sessionId = this.options.sessionId;
    if (store === undefined || sessionId === undefined) {
      this.write(dim("this session is not being written down\n"));
      return;
    }

    const roots = await store.tree(sessionId);
    if (roots.length === 0) {
      this.write(dim("the conversation is empty\n"));
      return;
    }

    this.write(`${bold("the conversation")}\n`);
    const show = (nodes: typeof roots, depth: number): void => {
      for (const node of nodes) {
        const text =
          node.entry.msg.role === "user"
            ? node.entry.msg.content
            : node.entry.msg.role === "tool"
              ? `tool ${node.entry.msg.callId}`
              : "the model answered";
        this.write(
          `${"  ".repeat(depth)}${dim(node.entry.id)} ${String(text).slice(0, 60)}\n`,
        );
        show(node.children, depth + 1);
      }
    };
    show(roots, 1);
  }

  /** Undo the last change to a file. */
  private async undo(args: string): Promise<void> {
    const checkpoints = this.options.checkpoints;
    if (checkpoints === undefined) {
      this.write(dim("nothing is being checkpointed\n"));
      return;
    }

    const path = args.length > 0 ? args : undefined;
    const undone = await checkpoints.undo(path);
    if (undone === undefined) {
      this.write(dim("there is nothing to undo\n"));
      return;
    }

    this.write(
      `${green("undone")} ${dim(`${undone.checkpoint.path} (${undone.checkpoint.callId})`)}\n`,
    );
  }

  /** Show or change the model. */
  private async switchModel(args: string): Promise<void> {
    if (args.length === 0) {
      this.write(`${bold("models")}\n`);
      for (const ref of knownModels()) {
        const mark = ref === this.model ? green("●") : " ";
        this.write(`${mark} ${ref}\n`);
      }
      this.write(dim("\n/model <provider/model> to switch\n"));
      return;
    }

    const onModel = this.options.onModel;
    if (onModel === undefined) return;

    const provider = await onModel(args);
    if (provider === undefined) {
      this.write(`${red(`could not use ${args}`)}\n`);
      return;
    }

    this.model = args;
    this.options.state.provider = provider;
    this.options.state.model = modelIdOf(args);
    this.write(`${green("now using")} ${cyan(args)}\n`);
  }

  /** Sign in to a provider. */
  private async login(args: string): Promise<void> {
    const onLogin = this.options.onLogin;
    if (onLogin === undefined) {
      this.write(dim("this build cannot sign in\n"));
      return;
    }
    if (args.length === 0) {
      this.write(dim("/login <provider>\n"));
      return;
    }

    const message = await onLogin(args);
    this.write(`${message ?? dim("nothing to do")}\n`);
  }

  /** Summarise the conversation and start again from the summary. */
  private async compact(): Promise<void> {
    const messages = this.options.state.messages;
    if (messages.length === 0) {
      this.write(dim("there is nothing to compact\n"));
      return;
    }

    const summary = await summarise(this.options.state, messages);
    if (summary === undefined) {
      this.write(`${red("could not summarise the conversation")}\n`);
      return;
    }

    const kept = messages.slice(-2);
    this.options.state.messages = [
      { role: "user", content: `Earlier in this conversation:\n${summary}` },
      ...kept,
    ];
    this.write(
      `${green("compacted")} ${dim(
        `(${messages.length} messages -> ${this.options.state.messages.length})`,
      )}\n`,
    );
  }

  /** Go back to an earlier conversation. */
  private async resume(args: string): Promise<void> {
    const sessions = this.options.sessions;
    if (sessions === undefined) {
      this.write(dim("this build keeps no conversations\n"));
      return;
    }

    if (args.length === 0) {
      const saved = await sessions.list();
      if (saved.length === 0) {
        this.write(dim("there are no earlier conversations\n"));
        return;
      }
      this.write(`${bold("conversations")}\n`);
      for (const session of saved) {
        this.write(`  ${session.id}  ${dim(session.updatedAt)}\n`);
      }
      this.write(dim("\n/resume <id> to go back to one\n"));
      return;
    }

    const session = await sessions.load(args);
    if (session === undefined) {
      this.write(`${red(`no conversation called ${args}`)}\n`);
      return;
    }

    this.options.state.messages = session.messages;
    this.write(`${green("resumed")} ${dim(args)}\n`);
  }

  /** List or switch the agent. */
  private async switchAgent(args: string): Promise<void> {
    const agents = this.options.agents ?? [];
    const roles = this.options.roles;

    if (agents.length === 0 && (roles === undefined || roles.size === 0)) {
      this.write(dim("no other agents are configured\n"));
      return;
    }

    if (args.length === 0) {
      if (roles !== undefined && roles.size > 0) {
        this.write(`${bold("the agents you can delegate to")}\n`);
        for (const [name, role] of roles) {
          this.write(
            `  ${name}  ${dim(role.description ?? role.model ?? "")}\n`,
          );
        }
      }
      if (agents.length > 0) {
        this.write(`${bold("agents")}\n`);
        for (const agent of agents) {
          const mark = agent.name === "main" ? green("●") : " ";
          this.write(
            `${mark} ${agent.name}  ${dim(agent.description ?? agent.model)}\n`,
          );
        }
        this.write(dim("\n/agents <name> to switch\n"));
      }
      return;
    }

    const agent = agents.find((candidate) => candidate.name === args);
    if (agent === undefined) {
      this.write(`${red(`no agent called ${args}`)}\n`);
      return;
    }

    const onModel = this.options.onModel;
    if (onModel !== undefined) {
      const provider = await onModel(agent.model);
      if (provider !== undefined) {
        this.options.state.provider = provider;
        this.options.state.model = modelIdOf(agent.model);
        this.model = agent.model;
      }
    }
    this.write(`${green("now the")} ${bold(agent.name)} ${dim("agent")}\n`);
  }

  // -------------------------------------------------------------------------
  // The shell escape
  // -------------------------------------------------------------------------

  private async runShell(command: string): Promise<void> {
    const result = await createBashTool().run(
      { command },
      {
        cwd: this.options.cwd,
        signal: new AbortController().signal,
      },
    );

    this.write(`${dim(`$ ${command}`)}\n`);
    this.write(`${result.output}\n`);
  }

  // -------------------------------------------------------------------------
  // The turn
  // -------------------------------------------------------------------------

  /** Ask the model something and show the answer. */
  private async ask(prompt: string): Promise<void> {
    this.working = true;
    this.turn = new AbortController();
    const controller = this.turn;
    const markdown = new MarkdownStream();

    this.write("\n");

    try {
      for await (const event of run(this.options.state, prompt, controller.signal)) {
        switch (event.t) {
          case "text": {
            const text = markdown.write(event.delta);
            if (text.length > 0) this.write(text);
            break;
          }

          case "thinking":
            // The reasoning is not the answer; it is not shown.
            break;

          case "toolStart": {
            const block: ToolBlock = {
              id: event.call.id,
              name: event.call.name,
              args: event.call.args,
              expanded: false,
              ...(event.call.name === "edit"
                ? { replacement: replacementOf(event.call.args) }
                : {}),
            };
            this.blocks.push(block);
            this.write(`\n${renderToolBlock(block)}\n`);
            break;
          }

          case "toolEnd": {
            const block = this.blocks.find(
              (candidate) => candidate.id === event.call.id,
            );
            if (block !== undefined) {
              block.output = event.output;
              block.isError = event.isError === true;
              // The header was printed when the tool was asked for; the
              // result goes under it.
              const result = renderToolResult(block);
              if (result.length > 0) this.write(`${indent(result)}\n`);
            }
            break;
          }

          case "done": {
            this.usage = event.usage;
            this.turns += event.turns;
            break;
          }

          case "retry":
            this.write(`${yellow(`retrying in ${event.delayMs}ms`)}\n`);
            break;
        }
      }
    } catch (error) {
      this.write(
        `${red(error instanceof Error ? error.message : String(error))}\n`,
      );
    } finally {
      const rest = markdown.flush();
      if (rest.length > 0) this.write(rest);
      this.working = false;
      this.turn = undefined;
    }

    await this.save();
    this.write("\n");
    this.write(`${renderStatus(this.statusInput())}\n`);
  }

  /** The status line, with what the model table says the model costs. */
  private statusInput(): {
    model: string;
    usage?: Usage;
    info?: ModelInfo;
    permissionMode: string;
    turns: number;
  } {
    const provider = this.model.split("/")[0] as string;
    const info = lookupModel(provider, modelIdOf(this.model));

    return {
      model: modelIdOf(this.model),
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(info === undefined ? {} : { info }),
      permissionMode: this.permissionMode,
      turns: this.turns,
    };
  }

  /** The prompt, with the permission mode in it. */
  private promptText(): string {
    return `${permissionLabel(this.permissionMode)} ${bold("›")} `;
  }

  /** Write to the terminal. */
  private write(text: string): void {
    this.options.out.write(text);
  }

  /** Save the conversation, so /resume can find it. */
  private async save(): Promise<void> {
    const sessions = this.options.sessions;
    if (sessions === undefined) return;

    await sessions.save({
      id: this.options.sessionId ?? "session",
      model: this.model,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      messages: this.options.state.messages,
    });
  }

  // -------------------------------------------------------------------------
  // The keys
  // -------------------------------------------------------------------------

  private readonly onKeypress = (
    _text: string,
    key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string },
  ): void => {
    // Node reports a lone Esc as "escape" when the next key completes the
    // sequence, and with no name at all when it is flushed on its own.
    if (key.name === "escape" || key.sequence === "") {
      if (this.working) {
        this.turn?.abort();
        this.write(`${yellow("interrupted")}\n`);
      }
      return;
    }

    if (key.name === "tab" && key.shift === true) {
      this.permissionMode = nextPermissionMode(this.permissionMode);
      this.write(
        `${dim("permission mode:")} ${permissionLabel(this.permissionMode)}\n`,
      );
      return;
    }

    if (key.ctrl === true && key.name === FOLD_KEY) {
      const block = this.blocks[this.blocks.length - 1];
      if (block !== undefined) {
        block.expanded = !block.expanded;
        this.write(`${renderToolBlock(block)}\n`);
      }
      return;
    }

    if (key.name === "tab" && key.shift !== true) {
      void this.complete();
    }
  };

  /** Complete an @-mention with a file. */
  private async complete(): Promise<void> {
    const line = this.rl.line;
    const cursor = this.rl.cursor ?? line.length;
    const word = wordAt(line, cursor);
    if (word === undefined) return;

    const candidates = await completePath(
      word.word.slice(1),
      this.options.cwd,
    );
    const chosen = candidates[0];
    if (chosen === undefined) return;

    const next = line.slice(0, word.start) + `@${chosen}`;
    this.rl.write(null, { ctrl: true, name: "u" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.write(next);
  }
}

/** The models the agent knows about, for /model. */
export function knownModels(): string[] {
  return [
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-opus-5-5",
    "anthropic/claude-haiku-5-5",
    "openai/gpt-5.5",
    "openai/gpt-5.6-sol",
    "gemini/gemini-3.1-flash-lite",
    "gemini/gemini-3.8-flash",
  ];
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** The model id of a "provider/model" ref. */
export function modelIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash <= 0 ? ref : ref.slice(slash + 1);
}

/** The old and new text of an edit, when the tool was one. */
function replacementOf(
  args: unknown,
): { oldString: string; newString: string } | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  if (typeof record.old_string !== "string") return undefined;
  return {
    oldString: record.old_string,
    newString: typeof record.new_string === "string" ? record.new_string : "",
  };
}

/**
 * Summarise a conversation, so the context can start again from the summary.
 */
export async function summarise(
  state: AgentState,
  messages: Msg[],
): Promise<string | undefined> {
  const transcript = messages
    .map((message) => `${message.role}: ${contentOf(message)}`)
    .join("\n\n");

  const pieces: string[] = [];
  try {
    for await (const event of state.provider.stream({
      model: state.model,
      system:
        "Summarise this conversation in a few lines: what was asked, what was done, and what is left. Keep the details that matter for continuing.",
      messages: [{ role: "user", content: transcript }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.t === "text") pieces.push(event.delta);
    }
  } catch {
    return undefined;
  }

  const summary = pieces.join("").trim();
  return summary.length > 0 ? summary : undefined;
}

function contentOf(message: Msg): string {
  if (message.role === "user" || message.role === "tool") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}





