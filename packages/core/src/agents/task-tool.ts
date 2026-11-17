/**
 * The task tool.
 *
 * The parent delegates to a worker: the worker gets its own system prompt,
 * its own tools and its own model, and only the report it writes comes
 * back. A worker can read fifty files; the parent sees three hundred words.
 *
 * The guards are here, not in the worker:
 * - a worker cannot spawn workers, unless its role says it may (the depth
 *   limit)
 * - a worker has its own turn and token budget, and its own timeout
 * - the tasks of one session run at most a few at a time
 * - a failure is reported, not retried in silence
 */

import type { Provider } from "@cli-agent/ai";
import type { Msg } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { WorkerManager } from "./worker-manager.js";
import { Board } from "./board.js";
import { mergeWorktree, removeWorktree, type Worktree } from "./isolation.js";
import type { AgentRole } from "./roles.js";

export interface TaskToolOptions {
  parentId?: string;
  manager?: WorkerManager;
  /** The roles that can be called. */
  roles: Map<string, AgentRole>;
  /** Builds the provider for a role's model. */
  providerFor: (model: string) => Promise<Provider>;
  /** The model the roles use when they do not name one. */
  defaultModel: string;
  /** The tools the parent has; a worker gets the ones its role names. */
  tools: Tool[];
  /** The workspace the workers work in. */
  cwd: string;
  /** The board the tasks are written to. */
  board?: Board;
  /** How many workers may run at once. Default 3. */
  concurrency?: number;
  /** How deep the workers may go. Default 1: only the lead spawns. */
  maxDepth?: number;
  /** How long a worker may take. Default 10 minutes. */
  timeoutMs?: number;
  /** The tokens one worker may use. */
  tokenBudget?: number;
  /** The US dollars one worker may spend. */
  costBudget?: number;
  /** Gives a writing worker a worktree of its own. Default true. */
  isolate?: boolean;
  /** How deep the parent is. */
  depth?: number;
  /**
   * Called when a worker is done.
   *
   * The worker's own conversation is kept here: it is not in the parent's
   * context, but the user may want to look inside the worker that did the
   * work.
   */
  onWorker?: (worker: WorkerRecord) => void;
}

/** What a worker did, for the user to look at. */
export interface WorkerRecord {
  status?:
    | "queued"
    | "running"
    | "waiting-approval"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  model?: string;
  parentId?: string;
  startedAt?: string;
  updatedAt?: string;
  tokens?: number;
  cost?: number;
  error?: string;
  worktree?: Worktree;
  queued?: string[];
  runNumber?: number;

  /** The id of the task. */
  id: string;
  /** The role that did it. */
  agent: string;
  /** What it was asked. */
  prompt: string;
  /** The report it wrote. */
  report: string;
  /** Its own conversation. */
  messages: Msg[];
}

/** The same manager serves model delegation and the interactive worker controls. */
export function createTaskTool(options: TaskToolOptions): Tool {
  const manager = options.manager ?? new WorkerManager(options);
  return {
    name: "task",
    description:
      "Delegate a task to a named agent; only its final report returns.",
    effect: "execute",
    schema: z.object({ agent: z.string(), prompt: z.string() }),
    async run(args: { agent: string; prompt: string }, ctx) {
      try {
        const record = await manager.start(args.agent, args.prompt, ctx.signal);
        return {
          output: record.report + (record.error ? `\n${record.error}` : ""),
          ...(record.status === "failed" || record.status === "cancelled"
            ? { isError: true }
            : {}),
        };
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  };
}

/** Merge the branch of a worker that wrote something. */
export async function mergeWorker(
  cwd: string,
  branch: string,
): Promise<{ merged: boolean; message: string }> {
  return mergeWorktree(cwd, branch);
}

/** Take a worker's worktree away. */
export async function cleanWorker(
  cwd: string,
  worktree: Worktree,
): Promise<void> {
  await removeWorktree(cwd, worktree);
}
