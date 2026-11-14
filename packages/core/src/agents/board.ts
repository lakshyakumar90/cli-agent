/**
 * The shared board.
 *
 * The workers of one task write to it, so the lead can see what is going on:
 * which task, who owns it, what state it is in and what it found. It is a
 * JSON file, so it survives a crash and can be read while the work is going
 * on.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** What a task is doing. */
export type TaskStatus = "pending" | "running" | "done" | "failed";

/** One task on the board. */
export interface BoardTask {
  /** Its id. */
  id: string;
  /** The role that owns it. */
  agent: string;
  /** What it was asked to do. */
  prompt: string;
  /** Where it stands. */
  status: TaskStatus;
  /** Who is working on it. */
  owner?: string;
  /** What it found. */
  result?: string;
  /** Why it failed. */
  error?: string;
  /** The tokens it used. */
  tokens?: number;
  /** The branch it worked on, when it had one. */
  branch?: string;
  /** When it was added. */
  at: string;
}

export interface BoardOptions {
  /** The file the board is written to. */
  path?: string;
}

export class Board {
  /** The file the board is written to, when it has one. */
  readonly path?: string;

  private readonly tasks = new Map<string, BoardTask>();

  constructor(options: BoardOptions = {}) {
    this.path = options.path;
  }

  /** Put a task on the board. */
  add(task: Omit<BoardTask, "status" | "at">): BoardTask {
    const entry: BoardTask = {
      ...task,
      status: "pending",
      at: new Date().toISOString(),
    };
    this.tasks.set(entry.id, entry);
    return entry;
  }

  /** Change a task. */
  update(id: string, patch: Partial<BoardTask>): BoardTask | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;

    const updated = { ...task, ...patch };
    this.tasks.set(id, updated);
    return updated;
  }

  /** One task. */
  get(id: string): BoardTask | undefined {
    return this.tasks.get(id);
  }

  /** Every task, newest first. */
  list(): BoardTask[] {
    return [...this.tasks.values()].reverse();
  }

  /** The tasks that are not finished. */
  open(): BoardTask[] {
    return this.list().filter(
      (task) => task.status === "pending" || task.status === "running",
    );
  }

  /** Write the board out. */
  async save(): Promise<void> {
    if (this.path === undefined) return;

    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(
      this.path,
      `${JSON.stringify(this.list(), null, 2)}\n`,
      "utf8",
    );
  }

  /** Read the board in. */
  async load(): Promise<void> {
    if (this.path === undefined) return;

    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) return;

      for (const entry of parsed) {
        const task = entry as BoardTask;
        if (typeof task.id === "string") this.tasks.set(task.id, task);
      }
    } catch {
      // No board yet.
    }
  }

  /** The board, as one line per task. */
  render(): string {
    return this.list()
      .map((task) => {
        const mark =
          task.status === "done"
            ? "✓"
            : task.status === "failed"
              ? "✗"
              : task.status === "running"
                ? "…"
                : "·";
        return `${mark} ${task.id} ${task.agent}: ${task.prompt.slice(0, 60)}`;
      })
      .join("\n");
  }
}

/** Where the board of a project lives. */
export function boardPath(cwd: string): string {
  return join(cwd, ".myagent", "board.json");
}
