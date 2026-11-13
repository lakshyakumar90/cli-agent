import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateArgs } from "./validate.js";

const echo: Tool = {
  name: "echo",
  description: "Echoes the text back.",
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  async run() {
    return { output: "" };
  },
};

describe("validateArgs", () => {
  it("accepts arguments that match the schema", () => {
    expect(validateArgs(echo, { text: "hello" })).toEqual({ ok: true });
  });

  it("rejects a missing required property", () => {
    const result = validateArgs(echo, {});

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      'missing required property "text"',
    );
  });

  it("rejects the wrong type and says which one", () => {
    const result = validateArgs(echo, { text: 42 });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("must be string");
  });

  it("rejects an unexpected property", () => {
    const result = validateArgs(echo, { text: "hi", extra: true });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      'unexpected property "extra"',
    );
  });

  it("names the tool in the message", () => {
    const result = validateArgs(echo, {});

    expect(result.ok === false && result.message).toContain("invalid arguments for echo");
  });

  it("accepts anything for an empty schema", () => {
    const anything: Tool = {
      name: "anything",
      description: "Takes whatever.",
      schema: {},
      async run() {
        return { output: "" };
      },
    };

    expect(validateArgs(anything, { whatever: 1 })).toEqual({ ok: true });
  });

  it("lists the allowed values of an enum", () => {
    const mode: Tool = {
      name: "mode",
      description: "Picks a mode.",
      schema: {
        type: "object",
        properties: { mode: { enum: ["read", "write"] } },
        required: ["mode"],
      },
      async run() {
        return { output: "" };
      },
    };

    const result = validateArgs(mode, { mode: "delete" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain('["read","write"]');
  });

  it("refuses a tool whose schema does not compile", () => {
    const broken: Tool = {
      name: "broken",
      description: "Has a schema that is not a schema.",
      schema: { type: "not-a-type" } as never,
      async run() {
        return { output: "" };
      },
    };

    const result = validateArgs(broken, {});

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      'the tool "broken" has an invalid schema',
    );
  });

  it("compiles a schema only once", () => {
    const first = validateArgs(echo, { text: "a" });
    const second = validateArgs(echo, { text: "b" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});
