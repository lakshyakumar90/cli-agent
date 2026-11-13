/**
 * todo — the checklist the model keeps.
 *
 * The model rewrites the list when its plan changes, and reads it back when
 * it needs to remember what is left. The list lives with the tool, so it
 * lasts for the session.
 */

import { z } from "zod";
import { defineTool, type Tool } from "./types.js";

/** One item on the list. */
export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export function createTodoTool(initial: Todo[] = []): Tool {
  let todos: Todo[] = [...initial];

  return defineTool({
    name: "todo",
    description:
      "Keep a checklist of what is left to do. Send the whole list every time, with the items that are done marked as completed.",
    schema: z.object({
      todos: z
        .array(
          z.object({
            content: z.string().describe("What has to be done."),
            status: z
              .enum(["pending", "in_progress", "completed"])
              .describe("Where the item stands."),
          }),
        )
        .optional()
        .describe("The whole list. Leave it out to see the current one."),
    }),
    async run(args) {
      if (args.todos !== undefined) {
        todos = args.todos.map((todo) => ({
          content: todo.content,
          status: todo.status,
        }));
      }

      if (todos.length === 0) {
        return { output: "the list is empty" };
      }

      const done = todos.filter((todo) => todo.status === "completed").length;
      const lines = todos.map((todo, index) => {
        const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? ">" : " ";
        return `${index + 1}. [${mark}] ${todo.content}${
          todo.status === "in_progress" ? " (in progress)" : ""
        }`;
      });

      return {
        output: `${lines.join("\n")}\n\n${done} of ${todos.length} done`,
      };
    },
  });
}
