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
import { estimateRequest } from "@cli-agent/core";
import type { CheckpointStore, SessionStore } from "@cli-agent/core";
import type { AgentRole, Command } from "@cli-agent/core";
import { renderCommand } from "@cli-agent/core";
import type { AvailableModel } from "../catalog.js";
import { createBashTool } from "@cli-agent/tools";
import { toToolSpec } from "@cli-agent/tools";
import type { PermissionMode } from "@cli-agent/tools";
import { bold, cyan, dim, green, red, yellow } from "./colors.js";
import { completeFile, completePath, wordAt } from "./complete.js";
import {
  renderHeader,
  spinnerFrame,
  type ContextLeft,
} from "./frame.js";
import { Picker, type PickerItem } from "./picker.js";
import { MarkdownStream } from "./markdown.js";
import {
  isKnownSlash,
  nextPermissionMode,
  parseShellEscape,
  parseSlash,
  SLASH_COMMANDS,
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
  /** The commands the user has of their own. */
  commands?: Command[];
  /** Where the log of the session is written. */
  logPath?: string;
  /**
   * The models the user can pick.
   *
   * It is asked for when the picker is opened, so the list is of today.
   */
  onModels?: () => Promise<AvailableModel[]>;
}

/** The key that folds the last tool block. */
const FOLD_KEY = "t";

export class InteractiveUi {
  private readonly options: InteractiveOptions;
  private readonly rl: Readline;
  private readonly blocks: ToolBlock[] = [];

  private permissionMode: PermissionMode;
  private model: string;
  /** What the whole session has used, so the cost adds up. */
  private total: Usage = { inputTokens: 0, outputTokens: 0 };
  private turns = 0;
  private turn?: AbortController;
  private working = false;
  private pumping = false;
  private closed = false;
  /** The list that is open, when one is. */
  private picker?: {
    picker: Picker;
    /** The key was taken by the list. */
    onKey: (key: {
      name?: string;
      ctrl?: boolean;
      shift?: boolean;
      sequence?: string;
    }) => boolean;
    /** The line changed, so the list is drawn again. */
    onChange: () => void;
  };
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

      // The header says where the agent is.
      this.write(`${renderHeader({
        model: this.model,
        cwd: this.options.cwd,
      })}\n\n`);

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

    if (name === "/help") {
      this.showHelp();
      return;
    }

    // A command of the user's own: the file says what to ask.
    const custom = this.options.commands?.find(
      (command) => command.name === name,
    );
    if (custom !== undefined) {
      await this.ask(renderCommand(custom, args));
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
        this.total = { inputTokens: 0, outputTokens: 0 };
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
      // The picker: a list to move through, not a wall of text.
      const models = await this.availableModels();
      if (models.length === 0) {
        this.write(dim("  there is nothing to pick yet\n"));
        return;
      }

      const items: PickerItem[] = models.map((model) => ({
        label: model.id,
        value: model.ref,
        group: model.provider,
      }));

      const chosen = await this.pick(items, "pick a model", {
        onChange: (picker) => picker.narrow(this.rl.line),
      });
      if (chosen === undefined) return;

      await this.useModel(chosen);
      return;
    }

    await this.useModel(args);
  }

  /** Switch to a model, if it can be used. */
  private async useModel(ref: string): Promise<void> {
    const onModel = this.options.onModel;
    if (onModel === undefined) return;

    const provider = await onModel(ref);
    if (provider === undefined) {
      this.write(`${red(`could not use ${ref}`)}\n`);
      return;
    }

    this.model = ref;
    this.options.state.provider = provider;
    this.options.state.model = modelIdOf(ref);
    this.write(`${green("now using")} ${cyan(ref)}\n`);
  }

  /**
   * Put a list under the prompt and let the user move through it.
   *
   * The arrows move, Enter takes, Escape puts it away. Any other key goes
   * to the line as usual, and the list is narrowed down to what was typed.
   */
  private pick(
    items: PickerItem[],
    title: string,
    options: { onChange?: (picker: Picker) => void } = {},
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const picker = new Picker(items, {
        out: this.options.out,
        title,
      });

      this.picker = {
        picker,
        onKey: (key) => {
          if (key.name === "up") {
            picker.move(-1);
            picker.render();
            return true;
          }
          if (key.name === "down") {
            picker.move(1);
            picker.render();
            return true;
          }
          if (key.name === "return" || key.name === "enter") {
            const chosen = picker.selected?.value;
            this.closePicker();
            resolve(chosen);
            return true;
          }
          if (key.name === "escape") {
            this.closePicker();
            resolve(undefined);
            return true;
          }
          return false;
        },
        onChange: () => {
          options.onChange?.(picker);
          picker.render();
        },
      };

      picker.render();
    });
  }

  /** Take the picker off the screen and put the line back. */
  private closePicker(): void {
    this.picker = undefined;
    this.restoreLine();
  }

  /** Redraw the input line, after something was drawn under it. */
  private restoreLine(): void {
    const line = this.rl.line;
    this.rl.write(null, { ctrl: true, name: "u" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.write(line);
  }

  /**
   * The models the user can pick.
   *
   * The list is asked for when the picker is opened, so it is the list of
   * today: the free models of a router change from day to day.
   */
  private async availableModels(): Promise<AvailableModel[]> {
    const onModels = this.options.onModels;
    if (onModels === undefined) {
      return knownModels().map((ref) => ({
        ref,
        provider: modelIdOf(ref) === ref ? ref : ref.split("/")[0] ?? ref,
        id: modelIdOf(ref),
        free: false,
      }));
    }

    try {
      return await onModels();
    } catch {
      return [];
    }
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

  /** The commands the session knows. */
  private showHelp(): void {
    this.write(`${bold("the commands")}\n`);

    for (const command of SLASH_COMMANDS) {
      this.write(`  ${command.name}  ${dim(command.description)}\n`);
    }

    const custom = this.options.commands ?? [];
    if (custom.length > 0) {
      this.write(`\n${bold("your own commands")}\n`);
      for (const command of custom) {
        const hint =
          command.argumentHint === undefined ? "" : ` ${command.argumentHint}`;
        this.write(
          `  ${command.name}${hint}  ${dim(command.description ?? "")}\n`,
        );
      }
    }

    this.write(dim("\n@file puts a file in the prompt, !command runs a shell\n"));

    const logPath = this.options.logPath;
    if (logPath !== undefined && logPath.length > 0) {
      this.write(dim(`\nthe log of this session is at ${logPath}\n`));
    }
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

    // The spinner says the agent is working. It steps aside as soon as
    // there is something to show.
    const spinner = this.startSpinner();

    try {
      for await (const event of run(this.options.state, prompt, controller.signal)) {
        switch (event.t) {
          case "text": {
            spinner.stop();
            const text = markdown.write(event.delta);
            if (text.length > 0) this.write(text);
            break;
          }

          case "thinking":
            // The reasoning is not the answer; it is not shown.
            break;

          case "toolStart": {
            spinner.stop();
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
            this.turns += event.turns;
            // What the session has used, so the cost adds up.
            this.total = {
              inputTokens: this.total.inputTokens + event.usage.inputTokens,
              outputTokens:
                this.total.outputTokens + event.usage.outputTokens,
              ...(event.usage.cacheReadTokens === undefined
                ? {}
                : {
                    cacheReadTokens:
                      (this.total.cacheReadTokens ?? 0) +
                      event.usage.cacheReadTokens,
                  }),
              ...(event.usage.cacheWriteTokens === undefined
                ? {}
                : {
                    cacheWriteTokens:
                      (this.total.cacheWriteTokens ?? 0) +
                      event.usage.cacheWriteTokens,
                  }),
            };
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
      spinner.stop();
      const rest = markdown.flush();
      if (rest.length > 0) this.write(rest);
      this.working = false;
      this.turn = undefined;
    }

    await this.save();
    this.write("\n");
    this.write(`${renderStatus(this.statusInput())}\n`);
  }

  /**
   * The status line, with what the model table says the model costs.
   *
   * It also says how much of the context is left, so the user knows when
   * the conversation is about to be summarised.
   */
  private statusInput(): {
    model: string;
    usage?: Usage;
    info?: ModelInfo;
    permissionMode: string;
    turns: number;
    left?: ContextLeft;
  } {
    const provider = this.model.split("/")[0] as string;
    const info = lookupModel(provider, modelIdOf(this.model));

    return {
      model: modelIdOf(this.model),
      // What the whole session has used, so the cost is what it has cost.
      ...(this.turns === 0 ? {} : { usage: this.total }),
      ...(info === undefined ? {} : { info }),
      permissionMode: this.permissionMode,
      turns: this.turns,
      ...(this.contextLeft() === undefined
        ? {}
        : { left: this.contextLeft() as ContextLeft }),
    };
  }

  /**
   * The spinner.
   *
   * It says the agent is working, and it steps aside as soon as there is
   * something to show: the answer, or a tool that is running.
   */
  private startSpinner(): { stop: () => void } {
    let step = 0;
    let timer: NodeJS.Timeout | undefined;
    let drawn = false;

    const draw = (): void => {
      // The line is taken away and put again: the spinner turns where it
      // is, not on a new line.
      if (drawn) this.write(`\x1b[1A\r\x1b[2K`);
      this.write(`${cyan(spinnerFrame(step))} ${dim("working")}`);
      drawn = true;
      step += 1;
    };

    draw();
    timer = setInterval(draw, 90);

    return {
      stop: () => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        if (!drawn) return;
        this.write("\x1b[1A\r\x1b[2K");
        drawn = false;
      },
    };
  }

  /** How much of the context is left, when it can be worked out. */
  private contextLeft(): ContextLeft | undefined {
    const provider = this.model.split("/")[0] as string;
    const model = modelIdOf(this.model);

    const total = lookupModel(provider, model)?.contextWindow;
    if (total === undefined) return undefined;

    const used = estimateRequest({
      model,
      system: this.options.state.system ?? "",
      messages: this.options.state.messages,
      tools: this.options.state.tools.map(toToolSpec),
    });

    return { used, total };
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
    // A list that is open takes the keys that move it.
    const picker = this.picker;
    if (picker !== undefined) {
      if (picker.onKey(key)) return;
      // Any other key goes to the line, and the list is drawn again.
      picker.onChange();
      return;
    }

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

  /**
   * Complete an @-mention with a file.
   *
   * The files that match are put in a list under the prompt: the arrows
   * move through them, Enter takes the one that is on.
   */
  private async complete(): Promise<void> {
    const line = this.rl.line;
    const cursor = this.rl.cursor ?? line.length;
    const word = wordAt(line, cursor);
    if (word === undefined) return;

    const candidates = await this.fileCandidates(word.word.slice(1));
    if (candidates.length === 0) return;

    const items: PickerItem[] = candidates.map((path) => ({
      label: path,
      value: path,
    }));

    const chosen = await this.pick(items, "pick a file", {
      onChange: (picker) => {
        // The line changed, so the files that match it changed too.
        void this.refineFiles(picker, word);
      },
    });
    if (chosen === undefined) return;

    // The chosen path goes into the line, in place of what was typed.
    const next =
      line.slice(0, word.start) + `@${chosen}` + line.slice(cursor);
    this.rl.write(null, { ctrl: true, name: "u" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.write(next);
  }

  /** The files that could complete what is being typed. */
  private async fileCandidates(typed: string): Promise<string[]> {
    const directories = await completePath(typed, this.options.cwd);
    const files = await completeFile(typed, this.options.cwd);
    return [...directories, ...files];
  }

  /** Narrow the file list down to what is being typed now. */
  private async refineFiles(
    picker: Picker,
    word: { word: string; start: number },
  ): Promise<void> {
    const line = this.rl.line;
    const cursor = this.rl.cursor ?? line.length;
    const current = wordAt(line, cursor);

    const typed =
      current === undefined
        ? word.word.slice(1)
        : current.word.slice(1);

    const candidates = await this.fileCandidates(typed);
    picker.items = candidates.map((path) => ({ label: path, value: path }));
  }
}

/**
 * The models the agent knows about, for /model.
 *
 * This is the fallback: the real list is asked of the providers when the
 * picker is opened, so the free models of a router are the ones that
 * exist today.
 */
export function knownModels(): string[] {
  return [
    "openrouter/nvidia/nemotron-3.5-lightning:free",
    "openrouter/inclusionai/ling-3.2-flash:free",
    "openrouter/cohere/north-mini-code:free",
    "codex/gpt-6.1-sol",
    "opencode-cli/opencode/big-pickle",
    "anthropic/claude-sonnet-5-5",
    "openai/gpt-6.1-sol",
    "gemini/gemini-3.1-flash-lite",
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





