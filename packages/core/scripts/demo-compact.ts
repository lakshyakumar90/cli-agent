/**
 * Phase 5 demo: a long session that has to compact.
 *
 * A conversation that has grown past the model's window is summarised, and
 * the agent carries on with the summary. The point is that it still knows
 * what the task was.
 *
 * Run: pnpm --filter @cli-agent/core demo:compact
 * Needs GEMINI_API_KEY (or OPENAI_API_KEY).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gemini, openaiCompat } from "@cli-agent/ai";
import { createState, run } from "../src/index.js";

const workspace = await mkdtemp(join(tmpdir(), "cli-agent-compact-"));
const geminiKey = process.env.GEMINI_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();
const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();

const provider =
  geminiKey !== undefined && geminiKey.length > 0
    ? gemini({ apiKey: geminiKey })
    : openrouterKey !== undefined && openrouterKey.length > 0
      ? openaiCompat({
          id: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: openrouterKey,
          headers: { "X-Title": "cli-agent" },
        })
      : openaiCompat({
          id: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKey: openaiKey ?? "",
        });

const model =
  geminiKey !== undefined && geminiKey.length > 0
    ? "gemini-2.5-flash"
    : openrouterKey !== undefined && openrouterKey.length > 0
      ? "baidu/ernie-5.5-flash-preview:free"
      : "gpt-5.5";

const state = createState(provider, {
  model,
  cwd: workspace,
  // A small window, so a long conversation has to be compacted.
  limits: { contextWindow: 2_400, outputReserve: 400 },
  system:
    "You are a coding agent. Keep your answers to one sentence.",
});

// A conversation that has been going a while.
state.messages.push({
  role: "user",
  content: "The task: write a function that adds two numbers, in add.ts.",
});
state.messages.push({
  role: "assistant",
  content: [
    {
      type: "text",
      text: "I will write add.ts with an exported function add(a, b).",
    },
  ],
});

for (let index = 0; index < 30; index += 1) {
  state.messages.push({
    role: "user",
    content: `Question ${index}: what is the state of the work? `.repeat(8),
  });
  state.messages.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text: `Answer ${index}: add.ts has an exported add(a, b) that returns a + b. The task is to write a function that adds two numbers, in add.ts. `.repeat(8),
      },
    ],
  });
}

console.log(
  `the conversation has ${state.messages.length} messages before the turn\n`,
);

for await (const event of run(
  state,
  "What is the task, and which file is it about?",
  new AbortController().signal,
)) {
  if (event.t === "compacted") {
    console.log(
      `[compacted] the conversation was ${event.tokens} tokens against a budget of ${event.budget}`,
    );
  }
  if (event.t === "text") process.stdout.write(event.delta);
  if (event.t === "done") {
    console.log(
      `\n[done] reason=${event.reason} turns=${event.turns} usage=${event.usage.inputTokens} in / ${event.usage.outputTokens} out`,
    );
  }
}

console.log(`\nthe transcript now has ${state.messages.length} messages:`);
console.log(`  first: ${String(state.messages[0]?.content ?? "").slice(0, 160)}...`);

await rm(workspace, { recursive: true, force: true });
