/**
 * The standard set of tools.
 */

import { createBashTool, type BashOptions } from "./bash.js";
import { createEditTool, type EditOptions } from "./edit.js";
import { createGlobTool, type GlobOptions } from "./glob.js";
import { createGrepTool, type GrepOptions } from "./grep.js";
import { createReadTool, type ReadOptions } from "./read.js";
import { createTodoTool, type Todo } from "./todo.js";
import type { Tool } from "./types.js";
import { createWriteTool } from "./write.js";

export interface ToolSetOptions {
  read?: ReadOptions;
  edit?: EditOptions;
  bash?: BashOptions;
  grep?: GrepOptions;
  glob?: GlobOptions;
  /** The checklist the session starts with. */
  todos?: Todo[];
}

/**
 * The six tools: read, write, edit, bash, grep, glob and todo.
 *
 * The permissions layer (Phase 3's other half) wraps these; what it decides
 * is which of them may run, and when.
 */
export function createTools(options: ToolSetOptions = {}): Tool[] {
  return [
    createReadTool(options.read),
    createWriteTool(),
    createEditTool(options.edit),
    createBashTool(options.bash),
    createGrepTool(options.grep),
    createGlobTool(options.glob),
    createTodoTool(options.todos),
  ];
}
