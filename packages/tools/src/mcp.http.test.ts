/**
 * The MCP client, against a server that talks over HTTP.
 *
 * The other test starts a server as a process; this one starts it in the
 * same process and reaches it over HTTP, which is the other way an MCP
 * server is used.
 */

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadMcpTools } from "./mcp.js";

let http: Server | undefined;

afterEach(async () => {
  const server = http;
  http = undefined;
  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** An MCP server on a port of its own. */
async function startServer(): Promise<string> {
  const mcp = new McpServer({ name: "echo-http", version: "1.0.0" });

  mcp.registerTool(
    "echo",
    {
      description: "Echoes the text back.",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({
      content: [{ type: "text", text: `echo: ${text}` }],
    }),
  );

  const transport = new StreamableHTTPServerTransport({
    // A session of its own for each client.
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  http = createServer((request, response) => {
    void (async () => {
      try {
        await transport.handleRequest(request, response);
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    })();
  });

  await new Promise<void>((resolve) =>
    http?.listen(0, "127.0.0.1", () => resolve()),
  );

  const address = http.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server did not say where it is");
  }

  return `http://127.0.0.1:${address.port}`;
}

describe("an MCP server over HTTP", () => {
  it("gives us its tools, and we can call them", async () => {
    const url = await startServer();

    const { tools, servers, problems } = await loadMcpTools(
      {
        mcpServers: {
          web: { url },
        },
      },
      { connectTimeoutMs: 20_000 },
    );

    expect(problems).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual(["web__echo"]);

    const echo = tools[0];
    const result = await echo?.run(
      { text: "hello" },
      { cwd: process.cwd(), signal: new AbortController().signal },
    );
    expect(result?.output).toBe("echo: hello");

    await Promise.all(servers.map((server) => server.close()));
  }, 60_000);
});
