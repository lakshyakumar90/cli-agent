import { describe, expect, it } from "vitest";
import { parseArgs, parseRuleArgument, isPermissionMode } from "./args.js";

describe("parseArgs", () => {
  it("is interactive without a prompt", () => {
    const result = parseArgs([]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.mode).toBe("interactive");
      expect(result.options.prompt).toBeUndefined();
    }
  });

  it("takes a prompt with -p", () => {
    const result = parseArgs(["-p", "do the thing"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.mode).toBe("print");
      expect(result.options.prompt).toBe("do the thing");
    }
  });

  it("takes a prompt with --print", () => {
    const result = parseArgs(["--print", "do the thing"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.prompt).toBe("do the thing");
  });

  it("takes a prompt as the last argument", () => {
    const result = parseArgs(["do the thing"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.mode).toBe("print");
      expect(result.options.prompt).toBe("do the thing");
    }
  });

  it("joins the words of a prompt", () => {
    const result = parseArgs(["do", "the", "thing"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.prompt).toBe("do the thing");
  });

  it("is json with --json", () => {
    const result = parseArgs(["--json", "-p", "hi"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.mode).toBe("json");
  });

  it("is rpc with --rpc", () => {
    const result = parseArgs(["--rpc"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.mode).toBe("rpc");
  });

  it("refuses --json and --rpc together", () => {
    const result = parseArgs(["--json", "--rpc"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("cannot be used together");
  });

  it("takes the model", () => {
    const result = parseArgs(["--model", "openai/gpt-5.5", "-p", "hi"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.model).toBe("openai/gpt-5.5");
  });

  it("takes the permission mode", () => {
    const result = parseArgs(["--mode", "plan", "-p", "hi"]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.options.permissionMode).toBe("plan");
  });

  it("refuses a permission mode it does not know", () => {
    const result = parseArgs(["--mode", "whatever"]);

    expect(result.ok).toBe(false);
  });

  it("takes the rules", () => {
    const result = parseArgs([
      "--allow",
      "bash(git status) allow",
      "--deny",
      "write(src/**) deny",
      "--ask",
      "bash(rm *) ask",
      "-p",
      "hi",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.options.rules).toEqual([
        { tool: "bash", pattern: "git status", action: "allow" },
        { tool: "write", pattern: "src/**", action: "deny" },
        { tool: "bash", pattern: "rm *", action: "ask" },
      ]);
    }
  });

  it("refuses a rule it cannot read", () => {
    const result = parseArgs(["--allow", "nonsense"]);

    expect(result.ok).toBe(false);
  });

  it("refuses an option it does not know", () => {
    const result = parseArgs(["--nope"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown option");
  });

  it("refuses an option that needs a value", () => {
    expect(parseArgs(["-p"]).ok).toBe(false);
    expect(parseArgs(["--model"]).ok).toBe(false);
    expect(parseArgs(["--cwd"]).ok).toBe(false);
  });

  it("asks for help", () => {
    const result = parseArgs(["--help"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.help).toBe(true);
  });
});

describe("parseRuleArgument", () => {
  it("reads a rule with a pattern", () => {
    expect(parseRuleArgument("bash(git status) allow")).toEqual({
      tool: "bash",
      pattern: "git status",
      action: "allow",
    });
  });

  it("reads a rule for every call of a tool", () => {
    expect(parseRuleArgument("read allow")).toEqual({
      tool: "read",
      action: "allow",
    });
  });

  it("refuses a rule without an action", () => {
    expect(parseRuleArgument("bash(git status)")).toBeUndefined();
  });
});

describe("isPermissionMode", () => {
  it("knows the four modes", () => {
    expect(isPermissionMode("ask")).toBe(true);
    expect(isPermissionMode("auto-edit")).toBe(true);
    expect(isPermissionMode("yolo")).toBe(true);
    expect(isPermissionMode("plan")).toBe(true);
    expect(isPermissionMode("nope")).toBe(false);
  });
});
