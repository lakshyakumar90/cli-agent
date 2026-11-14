import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { createSession } from "./session.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-session-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A provider that answers with a fixed text. */
const provider: Provider = {
  id: "test",
  models: async (): Promise<ModelInfo[]> => [],
  async *stream(request: StreamRequest): AsyncGenerator<Event> {
    yield { t: "text", delta: "ok" };
    yield {
      t: "done",
      usage: { inputTokens: 1, outputTokens: 1 },
      stop: "end",
    };
  },
};

/** An extension file in the project. */
async function writeExtension(name: string, source: string): Promise<void> {
  const folder = join(directory, ".myagent", "extensions");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.ts`), source, "utf8");
}

describe("the session", () => {
  it("gives the agent the tools of the extensions", async () => {
    await writeExtension(
      "hello",
      [
        "export function register(api: any) {",
        "  api.addTool({",
        "    name: 'hello',",
        "    description: 'Says hello.',",
        "    schema: api.z.object({ name: api.z.string() }),",
        "    async run(args: any) { return { output: `hello ${args.name}` }; },",
        "  });",
        "}",
      ].join("\n"),
    );

    const session = await createSession({
      model: "test/model",
      cwd: directory,
      permissionMode: "yolo",
      provider,
    });

    const tool = session.tools.find((candidate) => candidate.name === "hello");
    expect(tool).toBeDefined();

    // It works through the permission layer like the other tools.
    const result = await tool?.run(
      { name: "world" },
      { cwd: directory, signal: new AbortController().signal },
    );
    expect(result?.output).toBe("hello world");
  });

  it("gives the agent the commands of the extensions", async () => {
    await writeExtension(
      "deploy",
      [
        "export function register(api: any) {",
        "  api.addCommand({ name: 'deploy', description: 'Deploy', content: 'Deploy to $1.' });",
        "}",
      ].join("\n"),
    );

    const session = await createSession({
      model: "test/model",
      cwd: directory,
      permissionMode: "yolo",
      provider,
    });

    expect(session.commands.map((command) => command.name)).toContain(
      "/deploy",
    );
  });

  it("carries on when an extension cannot be loaded", async () => {
    await writeExtension("broken", "export function register() { throw new Error('no'); }");

    const session = await createSession({
      model: "test/model",
      cwd: directory,
      permissionMode: "yolo",
      provider,
    });

    expect(session.extensions.problems).toHaveLength(1);
    // The agent still works.
    expect(session.tools.length).toBeGreaterThan(0);
  });

  it("gives the agent the skill tool and the task tool", async () => {
    const session = await createSession({
      model: "test/model",
      cwd: directory,
      permissionMode: "yolo",
      provider,
    });

    const names = session.tools.map((tool) => tool.name);
    expect(names).toContain("skill");
    expect(names).toContain("task");
    expect(names).toContain("read");
  });
});
