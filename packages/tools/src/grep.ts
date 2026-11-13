/**
 * grep — search the files for a pattern.
 *
 * ripgrep does the work when it is installed: it is fast, it skips what git
 * ignores, and its output is exactly the shape we want. When it is not
 * installed, the same search runs here instead, with the same rules about
 * ignored files.
 */

import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { z } from "zod";
import { defineTool, type Tool } from "./types.js";
import { resolvePath } from "./paths.js";
import { findOnPath } from "./exec.js";
import { walkFiles } from "./walk.js";
import { runCommand } from "./run.js";

/** The most matches one call returns. */
export const DEFAULT_MAX_RESULTS = 200;

export interface GrepOptions {
  /** The most matches one call returns. */
  maxResults?: number;
}

export function createGrepTool(options: GrepOptions = {}): Tool {
  const { maxResults = DEFAULT_MAX_RESULTS } = options;

  return defineTool({
    name: "grep",
    description:
      "Search the files for a pattern. The output is file:line:text for every match. Files git ignores are skipped.",
    schema: z.object({
      pattern: z.string().describe("The regular expression to look for."),
      path: z
        .string()
        .optional()
        .describe("Where to search. Defaults to the working directory."),
      glob: z
        .string()
        .optional()
        .describe("Only search files matching this pattern, e.g. '*.ts'."),
      ignore_case: z
        .boolean()
        .optional()
        .describe("Ignore the case of the pattern."),
      max_results: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many matches to return."),
    }),
    async run(args, ctx) {
      const root = resolvePath(ctx.cwd, args.path ?? ".");
      const limit = args.max_results ?? maxResults;

      const ripgrep = findOnPath("rg");
      if (ripgrep !== undefined) {
        const result = await runCommand(
          ripgrep,
          [
            "--line-number",
            "--with-filename",
            "--no-heading",
            "--color=never",
            ...(args.ignore_case === true ? ["--ignore-case"] : []),
            ...(args.glob === undefined ? [] : ["--glob", args.glob]),
            "--max-count",
            String(limit),
            "--",
            args.pattern,
            root,
          ],
          { cwd: ctx.cwd, timeoutMs: 30_000 },
        );

        // 0 means "found something", 1 means "found nothing", 2 means "broken".
        if (result.code === 0 || result.code === 1) {
          const lines = result.output
            .split(/\r?\n/)
            .filter((line) => line.length > 0);

          if (lines.length === 0) {
            return { output: `no matches for ${args.pattern}` };
          }

          return {
            output: `${lines.slice(0, limit).join("\n")}${
              lines.length > limit
                ? `\n... ${lines.length - limit} more matches`
                : ""
            }`,
          };
        }
        // ripgrep could not run the search; fall through to the fallback.
      }

      return grepFallback(args, ctx, root, limit);
    },
  });
}

/** The search, without ripgrep. */
async function grepFallback(
  args: {
    pattern: string;
    glob?: string;
    ignore_case?: boolean;
  },
  ctx: { cwd: string },
  root: string,
  limit: number,
): Promise<{ output: string; isError?: boolean }> {
  let pattern: RegExp;
  try {
    pattern = new RegExp(args.pattern, args.ignore_case === true ? "i" : "");
  } catch (error) {
    return {
      output: `cannot search for ${args.pattern}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      isError: true,
    };
  }

  const files = await walkFiles(root, {
    ...(extensionFilter(args.glob) === undefined
      ? {}
      : { extensions: extensionFilter(args.glob) }),
  });

  const matches: string[] = [];

  for (const file of files) {
    if (matches.length >= limit) break;
    if (args.glob !== undefined && !matchesGlob(file, args.glob)) continue;

    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (matches.length >= limit) break;
      if (!pattern.test(line)) continue;
      const shown = relative(ctx.cwd, file).split(sep).join("/");
      matches.push(`${shown}:${index + 1}:${line}`);
    }
  }

  if (matches.length === 0) return { output: `no matches for ${args.pattern}` };

  return {
    output: `${matches.join("\n")}${
      matches.length >= limit ? `\n... stopped at ${limit} matches` : ""
    }`,
  };
}

/** Does a path match a glob pattern, the way a shell glob does? */
export function matchesGlob(path: string, pattern: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path;
  const regex = globToRegExp(pattern);
  return regex.test(name) || regex.test(path);
}

/** A glob pattern as a regular expression. */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*")
    .replace(/\{([^}]*)\}/g, (_, group: string) =>
      `(${group.split(",").map((part) => part.trim()).join("|")})`,
    );

  return new RegExp(`^${body}$`);
}

/** The extension a glob names, when it names one. */
export function extensionFilter(glob: string | undefined): string[] | undefined {
  if (glob === undefined) return undefined;
  const match = /\*\.([A-Za-z0-9]+)$/.exec(glob);
  return match === null ? undefined : [match[1]!.toLowerCase()];
}

