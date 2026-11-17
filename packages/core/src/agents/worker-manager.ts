import { randomUUID } from "node:crypto";
import type { Tool, ToolContext } from "@cli-agent/tools";
import { run } from "../loop.js";
import { costOf } from "../budget.js";
import { modelIdOf, providerIdOf } from "../ref.js";
import { createState, type AgentEvent, type AgentState } from "../types.js";
import { canWrite, createWorktree } from "./isolation.js";
import type { TaskToolOptions, WorkerRecord } from "./task-tool.js";

export interface WorkerUpdate {
  worker: WorkerRecord;
  event?: AgentEvent;
}

/** Owns worker lifetimes independently of whichever UI is observing them. */
export class WorkerManager {
  readonly records = new Map<string, WorkerRecord>();
  private controllers = new Map<string, AbortController>();
  private promises = new Map<string, Promise<WorkerRecord>>();
  private listeners = new Set<(update: WorkerUpdate) => void>();
  private running = 0;
  private waiters: Array<() => void> = [];
  constructor(readonly options: TaskToolOptions) {}
  get active(): WorkerRecord[] {
    return [...this.records.values()].filter((r) => this.controllers.has(r.id));
  }
  subscribe(listener: (update: WorkerUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(worker: WorkerRecord, event?: AgentEvent): void {
    worker.updatedAt = new Date().toISOString();
    this.options.onWorker?.(worker);
    for (const listener of this.listeners)
      listener({ worker, ...(event ? { event } : {}) });
  }
  restore(records: WorkerRecord[]): void {
    if (this.active.length)
      throw new Error("Stop workers before switching sessions");
    this.records.clear();
    for (const record of records) {
      if (
        ["queued", "running", "waiting-approval"].includes(record.status ?? "")
      ) {
        record.status = "interrupted";
      }
      this.records.set(record.id, record);
    }
  }
  setWaiting(id: string, waiting: boolean): void {
    const record = this.records.get(id);
    if (record && this.controllers.has(id) && record.status !== "queued") {
      record.status = waiting ? "waiting-approval" : "running";
      this.emit(record);
    }
  }
  start(
    agent: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<WorkerRecord> {
    if ((this.options.depth ?? 0) >= (this.options.maxDepth ?? 1)) {
      return Promise.reject(
        new Error(`the agent "${agent}" cannot delegate any further`),
      );
    }
    if (!this.options.roles.has(agent))
      return Promise.reject(new Error(`there is no agent called "${agent}"`));
    const record: WorkerRecord = {
      id: `t${randomUUID()}`,
      agent,
      prompt,
      report: "",
      messages: [],
      status: "queued",
      model: this.options.roles.get(agent)?.model ?? this.options.defaultModel,
      parentId: this.options.parentId,
      startedAt: new Date().toISOString(),
      queued: [],
      runNumber: 0,
    };
    this.records.set(record.id, record);
    this.options.board?.add({ id: record.id, agent, prompt, owner: agent });
    return this.launch(record, prompt, signal);
  }
  followUp(id: string, prompt: string): Promise<WorkerRecord> {
    const record = this.records.get(id);
    if (!record) return Promise.reject(new Error("Worker not found"));
    if (this.controllers.has(id)) {
      (record.queued ??= []).push(prompt);
      this.emit(record);
      return this.promises.get(id)!;
    }
    return this.launch(record, prompt);
  }
  stop(id: string): void {
    const record = this.records.get(id);
    if (record) record.queued = [];
    this.controllers.get(id)?.abort();
  }
  async stopAll(): Promise<void> {
    for (const id of this.controllers.keys()) this.stop(id);
    await Promise.allSettled(this.promises.values());
  }
  private async acquire(signal: AbortSignal): Promise<void> {
    while (this.running >= (this.options.concurrency ?? 3)) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal.removeEventListener("abort", wake);
          this.waiters = this.waiters.filter((fn) => fn !== wake);
          resolve();
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    signal.throwIfAborted();
    this.running++;
  }
  private launch(
    record: WorkerRecord,
    prompt: string,
    parentSignal?: AbortSignal,
  ): Promise<WorkerRecord> {
    const controller = new AbortController();
    this.controllers.set(record.id, controller);
    const signal = parentSignal
      ? AbortSignal.any([controller.signal, parentSignal])
      : controller.signal;
    const promise = this.execute(record, prompt, signal).finally(() => {
      this.controllers.delete(record.id);
      this.promises.delete(record.id);
      this.emit(record);
    });
    this.promises.set(record.id, promise);
    return promise;
  }
  private async execute(
    record: WorkerRecord,
    prompt: string,
    parentSignal: AbortSignal,
  ): Promise<WorkerRecord> {
    let acquired = false;
    let child: AgentState | undefined;
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      this.options.timeoutMs ?? 600_000,
    );
    timeout.unref();
    const signal = AbortSignal.any([parentSignal, timeoutController.signal]);
    record.status = "queued";
    record.error = undefined;
    this.emit(record);
    try {
      await this.acquire(signal);
      acquired = true;
      const role = this.options.roles.get(record.agent);
      if (!role) throw new Error("Worker role no longer exists");
      if (
        !record.worktree &&
        this.options.isolate !== false &&
        canWrite(role.tools)
      ) {
        record.worktree = await createWorktree(
          this.options.cwd,
          `${record.agent}-${record.id}`,
        );
      }
      const cwd = record.worktree?.path ?? this.options.cwd;
      const ref = record.model ?? this.options.defaultModel;
      const provider = await this.options.providerFor(ref);
      const workerTools: Tool[] = this.options.tools
        .filter(
          (tool) =>
            tool.name !== "task" &&
            (!role.tools || role.tools.includes(tool.name)),
        )
        .map((tool) => ({
          ...tool,
          run: (args: unknown, ctx: ToolContext) =>
            tool.run(args, {
              ...ctx,
              agentId: record.id,
              workspace: cwd,
            }),
        }));
      child = createState(provider, {
        model: modelIdOf(ref),
        tools: workerTools,
        system: role.prompt,
        cwd,
        depth: (this.options.depth ?? 0) + 1,
        messages: [...record.messages],
        limits: {
          tokenBudget: this.options.tokenBudget,
          costBudget: this.options.costBudget,
        },
      });
      record.status = "running";
      record.runNumber = (record.runNumber ?? 0) + 1;
      this.options.board?.update(record.id, { status: "running" });
      let next: string | undefined = prompt;
      while (next !== undefined) {
        signal.throwIfAborted();
        record.report = "";
        for await (const event of run(child, next, signal)) {
          if (event.t === "text") record.report += event.delta;
          if (event.t === "toolStart") record.report = "";
          if (event.t === "done") {
            record.tokens =
              (record.tokens ?? 0) +
              event.usage.inputTokens +
              event.usage.outputTokens;
            record.cost =
              (record.cost ?? 0) +
              costOf(providerIdOf(ref), modelIdOf(ref), event.usage);
            if (event.reason === "budget-exhausted")
              record.report += "\n(it ran out of budget)";
          }
          record.messages = [...child.messages];
          this.emit(record, event);
        }
        record.messages = [...child.messages];
        next = record.queued?.shift();
      }
      signal.throwIfAborted();
      record.status = "completed";
      this.options.board?.update(record.id, {
        status: "done",
        result: record.report,
        tokens: record.tokens,
        cost: record.cost,
        branch: record.worktree?.branch,
      });
    } catch (error) {
      record.status = parentSignal.aborted ? "cancelled" : "failed";
      record.error = timeoutController.signal.aborted
        ? "Worker timed out"
        : error instanceof Error
          ? error.message
          : String(error);
      this.options.board?.update(record.id, {
        status: "failed",
        error: record.error,
      });
    } finally {
      if (child) record.messages = [...child.messages];
      clearTimeout(timeout);
      if (acquired) {
        this.running--;
        this.waiters.shift()?.();
      }
      await this.options.board?.save();
      this.emit(record);
    }
    return record;
  }
}
