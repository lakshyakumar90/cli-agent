/**
 * The tool contract.
 *
 * A tool is something the model may call. The description and the JSON
 * Schema are what the provider advertises; `run` is the executable side,
 * which Phase 3 fills in (read, write, edit, bash, grep, glob, todo).
 */

import type { JSONSchema, ToolSpec } from "@cli-agent/ai";

/** What a tool is given when it runs. */
export interface ToolContext {
  /** Directory the agent is working in. */
  cwd: string;
  /** Cancels a long-running tool. */
  signal: AbortSignal;
}

/** What a tool gives back. */
export interface ToolResult {
  /** The text the model sees as the result. */
  output: string;
  /** The call failed. The model is told, and the loop carries on. */
  isError?: boolean;
}

export interface Tool {
  /** Name the model calls it by. */
  name: string;
  /** What it does, in the words the model reads. */
  description: string;
  /** The arguments, as JSON Schema. */
  schema: JSONSchema;
  /** Runs the tool. */
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Whether the call needs the user's approval (Phase 3, permissions).
   * Absent means the tool may run without asking.
   */
  needsApproval?(args: any): boolean;
}

/** The wire form of a tool, for the provider request. */
export function toToolSpec(tool: Tool): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
  };
}
