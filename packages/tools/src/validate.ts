/**
 * Validating a tool's arguments.
 *
 * The schema a tool declares is the schema its arguments are checked
 * against: the model is told exactly what is expected, and what it sends is
 * held to that. A tool with a broken schema is refused rather than run with
 * whatever the model happened to send.
 */

import type { z } from "zod";
import type { Tool } from "./types.js";

/** The outcome of checking a set of arguments. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Check a tool's arguments against its schema.
 *
 * The message is written for the model: it says what was wrong and where, so
 * the model can correct itself and try again.
 */
export function validateArgs(tool: Tool, args: unknown): ValidationResult {
  const result = tool.schema.safeParse(args);
  if (result.success) return { ok: true };

  return {
    ok: false,
    message: `invalid arguments for ${tool.name}: ${describe(result.error.issues)}`,
  };
}

/** The validation problems, as a list the model can read. */
function describe(issues: z.core.$ZodIssue[]): string {
  if (issues.length === 0) return "they do not match the schema";
  return issues.map(describeIssue).join("; ");
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  const message = issue.message.replace(/^Invalid input: /, "");

  // zod reports a missing key as "expected string, received undefined";
  // "missing" is what the model needs to hear.
  if (message.endsWith("received undefined")) {
    const expected = message.replace(", received undefined", "");
    return `${where}missing required value (${expected})`;
  }

  return `${where}${message}`;
}
