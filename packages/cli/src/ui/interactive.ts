import {
  Editor,
  Input,
  TuiMainScreen,
  CombinedAutocompleteProvider,
  matchesKey,
  truncateToWidth,
  type Component,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { Provider, Msg } from "@cli-agent/ai";
import { lookupModel } from "@cli-agent/ai";
import {
  run,
  renderCommand,
  compactMessages,
  type AgentState,
  type SessionStore,
  type CheckpointStore,
  type AgentRole,
  type Command,
  type WorkerRecord,
  type WorkerManager,
} from "@cli-agent/core";
import {
  PermissionController,
  createBashTool,
  withPermissions,
  type PermissionMode,
} from "@cli-agent/tools";
import type { AvailableModel, Catalog } from "../catalog.js";
import type { SessionController } from "../session-controller.js";
import {
  executeReview,
  reviewSnapshot,
  type ReviewRun,
  type ReviewTarget,
} from "../review.js";
import { bold, cyan, dim, red, yellow } from "./colors.js";
import {
  blockSummary,
  Detail,
  safe,
  Approval,
  Selector,
  selectTheme,
  Transcript,
  type Choice,
} from "./components.js";
import { UiStore } from "./store.js";
import { terminalFor } from "./terminal.js";
import { SLASH_COMMANDS, nextPermissionMode, parseSlash } from "./slash.js";
import { listFiles } from "./complete.js";
export { knownModels, modelIdOf, summarise } from "./helpers.js";

/** The name each provider is known by, in the list of models. */
const PROVIDER_NAMES: Record<string, string> = {
  "opencode-cli": "OpenCode CLI (on this machine)",
  opencode: "OpenCode Zen",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  codex: "Codex",
};

/** What to do about a provider that could not be reached. */
const PROVIDER_ADVICE: Record<string, string> = {
  "opencode-cli":
    "install the opencode CLI, or set MYAGENT_OPENCODE_COMMAND to where it is",
};

/**
 * What is wrong with the providers that could not be reached.
 *
 * The name is said, and what to do about it is said too: "unavailable" on
 * its own leaves the user guessing. A CLI that is not installed and a CLI
 * that did not answer are told apart, because telling somebody to install
 * what they already have is worse than saying nothing.
 */
function describeProblems(
  problems: Array<{
    provider: string;
    message: string;
    kind?: "missing" | "unreachable";
  }>,
): string {
  const parts = problems.map((problem) => {
    const name = PROVIDER_NAMES[problem.provider] ?? problem.provider;
    // The bridge says where it looked for the CLI when it is not there;
    // the advice is only added when it was not said already.
    const advice =
      problem.kind === "missing" &&
      !problem.message.includes("MYAGENT_OPENCODE_COMMAND")
        ? PROVIDER_ADVICE[problem.provider]
        : undefined;
    return advice === undefined
      ? `${name}: ${problem.message}`
      : `${name}: ${problem.message} — ${advice}`;
  });
  return `Unavailable · ${parts.join(" · ")}`;
}

export interface InteractiveOptions {
  state: AgentState;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  input: NodeJS.ReadableStream;
  model: string;
  permissionMode: PermissionMode;
  cwd: string;
  controller?: SessionController;
  permissions?: PermissionController;
  workerManager?: WorkerManager;
  terminal?: Terminal;
  onModel?: (ref: string) => Promise<Provider | undefined>;
  onLogin?: (
    provider: string,
  ) => Promise<string | { ok: boolean; message: string } | undefined>;
  onModels?: (signal?: AbortSignal) => Promise<AvailableModel[] | Catalog>;
  sessionId?: string;
  store?: SessionStore;
  checkpoints?: CheckpointStore;
  agents?: Array<{ name: string; model: string; description?: string }>;
  roles?: Map<string, AgentRole>;
  commands?: Command[];
  logPath?: string;
  workers?: Map<string, WorkerRecord>;
  resumePicker?: boolean;
}
interface Modal {
  component: Component;
  cancel(): void;
  /** How wide the overlay is, when it is not the whole screen. */
  width?: `${number}%` | number;
  /** The narrowest the overlay may be. */
  minWidth?: number;
}

/** One input owner and one differential renderer for every interactive workflow. */
export class InteractiveUi {
  readonly view = new UiStore();
  readonly tui: TuiMainScreen;
  readonly editor: Editor;
  readonly permissions: PermissionController;
  private transcript: Transcript;
  private model: string;
  private modal?: Modal;
  private suspended?: Modal;
  private overlay?: OverlayHandle;
  private approvalId?: string;
  private closed = false;
  private working = false;
  private turn?: AbortController;
  private task?: Promise<void>;
  private foreground?: Promise<unknown>;
  private resolveRun?: (code: number) => void;
  private cleanups: Array<() => void> = [];
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private models: AvailableModel[] = [];
  private stagedModel?: string;
  private catalogAbort?: AbortController;
  private delivered = new Set<string>();
  private reported = new Set<string>();
  private reports: Msg[] = [];
  private workerViews = new Map<string, UiStore>();
  private workerMessageCounts = new Map<string, number>();
  private workerSelector?: Selector;
  private started = false;
  private initialMode: PermissionMode;

  constructor(readonly options: InteractiveOptions) {
    this.model = options.controller?.model ?? options.model;
    this.initialMode = options.permissionMode;
    this.permissions =
      options.permissions ??
      new PermissionController({
        mode: options.permissionMode,
        workspace: options.cwd,
      });
    this.tui = new TuiMainScreen(
      options.terminal ?? terminalFor(options.input, options.out),
    );
    this.transcript = new Transcript(this.view);
    this.editor = new Editor(
      this.tui,
      { borderColor: dim, selectList: selectTheme },
      { paddingX: 1, autocompleteMaxVisible: 8 },
    );
    const autocomplete = new CombinedAutocompleteProvider(
      [
        ...SLASH_COMMANDS.map((c) => ({
          name: c.name.slice(1),
          description: c.description,
        })),
        ...(options.commands ?? []).map((c) => ({
          name: c.name.slice(1),
          description: c.description,
        })),
      ],
      options.cwd,
    );
    this.editor.setAutocompleteProvider({
      triggerCharacters: ["@"],
      getSuggestions: async (lines, row, col, request) => {
        const prefix = /(?:^|\s)(@\S*)$/.exec(
          (lines[row] ?? "").slice(0, col),
        )?.[1];
        if (!prefix)
          return autocomplete.getSuggestions(lines, row, col, request);
        const files = await listFiles(options.cwd);
        if (request.signal.aborted) return null;
        const items = files
          .filter((file) =>
            file.toLowerCase().includes(prefix.slice(1).toLowerCase()),
          )
          .slice(0, 30)
          .map((file) => ({
            label: file,
            value: /\s/.test(file) ? `@"${file}"` : `@${file}`,
          }));
        return items.length ? { items, prefix } : null;
      },
      applyCompletion: (...args) => autocomplete.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) =>
        autocomplete.shouldTriggerFileCompletion(...args),
    });
    this.editor.onSubmit = (text) => {
      this.editor.addToHistory(text);
      this.editor.setText("");
      void this.submit(text).catch((error) => this.notice(error));
    };
    const root: Component = {
      invalidate: () => this.transcript.invalidate(),
      render: (width) => {
        const session = options.store?.id ?? options.sessionId ?? "unsaved";
        const usage = options.controller?.usage;
        const workers = options.workerManager?.active.length ?? 0;
        const info = lookupModel(
          this.model.split("/")[0] ?? "",
          this.model.slice(this.model.indexOf("/") + 1),
        );
        const footer = `${this.model} · permission mode: ${this.modeLabel()}${usage ? ` · ${usage.inputTokens} in / ${usage.outputTokens} out` : ""}${info?.contextWindow ? ` · ${info.contextWindow.toLocaleString()} context` : ""}${workers ? ` · ${workers} workers` : ""}`;

        const header = truncateToWidth(
          `${bold("agent")}  ${cyan(this.model)}  ${dim(options.cwd)}  ${dim(session)}`,
          width,
        );
        const activity = truncateToWidth(
          this.view.activity
            ? `${cyan(["◐", "◓", "◑", "◒"][this.frame % 4] ?? "○")} ${this.view.activity} · Esc to interrupt`
            : dim(this.view.notice || "Ready"),
          width,
        );
        const queued = this.view.pending.length
          ? [
              truncateToWidth(
                dim(
                  `${this.view.pending.length} queued · next: ${safe(this.view.pending[0] ?? "")}`,
                ),
                width,
              ),
            ]
          : [];
        const staged = this.stagedModel
          ? [truncateToWidth(dim(`Next turn: ${this.stagedModel}`), width)]
          : [];
        const editor = this.editor.render(width);
        const facts = truncateToWidth(dim(footer), width);
        const keys = truncateToWidth(
          dim(
            "Shift+Tab mode · Alt+I inspect · Ctrl+O transcript · Ctrl+B workers · /help · ? shortcuts",
          ),
          width,
        );

        // The frame has to fit on the screen: a frame that is taller than
        // the terminal is written over the terminal, and the conversation
        // ends up on the screen twice. The conversation is trimmed to what
        // is left of the rows.
        const chrome = 3 + queued.length + staged.length + editor.length + 2;
        const room = Math.max(1, this.tui.terminal.rows - chrome);

        return [
          header,
          "",
          ...(this.view.blocks.length === 0
            ? this.welcome(width)
            : this.transcript.renderWithin(width, room)),
          activity,
          ...queued,
          ...staged,
          ...editor,
          facts,
          keys,
        ];
      },
    };
    this.tui.addChild(root);
    this.tui.setFocus(this.editor);
    this.cleanups.push(this.tui.addInputListener((data) => this.keys(data)));
  }
  run(): Promise<number> {
    this.started = true;
    this.reload();
    this.cleanups.push(this.permissions.subscribe(() => this.approvals()));
    if (this.options.workerManager)
      this.cleanups.push(
        this.options.workerManager.subscribe(({ worker, event }) => {
          let view = this.workerViews.get(worker.id);
          const userMessages = worker.messages.filter(
            (message) => message.role === "user",
          ).length;
          if (
            !view ||
            event?.t === "done" ||
            this.workerMessageCounts.get(worker.id) !== userMessages
          ) {
            view = new UiStore();
            view.restore(worker.messages, worker.id);
            this.workerViews.set(worker.id, view);
            this.workerMessageCounts.set(worker.id, userMessages);
          }
          if (event) view.event(event);
          this.workerSelector?.setItems(this.workerChoices());
          if (worker.status === "completed") {
            const key = `${worker.id}:${worker.runNumber}`;
            if (!this.delivered.has(key)) {
              this.delivered.add(key);
              this.view.notice = `${worker.agent} completed · Ctrl+B to inspect`;
            }
          }
          this.render();
        }),
      );
    const onEnd = (): void => {
      void this.close();
    };
    this.options.input.on("end", onEnd);
    this.cleanups.push(() => this.options.input.removeListener("end", onEnd));
    const promise = new Promise<number>((resolve) => {
      this.resolveRun = resolve;
    });
    this.tui.start();
    this.timer = setInterval(() => {
      if (this.view.activity) {
        this.frame++;
        this.render();
      }
    }, 120);
    this.timer.unref();
    this.approvals();
    if (this.options.resumePicker)
      void this.sessions().catch((error) => this.notice(error));
    return promise;
  }
  private render(): void {
    if (this.started && !this.closed) this.tui.requestRender();
  }
  /**
   * What the session says when it has nothing to say yet.
   *
   * The commands that are worth knowing are named, so that the first
   * question does not have to be looked up.
   */
  private welcome(width: number): string[] {
    const lines = [
      `${dim("Describe the task and press Enter.")}`,
      `${dim("")}${cyan("/model")} ${dim("choose the model")}  ${cyan("/help")} ${dim("the commands and the keys")}`,
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }
  private modeLabel(): string {
    return this.permissions.mode === "yolo"
      ? "Full access"
      : this.permissions.mode;
  }
  private notice(value: unknown): void {
    this.view.notice = value instanceof Error ? value.message : String(value);
    this.render();
  }
  private reload(): void {
    this.model = this.options.controller?.model ?? this.model;
    this.view.restore(
      this.options.state.messages,
      this.options.store?.id ?? "session",
      this.options.controller?.modelChanges,
      this.model,
    );
    this.workerViews.clear();
    this.workerMessageCounts.clear();
    this.render();
  }
  private keys(data: string): { consume: boolean } | undefined {
    if (matchesKey(data, "ctrl+d") && !this.modal && !this.editor.getText()) {
      void this.close();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.modal) this.modal.cancel();
      else if (this.working) this.turn?.abort();
      else void this.close();
      return { consume: true };
    }
    if (this.modal) return undefined;
    if (matchesKey(data, "escape")) {
      this.turn?.abort();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      this.permissions.setMode(nextPermissionMode(this.permissions.mode));
      this.render();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      this.detail("Transcript", () => this.transcriptText());
      return { consume: true };
    }
    if (matchesKey(data, "alt+i")) {
      this.inspectLatest();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+b")) {
      void this.workers();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+r")) {
      void this.select(
        "Prompt history",
        this.options.state.messages
          .filter((m) => m.role === "user")
          .map((m, index) => ({
            label: m.content as string,
            value: String(index),
          })),
      ).then((choice) => {
        if (choice) {
          this.editor.setText(choice.label);
          this.render();
        }
      });
      return { consume: true };
    }
    if (data === "?" && !this.editor.getText()) {
      this.help();
      return { consume: true };
    }
    return undefined;
  }
  private show(modal: Modal): void {
    this.overlay?.hide();
    this.modal = modal;
    this.overlay = this.tui.showOverlay(modal.component, {
      width: modal.width ?? "100%",
      ...(modal.minWidth === undefined ? {} : { minWidth: modal.minWidth }),
      maxHeight: "100%",
      anchor: "bottom-center",
      margin: 0,
    });
    this.render();
  }
  private dismiss(modal = this.modal): void {
    if (modal !== this.modal) return;
    this.overlay?.hide();
    this.overlay = undefined;
    this.modal = undefined;
    this.tui.setFocus(this.editor);
    this.render();
  }
  private select(
    title: string,
    choices: Choice[],
    description = "",
    searchable = true,
  ): Promise<Choice | undefined> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (choice?: Choice): void => {
        if (done) return;
        done = true;
        this.dismiss(modal);
        resolve(choice);
      };
      const selector = new Selector(
        title,
        choices,
        () => this.tui.terminal.rows,
        finish,
        searchable,
        description,
      );
      const modal: Modal = { component: selector, cancel: () => finish() };
      this.show(modal);
    });
  }
  private prompt(title: string, initial = ""): Promise<string | undefined> {
    return new Promise((resolve) => {
      const input = new Input({ prompt: "> " });
      input.setValue(initial);
      let done = false;
      const finish = (text?: string): void => {
        if (done) return;
        done = true;
        this.dismiss(modal);
        resolve(text);
      };
      input.onSubmit = (text) => finish(text);
      input.onEscape = () => finish();
      const component: Component = {
        invalidate: () => input.invalidate(),
        render: (width) => {
          input.focused = true;
          return [
            truncateToWidth(bold(title), width),
            "",
            ...input.render(width),
            "",
            truncateToWidth(dim("Enter confirm · Esc back"), width),
          ];
        },
        handleInput: (data) => input.handleInput(data),
      };
      const modal: Modal = { component, cancel: () => finish() };
      this.show(modal);
    });
  }
  private detail(
    title: string,
    content: () => string,
    action?: (key: string) => void,
    hint?: string,
  ): void {
    const modal: Modal = {
      component: new Detail(
        title,
        content,
        () => this.tui.terminal.rows,
        () => this.dismiss(modal),
        action,
        hint,
      ),
      cancel: () => this.dismiss(modal),
    };
    this.show(modal);
  }
  private inspectLatest(): void {
    const block = this.view.blocks.findLast(
      (b) => b.kind === "tool" || b.kind === "thinking",
    );
    if (!block) {
      this.notice("No tool output or thinking to inspect yet.");
      return;
    }
    this.detail(block.name ?? "Thinking", () =>
      block.kind === "thinking"
        ? block.text
        : `${blockSummary(block)}\n\n${JSON.stringify(block.args, null, 2)}\n\n${block.text}`,
    );
  }
  private transcriptText(): string {
    return this.view.blocks
      .map((block) =>
        block.kind === "tool"
          ? `${blockSummary(block)}\n${JSON.stringify(block.args, null, 2)}\n${block.text}`
          : `${block.kind === "user" ? "You" : block.kind === "thinking" ? "Thinking" : "Assistant"}\n${block.text}`,
      )
      .join("\n\n");
  }
  private approvals(): void {
    for (const worker of this.options.workerManager?.active ?? []) {
      this.options.workerManager?.setWaiting(
        worker.id,
        [...this.permissions.pending.values()].some(
          (p) => p.request.agentId === worker.id,
        ),
      );
    }
    const pending = this.permissions.pending.values().next().value;
    if (pending?.request.id === this.approvalId) {
      this.render();
      return;
    }
    if (this.approvalId) {
      this.dismiss();
      this.approvalId = undefined;
      if (this.suspended) {
        const modal = this.suspended;
        this.suspended = undefined;
        this.show(modal);
      }
    }
    if (!pending || this.closed) {
      this.render();
      return;
    }
    if (this.modal) {
      this.suspended = this.modal;
      this.overlay?.hide();
    }
    const { request } = pending;
    this.approvalId = request.id;
    // The question is drawn as a box: what the agent wants to do, and what
    // the user can say about it, in one place.
    const subject = request.subject ?? request.reason;
    const approval = new Approval(
      "Permission required",
      [
        request.agentId
          ? `Worker ${bold(request.agentId)} wants to run ${bold(request.tool)}.`
          : `The agent wants to run ${bold(request.tool)}.`,
        ...(request.reason === undefined || request.reason.length === 0
          ? []
          : [dim(`Reason: ${safe(request.reason)}`)]),
        ...(subject === undefined || subject === request.reason
          ? []
          : [`  Does: ${cyan(safe(subject))}`]),
        dim(`  In: ${request.cwd ?? this.options.cwd}`),
        dim(`  Arguments: ${safe(JSON.stringify(request.args ?? {}))}`),
        ...(request.outsideWorkspace === true
          ? [yellow("This is outside the workspace.")]
          : []),
      ],
      [
        {
          value: "allow",
          label: "Allow once",
          hint: "Run it this time, and ask again next time.",
        },
        {
          value: "allow-always",
          label: "Allow this exact action for this session",
          hint: "The same command or edit will not ask again.",
        },
        { value: "deny", label: "Deny", hint: "The agent is told it may not." },
      ],
      (choice) => {
        this.permissions.answer(
          request.id,
          (choice?.value ?? "deny") as "allow" | "deny" | "allow-always",
        );
      },
      () => this.tui.terminal.rows,
      "↑↓ move · Enter choose · d details · Esc denies",
    );
    const modal: Modal = {
      component: approval,
      cancel: () => this.permissions.answer(request.id, "deny"),
      // The dialog is a box in the middle of the screen, not a sheet over
      // it: the answer behind it stays readable.
      width: "72%",
      minWidth: 44,
    };
    approval.onDetails = () => {
      const detail: Modal = {
        component: new Detail(
          "Approval request · full details",
          () => JSON.stringify(request, null, 2),
          () => this.tui.terminal.rows,
          () => this.show(modal),
        ),
        cancel: () => this.show(modal),
      };
      this.show(detail);
    };
    this.show(modal);
  }
  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.closed) return;
    const slash = parseSlash(text);
    if (slash) {
      const safeWhileWorking = [
        "/exit",
        "/quit",
        "/model",
        "/inspect",
        "/permissions",
        "/tasks",
        "/agents",
        "/help",
        "/resume",
        "/clear",
        "/new",
      ];
      if (this.working && !safeWhileWorking.includes(slash.name)) {
        this.notice("Wait for the current turn, or press Esc to stop it.");
        return;
      }
      await this.command(slash.name, slash.args);
      this.render();
      return;
    }
    if (text === "?") {
      this.help();
      return;
    }
    this.view.pending.push(text);
    if (!this.working) this.task = this.pump();
    this.render();
  }
  private async pump(): Promise<void> {
    this.working = true;
    try {
      while (this.view.pending.length && !this.closed) {
        this.turn = new AbortController();
        await this.flushReports();
        if (this.stagedModel) {
          const model = this.stagedModel;
          this.stagedModel = undefined;
          await this.useModel(model);
        }
        const prompt = this.view.pending.shift()!;
        if (prompt.startsWith("!")) {
          const tool =
            this.options.state.tools.find((t) => t.name === "bash") ??
            withPermissions([createBashTool()], {
              mode: this.permissions.mode,
              controller: this.permissions,
              workspace: this.options.cwd,
            })[0]!;
          const call = {
            type: "toolCall" as const,
            id: `shell-${Date.now()}`,
            name: "bash",
            args: { command: prompt.slice(1).trim() },
          };
          this.view.begin(prompt);
          this.view.event({ t: "toolStart", call });
          this.render();
          const result = await tool.run(call.args, {
            cwd: this.options.cwd,
            signal: this.turn.signal,
          });
          this.view.event({
            t: "toolEnd",
            call,
            output: result.output,
            isError: result.isError,
          });
        } else {
          this.view.begin(prompt);
          this.render();
          try {
            for await (const event of run(
              this.options.state,
              prompt,
              this.turn.signal,
            )) {
              this.view.event(event);
              this.render();
            }
          } catch (error) {
            this.notice(error);
          }
        }
        this.view.finish(this.turn.signal.aborted);
        this.turn = undefined;
        await this.options.controller?.save();
        this.render();
      }
    } catch (error) {
      this.notice(error);
    } finally {
      this.working = false;
      this.turn = undefined;
      this.view.finish();
      await this.flushReports();
      this.render();
    }
  }
  private async stopForSwitch(): Promise<boolean> {
    if (!this.working && !this.options.workerManager?.active.length)
      return true;
    const choice = await this.select(
      "Switch conversation?",
      [
        { label: "Keep working", value: "cancel" },
        { label: "Stop active work and switch", value: "stop" },
      ],
      "The current turn and its workers must stop before switching.",
      false,
    );
    if (choice?.value !== "stop") return false;
    this.view.pending = [];
    this.turn?.abort();
    await this.options.workerManager?.stopAll();
    await this.foreground;
    await this.task;
    return true;
  }
  private async command(name: string, args: string): Promise<void> {
    const custom = this.options.commands?.find((c) => c.name === name);
    if (custom) {
      await this.submit(renderCommand(custom, args));
      return;
    }
    switch (name) {
      case "/exit":
      case "/quit":
        await this.close();
        return;
      case "/help":
        this.help();
        return;
      case "/inspect":
        this.inspectLatest();
        return;
      case "/model":
        await this.modelsPicker(args);
        return;
      case "/permissions":
        await this.permissionPicker();
        return;
      case "/resume":
        await this.sessions(args);
        return;
      case "/new":
      case "/clear":
        if (await this.stopForSwitch()) {
          await this.requireController().create();
          this.permissions.setMode(
            this.initialMode === "yolo" ? "ask" : this.initialMode,
          );
          this.reload();
        }
        return;
      case "/rename": {
        const title = args || (await this.prompt("Session name"));
        if (title?.trim()) {
          await this.options.store?.updateMetadata({ title: title.trim() });
          this.notice("Session renamed");
        }
        return;
      }
      case "/fork":
        await this.requireController().fork(args || undefined);
        this.reload();
        return;
      case "/tree": {
        const entries = await this.options.store?.read(
          this.options.store.id ?? "",
        );
        const sessions = await this.options.store?.list();
        this.detail(
          "Conversation branches · /fork <entry-id>",
          () =>
            (sessions ?? [])
              .map(
                (s) =>
                  `${s.id} ← ${s.parentSessionId ?? "root"}${s.forkEntryId ? ` at ${s.forkEntryId}` : ""} · ${s.title ?? "untitled"}`,
              )
              .join("\n") +
            "\n\nCurrent conversation entries:\n" +
            (entries ?? [])
              .map((e) => `${e.id} ← ${e.parent ?? "root"} · ${e.msg.role}`)
              .join("\n"),
        );
        return;
      }
      case "/undo": {
        if (this.permissions.mode === "plan") {
          this.notice("Plan mode is read-only");
          return;
        }
        const undone = await (
          this.options.state.checkpoints ?? this.options.checkpoints
        )?.undo(args || undefined);
        this.notice(
          undone
            ? `Undone ${undone.checkpoint.path}`
            : "There is nothing to undo",
        );
        return;
      }
      case "/compact": {
        this.working = true;
        this.turn = new AbortController();
        this.view.activity = "Compacting";
        try {
          const compaction = compactMessages({
            provider: this.options.state.provider,
            model: this.options.state.model,
            messages: this.options.state.messages,
            signal: this.turn.signal,
          });
          this.foreground = compaction;
          const messages = await compaction;
          if (messages) {
            for (const [index, msg] of messages.entries())
              await this.options.state.journal?.append(msg, {
                compacted: index === 0,
                model: this.model,
              });
            this.options.state.messages = messages;
            this.reload();
          }
        } finally {
          this.foreground = undefined;
          this.working = false;
          this.turn = undefined;
          this.view.finish();
          this.render();
        }
        return;
      }
      case "/login": {
        const provider = args || (await this.prompt("Provider to sign in to"));
        if (provider) {
          const result = await this.options.onLogin?.(provider);
          if (result && typeof result !== "string" && result.ok) {
            this.models = [];
            if (this.model.split("/")[0] === provider)
              await this.useModel(this.model);
          }
          this.notice(
            typeof result === "string"
              ? result
              : (result?.message ?? "Login is unavailable"),
          );
        }
        return;
      }
      case "/tasks":
      case "/subagents":
        await this.workers();
        return;
      case "/agents": {
        const profile = this.options.agents?.find(
          (agent) => agent.name === args,
        );
        if (profile) {
          if (this.working) this.stagedModel = profile.model;
          else await this.useModel(profile.model);
          return;
        }
        const choices = [...(this.options.roles?.values() ?? [])].map(
          (role) => ({
            label: `${role.name} · worker role`,
            value: role.name,
            description: `${role.description ?? ""} · ${role.model ?? this.model} · tools: ${role.tools?.join(", ") ?? "inherited"}`,
          }),
        );
        choices.push(
          ...(this.options.agents ?? []).map((agent) => ({
            label: `${agent.name} · main-agent profile`,
            value: `profile:${agent.name}`,
            description: `${agent.description ?? ""} · ${agent.model}`,
          })),
        );
        const choice = await this.select("Agent roles", choices);
        if (choice) {
          if (choice.value.startsWith("profile:")) {
            const selected = this.options.agents?.find(
              (agent) => `profile:${agent.name}` === choice.value,
            );
            if (selected) {
              if (this.working) this.stagedModel = selected.model;
              else await this.useModel(selected.model);
            }
            return;
          }
          const prompt = await this.prompt(`Task for ${choice.label}`);
          if (prompt)
            void this.options.workerManager
              ?.start(choice.value, prompt)
              .then((record) => this.reportWorker(record))
              .catch((error) => this.notice(error));
        }
        return;
      }
      case "/review":
        await this.review();
        return;
      case "/diff": {
        const snapshot = await reviewSnapshot(
          this.options.cwd,
          { kind: "uncommitted" },
          new AbortController().signal,
        );
        this.detail("Working tree diff", () => snapshot.diff || "No changes");
        return;
      }
      default:
        this.notice(`Unknown command: ${name}. Try /help.`);
    }
  }
  private requireController(): SessionController {
    if (!this.options.controller)
      throw new Error("This session has no persistence controller");
    return this.options.controller;
  }
  /**
   * The commands and the keys.
   *
   * The name of a command is in bold and its explanation is dim: the bold
   * is for the small things — the name and the key — and not for the text
   * that explains them.
   */
  private help(): void {
    const shortcuts: Array<[string, string]> = [
      ["Shift+Tab", "Ask → Auto-edit → Plan"],
      ["Ctrl+O", "Transcript"],
      ["Alt+I", "Latest tool/thinking"],
      ["Ctrl+B", "Workers"],
      ["Ctrl+R", "Prompt history"],
      ["Shift+Enter / Ctrl+J", "Newline"],
      ["Esc", "Back / interrupt"],
      ["@file", "File completion"],
      ["!command", "Shell (current permissions apply)"],
    ];
    const widest = shortcuts.reduce(
      (most, [key]) => Math.max(most, key.length),
      0,
    );
    this.detail("Commands and shortcuts", () => {
      const commands = [
        ...SLASH_COMMANDS,
        ...(this.options.commands ?? []),
      ].map((c) => `${bold(c.name)}  ${dim(c.description ?? "")}`);
      const keys = shortcuts.map(
        ([key, what]) =>
          `${bold(key.padEnd(widest))}  ${dim(what)}`,
      );
      return [
        ...commands,
        "",
        ...keys,
        "",
        dim("Full access is available explicitly in /permissions."),
      ].join("\n");
    });
  }
  private async modelsPicker(ref: string): Promise<void> {
    if (ref) {
      if (this.working) this.stagedModel = ref;
      else await this.useModel(ref);
      return;
    }
    const choiceFor = (model: AvailableModel): Choice => ({
      value: model.ref,
      label: model.name ?? model.id,
      description: `${model.ref}${model.free ? " · free" : ""}${model.contextWindow ? ` · ${model.contextWindow.toLocaleString()} context` : ""}${model.pricing ? ` · $${model.pricing.input}/$${model.pricing.output} per 1M tokens` : ""}`,
      // The models of a provider sit under its name, so the list says
      // where each one comes from.
      group: PROVIDER_NAMES[model.provider] ?? model.provider,
      current: model.ref === this.model,
    });
    const promise = this.select(
      "Select Model",
      this.models.map(choiceFor),
      "Configured providers · type to search",
    );
    const modal = this.modal;
    const selector = modal?.component as Selector;
    selector.status = this.models.length
      ? "Refreshing catalog…"
      : "Loading models…";
    this.catalogAbort?.abort();
    const catalogAbort = new AbortController();
    this.catalogAbort = catalogAbort;
    void (
      this.options.onModels?.(catalogAbort.signal) ?? Promise.resolve([])
    ).then(
      (result) => {
        if (this.closed || (this.modal !== modal && this.suspended !== modal))
          return;
        const models = Array.isArray(result) ? result : result.models;
        const problems = Array.isArray(result) ? [] : (result.problems ?? []);
        const unavailable = new Set(
          problems.map((problem) => problem.provider),
        );
        if (models.length)
          this.models = [
            ...new Map(
              [
                ...this.models.filter((model) =>
                  unavailable.has(model.provider),
                ),
                ...models,
              ].map((model) => [model.ref, model]),
            ).values(),
          ];
        selector.setItems(this.models.map(choiceFor));
        selector.status = problems.length
          ? describeProblems(problems)
          : models.length
            ? ""
            : this.models.length
              ? "Using cached catalog; refresh returned no models"
              : "No available models. Use /login to configure a provider.";
        this.render();
      },
      (error) => {
        if (this.closed || catalogAbort.signal.aborted) return;
        selector.status = `Catalog unavailable${this.models.length ? "; cached models shown" : ""}: ${String(error)}`;
        this.render();
      },
    );
    const selected = await promise;
    catalogAbort.abort();
    if (selected) {
      if (this.working) this.stagedModel = selected.value;
      else await this.useModel(selected.value);
    }
  }
  private async useModel(ref: string): Promise<void> {
    let provider: Provider | undefined;
    try {
      provider = this.options.onModel
        ? await this.options.onModel(ref)
        : this.options.controller
          ? await this.options.controller.options.providerFor(ref)
          : undefined;
    } catch (error) {
      this.notice(
        `Could not use ${ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!provider) {
      this.notice(`Could not use ${ref}`);
      return;
    }
    const metadata = this.models.find((model) => model.ref === ref);
    let effort: string | undefined;
    if (metadata?.supportedEfforts?.length) {
      const choice = await this.select(
        "Reasoning effort",
        [
          { label: "Provider default", value: "default" },
          ...metadata.supportedEfforts.map((value) => ({
            label: value,
            value,
          })),
        ],
        "Only values advertised by this model are shown.",
        false,
      );
      if (!choice) return;
      effort = choice.value === "default" ? undefined : choice.value;
    }
    if (this.options.controller)
      await this.options.controller.setModel(ref, provider, effort);
    else {
      this.options.state.provider = provider;
      this.options.state.model = ref.slice(ref.indexOf("/") + 1);
    }
    this.options.state.reasoningEffort = effort;
    const previous = this.model;
    this.model = ref;
    if (previous !== ref) {
      this.view.modelChanged(previous, ref);
      this.options.controller?.recordModelChange(previous, ref);
      await this.options.controller?.save();
    }
    // The notice says who answers: the name of the provider is the thing
    // the user needs when an answer does not come from where it should.
    const expected = ref.slice(0, ref.indexOf("/"));
    const name = PROVIDER_NAMES[expected];
    this.notice(
      `now using ${ref}${name === undefined ? "" : ` · ${name}`}${
        provider.id === expected ? "" : ` · served by "${provider.id}"`
      }`,
    );
  }
  private async permissionPicker(): Promise<void> {
    const choice = await this.select(
      "Permissions",
      [
        {
          label: "Ask",
          value: "ask",
          description: "Read files; ask before edits and commands.",
        },
        {
          label: "Auto-edit",
          value: "auto-edit",
          description: "Read and edit workspace files; ask before commands.",
        },
        {
          label: "Plan",
          value: "plan",
          description: "Read-only tools; deny edits and execution.",
        },
        {
          label: "Full access",
          value: "yolo",
          description:
            "Skip application approval prompts. Explicit deny rules still apply. This does not change OS sandboxing.",
        },
      ].map((item) => ({
        ...item,
        current: item.value === this.permissions.mode,
      })),
      `Rules: ${this.permissions.config.rules?.map((r) => `${r.tool}(${r.pattern ?? "*"}) ${r.action}`).join("; ") || "none"}`,
      false,
    );
    if (!choice) return;
    if (choice.value === "yolo") {
      const confirm = await this.select(
        "Enable Full access?",
        [
          { label: "Keep current permissions", value: "cancel" },
          { label: "Enable Full access for this session", value: "enable" },
        ],
        "Commands and out-of-workspace actions may run without approval.",
        false,
      );
      if (confirm?.value !== "enable") return;
    }
    this.permissions.setMode(choice.value as PermissionMode);
  }
  private async sessions(id?: string): Promise<void> {
    const controller = this.requireController();
    let chosen = id;
    if (!chosen) {
      const sessions = await controller.options.store.list();
      const choice = await this.select(
        "Resume conversation",
        sessions.map((s) => ({
          value: s.id,
          label: s.title || s.id,
          description: `${s.updatedAt} · ${s.model} · ${s.entries} messages · ${s.id}`,
          current: s.id === controller.id,
        })),
      );
      chosen = choice?.value;
    }
    if (!chosen || chosen === controller.id || !(await this.stopForSwitch()))
      return;
    try {
      await controller.open(chosen);
    } catch (error) {
      this.notice(error);
      const replacement = await this.select(
        "Saved model unavailable",
        [
          { label: `Use current model: ${this.model}`, value: this.model },
          { label: "Cancel", value: "cancel" },
        ],
        String(error),
        false,
      );
      if (!replacement || replacement.value === "cancel") return;
      await controller.open(chosen, replacement.value);
    }
    this.permissions.setMode(
      this.initialMode === "yolo" ? "ask" : this.initialMode,
    );
    this.reload();
  }
  private workerChoices(): Choice[] {
    return [
      ...(
        this.options.workerManager?.records ??
        this.options.workers ??
        new Map<string, WorkerRecord>()
      ).values(),
    ].map((w) => ({
      value: w.id,
      label: `${w.agent} · ${w.status ?? "completed"}`,
      description: `${w.prompt} · ${w.model ?? ""} · ${w.tokens ?? 0} tokens`,
    }));
  }
  private async workers(): Promise<void> {
    const manager = this.options.workerManager;
    const records =
      manager?.records ??
      this.options.workers ??
      new Map<string, WorkerRecord>();
    const selection = this.select("Workers", this.workerChoices());
    this.workerSelector = this.modal?.component as Selector;
    const choice = await selection;
    this.workerSelector = undefined;
    if (!choice) return;
    const worker = records.get(choice.value);
    if (!worker) return;
    const show = (): void =>
      this.detail(
        `Worker · ${worker.agent} · ${worker.id}`,
        () => {
          const view = this.workerViews.get(worker.id);
          const messages = view
            ? view.blocks
                .map((b) => `${b.kind}: ${b.text || blockSummary(b)}`)
                .join("\n\n")
            : worker.messages
                .map((m) =>
                  m.role === "assistant"
                    ? m.content
                        .map((b) => (b.type === "toolCall" ? b.name : b.text))
                        .join("\n")
                    : m.content,
                )
                .join("\n\n");
          return `${worker.status ?? "completed"} · ${worker.model ?? ""} · ${worker.tokens ?? 0} tokens\nTask: ${worker.prompt}\n${worker.worktree ? `Worktree: ${worker.worktree.path}\nBranch: ${worker.worktree.branch}` : "Shared workspace"}\n${worker.error ?? ""}\nQueued follow-ups: ${worker.queued?.length ?? 0}\n\n${messages || worker.report}`;
        },
        (key) => {
          if (key === "s") {
            manager?.stop(worker.id);
            this.render();
          }
          if (key === "f" || key === "r") {
            this.dismiss();
            void this.prompt(
              `${key === "r" ? "Resume" : "Follow up with"} ${worker.agent}`,
            ).then((prompt) => {
              if (prompt)
                void manager
                  ?.followUp(worker.id, prompt)
                  .then((record) => this.reportWorker(record))
                  .catch((error) => this.notice(error));
              show();
            });
          }
        },
        "↑↓ scroll · s stop · f follow-up · r resume · Esc main conversation",
      );
    show();
  }
  private async review(): Promise<void> {
    const choice = await this.select(
      "Review changes",
      [
        { label: "Uncommitted changes", value: "uncommitted" },
        { label: "Against a base branch", value: "base" },
        { label: "A commit", value: "commit" },
        { label: "Custom instructions (uncommitted changes)", value: "custom" },
        ...(this.options.controller?.reviews.map((r) => ({
          label: `${r.status} · ${r.at}`,
          value: r.id,
        })) ?? []),
      ],
      "Read-only review; findings never apply changes automatically.",
      false,
    );
    if (!choice) return;
    const previous = this.options.controller?.reviews.find(
      (r) => r.id === choice.value,
    );
    if (previous) {
      await this.reviewDetail(previous);
      return;
    }
    let target: ReviewTarget = { kind: "uncommitted" };
    let instructions = "";
    if (choice.value === "base" || choice.value === "commit") {
      const ref = await this.prompt(
        choice.value === "base" ? "Base branch" : "Commit",
      );
      if (!ref) return;
      target = { kind: choice.value, ref };
    }
    if (choice.value === "custom") {
      const value = await this.prompt("Review instructions");
      if (!value) return;
      instructions = value;
    }
    this.working = true;
    this.turn = new AbortController();
    this.view.activity = "Reviewing changes";
    this.render();
    try {
      const execution = executeReview(
        this.options.state,
        target,
        instructions,
        this.turn.signal,
        (record) => {
          const reviews = this.options.controller?.reviews;
          if (reviews && !reviews.some((r) => r.id === record.id))
            reviews.push(record);
          this.options.controller?.scheduleSave();
          this.render();
        },
      );
      this.foreground = execution;
      const review = await execution;
      await this.options.controller?.save();
      if (!this.closed && !this.turn?.signal.aborted)
        await this.reviewDetail(review);
    } finally {
      this.foreground = undefined;
      this.working = false;
      this.turn = undefined;
      this.view.finish();
      this.render();
      if (this.view.pending.length && !this.closed) this.task = this.pump();
    }
  }
  private async reportWorker(record: WorkerRecord): Promise<void> {
    const key = `${record.id}:${record.runNumber}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.reports.push({
      role: "user",
      content: `Worker ${record.agent} (${record.id}) ${record.status}:\n<worker_report>\n${record.report}\n${record.error ?? ""}\n</worker_report>`,
    });
    if (!this.working) await this.flushReports();
  }
  private async flushReports(): Promise<void> {
    for (const msg of this.reports.splice(0)) {
      this.options.state.messages.push(msg);
      await this.options.state.journal?.append(msg, { model: this.model });
    }
  }
  private async reviewDetail(review: ReviewRun): Promise<void> {
    const snapshot = await reviewSnapshot(
      this.options.cwd,
      review.target,
      new AbortController().signal,
    ).catch(() => undefined);
    const stale = !snapshot || snapshot.fingerprint !== review.fingerprint;
    this.detail(
      `Code review · ${review.status}${stale ? " · STALE" : ""}`,
      () =>
        `${review.summary}\n${review.error ?? ""}\n${review.omissions.join("\n")}\n\n${review.findings
          .map(
            (f) => `${f.priority} ${f.path}:${f.line} · ${f.title}\n${f.body}`,
          )
          .join(
            "\n\n",
          )}\n\n${review.status === "completed" && !review.findings.length ? "No findings." : ""}\n\nReviewed diff:\n${review.diff}`,
      (key) => {
        if (key === "f" && review.findings.length) {
          this.dismiss();
          this.editor.setText(
            `Fix these review findings:\n${JSON.stringify(review.findings, null, 2)}`,
          );
        }
      },
      "↑↓ scroll · f draft a fix request · Esc back",
    );
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.view.pending = [];
    this.turn?.abort();
    this.permissions.reset();
    this.catalogAbort?.abort();
    this.modal?.cancel();
    this.suspended?.cancel();
    if (this.timer) clearInterval(this.timer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    let code = 0;
    try {
      await this.options.workerManager?.stopAll();
      await this.foreground;
      await this.task;
      await this.options.controller?.save();
    } catch {
      code = 1;
    } finally {
      this.overlay?.hide();
      this.tui.stop();
      this.resolveRun?.(code);
    }
  }
}
