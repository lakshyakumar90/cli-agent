/**
 * A local server that speaks two real provider wire formats.
 *
 * It exists so the registry can be exercised end to end — real HTTP, real SSE,
 * real adapters — without an API key: one endpoint answers in OpenAI's
 * `chat.completion.chunk` shape, the other in Anthropic's named-event shape.
 * The point of the registry is that the *same* code drives both.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockProviderOptions {
  /** Text the OpenAI-compatible endpoint streams. */
  openai?: string;
  /** Text the Anthropic endpoint streams. */
  anthropic?: string;
  /** Usage both endpoints report. */
  usage?: { input: number; output: number };
  /** Models the `/models` endpoint advertises. */
  models?: Array<{ id: string; context_length?: number }>;
}

export interface MockProviderServer {
  /** Base URL of the server, e.g. `http://127.0.0.1:53211`. */
  url: string;
  /** Requests received, in order. */
  requests: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

const DEFAULT_USAGE = { input: 11, output: 4 };

/** Split a string into a few chunks so the stream has several deltas. */
function chunk(text: string, size = 12): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }
  return parts;
}

function sse(res: ServerResponse, parts: string[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "close",
  });
  for (const part of parts) res.write(part);
  res.end();
}

function openAiStream(text: string, usage: { input: number; output: number }): string[] {
  const parts: string[] = [];
  for (const piece of chunk(text)) {
    parts.push(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })}\n\n`,
    );
  }
  parts.push(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  parts.push(
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
    })}\n\n`,
  );
  parts.push("data: [DONE]\n\n");
  return parts;
}

function anthropicStream(
  text: string,
  usage: { input: number; output: number },
): string[] {
  const event = (type: string, data: Record<string, unknown> = {}): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

  const parts: string[] = [
    event("message_start", {
      message: { usage: { input_tokens: usage.input } },
    }),
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];

  for (const piece of chunk(text)) {
    parts.push(
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: piece },
      }),
    );
  }

  parts.push(event("content_block_stop", { index: 0 }));
  parts.push(
    event("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: usage.output },
    }),
  );
  parts.push(event("message_stop"));
  return parts;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function startMockProviderServer(
  options: MockProviderOptions = {},
): Promise<MockProviderServer> {
  const {
    openai = "Hello from the OpenAI-compatible endpoint.",
    anthropic = "Hello from the Anthropic endpoint.",
    usage = DEFAULT_USAGE,
    models = [],
  } = options;

  const requests: MockProviderServer["requests"] = [];

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const body = await readBody(req);
      requests.push({ path, body });

      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: models }));
        return;
      }

      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        sse(res, openAiStream(openai, usage));
        return;
      }

      if (req.method === "POST" && path.endsWith("/messages")) {
        sse(res, anthropicStream(anthropic, usage));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no mock route for ${req.method} ${path}` }));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
