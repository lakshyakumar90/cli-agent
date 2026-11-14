/**
 * Record the streams the vendors send.
 *
 * The tests replay these instead of writing the wire format out by hand,
 * so a change in the format shows up as a failing test.
 *
 * Run: pnpm --filter @cli-agent/ai record:fixtures
 *
 * It needs a key for the provider it records, and it says which ones it
 * could not reach.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "../src/providers/anthropic.js";
import { codex } from "../src/providers/codex.js";
import { gemini } from "../src/providers/gemini.js";
import { openaiCompat } from "../src/providers/openai-compat.js";
import type { Provider, StreamRequest } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "fixtures");

/** What was recorded, and what it was. */
interface Recording {
  /** The name of the file, without the extension. */
  name: string;
  /** Builds the provider, with the fetch that records. */
  build: (fetch: typeof globalThis.fetch) => Provider;
  /** The request that was sent. */
  request: StreamRequest;
}

/** A request that says hello. */
function hello(model: string): StreamRequest {
  return {
    model,
    system: "You are a coding agent.",
    messages: [{ role: "user", content: "Say hello in three words." }],
    tools: [],
    signal: new AbortController().signal,
  };
}

/** A request that asks for a tool. */
function withTool(model: string): StreamRequest {
  return {
    model,
    system: "You are a coding agent.",
    messages: [
      { role: "user", content: "Read the file a.ts and tell me what it says." },
    ],
    tools: [
      {
        name: "read",
        description: "Reads a file.",
        schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
    signal: new AbortController().signal,
  };
}

/**
 * Call a provider and write down what came back.
 *
 * The body is written exactly as it came, before anything reads it.
 */
async function record(
  recording: Recording,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  let body = "";

  const capturing: typeof globalThis.fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    body = await response.clone().text();
    return response;
  };

  const provider = recording.build(capturing);

  try {
    for await (const _event of provider.stream(recording.request)) {
      // The body is what matters, not the events.
    }
  } catch (error) {
    console.log(
      `  ${recording.name}: the provider said ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (body.length === 0) {
    console.log(`  ${recording.name}: nothing came back`);
    return;
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${recording.name}.txt`), body, "utf8");
  console.log(`  ${recording.name}: ${body.length} bytes`);
}

/** The Codex login, when the Codex CLI has one. */
async function readCodexAuth(): Promise<
  { accessToken: string; accountId?: string } | undefined
> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");

    const raw = await readFile(
      join(homedir(), ".codex", "auth.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      tokens?: { access_token?: string; account_id?: string };
    };

    const accessToken = parsed.tokens?.access_token;
    if (accessToken === undefined || accessToken.length === 0) return undefined;

    const accountId = parsed.tokens?.account_id;
    return {
      accessToken,
      ...(accountId === undefined ? {} : { accountId }),
    };
  } catch {
    return undefined;
  }
}

const geminiKey = process.env.GEMINI_API_KEY?.trim();const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();

console.log("recording the streams:");

if (geminiKey !== undefined && geminiKey.length > 0) {
  await record(
    {
      name: "gemini-stream",
      build: (fetch) => gemini({ apiKey: geminiKey, fetch }),
      request: hello("gemini-2.5-flash"),
    },
    globalThis.fetch,
  );
  await record(
    {
      name: "gemini-tool-call",
      build: (fetch) => gemini({ apiKey: geminiKey, fetch }),
      request: withTool("gemini-2.5-flash"),
    },
    globalThis.fetch,
  );
} else {
  console.log("  gemini: no GEMINI_API_KEY");
}

if (openrouterKey !== undefined && openrouterKey.length > 0) {
  const baseUrl = "https://openrouter.ai/api/v1";
  const model = "nvidia/nemotron-3.5-lightning:free";

  await record(
    {
      name: "openai-compat-stream",
      build: (fetch) =>
        openaiCompat({ id: "openrouter", baseUrl, apiKey: openrouterKey, fetch }),
      request: hello(model),
    },
    globalThis.fetch,
  );
  await record(
    {
      name: "openai-compat-tool-call",
      build: (fetch) =>
        openaiCompat({ id: "openrouter", baseUrl, apiKey: openrouterKey, fetch }),
      request: withTool(model),
    },
    globalThis.fetch,
  );
} else if (geminiKey !== undefined && geminiKey.length > 0) {
  // Gemini speaks the OpenAI wire format as well, so the format is
  // recorded from a real stream even when OpenRouter cannot be reached.
  const baseUrl =
    "https://generativelanguage.googleapis.com/v1beta/openai";
  const model = "gemini-2.5-flash";

  await record(
    {
      name: "openai-compat-stream",
      build: (fetch) =>
        openaiCompat({ id: "openrouter", baseUrl, apiKey: geminiKey, fetch }),
      request: hello(model),
    },
    globalThis.fetch,
  );
  await record(
    {
      name: "openai-compat-tool-call",
      build: (fetch) =>
        openaiCompat({ id: "openrouter", baseUrl, apiKey: geminiKey, fetch }),
      request: withTool(model),
    },
    globalThis.fetch,
  );
} else {
  console.log("  openai-compat: no key to record it with");
}

if (anthropicKey !== undefined && anthropicKey.length > 0) {
  await record(
    {
      name: "anthropic-stream",
      build: (fetch) => anthropic({ apiKey: anthropicKey, fetch }),
      request: hello("claude-sonnet-4-5"),
    },
    globalThis.fetch,
  );
} else {
  console.log("  anthropic: no ANTHROPIC_API_KEY");
}

// The Codex stream needs a ChatGPT login. The Codex CLI keeps one in
// ~/.codex/auth.json, and it is read from there: the agent has a login
// flow of its own, and this is only the recorder.
const codexAuth = await readCodexAuth();
if (codexAuth !== undefined) {
  await record(
    {
      name: "codex-stream",
      build: (fetch) =>
        codex({
          accessToken: codexAuth.accessToken,
          accountId: codexAuth.accountId,
          fetch,
        }),
      request: hello("gpt-6.1-sol"),
    },
    globalThis.fetch,
  );
  await record(
    {
      name: "codex-tool-call",
      build: (fetch) =>
        codex({
          accessToken: codexAuth.accessToken,
          accountId: codexAuth.accountId,
          fetch,
        }),
      request: withTool("gpt-6.1-sol"),
    },
    globalThis.fetch,
  );
} else {
  console.log("  codex: no login in ~/.codex/auth.json");
}
