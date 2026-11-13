/**
 * Where the agent is.
 *
 * The working directory, the branch it is on, the operating system and the
 * date. It changes while the session runs, so it sits below the parts that
 * do not: everything above it can be cached by the provider.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Environment {
  /** The directory the agent works in. */
  cwd: string;
  /** The branch, when the directory is in a repository. */
  branch?: string;
  /** The operating system. */
  os: string;
  /** The date, in UTC. */
  date: string;
}

/** Read the environment of a directory. */
export async function readEnvironment(cwd: string): Promise<Environment> {
  const branch = await readBranch(cwd);
  const now = new Date();

  return {
    cwd,
    ...(branch === undefined ? {} : { branch }),
    os: `${process.platform} ${process.arch}`,
    date: now.toISOString().slice(0, 10),
  };
}

/**
 * The branch the directory is on.
 *
 * It is read from .git/HEAD rather than by running git: the loop must not
 * wait for a process to answer.
 */
export async function readBranch(cwd: string): Promise<string | undefined> {
  const gitDir = await findGitDir(cwd);
  if (gitDir === undefined) return undefined;

  try {
    const head = await readFile(join(gitDir, "HEAD"), "utf8");
    const trimmed = head.trim();

    const reference = /^ref:\s*(.+)$/.exec(trimmed);
    if (reference !== null) {
      const ref = (reference[1] as string).trim();
      return ref.replace(/^refs\/heads\//, "");
    }

    // A detached HEAD: the commit itself.
    return trimmed.slice(0, 7);
  } catch {
    return undefined;
  }
}

/** The .git directory above a directory, if there is one. */
export async function findGitDir(cwd: string): Promise<string | undefined> {
  let current = cwd;

  for (;;) {
    try {
      const head = await readFile(join(current, ".git", "HEAD"), "utf8");
      if (head.length > 0) return join(current, ".git");
    } catch {
      // Not here; go up.
    }

    const parent = current.replace(/[\\/][^\\/]+$/, "");
    if (parent === current || parent.length === 0) return undefined;
    current = parent;
  }
}

/** The environment block, as the model reads it. */
export function renderEnvironment(environment: Environment): string {
  const lines = [
    `Working directory: ${environment.cwd}`,
    `Operating system: ${environment.os}`,
    `Date: ${environment.date}`,
  ];

  if (environment.branch !== undefined) {
    lines.splice(1, 0, `Git branch: ${environment.branch}`);
  }

  return lines.join("\n");
}
