import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, toJsonSchema, toToolSpec } from "./types.js";
import { validateArgs } from "./validate.js";

const echo = defineTool({
  name: "echo",
  description: "Echoes the text back.",
  schema: z.object({ text: z.string() }),
  async run(args) {
    return { output: `echo: ${args.text}` };
  },
});

describe("validateArgs", () => {
  it("accepts arguments that match the schema", () => {
    expect(validateArgs(echo, { text: "hello" })).toEqual({ ok: true });
  });

  it("rejects a missing required property", () => {
    const result = validateArgs(echo, {});

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      "missing required value",
    );
    expect(result.ok === false && result.message).toContain("text");
  });

  it("rejects the wrong type and says which one", () => {
    const result = validateArgs(echo, { text: 42 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      "text: expected string, received number",
    );
  });

  it("rejects an unexpected property of a strict object", () => {
    const strict = defineTool({
      name: "strict",
      description: "Refuses extra keys.",
      schema: z.strictObject({ text: z.string() }),
      async run() {
        return { output: "" };
      },
    });

    const result = validateArgs(strict, { text: "hi", extra: true });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("extra");
  });

  it("names the tool in the message", () => {
    const result = validateArgs(echo, {});

    expect(result.ok === false && result.message).toContain(
      "invalid arguments for echo",
    );
  });

  it("accepts anything for an empty schema", () => {
    const anything = defineTool({
      name: "anything",
      description: "Takes whatever.",
      schema: z.object({}).passthrough(),
      async run() {
        return { output: "" };
      },
    });

    expect(validateArgs(anything, { whatever: 1 })).toEqual({ ok: true });
  });

  it("lists the allowed values of an enum", () => {
    const mode = defineTool({
      name: "mode",
      description: "Picks a mode.",
      schema: z.object({ mode: z.enum(["read", "write"]) }),
      async run() {
        return { output: "" };
      },
    });

    const result = validateArgs(mode, { mode: "delete" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("read");
    expect(result.ok === false && result.message).toContain("write");
  });

  it("checks the input side of the schema", () => {
    // A default means the model may leave the field out.
    const withDefault = defineTool({
      name: "withDefault",
      description: "Has a default.",
      schema: z.object({ count: z.number().default(1) }),
      async run() {
        return { output: "" };
      },
    });

    expect(validateArgs(withDefault, {})).toEqual({ ok: true });
    expect(validateArgs(withDefault, { count: "two" }).ok).toBe(false);
  });
});

describe("toToolSpec", () => {
  it("derives the JSON Schema the model is told", () => {
    const spec = toToolSpec(echo);

    expect(spec.name).toBe("echo");
    expect(spec.description).toBe("Echoes the text back.");
    expect(spec.schema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("leaves the dialect marker off the wire", () => {
    expect(toToolSpec(echo).schema).not.toHaveProperty("$schema");
  });

  it("derives it once per tool", () => {
    expect(toToolSpec(echo).schema).toBe(toToolSpec(echo).schema);
  });

  it("degrades an exotic type to anything-goes", () => {
    const exotic = z.object({ when: z.date() });

    expect(toJsonSchema(exotic)).toMatchObject({
      type: "object",
      properties: { when: {} },
    });
  });

  it("keeps a recursive schema as a reference", () => {
    const recursive: z.ZodType = z.lazy(() => recursive);
    expect(toJsonSchema(recursive)).toEqual({ $ref: "#" });
  });
});
