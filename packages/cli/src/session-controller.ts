import type { Provider, Usage } from "@cli-agent/ai";
import type {
  AgentState,
  SessionStore,
  WorkerManager,
  WorkerRecord,
} from "@cli-agent/core";
import { CheckpointStore } from "@cli-agent/core";
import type { PermissionController } from "@cli-agent/tools";
import type { ReviewRun } from "./review.js";

export interface ModelChange {
  after: number;
  from: string;
  to: string;
}

interface SavedUi {
  modelChanges?: ModelChange[];
  version: 1;
  model?: string;
  workers: WorkerRecord[];
  reviews: ReviewRun[];
  reasoningEffort?: string;
}
export interface SessionControllerOptions {
  state: AgentState;
  store: SessionStore;
  permissions: PermissionController;
  workerManager: WorkerManager;
  model: string;
  providerFor(ref: string): Promise<Provider>;
  onSwitch?(id: string): Promise<void>;
}

/** Switches runtime state and journal together; UI never replaces messages on its own. */
export class SessionController {
  model: string;
  reviews: ReviewRun[] = [];
  modelChanges: ModelChange[] = [];
  recordModelChange(from: string, to: string): void {
    this.modelChanges.push({
      after: this.options.state.messages.length,
      from,
      to,
    });
  }
  private writes: Promise<void> = Promise.resolve();
  private persistTimer?: NodeJS.Timeout;
  constructor(readonly options: SessionControllerOptions) {
    this.model = options.model;
    options.workerManager.subscribe(() => this.scheduleSave());
  }
  get id(): string | undefined {
    return this.options.store.id;
  }
  get usage(): Usage {
    return this.options.state.messages.reduce<Usage>(
      (total, message) => {
        if (message.role === "assistant" && message.usage) {
          total.inputTokens += message.usage.inputTokens;
          total.outputTokens += message.usage.outputTokens;
        }
        return total;
      },
      { inputTokens: 0, outputTokens: 0 },
    );
  }
  async restore(): Promise<void> {
    const saved = await this.options.store.loadUi<SavedUi>({
      version: 1,
      workers: [],
      reviews: [],
    });
    this.modelChanges = Array.isArray(saved.modelChanges)
      ? saved.modelChanges
      : [];
    this.reviews = Array.isArray(saved.reviews) ? saved.reviews : [];
    for (const review of this.reviews)
      if (review.status === "running") {
        review.status = "cancelled";
        review.error = "Review interrupted when the previous process exited.";
      }
    this.options.state.reasoningEffort =
      saved.model === this.model ? saved.reasoningEffort : undefined;
    this.options.workerManager.restore(
      Array.isArray(saved.workers) ? saved.workers : [],
    );
  }
  scheduleSave(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.save().catch(() => undefined);
    }, 150);
    this.persistTimer.unref();
  }
  async save(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const id = this.id;
    const snapshot: SavedUi = JSON.parse(
      JSON.stringify({
        version: 1,
        model: this.model,
        workers: [...this.options.workerManager.records.values()],
        reviews: this.reviews,
        modelChanges: this.modelChanges,
        reasoningEffort: this.options.state.reasoningEffort,
      }),
    ) as SavedUi;
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => this.options.store.saveUi(snapshot, id));
    await this.writes;
  }
  async setModel(
    ref: string,
    provider?: Provider,
    effort?: string,
  ): Promise<void> {
    const resolved = provider ?? (await this.options.providerFor(ref));
    await this.options.store.updateMetadata({ model: ref });
    this.applyModel(ref, resolved, effort);
  }
  private applyModel(ref: string, resolved: Provider, effort?: string): void {
    if (this.model !== ref) this.options.state.tokens = undefined;
    this.model = ref;
    this.options.state.provider = resolved;
    this.options.state.model = ref.slice(ref.indexOf("/") + 1);
    this.options.state.reasoningEffort = effort;
    this.options.workerManager.options.defaultModel = ref;
  }
  private checkIdle(): void {
    if (this.options.workerManager.active.length)
      throw new Error("Stop workers before switching sessions");
  }
  async open(id: string, replacement?: string): Promise<void> {
    this.checkIdle();
    const { store, state } = this.options;
    if (!(await store.exists(id)))
      throw new Error(`No conversation called ${id}`);
    const metadata = await store.metadata(id);
    const ref = replacement ?? metadata?.model ?? this.model;
    // Resolve everything that can fail before changing the active journal.
    const provider = await this.options.providerFor(ref || this.model);
    const messages = await store.transcript(id);
    await this.save();
    await store.updateMetadata({ model: ref || this.model }, id);
    await store.open({ id });
    this.options.workerManager.options.parentId = id;
    state.messages = messages;
    state.checkpoints = new CheckpointStore();
    state.tokens = undefined;
    this.options.permissions.reset();
    this.applyModel(ref || this.model, provider);
    await this.restore();
    await this.options.onSwitch?.(id);
  }
  async create(): Promise<void> {
    this.checkIdle();
    await this.save();
    const id = await this.options.store.create({ model: this.model });
    this.options.workerManager.options.parentId = id;
    this.options.state.messages = [];
    this.options.state.checkpoints = new CheckpointStore();
    this.options.state.tokens = undefined;
    this.options.state.reasoningEffort = undefined;
    this.options.permissions.reset();
    this.options.workerManager.restore([]);
    this.reviews = [];
    this.modelChanges = [];
    await this.options.onSwitch?.(id);
  }
  async fork(entryId?: string): Promise<void> {
    this.checkIdle();
    const { store, state } = this.options;
    if (!store.id) throw new Error("No active session");
    const entries = await store.read(store.id);
    const from = entryId ?? entries.at(-1)?.id;
    if (!from) throw new Error("There is nothing to fork from");
    await this.save();
    const id = await store.fork(store.id, from, { model: this.model });
    if (!id) throw new Error("Message not found");
    this.options.workerManager.options.parentId = id;
    state.messages = await store.transcript(id);
    state.checkpoints = new CheckpointStore();
    this.options.permissions.reset();
    this.options.workerManager.restore([]);
    this.reviews = [];
    this.modelChanges = [];
    await this.options.onSwitch?.(id);
  }
}
