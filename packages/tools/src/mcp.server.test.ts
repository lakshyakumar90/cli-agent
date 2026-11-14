/**
 * The MCP client, against a real server.
 *
 * The unit tests check the parts on their own. This one starts an actual
 * MCP server, connects to it over stdio, and calls its tools - the whole
 * way a user's server would be used.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadMcpTools, type McpServer } from "./mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "fixtures", "echo-server.mjs");

describe("a real MCP server", () => {
  it("gives us its tools, and we can call them", async () => {
    const { tools, servers, problems } = await loadMcpTools(
      {
        mcpServers: {
          echo: { command: process.execPath, args: [server] },
        },
      },
      { connectTimeoutMs: 20_000 },
    );

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "echo__boom",
      "echo__echo",
    ]);

    const echo = tools.find((tool) => tool.name === "echo__echo");
    expect(echo?.description).toBe("Echoes the text back.");

    const result = await echo?.run(
      { text: "hello" },
      { cwd: here, signal: new AbortController().signal },
    );
    expect(result?.output).toBe("echo: hello");

    // A tool that fails says so.
    const boom = tools.find((tool) => tool.name === "echo__boom");
    const failed = await boom?.run(
      {},
      { cwd: here, signal: new AbortController().signal },
    );
    expect(failed?.isError).toBe(true);
    expect(failed?.output).toBe("it went wrong");

    // The server is shut down with the session.
    await Promise.all(servers.map((one: McpServer) => one.close()));
  }, 60_000);

  it("is left alone when it does not answer", async () => {
    const { tools, problems } = await loadMcpTools(
      {
        mcpServers: {
          broken: { command: "definitely-not-a-real-command-xyz" },
        },
      },
      { connectTimeoutMs: 3_000 },
    );

    expect(tools).toEqual([]);
    expect(problems[0]?.server).toBe("broken");
  }, 30_000);
});
