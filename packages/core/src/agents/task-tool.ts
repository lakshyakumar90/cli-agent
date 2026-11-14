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
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { run } from "../loop.js";
import { createState, type AgentState } from "../types.js";
import { Board } from "./board.js";
import {
  canWrite,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  type Worktree,
} from "./isolation.js";
import type { AgentRole } from "./roles.js";

export interface TaskToolOptions {
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
  /** Gives a writing worker a worktree of its own. Default true. */
  isolate?: boolean;
  /** How deep the parent is. */
  depth?: number;
}

/** The tool the parent uses to delegate. */
export function createTaskTool(options: TaskToolOptions): Tool {
  const {
    roles,
    providerFor,
    defaultModel,
    tools,
    cwd,
    board,
    concurrency = 3,
    maxDepth = 1,
    timeoutMs = 10 * 60_000,
    tokenBudget,
    isolate = true,
    depth = 0,
  } = options;

  // How many workers are running at once, across the whole session.
  let running = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
  };

  const release = (): void => {
    running -= 1;
    waiting.shift()?.();
  };

  const taskTool: Tool = {
    name: "task",
    description: [
      "Hand a job to another agent and get a report back.",
      "",
      "Give the name of an agent and what it should find out or do. The agent",
      "works on its own, with its own tools and its own context: only its final",
      "report comes back, not the files it read.",
    ].join("\n"),
    effect: "execute",
    schema: z.object({
      agent: z.string().describe("The agent to hand the job to."),
      prompt: z
        .string()
        .describe("What the agent should do, in enough detail to work from."),
    }),
    async run(args: { agent: string; prompt: string }, ctx) {
      // The guard: a worker does not spawn workers.
      if (depth >= maxDepth) {
        return {
          output: `the agent "${args.agent}" cannot delegate any further`,
          isError: true,
        };
      }

      const role = roles.get(args.agent);
      if (role === undefined) {
        const known = [...roles.keys()].join(", ");
        return {
          output: `there is no agent called "${args.agent}" — known: ${known}`,
          isError: true,
        };
      }

      const taskId = `t${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 5)}`;

      board?.add({
        id: taskId,
        agent: args.agent,
        prompt: args.prompt,
        owner: args.agent,
      });
      board?.update(taskId, { status: "running" });
      await board?.save();

      await acquire();
      let worktree: Worktree | undefined;

      try {
        // A worker that writes gets a worktree of its own.
        if (isolate && canWrite(role.tools)) {
          worktree = await createWorktree(cwd, `${args.agent}-${taskId}`);
        }

        const model = role.model ?? defaultModel;
        const provider = await providerFor(model);

        // The worker gets the tools its role names — and never the task
        // tool, unless its role asks for it.
        const workerTools = tools.filter(
          (tool) =>
            role.tools === undefined ||
            (role.tools.includes(tool.name) &&
              !(tool.name === "task" && !role.tools.includes("task"))),
        );

        const child: AgentState = createState(provider, {
          model,
          tools: workerTools,
          system: role.prompt,
          cwd: worktree?.path ?? cwd,
          depth: depth + 1,
          ...(tokenBudget === undefined ? {} : { limits: { tokenBudget } }),
        });

        // The report is all that comes back.
        let report = "";
        let tokens = 0;

        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = AbortSignal.any([timeout, ctx.signal]);

        for await (const event of run(child, args.prompt, signal)) {
          if (event.t === "text") report += event.delta;
          if (event.t === "toolStart") {
            // Only the final report comes back: what the worker said before
            // it started using its tools stays in its own context.
            report = "";
          }
          if (event.t === "done") {
            tokens += event.usage.inputTokens + event.usage.outputTokens;
          }
        }

        board?.update(taskId, {
          status: "done",
          result: report,
          tokens,
          ...(worktree === undefined ? {} : { branch: worktree.branch }),
        });
        await board?.save();

        const notes: string[] = [];
        if (worktree !== undefined) {
          notes.push(`the work is on the branch ${worktree.branch}`);
        }
        if (tokens > 0) notes.push(`it used ${tokens} tokens`);

        return {
          output:
            notes.length > 0 ? `${report}\n\n(${notes.join("; ")})` : report,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        board?.update(taskId, { status: "failed", error: message });
        await board?.save();
        return {
          output: `the agent "${args.agent}" failed: ${message}`,
          isError: true,
        };
      } finally {
        release();
      }
    },
  };

  return taskTool;
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
  worktree: Worktree): Promise<void> {
  await removeWorktree(cwd, worktree);
}
