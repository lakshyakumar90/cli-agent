import { randomUUID } from "node:crypto";
import { decidePermission, type PermissionConfig } from "./decide.js";
import type {
  AskPermission,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "./types.js";
import { matchRule } from "./rules.js";

export interface PendingApproval {
  request: PermissionRequest & { id: string };
  resolve(decision: PermissionDecision): void;
}

/** One live policy for the main agent and all of its workers. Grants are literal. */
export class PermissionController {
  private grants = new Set<string>();
  private listeners = new Set<() => void>();
  readonly pending = new Map<string, PendingApproval>();
  constructor(
    readonly config: PermissionConfig,
    private ask?: AskPermission,
  ) {}
  get mode(): PermissionMode {
    return this.config.mode;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
  setMode(mode: PermissionMode): void {
    this.config.mode = mode;
    for (const item of [...this.pending.values()]) {
      const action = this.action(item.request);
      if (action !== "ask") item.resolve(action === "allow" ? "allow" : "deny");
    }
    this.emit();
  }
  reset(): void {
    this.grants.clear();
    for (const item of [...this.pending.values()]) item.resolve("deny");
    this.emit();
  }
  private key(request: PermissionRequest): string {
    return JSON.stringify([
      request.tool,
      request.subject,
      request.path,
      request.cwd,
      request.args,
    ]);
  }
  private action(request: PermissionRequest): "allow" | "deny" | "ask" {
    const action = decidePermission(request, this.config);
    if (action === "ask" && this.grants.has(this.key(request))) return "allow";
    return action;
  }
  async authorize(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return false;
    const action = this.action(request);
    if (action !== "ask") return action === "allow";
    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (decision: PermissionDecision): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
        if (decision === "allow-always") this.grants.add(this.key(request));
        this.emit();
        // A stricter policy may have arrived while the dialog was open.
        resolve(
          !signal.aborted &&
            decision !== "deny" &&
            this.action(request) !== "deny",
        );
      };
      const abort = (): void => finish("deny");
      const item = { request: { ...request, id }, resolve: finish };
      this.pending.set(id, item);
      signal.addEventListener("abort", abort, { once: true });
      this.emit();
      if (this.ask !== undefined)
        void this.ask(item.request, signal).then(finish, () => finish("deny"));
    });
  }
  answer(id: string, decision: PermissionDecision): void {
    this.pending.get(id)?.resolve(decision);
  }
  explain(request: PermissionRequest): string {
    if (this.mode === "plan" && request.effect !== "read")
      return "Plan mode only permits read-only tools";
    const rule = (this.config.rules ?? []).find(
      (r) =>
        r.action === "deny" && matchRule([r], request.tool, request.subject),
    );
    if (rule)
      return `Denied by rule: ${rule.tool}(${rule.pattern ?? "*"}) deny`;
    if (this.mode === "plan" && request.outsideWorkspace)
      return "Plan mode cannot access paths outside the workspace";
    return `Approval denied or cancelled for ${request.tool}: ${request.subject ?? request.reason}`;
  }
}
