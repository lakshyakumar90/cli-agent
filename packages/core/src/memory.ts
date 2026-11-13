/**
 * Project memory.
 *
 * AGENTS.md and CLAUDE.md are how a project says what it wants. The search
 * walks up from the working directory, so the memory of the directory you
 * are in and of every directory above it is read; the user's own
 * ~/.myagent/AGENTS.md is read too.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, relative, sep } from "node:path";

/** The files that hold a project's memory, in the order they are preferred. */
export const MEMORY_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** One memory file. */
export interface MemoryFile {
  /** Where it is. */
  path: string;
  /** The directory it belongs to. */
  dir: string;
  /** What is in it. */
  content: string;
}

/** The user's own memory, shared by every project. */
export function globalMemoryPath(): string {
  return join(homedir(), ".myagent", "AGENTS.md");
}

/**
 * The memory files that apply to a directory.
 *
 * The walk goes from the top down, so the broadest memory comes first and
 * the memory of the directory you are in comes last: the nearer file has
 * the final say.
 */
export async function findMemoryFiles(
  cwd: string,
  options: { global?: boolean } = {},
): Promise<MemoryFile[]> {
  const { global = true } = options;
  const found: MemoryFile[] = [];

  const directories = directoriesUp(cwd);
  for (const directory of directories) {
    for (const name of MEMORY_FILES) {
      const file = await readIfThere(join(directory, name));
      if (file !== undefined) {
        found.push({ path: file.path, dir: directory, content: file.content });
      }
    }
  }

  if (global) {
    const file = await readIfThere(globalMemoryPath());
    if (file !== undefined) {
      found.push({
        path: file.path,
        dir: dirname(file.path),
        content: file.content,
      });
    }
  }

  return found;
}

/** The directories from the root down to a directory. */
export function directoriesUp(cwd: string): string[] {
  const { root } = parse(cwd);
  const directories: string[] = [];

  let current = cwd;
  for (;;) {
    directories.unshift(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return directories;
}

/** A file, if it is there. */
async function readIfThere(
  path: string,
): Promise<{ path: string; content: string } | undefined> {
  try {
    const content = await readFile(path, "utf8");
    if (content.trim().length === 0) return undefined;
    return { path, content };
  } catch {
    return undefined;
  }
}

/** A path as the model should see it: relative to the working directory. */
export function displayMemoryPath(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return path;
  return relativePath.split(sep).join("/");
}
