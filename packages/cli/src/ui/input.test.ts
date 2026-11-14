import { describe, expect, it } from "vitest";
import {
  nextPermissionMode,
  parseShellEscape,
  parseSlash,
  SLASH_COMMANDS,
} from "./slash.js";
import { completionCandidates, wordAt } from "./complete.js";
describe("slash commands", () => {
  it("reads a command and its argument", () => {
    expect(parseSlash("/model openai/gpt-5.5")).toEqual({
      name: "/model",
      args: "openai/gpt-5.5",
      raw: "/model openai/gpt-5.5",
    });
  });

  it("reads a command without an argument", () => {
    expect(parseSlash("/clear")?.args).toBe("");
  });

  it("is not a command when the line does not start with a slash", () => {
    expect(parseSlash("hello")).toBeUndefined();
  });

  it("knows the commands", () => {
    expect(SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "/model",
      "/login",
      "/compact",
      "/clear",
      "/resume",
      "/agents",
      "/fork",
      "/tree",
      "/undo",
    ]);
  });

  it("cycles the permission modes", () => {
    expect(nextPermissionMode("ask")).toBe("auto-edit");
    expect(nextPermissionMode("auto-edit")).toBe("yolo");
    expect(nextPermissionMode("yolo")).toBe("plan");
    expect(nextPermissionMode("plan")).toBe("ask");
  });
});

describe("the shell escape", () => {
  it("reads a command that starts with a bang", () => {
    expect(parseShellEscape("!npm test")).toEqual({ command: "npm test" });
  });

  it("is not a command without one", () => {
    expect(parseShellEscape("npm test")).toBeUndefined();
    expect(parseShellEscape("!")).toBeUndefined();
  });
});

describe("@-completion", () => {
  it("finds the word being typed", () => {
    expect(wordAt("look at @src/in", 15)).toEqual({
      word: "@src/in",
      start: 8,
    });
  });

  it("finds no word when there is none", () => {
    expect(wordAt("look at src", 11)).toBeUndefined();
  });

  it("offers the files that match", () => {
    const candidates = completionCandidates("@src", "/work", [
      "src/index.ts",
      "src/other.ts",
      "readme.md",
    ]);

    expect(candidates).toEqual(["src/index.ts", "src/other.ts"]);
  });
});

