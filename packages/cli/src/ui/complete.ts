/**
 * @-completion.
 *
 * Typing "@src/li" offers the files that start with it, so a file can be
 * named without typing the whole path.
 */

import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { walkFiles } from "@cli-agent/tools";

/** How many candidates to offer at once. */
export const MAX_COMPLETIONS = 20;

/**
 * The files that could complete a word.
 *
 * The word starts at an "@", and may be a path.
 */
export function completionCandidates(
  word: string,
  cwd: string,
  files: string[] = [],
): string[] {
  if (!word.startsWith("@")) return [];

  const typed = word.slice(1);
  const candidates = files.length > 0 ? files : [];

  return candidates
    .filter((file) => file.startsWith(typed) || typed.length === 0)
    .slice(0, MAX_COMPLETIONS);
}

/** The word being typed, and where it starts in the line. */
export function wordAt(
  line: string,
  cursor: number,
): { word: string; start: number } | undefined {
  const before = line.slice(0, cursor);
  const match = /@\S*$/.exec(before);
  if (match === null) return undefined;
  return {
    word: match[0],
    start: cursor - match[0].length,
  };
}

/** The files under a directory, as paths the user can type. */
export async function listFiles(
  cwd: string,
  limit = 2_000,
): Promise<string[]> {
  const files = await walkFiles(cwd, { limit });
  return files
    .map((file) => relative(cwd, file).split(sep).join("/"))
    .sort();
}

/** The directories under a directory, for completing a path. */
export async function listDirectories(cwd: string): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

/** The completion for a path that is being typed. */
export async function completePath(
  typed: string,
  cwd: string,
): Promise<string[]> {
  const slash = typed.lastIndexOf("/");
  const directory = slash === -1 ? cwd : join(cwd, typed.slice(0, slash));
  const prefix = slash === -1 ? typed : typed.slice(slash + 1);

  let entries: string[];
  try {
    entries = await listDirectories(directory);
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => (slash === -1 ? entry : `${typed.slice(0, slash + 1)}${entry}/`));
}
