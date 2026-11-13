/**
 * Paths, as the tools see them.
 *
 * Every tool takes a path the way a person would write it: relative to the
 * working directory, or absolute. The resolved path is what the tool
 * touches, and it is what the error messages name.
 */

import { resolve, isAbsolute } from "node:path";

/** Resolve a path against the working directory. */
export function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** A path as it is shown to the model: relative to the working directory. */
export function displayPath(cwd: string, path: string): string {
  const resolved = resolvePath(cwd, path);
  const relative = resolved.startsWith(cwd) ? resolved.slice(cwd.length) : resolved;
  return relative.replace(/^[\\/]/, "") || resolved;
}

/**
 * Split text into lines, without the line endings.
 *
 * A trailing newline ends the last line; it does not start another one, so
 * "one\ntwo\n" is two lines and not three.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Whether a buffer looks like binary.
 *
 * A tool that prints binary is unreadable and can fill the context, so the
 * file tools refuse it.
 */
export function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_192);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}
