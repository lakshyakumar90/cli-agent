import { describe, expect, it } from "vitest";
import { parseRule, parseRules, matchRule, matchesPattern } from "./rules.js";
import { decidePermission } from "./decide.js";
import type { PermissionRequest } from "./types.js";

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "bash",
    effect: "execute",
    args: {},
    subject: "git status",
    reason: "bash wants to run: git status",
    ...over,
  };
}

describe("parsing rules", () => {
  it("reads a rule with a pattern", () => {
    expect(parseRule("bash(git status) allow")).toEqual({
      tool: "bash",
      pattern: "git status",
      action: "allow",
    });
  });

  it("reads a rule for every call of a tool", () => {
    expect(parseRule("read allow")).toEqual({
      tool: "read",
      action: "allow",
    });
  });

  it("reads a rule for every tool", () => {
    expect(parseRule("* ask")).toEqual({ tool: "*", action: "ask" });
  });

  it("refuses a line it cannot read", () => {
    expect(parseRule("bash(git status)")).toBeUndefined();
    expect(parseRule("nonsense")).toBeUndefined();
  });

  it("reads a list of rules", () => {
    const rules = parseRules(`
# the safe ones
bash(git status) allow
bash(rm *)   ask
write(src/**) deny
`);

    expect(rules).toEqual([
      { tool: "bash", pattern: "git status", action: "allow" },
      { tool: "bash", pattern: "rm *", action: "ask" },
      { tool: "write", pattern: "src/**", action: "deny" },
    ]);
  });
});

describe("matching rules", () => {
  it("matches a pattern without a wildcard exactly", () => {
    expect(matchesPattern("git status", "git status")).toBe(true);
    expect(matchesPattern("git status", "git status --short")).toBe(false);
  });

  it("matches a pattern with a wildcard", () => {
    expect(matchesPattern("rm *", "rm -rf build")).toBe(true);
    expect(matchesPattern("rm *", "ls -la")).toBe(false);
  });

  it("takes the first rule that matches", () => {
    const rules = parseRules("bash(rm -rf *) deny\nbash(rm *) ask");

    expect(matchRule(rules, "bash", "rm -rf build")?.action).toBe("deny");
    expect(matchRule(rules, "bash", "rm build")?.action).toBe("ask");
    expect(matchRule(rules, "bash", "ls")?.action).toBeUndefined();
    expect(matchRule(rules, "read", "a.txt")).toBeUndefined();
  });
});

describe("deciding", () => {
  it("lets the read-only tools run in plan mode", () => {
    expect(
      decidePermission(request({ tool: "read", effect: "read" }), {
        mode: "plan",
      }),
    ).toBe("allow");
  });

  it("refuses everything else in plan mode", () => {
    expect(decidePermission(request(), { mode: "plan" })).toBe("deny");
    expect(
      decidePermission(request({ tool: "edit", effect: "write" }), {
        mode: "plan",
      }),
    ).toBe("deny");
  });

  it("asks before a write in ask mode", () => {
    expect(
      decidePermission(request({ tool: "write", effect: "write" }), {
        mode: "ask",
      }),
    ).toBe("ask");
  });

  it("asks before a command in ask mode", () => {
    expect(decidePermission(request(), { mode: "ask" })).toBe("ask");
  });

  it("lets the read-only tools run in ask mode", () => {
    expect(
      decidePermission(request({ tool: "read", effect: "read" }), {
        mode: "ask",
      }),
    ).toBe("allow");
  });

  it("lets an edit through in auto-edit mode", () => {
    expect(
      decidePermission(request({ tool: "edit", effect: "write" }), {
        mode: "auto-edit",
      }),
    ).toBe("allow");
  });

  it("still asks before a command in auto-edit mode", () => {
    expect(decidePermission(request(), { mode: "auto-edit" })).toBe("ask");
  });

  it("allows everything in yolo mode", () => {
    expect(decidePermission(request(), { mode: "yolo" })).toBe("allow");
  });

  it("lets a rule decide before the mode does", () => {
    const config = {
      mode: "ask" as const,
      rules: parseRules("bash(git status) allow\nbash(rm *) deny"),
    };

    expect(decidePermission(request(), config)).toBe("allow");
    expect(
      decidePermission(request({ subject: "rm -rf build" }), config),
    ).toBe("deny");
  });

  it("asks about a path outside the workspace", () => {
    expect(
      decidePermission(
        request({ tool: "read", effect: "read", outsideWorkspace: true }),
        { mode: "ask" },
      ),
    ).toBe("ask");
  });

  it("allows a path outside the workspace in yolo mode", () => {
    expect(
      decidePermission(
        request({ tool: "read", effect: "read", outsideWorkspace: true }),
        { mode: "yolo" },
      ),
    ).toBe("allow");
  });

  it("refuses a path outside the workspace in plan mode", () => {
    expect(
      decidePermission(
        request({ tool: "read", effect: "read", outsideWorkspace: true }),
        { mode: "plan" },
      ),
    ).toBe("deny");
  });

  it("asks when the tool asks for approval itself", () => {
    expect(
      decidePermission(request({ needsApproval: true }), { mode: "yolo" }),
    ).toBe("ask");
  });

  it("lets a rule overrule a tool that wants approval", () => {
    expect(
      decidePermission(request({ needsApproval: true }), {
        mode: "ask",
        rules: parseRules("bash(git status) allow"),
      }),
    ).toBe("allow");
  });
});
