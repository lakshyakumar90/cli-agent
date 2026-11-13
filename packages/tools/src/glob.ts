/**
 * glob — find the files whose names match a pattern.
 *
 * ripgrep lists the files when it is installed; otherwise the same list is
 * built here, skipping what git ignores.
 */

import { relative, sep } from "node:path";
import { z } from "zod";
import { defineTool, type Tool } from "./types.js";
import { resolvePath } from "./paths.js";
import { findOnPath } from "./exec.js";
import { walkFiles } from "./walk.js";
import { runCommand } from "./run.js";
import { globToRegExp } from "./grep.js";

/** The most files one call returns. */
export const DEFAULT_MAX_FILES = 500;

export interface GlobOptions {
  /** The most files one call returns. */
  maxResults?: number;
}

export function createGlobTool(options: GlobOptions = {}): Tool {
  const { maxResults = DEFAULT_MAX_FILES } = options;

  return defineTool({
    name: "glob",
    description:
      "Find the files whose names match a pattern, e.g. '**/*.ts'. The output is one path per line, relative to the working directory.",
    schema: z.object({
      pattern: z
        .string()
        .describe("The pattern to match, e.g. '**/*.ts' or 'src/**/*.test.ts'."),
      path: z
        .string()
        .optional()
        .describe("Where to look. Defaults to the working directory."),
      max_results: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many files to return."),
    }),
    async run(args, ctx) {
      const root = resolvePath(ctx.cwd, args.path ?? ".");
      const limit = args.max_results ?? maxResults;

      const ripgrep = findOnPath("rg");
      if (ripgrep !== undefined) {
        const result = await runCommand(
          ripgrep,
          [
            "--files",
            "--color=never",
            "--glob",
            args.pattern,
            root,
          ],
          { cwd: ctx.cwd, timeoutMs: 30_000 },
        );

        if (result.code === 0 || result.code === 1) {
          const lines = result.output
            .split(/\r?\n/)
            .filter((line) => line.length > 0);

          if (lines.length === 0) {
            return { output: `no files match ${args.pattern}` };
          }

          return {
            output: `${lines.slice(0, limit).join("\n")}${
              lines.length > limit ? `\n... ${lines.length - limit} more files` : ""
            }`,
          };
        }
      }

      const files = await walkFiles(root);
      const matcher = globToRegExp(args.pattern);
      const matches = files
        .map((file) => relative(ctx.cwd, file).split(sep).join("/"))
        .filter((file) => matcher.test(file) || matcher.test(file.split("/").pop() ?? file));

      if (matches.length === 0) {
        return { output: `no files match ${args.pattern}` };
      }

      return {
        output: `${matches.slice(0, limit).join("\n")}${
          matches.length > limit ? `\n... ${matches.length - limit} more files` : ""
        }`,
      };
    },
  });
}

