import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRules } from "./rules.js";
import { withPermissions } from "./wrap.js";
import { createBashTool } from "../bash.js";
import { createEditTool } from "../edit.js";
import { createReadTool } from "../read.js";
import { createWriteTool } from "../write.js";
import type { PermissionDecision, PermissionRequest } from "./types.js";
import type { ToolContext } from "../types.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-perm-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: directory,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("the permission wrapper", () => {
  it("runs a read without asking", async () => {
    await writeFile(join(directory, "a.txt"), "hello");

    const [read] = withPermissions([createReadTool()], { mode: "ask" });
    const result = await read!.run({ path: "a.txt" }, context());

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("hello");
  });

  it("refuses a write in plan mode", async () => {
    const [write] = withPermissions([createWriteTool()], { mode: "plan" });
    const result = await write!.run(
      { path: "a.txt", content: "x" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("permission denied");
    expect(result.output).toContain("plan mode");
  });

  it("asks before a write in ask mode, and runs it when allowed", async () => {
    const asked: PermissionRequest[] = [];
    const [write] = withPermissions([createWriteTool()], {
      mode: "ask",
      ask: async (request) => {
        asked.push(request);
        return "allow";
      },
    });

    const result = await write!.run(
      { path: "a.txt", content: "x" },
      context(),
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]?.tool).toBe("write");
    expect(asked[0]?.effect).toBe("write");
    expect(result.isError).toBeUndefined();
  });

  it("refuses a write the user does not allow", async () => {
    const [write] = withPermissions([createWriteTool()], {
      mode: "ask",
      ask: async () => "deny",
    });

    const result = await write!.run(
      { path: "a.txt", content: "x" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("permission denied");
  });

  it("refuses everything when there is nobody to ask", async () => {
    const [write] = withPermissions([createWriteTool()], { mode: "ask" });
    const result = await write!.run(
      { path: "a.txt", content: "x" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("nobody to ask");
  });

  it("remembers an allow-always for the session", async () => {
    const asked: PermissionRequest[] = [];
    const [bash] = withPermissions([createBashTool()], {
      mode: "ask",
      ask: async (request) => {
        asked.push(request);
        return "allow-always";
      },
    });

    await bash!.run({ command: "echo one" }, context());
    await bash!.run({ command: "echo one" }, context());

    // The second call was not asked about: the rule remembers it.
    expect(asked).toHaveLength(1);
  });

  it("refuses a path outside the workspace unless it is allowed", async () => {
    await writeFile(join(directory, "..", "outside.txt"), "outside");

    const asked: PermissionRequest[] = [];
    const [read] = withPermissions([createReadTool()], {
      mode: "ask",
      ask: async (request) => {
        asked.push(request);
        return "allow";
      },
    });

    const result = await read!.run(
      { path: "../outside.txt" },
      context(),
    );

    expect(asked).toHaveLength(1);
    expect(asked[0]?.outsideWorkspace).toBe(true);
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("outside");
  });

  it("refuses a path outside the workspace when the user says no", async () => {
    const [read] = withPermissions([createReadTool()], {
      mode: "ask",
      ask: async () => "deny",
    });

    const result = await read!.run({ path: "../outside.txt" }, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("permission denied");
  });

  it("refuses an absolute path outside the workspace", async () => {
    const [read] = withPermissions([createReadTool()], {
      mode: "ask",
      ask: async () => "deny",
    });

    const result = await read!.run(
      { path: join(directory, "..", "outside.txt") },
      context(),
    );

    expect(result.isError).toBe(true);
  });

  it("follows a rule that allows one command", async () => {
    // No asker: only the rule lets this through.
    const [bash] = withPermissions([createBashTool()], {
      mode: "ask",
      rules: parseRules("bash(echo *) allow"),
    });

    const result = await bash!.run({ command: "echo allowed" }, context());

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("allowed");
  });

  it("follows a rule that refuses one command", async () => {
    const [bash] = withPermissions([createBashTool()], {
      mode: "yolo",
      rules: parseRules("bash(rm *) deny"),
    });

    const result = await bash!.run({ command: "rm -rf build" }, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("permission denied");
  });

  it("asks for a command a rule marks as always worth a question", async () => {
    const asked: PermissionRequest[] = [];
    const [bash] = withPermissions([createBashTool()], {
      mode: "yolo",
      rules: parseRules("bash(rm *) ask"),
      ask: async (request) => {
        asked.push(request);
        return "deny";
      },
    });

    const result = await bash!.run({ command: "rm -rf build" }, context());

    expect(asked).toHaveLength(1);
    expect(result.isError).toBe(true);
  });

  it("refuses a file a rule protects", async () => {
    await writeFile(join(directory, "secret.key"), "s3cret");

    const [read] = withPermissions([createReadTool()], {
      mode: "yolo",
      rules: parseRules("read(*.key) deny"),
    });

    const result = await read!.run({ path: "secret.key" }, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("permission denied");
  });

  it("lets an edit through in auto-edit mode", async () => {
    await writeFile(join(directory, "a.txt"), "old");

    const [edit] = withPermissions([createEditTool()], { mode: "auto-edit" });
    const result = await edit!.run(
      { path: "a.txt", old_string: "old", new_string: "new" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("replaced 1 occurrence");
  });

  it("still asks before a command in auto-edit mode", async () => {
    const asked: PermissionRequest[] = [];
    const [bash] = withPermissions([createBashTool()], {
      mode: "auto-edit",
      ask: async (request) => {
        asked.push(request);
        return "allow";
      },
    });

    await bash!.run({ command: "echo hi" }, context());

    expect(asked).toHaveLength(1);
  });

  it("keeps the tool's own name and description", () => {
    const [read] = withPermissions([createReadTool()], { mode: "ask" });

    expect(read?.name).toBe("read");
    expect(read?.description.length).toBeGreaterThan(0);
  });

  it("asks when the tool asks for approval itself", async () => {
    const asked: PermissionRequest[] = [];
    const careful = {
      name: "careful",
      description: "Asks first.",
      schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never,
      effect: "read" as const,
      needsApproval: () => true,
      async run() {
        return { output: "ran" };
      },
    };

    const [wrapped] = withPermissions([careful], {
      mode: "yolo",
      ask: async (request: PermissionRequest) => {
        asked.push(request);
        return "allow" as PermissionDecision;
      },
    });

    const result = await wrapped!.run({}, context());

    expect(asked).toHaveLength(1);
    expect(result.output).toBe("ran");
  });
});


