import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateArgs } from "./validate.js";
import {
  loadMcpTools,
  readMcpConfig,
  renderResult,
  toolName,
  toTool,
  toZod,
  type McpCaller,
} from "./mcp.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-mcp-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A caller that answers with a fixed text. */
const answering = (text: string): McpCaller => ({
  async callTool() {
    return { content: [{ type: "text", text }] };
  },
});

describe("the MCP config", () => {
  it("reads the servers of a project", async () => {
    await mkdir(join(directory, ".myagent"), { recursive: true });
    await writeFile(
      join(directory, ".myagent", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-filesystem"] },
        },
      }),
      "utf8",
    );

    const config = await readMcpConfig(directory, { global: false });

    expect(config.mcpServers.files).toEqual({
      command: "npx",
      args: ["-y", "server-filesystem"],
    });
  });

  it("has no servers when there is no file", async () => {
    const config = await readMcpConfig(directory, { global: false });

    expect(config.mcpServers).toEqual({});
  });

  it("ignores a file that is not JSON", async () => {
    await writeFile(join(directory, ".mcp.json"), "not json at all", "utf8");

    const config = await readMcpConfig(directory, { global: false });

    expect(config.mcpServers).toEqual({});
  });
});

describe("an MCP tool", () => {
  it("is named server__tool", () => {
    expect(toolName("files", "read_file")).toBe("files__read_file");
  });

  it("cleans up the parts a provider would not accept", () => {
    expect(toolName("my.server", "read file")).toBe("my_server__read_file");
  });

  it("keeps the name short enough for a provider", () => {
    const name = toolName("a".repeat(40), "b".repeat(40));

    expect(name.length).toBeLessThanOrEqual(64);
  });

  it("holds the model to the schema the server gave", async () => {
    const tool = toTool(
      "files",
      {
        name: "read_file",
        description: "Reads a file.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      answering("the contents"),
    );

    expect(tool.name).toBe("files__read_file");
    expect(tool.description).toBe("Reads a file.");

    // The arguments are checked the same way our own tools are: the loop
    // holds the model to the schema the server gave.
    const good = validateArgs(tool, { path: "a.txt" });
    expect(good.ok).toBe(true);

    const bad = validateArgs(tool, {});
    expect(bad.ok).toBe(false);

    const result = await tool.run(
      { path: "a.txt" },
      { cwd: directory, signal: new AbortController().signal },
    );
    expect(result.output).toBe("the contents");
  });

  it("calls the server with the name the server knows", async () => {
    const asked: Array<{ name: string; arguments: Record<string, unknown> }> =
      [];

    const tool = toTool(
      "files",
      {
        name: "read_file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        async callTool(params) {
          asked.push(params);
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    );

    await tool.run(
      { path: "a.txt" },
      { cwd: directory, signal: new AbortController().signal },
    );

    // The model calls "files__read_file"; the server knows "read_file".
    expect(asked[0]?.name).toBe("read_file");
    expect(asked[0]?.arguments).toEqual({ path: "a.txt" });
  });

  it("takes anything when the schema cannot be read", async () => {
    const tool = toTool(
      "odd",
      { name: "thing", inputSchema: { type: "not-a-type" } as never },
      answering("fine"),
    );

    const result = await tool.run(
      { anything: true },
      { cwd: directory, signal: new AbortController().signal },
    );

    expect(result.output).toBe("fine");
  });
});

describe("the schema of an MCP tool", () => {
  it("becomes the same kind of schema our own tools have", () => {
    const schema = toZod({
      type: "object",
      properties: { path: { type: "string" }, count: { type: "number" } },
      required: ["path"],
    });

    expect(schema.parse({ path: "a", count: 2 })).toEqual({
      path: "a",
      count: 2,
    });
    expect(() => schema.parse({ count: 2 })).toThrow();
  });

  it("takes anything when there is no schema", () => {
    const schema = toZod(undefined);

    expect(schema.parse({ whatever: true })).toEqual({ whatever: true });
  });
});

describe("the result of an MCP tool", () => {
  it("is the text the server sent", () => {
    expect(
      renderResult({ content: [{ type: "text", text: "hello" }] }),
    ).toBe("hello");
  });

  it("joins several parts", () => {
    expect(
      renderResult({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
  });

  it("says what a part is when it is not text", () => {
    expect(
      renderResult({
        content: [{ type: "image", mimeType: "image/png" }],
      }),
    ).toBe("[image: image/png]");
  });

  it("says so when the server said nothing", () => {
    expect(renderResult({ content: [] })).toBe("(the server said nothing)");
  });
});

describe("the MCP servers", () => {
  it("are nothing when there are none", async () => {
    const result = await loadMcpTools({ mcpServers: {} });

    expect(result.tools).toEqual([]);
    expect(result.servers).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("report a server that does not answer, and the others carry on", async () => {
    const result = await loadMcpTools(
      {
        mcpServers: {
          broken: { command: "definitely-not-a-real-command-xyz" },
        },
      },
      { connectTimeoutMs: 2_000 },
    );

    expect(result.tools).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.server).toBe("broken");
    expect(result.problems[0]?.message.length).toBeGreaterThan(0);
  }, 30_000);
});
