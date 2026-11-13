/**
 * Walking a directory, the way a search should.
 *
 * Git's ignored files are skipped, and so are the directories that are never
 * worth searching: .git, node_modules and the usual build output.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { IgnoreRules } from "./ignore.js";

/** Directories that are skipped wherever they are. */
export const ALWAYS_SKIPPED = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "__pycache__",
]);

export interface WalkOptions {
  /** How deep to go. Default 12. */
  maxDepth?: number;
  /** How many files to collect at most. Default 20 000. */
  limit?: number;
  /** Only files with these extensions. */
  extensions?: string[];
}

/**
 * Every file under a directory that is not ignored.
 *
 * The .gitignore of the root and of any directory along the way applies.
 */
export async function walkFiles(
  root: string,
  options: WalkOptions = {},
): Promise<string[]> {
  const { maxDepth = 12, limit = 20_000 } = options;
  const files: string[] = [];

  const rootRules = await readIgnoreFile(root);
  await walk(root, root, rootRules, 0, files, options, limit);

  return files;
}

async function walk(
  root: string,
  directory: string,
  rootRules: IgnoreRules,
  depth: number,
  files: string[],
  options: WalkOptions,
  limit: number,
): Promise<void> {
  if (depth > (options.maxDepth ?? 12) || files.length >= limit) return;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  // A .gitignore in this directory applies to what is below it.
  const localRules = await readIgnoreFile(directory);
  const rules = localRules.isEmpty ? rootRules : localRules;

  for (const entry of entries) {
    if (files.length >= limit) return;
    if (ALWAYS_SKIPPED.has(entry.name)) continue;

    const full = join(directory, entry.name);
    const relativePath = relative(root, full).split(sep).join("/");

    if (entry.isDirectory()) {
      if (rules.ignores(relativePath, true)) continue;
      await walk(root, full, rootRules, depth + 1, files, options, limit);
      continue;
    }

    if (!entry.isFile()) continue;
    if (rules.ignores(relativePath, false)) continue;
    if (
      options.extensions !== undefined &&
      !options.extensions.includes(extensionOf(entry.name))
    ) {
      continue;
    }

    files.push(full);
  }
}

async function readIgnoreFile(directory: string): Promise<IgnoreRules> {
  try {
    const content = await readFile(join(directory, ".gitignore"), "utf8");
    return IgnoreRules.fromFile(content);
  } catch {
    return IgnoreRules.none();
  }
}

/** The lower-case extension of a file name, without the dot. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Is a path a directory? */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
