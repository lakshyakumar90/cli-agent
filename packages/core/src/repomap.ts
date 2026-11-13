/**
 * The repo map.
 *
 * An outline of what is in the project: the files, and the symbols in them.
 * It is injected into the prompt so the model can find the right file
 * without reading every file first — the agentic search (grep, glob, read)
 * still does the finding, but the map tells it what exists.
 *
 * The symbols are found by reading the source, not by parsing it: an export
 * or a top-level declaration is what matters here, and a tree-sitter
 * grammar would buy more than this needs.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { walkFiles } from "@cli-agent/tools";

/** One file and what is in it. */
export interface RepoMapEntry {
  /** The path, relative to the working directory. */
  path: string;
  /** The symbols it holds. */
  symbols: string[];
}

export interface RepoMapOptions {
  /** The most files in the map. */
  maxFiles?: number;
  /** The most symbols per file. */
  maxSymbols?: number;
  /** Only these extensions. */
  extensions?: string[];
}

/** The files that are worth mapping. */
export const DEFAULT_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "cs",
  "php",
  "sh",
];

/** The patterns that find a symbol. */
const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+enum\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+let\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+var\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*class\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+([A-Za-z_][\w]*)/,
  /^\s*(?:pub\s+)?(?:struct|enum|trait|fn)\s+([A-Za-z_][\w]*)/,
];

/**
 * The outline of a project.
 *
 * Only the files that hold code, and only what is in them.
 */
export async function buildRepoMap(
  cwd: string,
  options: RepoMapOptions = {},
): Promise<RepoMapEntry[]> {
  const {
    maxFiles = 300,
    maxSymbols = 12,
    extensions = DEFAULT_EXTENSIONS,
  } = options;

  const files = await walkFiles(cwd, { extensions, limit: maxFiles * 2 });
  const entries: RepoMapEntry[] = [];

  for (const file of files) {
    if (entries.length >= maxFiles) break;

    const symbols = await symbolsIn(file);
    if (symbols.length === 0) continue;

    entries.push({
      path: relative(cwd, file).split(sep).join("/"),
      symbols: symbols.slice(0, maxSymbols),
    });
  }

  return entries;
}

/** The symbols in a file. */
export async function symbolsIn(path: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const found: string[] = [];
  const seen = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (match === null) continue;

      const name = match[1];
      if (name === undefined || seen.has(name)) continue;

      seen.add(name);
      found.push(name);
      break;
    }
  }

  return found;
}

/** The map, as the model reads it. */
export function renderRepoMap(entries: RepoMapEntry[]): string {
  if (entries.length === 0) return "";

  const lines = entries.map(
    (entry) => `${entry.path}: ${entry.symbols.join(", ")}`,
  );
  return `The project (${entries.length} files):\n${lines.join("\n")}`;
}
