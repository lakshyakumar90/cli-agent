import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { HookRunner } from "./hooks.js";
import { run } from "./loop.js";
import { collect, scriptedProvider, stateWith } from "./loop.test-helpers.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-hook-loop-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A hook script. */
async function writeHook(name: string, script: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return path;
}

/** A tool that remembers whether it ran. */
function countingTool(onRun: () => void) {
  return {
    name: "bash",
    description: "Runs a command.",
    schema: z.object({ command: z.string().optional() }),
    effect: "execute" as const,
    async run() {
      onRun();
      return { output: "the command ran" };
    },
  };
}

describe("a hook in the loop", () => {
  it("stops a call it does not want", async () => {
    let ran = false;

    const script = await writeHook(
      "no-rm-rf.sh",
      "#!/bin/sh\necho 'that would delete everything'\nexit 1\n",
    );

    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "bash", args: { command: "rm -rf /" } }] },
      { text: "I will not do that" },
    ]);

    const state = stateWith(provider, [countingTool(() => (ran = true))]);
    state.cwd = directory;
    state.hooks = new HookRunner(
      { hooks: { PreToolUse: [{ matcher: "bash", command: script }] } },
      { cwd: directory },
    );

    const events = await collect(
      run(state, "delete everything", new AbortController().signal),
    );

    // The tool never ran.
    expect(ran).toBe(false);

    // The model is told why.
    const result = state.messages.find((message) => message.role === "tool");
    expect(result?.role === "tool" ? result.content : "").toContain(
      "that would delete everything",
    );
    expect(result?.role === "tool" ? result.isError : false).toBe(true);

    // The turn carried on: the model was told and answered.
    expect(events.some((event) => event.t === "text")).toBe(true);
  });

  it("lets a call through when the hook is happy", async () => {
    let ran = false;

    const script = await writeHook("ok.sh", "#!/bin/sh\nexit 0\n");

    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "bash", args: { command: "git status" } }] },
      { text: "done" },
    ]);

    const state = stateWith(provider, [countingTool(() => (ran = true))]);
    state.cwd = directory;
    state.hooks = new HookRunner(
      { hooks: { PreToolUse: [{ matcher: "bash", command: script }] } },
      { cwd: directory },
    );

    await collect(run(state, "check it", new AbortController().signal));

    expect(ran).toBe(true);
  });

  it("adds what a hook says after the call to the result", async () => {
    const script = await writeHook(
      "lint.sh",
      "#!/bin/sh\necho 'the lint said hello'\nexit 0\n",
    );

    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "bash", args: { command: "ls" } }] },
      { text: "done" },
    ]);

    const state = stateWith(provider, [countingTool(() => undefined)]);
    state.cwd = directory;
    state.hooks = new HookRunner(
      { hooks: { PostToolUse: [{ matcher: "bash", command: script }] } },
      { cwd: directory },
    );

    await collect(run(state, "list it", new AbortController().signal));

    const result = state.messages.find((message) => message.role === "tool");
    expect(result?.role === "tool" ? result.content : "").toContain(
      "the lint said hello",
    );
  });

  it("puts what the session hook says in the prompt", async () => {
    const script = await writeHook(
      "start.sh",
      "#!/bin/sh\necho 'the tests are run with pnpm'\nexit 0\n",
    );

    const provider = scriptedProvider([{ text: "ok" }]);

    const state = stateWith(provider, []);
    state.cwd = directory;
    state.hooks = new HookRunner(
      { hooks: { SessionStart: [{ command: script }] } },
      { cwd: directory },
    );

    await collect(run(state, "hello", new AbortController().signal));

    // The note is in the prompt of every turn.
    expect(state.active?.notes).toEqual(["the tests are run with pnpm"]);

    const system = provider.requests[0]?.system ?? "";
    expect(system).toContain("the tests are run with pnpm");
  });
});
