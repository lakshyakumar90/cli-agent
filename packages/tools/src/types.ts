/**
 * The tool contract.
 *
 * A tool is something the model may call. The description and the schema are
 * what the provider advertises; `run` is the executable side, which Phase 3
 * fills in (read, write, edit, bash, grep, glob, todo).
 *
 * The schema is a zod schema. The JSON Schema the model is told is derived
 * from it, so the shape the model is shown and the shape the arguments are
 * checked against are the same thing by construction — they cannot drift
 * apart.
 */

import type { JSONSchema, ToolSpec } from "@cli-agent/ai";
import { z, type ZodType } from "zod";

/** What a tool is given when it runs. */
export interface ToolContext {
  /** Directory the agent is working in. */
  cwd: string;
  /** Cancels a long-running tool. */
  signal: AbortSignal;
  /**
   * Called with output as it arrives, for tools that produce it while they
   * run (bash). A tool still returns the whole output at the end.
   */
  onOutput?: (text: string) => void;
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
  /** The arguments, as a zod schema. */
  schema: ZodType;
  /** Runs the tool. */
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Whether the call needs the user's approval (Phase 3, permissions).
   * Absent means the tool may run without asking.
   */
  needsApproval?(args: any): boolean;
}

/**
 * Define a tool.
 *
 * The arguments are typed from the schema, so a tool author does not repeat
 * what the schema already says.
 */
export function defineTool<S extends ZodType>(definition: {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
  needsApproval?(args: z.infer<S>): boolean;
}): Tool {
  return definition;
}

/** The JSON Schema of a tool, derived once and kept. */
const jsonSchemas = new WeakMap<Tool, JSONSchema>();

/** The wire form of a tool, for the provider request. */
export function toToolSpec(tool: Tool): ToolSpec {
  let schema = jsonSchemas.get(tool);
  if (schema === undefined) {
    schema = toJsonSchema(tool.schema);
    jsonSchemas.set(tool, schema);
  }
  return {
    name: tool.name,
    description: tool.description,
    schema,
  };
}

/**
 * The JSON Schema for a zod schema.
 *
 * The input side is used: it is what the model is allowed to send. A type
 * that has no JSON Schema equivalent becomes "any" rather than an error, and
 * a schema that cannot be converted at all falls back to "anything goes".
 */
export function toJsonSchema(schema: ZodType): JSONSchema {
  try {
    const json = z.toJSONSchema(schema, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;

    // The dialect marker is noise on the wire.
    const { $schema: _dialect, ...rest } = json;
    void _dialect;
    return rest as JSONSchema;
  } catch {
    return {};
  }
}
