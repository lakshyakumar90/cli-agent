/**
 * edit — replace an exact string in a file.
 *
 * The most reliable edit format there is: the model says what is in the
 * file and what should be there instead. The edit only goes through when
 * what it says is actually there, and only once — a match that is missing or
 * that appears more than once is an error, not a guess.
 */

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, type Tool } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";

export interface EditOptions {
  /** Write the file even when nothing matched? Never. */
  dryRun?: boolean;
}

export function createEditTool(options: EditOptions = {}): Tool {
  const { dryRun = false } = options;

  return defineTool({
    name: "edit",
    description:
      "Replace an exact string in a file. The old string must be in the file, and it must appear exactly once unless replace_all is set.",
    schema: z.object({
      path: z.string().describe("The file to edit."),
      old_string: z
        .string()
        .describe("The text to replace, exactly as it is in the file."),
      new_string: z.string().describe("The text to put in its place."),
      replace_all: z
        .boolean()
        .optional()
        .describe("Replace every occurrence instead of requiring a unique one."),
    }),
    async run(args, ctx) {
      const file = resolvePath(ctx.cwd, args.path);
      const shown = displayPath(ctx.cwd, file);

      if (args.old_string === args.new_string) {
        return {
          output: `cannot edit ${shown}: the old string and the new string are the same`,
          isError: true,
        };
      }

      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        return {
          output: `cannot edit ${shown}: no such file`,
          isError: true,
        };
      }

      const occurrences = countOccurrences(content, args.old_string);

      if (occurrences === 0) {
        return {
          output: `cannot edit ${shown}: the old string is not in the file`,
          isError: true,
        };
      }

      if (occurrences > 1 && args.replace_all !== true) {
        return {
          output: `cannot edit ${shown}: the old string appears ${occurrences} times, so it is not unique — add more context, or set replace_all`,
          isError: true,
        };
      }

      const updated =
        args.replace_all === true
          ? content.split(args.old_string).join(args.new_string)
          : content.replace(args.old_string, args.new_string);

      if (dryRun) {
        return {
          output: `would replace ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${shown}`,
        };
      }

      try {
        await writeFile(file, updated, "utf8");
      } catch (error) {
        return {
          output: `cannot edit ${shown}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      const replaced = args.replace_all === true ? occurrences : 1;
      return {
        output: `replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${shown}`,
      };
    },
  });
}

/** How many times a string appears in the text, without overlapping. */
export function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;

  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}
