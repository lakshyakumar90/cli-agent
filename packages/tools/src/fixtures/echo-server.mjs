/**
 * A small MCP server, for the tests.
 *
 * It says hello with two tools: one that echoes what it is given, and one
 * that fails. It talks over stdio, which is how most MCP servers are run.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes the text back.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `echo: ${text}` }],
  }),
);

server.registerTool(
  "boom",
  {
    description: "Always fails.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "it went wrong" }],
    isError: true,
  }),
);

await server.connect(new StdioServerTransport());
