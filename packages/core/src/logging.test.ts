import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Log } from "./logging.js";
import { run } from "./loop.js";
import { collect, scriptedProvider, stateWith } from "./loop.test-helpers.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-log-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** The lines of a log, as objects. */
async function lines(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the log", () => {
  it("is one JSON object per line", async () => {
    const path = join(directory, "session.jsonl");
    const log = new Log({ path });

    log.write({ event: "note", message: "the first thing" });
    log.write({ event: "note", message: "the second thing" });

    const entries = await lines(path);

    expect(entries).toHaveLength(2);
    expect(entries[0]?.message).toBe("the first thing");
    expect(typeof entries[0]?.at).toBe("string");
  });

  it("takes the secrets out", async () => {
    const path = join(directory, "session.jsonl");
    const log = new Log({ path });

    log.write({
      event: "toolStart",
      tool: "bash",
      args: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrst'" },
    });

    const entries = await lines(path);

    expect(JSON.stringify(entries)).not.toContain("abcdefghijklmnopqrst");
  });

  it("keeps the secrets the process knows out", async () => {
    const path = join(directory, "session.jsonl");
    const log = new Log({ path, secrets: ["my-own-secret-value"] });

    log.write({
      event: "toolStart",
      tool: "bash",
      args: { command: "echo my-own-secret-value" },
    });

    const entries = await lines(path);

    expect(JSON.stringify(entries)).not.toContain("my-own-secret-value");
  });

  it("does not stop the agent when it cannot be written", async () => {
    const log = new Log({ path: "\\\\?\\nope\\nope\\nope.jsonl" });

    // Nothing is written, and nothing is thrown.
    log.write({ event: "note", message: "hello" });
  });
});

describe("what the loop writes down", () => {
  it("the request, the tool call and the usage", async () => {
    const path = join(directory, "session.jsonl");
    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "echo", args: { text: "hi" } }] },
      { text: "done" },
    ]);

    const state = stateWith(provider, [
      {
        name: "echo",
        description: "Echoes.",
        schema: z.object({ text: z.string() }),
        async run() {
          return { output: "echo: hi" };
        },
      },
    ]);
    state.log = new Log({ path });

    await collect(run(state, "go", new AbortController().signal));

    const entries = await lines(path);
    const events = entries.map((entry) => entry.event);

    expect(events).toContain("request");
    expect(events).toContain("toolStart");
    expect(events).toContain("toolEnd");
    expect(events).toContain("usage");
    expect(events).toContain("turn");

    // The request says what was asked.
    const request = entries.find((entry) => entry.event === "request");
    expect(request?.model).toBe("test-model");
    expect(request?.tools).toBe(1);

    // The tool call says what was called and what it did.
    const started = entries.find((entry) => entry.event === "toolStart");
    expect(started?.tool).toBe("echo");

    const ended = entries.find((entry) => entry.event === "toolEnd");
    expect(ended?.ok).toBe(true);

    // The usage says what it used.
    const usage = entries.find((entry) => entry.event === "usage");
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(5);
  });

  it("what happened when a tool failed", async () => {
    const path = join(directory, "session.jsonl");
    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "echo", args: { text: "hi" } }] },
      { text: "done" },
    ]);

    const state = stateWith(provider, [
      {
        name: "echo",
        description: "Echoes.",
        schema: z.object({ text: z.string() }),
        async run() {
          return { output: "it went wrong", isError: true };
        },
      },
    ]);
    state.log = new Log({ path });

    await collect(run(state, "go", new AbortController().signal));

    const entries = await lines(path);
    const ended = entries.find((entry) => entry.event === "toolEnd");

    expect(ended?.ok).toBe(false);
  });
});
