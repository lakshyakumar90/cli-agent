/**
 * The MCP client.
 *
 * The Model Context Protocol is how a program offers its tools to other
 * programs. A server is a process (or a URL) that says "here are my tools",
 * and the agent calls them like its own.
 *
 * Each server's tools become tools of ours, named `server__tool`, so the
 * model can tell them apart and so two servers cannot collide.
 *
 * The SDK is loaded only when there is a server to talk to: a session that
 * uses no MCP server never pays for it, and a missing SDK never stops the
 * agent from working.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";

/** Where the servers are looked for. */
export const MCP_CONFIG_PATHS = [
  ".myagent/mcp.json",
  ".mcp.json",
] as const;

/** One server, as the config file describes it. */
export interface McpServerConfig {
  /** The program to run (a server that talks over stdio). */
  command?: string;
  /** The arguments for it. */
  args?: string[];
  /** Extra environment for it. */
  env?: Record<string, string>;
  /** The directory to run it in. */
  cwd?: string;
  /** Where to reach it (a server that talks over HTTP). */
  url?: string;
  /** The headers to send it. */
  headers?: Record<string, string>;
  /** The transport to use. Guessed when it is left out. */
  transport?: "stdio" | "http";
}

/** The config file. */
export interface McpConfig {
  /** The servers, by name. */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * The servers that are configured.
 *
 * The project's file comes first, then the user's, so a project can have a
 * server of its own without losing the rest.
 */
export async function readMcpConfig(
  cwd: string,
  options: { global?: boolean } = {},
): Promise<McpConfig> {
  const paths: string[] = [];
  if (options.global !== false) {
    paths.push(join(homedir(), ".myagent", "mcp.json"));
  }
  for (const relative of MCP_CONFIG_PATHS) {
    paths.push(join(cwd, relative));
  }

  const config: McpConfig = { mcpServers: {} };

  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      // No file, or a file that is not JSON: nothing to add.
      continue;
    }

    const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
    if (servers === undefined || typeof servers !== "object") continue;

    for (const [name, server] of Object.entries(
      servers as Record<string, unknown>,
    )) {
      if (server === null || typeof server !== "object") continue;
      config.mcpServers[name] = server as McpServerConfig;
    }
  }

  return config;
}

/** A server that is connected. */
export interface McpServer {
  /** Its name. */
  name: string;
  /** Its tools, as ours. */
  tools: Tool[];
  /** Say the server again. */
  close(): Promise<void>;
}

/** What went wrong, when something did. */
export interface McpProblem {
  /** The server it happened to. */
  server: string;
  /** What the server said. */
  message: string;
}

/** What the MCP servers gave us. */
export interface McpTools {
  /** The tools, from every server that answered. */
  tools: Tool[];
  /** The servers that answered. */
  servers: McpServer[];
  /** The servers that did not. */
  problems: McpProblem[];
}

export interface McpOptions {
  /** The directory the servers run in. */
  cwd?: string;
  /** How long a server may take to start and to answer. Default 30s. */
  timeoutMs?: number;
  /**
   * How long a server may take to start.
   *
   * A server that never answers must not hold the agent up: it is given
   * this long to say hello, and then it is left behind.
   */
  connectTimeoutMs?: number;
}

/**
 * Connect to every configured server and take its tools.
 *
 * A server that does not answer is reported, not thrown: one broken server
 * must not stop the agent from using the others.
 */
export async function loadMcpTools(
  config: McpConfig,
  options: McpOptions = {},
): Promise<McpTools> {
  const names = Object.keys(config.mcpServers);
  if (names.length === 0) {
    return { tools: [], servers: [], problems: [] };
  }

  const tools: Tool[] = [];
  const servers: McpServer[] = [];
  const problems: McpProblem[] = [];

  for (const name of names) {
    const server = config.mcpServers[name];
    if (server === undefined) continue;

    try {
      const connected = await connectServer(name, server, options);
      servers.push(connected);
      tools.push(...connected.tools);
    } catch (error) {
      problems.push({
        server: name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { tools, servers, problems };
}

/** Connect to one server and take its tools. */
export async function connectServer(
  name: string,
  config: McpServerConfig,
  options: McpOptions = {},
): Promise<McpServer> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const client = new Client(
    { name: "cli-agent", version: "0.0.0" },
    { capabilities: {} },
  ) as unknown as McpSdkClient & { connect(transport: unknown): Promise<void> };

  const transport =
    config.transport ??
    (config.url !== undefined && config.url.length > 0 ? "http" : "stdio");

  try {
    if (transport === "http") {
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const url = config.url as string;
      await withTimeout(
        client.connect(
          new StreamableHTTPClientTransport(new URL(url), {
            ...(config.headers === undefined
              ? {}
              : { requestInit: { headers: config.headers } }),
          }),
        ),
        options.connectTimeoutMs ?? 10_000,
        `the server "${name}"`,
      );
    } else {
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      await withTimeout(
        client.connect(
          new StdioClientTransport({
            command: config.command as string,
            ...(config.args === undefined ? {} : { args: config.args }),
            ...(config.env === undefined ? {} : { env: config.env }),
            ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
          }),
        ),
        options.connectTimeoutMs ?? 10_000,
        `the server "${name}"`,
      );
    }

    const listed = await withTimeout(
      client.listTools(),
      options.connectTimeoutMs ?? 10_000,
      `the server "${name}"`,
    );

    const caller = callerFor(client, options.timeoutMs ?? 30_000);
    const tools = listed.tools.map((tool) =>
      toTool(name, tool, caller, options),
    );

    return {
      name,
      tools,
      async close() {
        await client.close();
      },
    };
  } catch (error) {
    // The process the server started must not be left behind.
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Do something, but not longer than it may take.
 *
 * A server that hangs must not hang the agent with it: the wait is given
 * up, and the server is left behind.
 */
async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The part of the MCP client we use, so the types stay small. */
interface McpSdkClient {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<{ content?: unknown; isError?: boolean }>;
  listTools(): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: { type?: string; [key: string]: unknown };
    }>;
  }>;
  close(): Promise<void>;
}

/** The SDK client, as the caller a tool needs. */
function callerFor(
  client: McpSdkClient,
  timeoutMs: number,
): McpCaller {
  return {
    async callTool(params, signal) {
      const result = await client.callTool(params, undefined, {
        signal,
        timeout: timeoutMs,
      });

      const content = Array.isArray(result.content)
        ? (result.content as McpToolResult["content"])
        : [];

      return {
        content,
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

/**
 * A tool of the server, as one of ours.
 *
 * The schema the server gives is a JSON Schema; zod turns it into the same
 * kind of schema our own tools have, so the arguments are checked the same
 * way and the model is shown the same shape.
 */
export function toTool(
  serverName: string,
  tool: {
    name: string;
    description?: string;
    inputSchema?: { type?: string; properties?: unknown; [key: string]: unknown };
  },
  client: McpCaller,
  options: McpOptions = {},
): Tool {
  const schema = toZod(tool.inputSchema);
  const name = toolName(serverName, tool.name);

  return {
    name,
    description: tool.description ?? `the ${tool.name} tool of ${serverName}`,
    schema,
    // A server can do anything, so the careful answer is that it writes.
    effect: "write",
    async run(args: any, ctx) {
      const result = await client.callTool(
        { name: tool.name, arguments: args ?? {} },
        ctx.signal,
        options.timeoutMs ?? 30_000,
      );

      return {
        output: renderResult(result),
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
  };
}

/** The part of the MCP client a tool needs. */
export interface McpCaller {
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<McpToolResult>;
}

/** What a server gives back. */
export interface McpToolResult {
  /** The parts of the answer. */
  content: Array<{
    /** What the part is: "text", "image", "resource", … */
    type: string;
    /** The text, when the part is text. */
    text?: unknown;
    /** The kind of image, when the part is one. */
    mimeType?: unknown;
    /** The resource, when the part is one. */
    resource?: unknown;
  }>;
  /** The call failed. */
  isError?: boolean;
}

/**
 * The name the model calls the tool by.
 *
 * `server__tool`, with the parts cleaned up: a provider only accepts
 * letters, digits, dashes and underscores in a tool name.
 */
export function toolName(server: string, tool: string): string {
  const clean = (value: string): string =>
    value.replace(/[^A-Za-z0-9_-]/g, "_");

  const name = `${clean(server)}__${clean(tool)}`;
  // The longest name a provider takes is 64 characters.
  return name.length > 64 ? name.slice(0, 64) : name;
}

/** A JSON Schema as a zod schema. */
export function toZod(schema: unknown): z.ZodType {
  if (schema === undefined || schema === null) {
    return z.object({}).passthrough();
  }

  try {
    return z.fromJSONSchema(schema as never) as z.ZodType;
  } catch {
    // A schema zod cannot read is a schema the model is not held to: any
    // arguments are allowed, and the server decides.
    return z.object({}).passthrough();
  }
}

/** The result of a call, as the model reads it. */
export function renderResult(result: McpToolResult): string {
  const parts: string[] = [];

  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    if (part.type === "image") {
      const mime = part.mimeType;
      parts.push(`[image${typeof mime === "string" ? `: ${mime}` : ""}]`);
      continue;
    }
    if (part.type === "resource") {
      const resource = part.resource as { text?: unknown; uri?: unknown } | undefined;
      const text = resource?.text;
      if (typeof text === "string") {
        parts.push(text);
        continue;
      }
      const uri = resource?.uri;
      parts.push(`[resource${typeof uri === "string" ? `: ${uri}` : ""}]`);
      continue;
    }
    parts.push(`[${part.type}]`);
  }

  if (parts.length === 0) return "(the server said nothing)";
  return parts.join("\n");
}
