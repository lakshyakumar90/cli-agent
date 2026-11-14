/**
 * Isolation.
 *
 * A worker that only reads can share the workspace: it cannot change
 * anything, so there is nothing to keep apart. A worker that writes gets a
 * git worktree of its own, on a branch of its own, and the orchestrator
 * merges the branch when it is happy with it.
 *
 * When the workspace is not a repository, or git is not there, the worker
 * simply shares the workspace and says so.
 */

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A worktree a worker can work in. */
export interface Worktree {
  /** Where it is. */
  path: string;
  /** The branch it is on. */
  branch: string;
}

/** The tools that change things. */
const WRITING_TOOLS = new Set(["write", "edit", "bash", "todo"]);

/** Can this role change anything? */
export function canWrite(tools: string[] | undefined): boolean {
  if (tools === undefined) return true;
  return tools.some((tool) => WRITING_TOOLS.has(tool));
}

/** Is this a git repository? */
export async function isRepository(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * A worktree of the repository, on a branch of its own.
 *
 * Returns nothing when there is no repository or git is not there: the
 * worker shares the workspace instead.
 */
export async function createWorktree(
  cwd: string,
  name: string,
): Promise<Worktree | undefined> {
  if (!(await isRepository(cwd))) return undefined;

  const branch = `agent/${name.replace(/[^\w.-]+/g, "-")}`;
  const path = join(cwd, ".myagent", "worktrees", name.replace(/[^\w.-]+/g, "-"));

  try {
    await mkdir(join(cwd, ".myagent", "worktrees"), { recursive: true });
    await run("git", ["worktree", "add", "-b", branch, path], { cwd });
    return { path, branch };
  } catch {
    // The branch may already exist, or the repository may not allow it.
    try {
      await run("git", ["worktree", "add", path, branch], { cwd });
      return { path, branch };
    } catch {
      return undefined;
    }
  }
}

/** What happened when a branch was merged. */
export interface MergeResult {
  merged: boolean;
  message: string;
}

/**
 * Merge a worker's branch into the workspace.
 *
 * A conflict is reported, not thrown: the orchestrator decides what to do
 * with it.
 */
export async function mergeWorktree(
  cwd: string,
  branch: string,
): Promise<MergeResult> {
  try {
    const { stdout } = await run(
      "git",
      ["merge", "--no-ff", "-m", `merge ${branch}`, branch],
      { cwd },
    );
    return { merged: true, message: stdout.trim() };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    return { merged: false, message };
  }
}

/** Take a worktree away again. */
export async function removeWorktree(
  cwd: string,
  worktree: Worktree,
): Promise<void> {
  try {
    await run("git", ["worktree", "remove", "--force", worktree.path], { cwd });
  } catch {
    // It may already be gone.
  }
}
