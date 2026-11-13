/**
 * Validating a tool's arguments.
 *
 * The schema a tool advertises is the schema its arguments are checked
 * against: the model is told exactly what is expected, and what it sends is
 * held to that. A tool with a broken schema is refused rather than run with
 * whatever the model happened to send.
 */

// ajv is CommonJS: the named export is the class, the default import is the
// module namespace, so the named one is the one that works in ESM.
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import type { JSONSchema } from "@cli-agent/ai";
import type { Tool } from "./types.js";

/** The outcome of checking a set of arguments. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

/** One ajv instance, shared: compiling a schema is the expensive part. */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Compiled validators, one per tool. */
const compiled = new WeakMap<Tool, ValidateFunction | Error>();

/**
 * The validator for a tool's schema, compiled once.
 *
 * A schema that does not compile is remembered as an error, so a broken tool
 * is reported the same way every time instead of throwing on every call.
 */
export function validatorFor(tool: Tool): ValidateFunction | Error {
  const cached = compiled.get(tool);
  if (cached !== undefined) return cached;

  let result: ValidateFunction | Error;
  try {
    result = ajv.compile(tool.schema);
  } catch (error) {
    result = error instanceof Error ? error : new Error(String(error));
  }

  compiled.set(tool, result);
  return result;
}

/**
 * Check a tool's arguments against its schema.
 *
 * The message is written for the model: it says what was wrong and where, so
 * the model can correct itself and try again.
 */
export function validateArgs(tool: Tool, args: unknown): ValidationResult {
  const validator = validatorFor(tool);

  if (validator instanceof Error) {
    return {
      ok: false,
      message: `the tool "${tool.name}" has an invalid schema: ${validator.message}`,
    };
  }

  if (validator(args)) return { ok: true };

  return {
    ok: false,
    message: `invalid arguments for ${tool.name}: ${describe(validator.errors)}`,
  };
}

/** The validation problems, as a list the model can read. */
function describe(errors: ErrorObject[] | null | undefined): string {
  if (errors === undefined || errors === null || errors.length === 0) {
    return "they do not match the schema";
  }
  return errors.map(describeError).join("; ");
}

function describeError(error: ErrorObject): string {
  const where = error.instancePath === "" ? "" : `${error.instancePath} `;

  switch (error.keyword) {
    case "required": {
      const missing = (error.params as { missingProperty?: string })
        .missingProperty;
      return `missing required property "${missing}"`;
    }
    case "additionalProperties": {
      const extra = (error.params as { additionalProperty?: string })
        .additionalProperty;
      return `unexpected property "${extra}"`;
    }
    case "enum": {
      const allowed = (error.params as { allowedValues?: unknown[] })
        .allowedValues;
      return `${where}must be one of ${JSON.stringify(allowed)}`;
    }
    default:
      return `${where}${error.message ?? "is invalid"}`;
  }
}

/** The schema of a tool, as the provider sees it. */
export function schemaOf(tool: Tool): JSONSchema {
  return tool.schema;
}
