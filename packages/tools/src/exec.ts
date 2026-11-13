/**
 * Finding programs on PATH.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** The full path of an executable on PATH, if it is there. */
export function findOnPath(name: string): string | undefined {
  const path = process.env.PATH ?? "";
  const entries = path.split(delimiter).filter((entry) => entry.length > 0);

  for (const entry of entries) {
    const candidate = join(entry, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Is a program installed? */
export function hasProgram(name: string): boolean {
  return findOnPath(name) !== undefined;
}
