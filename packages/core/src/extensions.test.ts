import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { loadExtensions } from "./extensions.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-extensions-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** An extension file in the project. */
async function writeExtension(name: string, source: string): Promise<void> {
  const folder = join(directory, ".myagent", "extensions");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.ts`), source, "utf8");
}

/** A provider that answers with a fixed text. */
const provider: Provider = {
  id: "extra",
  models: async (): Promise<ModelInfo[]> => [],
  async *stream(request: StreamRequest): AsyncGenerator<Event> {
    const last = request.messages[request.messages.length - 1];
    yield {
      t: "text",
      delta: last?.role === "user" ? last.content : "ok",
    };
    yield { t: "done", usage: { inputTokens: 1, outputTokens: 1 }, stop: "end" };
  },
};

describe("an extension", () => {
  it("adds a tool", async () => {
    await writeExtension(
      "hello",
      [
        "export function register(api: any) {",
        "  api.addTool({",
        "    name: 'hello',",
        "    description: 'Says hello.',",
        "    schema: api.z.object({ name: api.z.string() }),",
        "    async run(args: any) {",
        "      return { output: `hello ${args.name}` };",
        "    },",
        "  });",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.problems).toEqual([]);
    expect(loaded.tools).toHaveLength(1);
    expect(loaded.tools[0]?.name).toBe("hello");

    const result = await loaded.tools[0]?.run(
      { name: "world" },
      { cwd: directory, signal: new AbortController().signal },
    );
    expect(result?.output).toBe("hello world");
  });

  it("adds a command", async () => {
    await writeExtension(
      "deploy",
      [
        "export function register(api: any) {",
        "  api.addCommand({",
        "    name: 'deploy',",
        "    description: 'Deploy the app',",
        "    content: 'Deploy to $1.',",
        "  });",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.commands).toHaveLength(1);
    expect(loaded.commands[0]).toMatchObject({
      name: "/deploy",
      description: "Deploy the app",
      content: "Deploy to $1.",
    });
  });

  it("adds a provider", async () => {
    await writeExtension(
      "extra",
      [
        "export function register(api: any) {",
        "  api.addProvider({",
        "    id: 'extra',",
        "    models: async () => [],",
        "    async *stream() {",
        "      yield { t: 'done', usage: { inputTokens: 0, outputTokens: 0 }, stop: 'end' };",
        "    },",
        "  });",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.providers.get("extra")).toBeDefined();
  });

  it("says something in the log", async () => {
    await writeExtension(
      "chatty",
      [
        "export function register(api: any) {",
        "  api.log('hello from the extension');",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.logs).toContain("hello from the extension");
    // And it says which one was loaded.
    expect(loaded.logs).toContain("loaded the extension chatty");
  });

  it("is reported when it cannot be loaded, and the others carry on", async () => {
    await writeExtension(
      "broken",
      "export function register(api: any) { throw new Error('no'); }",
    );
    await writeExtension(
      "fine",
      [
        "export function register(api: any) {",
        "  api.addCommand({ name: 'fine', content: 'all good' });",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.message).toContain("no");
    // The other extension still loaded.
    expect(loaded.commands.map((command) => command.name)).toEqual(["/fine"]);
  });

  it("is reported when it does not export a register function", async () => {
    await writeExtension("empty", "export const nothing = 1;");

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.message).toContain("register");
  });

  it("refuses a provider that is already there", async () => {
    await writeExtension(
      "twice",
      [
        "export function register(api: any) {",
        "  const p = { id: 'same', models: async () => [], async *stream() {} };",
        "  api.addProvider(p);",
        "  api.addProvider(p);",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]?.message).toContain("already registered");
  });

  it("is nothing when there is no folder", async () => {
    const loaded = await loadExtensions({ cwd: directory });

    expect(loaded.tools).toEqual([]);
    expect(loaded.commands).toEqual([]);
    expect(loaded.problems).toEqual([]);
  });
});

describe("a provider an extension added", () => {
  it("is the one that serves the model", async () => {
    await writeExtension(
      "extra",
      [
        "export function register(api: any) {",
        "  api.addProvider({",
        "    id: 'extra',",
        "    models: async () => [],",
        "    async *stream() {",
        "      yield { t: 'text', delta: 'from the extension' };",
        "      yield { t: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stop: 'end' };",
        "    },",
        "  });",
        "}",
      ].join("\n"),
    );

    const loaded = await loadExtensions({ cwd: directory });
    const added = loaded.providers.get("extra");

    let text = "";
    for await (const event of added?.stream({
      model: "extra/thing",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    } as never) ?? []) {
      if (event.t === "text") text += event.delta;
    }

    expect(text).toBe("from the extension");
  });
});
