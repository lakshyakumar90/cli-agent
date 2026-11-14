import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blockReason,
  HookRunner,
  matches,
  matchHooks,
  readHooksConfig,
} from "./hooks.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-hooks-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A hook script that always fails with a reason. */
async function writeHook(
  name: string,
  script: string,
): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return path;
}

describe("the hook config", () => {
  it("reads the hooks of a project", async () => {
    await mkdir(join(directory, ".myagent"), { recursive: true });
    await writeFile(
      join(directory, ".myagent", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "bash", command: "./no-rm-rf.sh" }],
        },
      }),
      "utf8",
    );

    const config = await readHooksConfig(directory, { global: false });

    expect(config.hooks.PreToolUse).toEqual([
      { matcher: "bash", command: "./no-rm-rf.sh" },
    ]);
  });

  it("has no hooks when there is no file", async () => {
    const config = await readHooksConfig(directory, { global: false });

    expect(config.hooks).toEqual({});
  });

  it("ignores a file that is not JSON", async () => {
    await mkdir(join(directory, ".myagent"), { recursive: true });
    await writeFile(join(directory, ".myagent", "hooks.json"), "{", "utf8");

    const config = await readHooksConfig(directory, { global: false });

    expect(config.hooks).toEqual({});
  });
});

describe("which hooks answer", () => {
  it("matches a tool by its name", () => {
    expect(matches("bash", "bash")).toBe(true);
    expect(matches("bash", "write")).toBe(false);
  });

  it("matches every tool with a star", () => {
    expect(matches("*", "bash")).toBe(true);
    expect(matches(undefined, "bash")).toBe(true);
  });

  it("matches with a pattern", () => {
    expect(matches("ba.*", "bash")).toBe(true);
    expect(matches("^wr", "write")).toBe(true);
    expect(matches("^wr", "bash")).toBe(false);
  });

  it("leaves a matcher that is not a pattern alone", () => {
    expect(matches("a(b", "a(b")).toBe(true);
    expect(matches("a(b", "ab")).toBe(false);
  });

  it("only gives the hooks of the event and the tool", () => {
    const config = {
      hooks: {
        PreToolUse: [
          { matcher: "bash", command: "one" },
          { command: "two" },
        ],
        PostToolUse: [{ matcher: "bash", command: "three" }],
      },
    };

    expect(matchHooks(config, "PreToolUse", "bash").map((h) => h.command)).toEqual([
      "one",
      "two",
    ]);
    expect(matchHooks(config, "PreToolUse", "read").map((h) => h.command)).toEqual([
      "two",
    ]);
    expect(matchHooks(config, "PostToolUse", "bash").map((h) => h.command)).toEqual([
      "three",
    ]);
  });
});

describe("a hook that runs", () => {
  it("succeeds when the command does", async () => {
    const script = await writeHook(
      "ok.sh",
      "#!/bin/sh\necho 'all good'\nexit 0\n",
    );

    const runner = new HookRunner(
      { hooks: { PreToolUse: [{ command: script }] } },
      { cwd: directory },
    );

    const outcomes = await runner.run("PreToolUse", { tool: "bash" });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.blocked).toBe(false);
    expect(outcomes[0]?.output).toBe("all good");
  });

  it("stops the call when it fails", async () => {
    const script = await writeHook(
      "no-rm-rf.sh",
      "#!/bin/sh\necho 'that would delete everything'\nexit 1\n",
    );

    const runner = new HookRunner(
      { hooks: { PreToolUse: [{ matcher: "bash", command: script }] } },
      { cwd: directory },
    );

    const outcomes = await runner.run("PreToolUse", { tool: "bash" });

    expect(outcomes[0]?.blocked).toBe(true);
    expect(outcomes[0]?.code).toBe(1);
    expect(blockReason(outcomes)).toContain("that would delete everything");
  });

  it("is told what happened, on its standard input", async () => {
    const script = await writeHook(
      "read-input.sh",
      "#!/bin/sh\ncat\n",
    );

    const runner = new HookRunner(
      { hooks: { PreToolUse: [{ command: script }] } },
      { cwd: directory },
    );

    const outcomes = await runner.run("PreToolUse", {
      tool: "bash",
      args: { command: "rm -rf /" },
    });

    expect(outcomes[0]?.output).toContain("rm -rf /");
    expect(outcomes[0]?.output).toContain("PreToolUse");
  });

  it("does not run for a tool it does not match", async () => {
    const script = await writeHook("no.sh", "#!/bin/sh\nexit 1\n");

    const runner = new HookRunner(
      { hooks: { PreToolUse: [{ matcher: "bash", command: script }] } },
      { cwd: directory },
    );

    const outcomes = await runner.run("PreToolUse", { tool: "read" });

    expect(outcomes).toEqual([]);
  });

  it("stops the hooks after one has stopped the call", async () => {
    const first = await writeHook("first.sh", "#!/bin/sh\nexit 1\n");
    const second = await writeHook(
      "second.sh",
      "#!/bin/sh\necho 'should not run'\nexit 0\n",
    );

    const runner = new HookRunner(
      {
        hooks: {
          PreToolUse: [{ command: first }, { command: second }],
        },
      },
      { cwd: directory },
    );

    const outcomes = await runner.run("PreToolUse", { tool: "bash" });

    expect(outcomes).toHaveLength(1);
  });
});
