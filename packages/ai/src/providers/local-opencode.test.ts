import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "../errors.js";
import type { Event } from "../types.js";
import { localOpencode } from "./local-opencode.js";

// ---------------------------------------------------------------------------
// A fake opencode CLI: reads the prompt from stdin, prints JSONL events.
// ---------------------------------------------------------------------------

const FAKE_CLI = `
const args = process.argv.slice(2);
if (args.includes("models")) {
  console.log("opencode/big-pickle");
  console.log("nvidia/openai/gpt-oss-20b");
  console.log("not a model line");
  process.exit(0);
}
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (args.includes("fail")) {
    console.error("something went wrong");
    process.exit(1);
  }
  console.log("> build · " + (args[args.indexOf("--model") + 1] || "?"));
  console.log(JSON.stringify({ type: "step_start" }));
  console.log(JSON.stringify({
    type: "text",
    part: { type: "text", text: "Hello from the CLI. [" + stdin.trim() + "]" },
  }));
  if (args.includes("hang")) {
    // Stay alive so the caller can abort mid-turn.
    setInterval(() => {}, 1000);
    return;
  }
  console.log(JSON.stringify({
    type: "step_finish",
    part: {
      type: "step-finish",
      reason: "stop",
      tokens: { input: 12, output: 3, cache: { read: 4, write: 0 } },
    },
  }));
});
`;

let directory: string;
let script: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-opencode-"));
  script = join(directory, "fake-opencode.mjs");
  await writeFile(script, FAKE_CLI, "utf8");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function provider(over: Record<string, unknown> = {}) {
  return localOpencode({
    command: process.execPath,
    args: [script],
    ...over,
  });
}

async function collect(events: AsyncIterable<Event>): Promise<Event[]> {
  const collected: Event[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("local opencode", () => {
  it("streams the CLI's text and usage", async () => {
    const events = await collect(
      provider().stream({
        model: "opencode/big-pickle",
        system: "Be brief.",
        messages: [{ role: "user", content: "Say hello." }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(events).toEqual([
      {
        t: "text",
        delta: "Hello from the CLI. [<system>\nBe brief.\n</system>\n\n<user>\nSay hello.\n</user>]",
      },
      {
        t: "done",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
        },
        stop: "end",
      },
    ]);
  });

  it("passes the model through to the CLI", async () => {
    const events = await collect(
      provider().stream({
        model: "nvidia/openai/gpt-oss-20b",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );

    expect(events[0]?.t).toBe("text");
  });

  it("lists the models the CLI can serve", async () => {
    const models = await provider().models();

    expect(models).toEqual([
      { id: "opencode/big-pickle", provider: "opencode" },
      { id: "nvidia/openai/gpt-oss-20b", provider: "opencode" },
    ]);
  });

  it("reports a failing CLI as a provider error", async () => {
    const error = await collect(
      provider().stream({
        model: "fail",
        system: "",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "opencode", code: "protocol" });
    expect((error as Error).message).toContain("something went wrong");
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const stream = provider({ timeoutMs: 60_000 }).stream({
      model: "hang",
      system: "",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: controller.signal,
    });

    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.t).toBe("text");

    controller.abort();
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: "aborted" });
  });
});
