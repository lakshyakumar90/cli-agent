/**
 * read — a file, with line numbers.
 *
 * The output looks like `cat -n`: every line is prefixed with its number, so
 * the model can say "line 42" and mean it.
 */

import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineTool, type Tool } from "./types.js";
import { displayPath, looksBinary, resolvePath, splitLines } from "./paths.js";

/** The most the tool will read from one file. */
export const DEFAULT_MAX_BYTES = 256 * 1024;
/** The most lines the tool will show in one call. */
export const DEFAULT_MAX_LINES = 2_000;

export interface ReadOptions {
  /** The most bytes read from one file. */
  maxBytes?: number;
  /** The most lines shown in one call. */
  maxLines?: number;
}

export function createReadTool(options: ReadOptions = {}): Tool {
  const { maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES } = options;

  return defineTool({
    name: "read",
    description:
      "Read a file. Shows every line with its number. Use offset and limit to read part of a big file.",
    schema: z.object({
      path: z.string().describe("The file to read."),
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("The first line to read (1 is the first line)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many lines to read."),
    }),
    async run(args, ctx) {
      const file = resolvePath(ctx.cwd, args.path);

      let info;
      try {
        info = await stat(file);
      } catch {
        return { output: `cannot read ${args.path}: no such file`, isError: true };
      }

      if (info.isDirectory()) {
        return {
          output: `cannot read ${args.path}: it is a directory`,
          isError: true,
        };
      }

      // Read a bounded slice: a huge file must not fill the model's context.
      const handle = await readFile(file);
      const truncated = handle.length > maxBytes;
      const buffer = truncated ? handle.subarray(0, maxBytes) : handle;

      if (looksBinary(buffer)) {
        return {
          output: `cannot read ${args.path}: it looks like a binary file`,
          isError: true,
        };
      }

      const lines = splitLines(buffer.toString("utf8"));
      const offset = args.offset ?? 1;
      const limit = args.limit ?? maxLines;

      const selected = lines.slice(offset - 1, offset - 1 + limit);
      if (selected.length === 0) {
        return {
          output: `cannot read ${args.path}: it has ${lines.length} line(s), so offset ${offset} is past the end`,
          isError: true,
        };
      }

      // The width of the numbers is the width of the last one, so the text
      // lines up.
      const width = String(offset + selected.length - 1).length;
      const body = selected
        .map((line, index) => `${String(offset + index).padStart(width)}\t${line}`)
        .join("\n");

      const notes: string[] = [];
      if (truncated) {
        notes.push(
          `the file is larger than ${maxBytes} bytes; only the beginning was read`,
        );
      }
      if (offset + selected.length - 1 < lines.length) {
        notes.push(
          `showing lines ${offset}-${offset + selected.length - 1} of ${lines.length}`,
        );
      }

      const output =
        notes.length > 0 ? `${body}\n\n(${notes.join("; ")})` : body;

      return {
        output: `${displayPath(ctx.cwd, file)}\n${output}`,
      };
    },
  });
}
