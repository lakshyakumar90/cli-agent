/**
 * write — create a file, or replace what is in it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { defineTool, type Tool } from "./types.js";
import { displayPath, resolvePath } from "./paths.js";

export function createWriteTool(): Tool {
  return defineTool({
    name: "write",
    effect: "write",
    description:
      "Write a file, creating it if it is missing and replacing it if it is not. Missing directories are created.",
    schema: z.object({
      path: z.string().describe("The file to write."),
      content: z.string().describe("The whole content of the file."),
    }),
    async run(args, ctx) {
      const file = resolvePath(ctx.cwd, args.path);

      try {
        await mkdir(dirname(file), { recursive: true });
      } catch (error) {
        return {
          output: `cannot write ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      try {
        await writeFile(file, args.content, "utf8");
      } catch (error) {
        return {
          output: `cannot write ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }

      const lines = args.content.length === 0 ? 0 : args.content.split("\n").length;
      return {
        output: `wrote ${args.content.length} bytes (${lines} line${lines === 1 ? "" : "s"}) to ${displayPath(ctx.cwd, file)}`,
      };
    },
  });
}

