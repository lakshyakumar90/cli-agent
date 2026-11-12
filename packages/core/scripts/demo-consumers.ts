/**
 * Phase 2 demo: one event stream, three consumers.
 *
 * The loop yields events and prints nothing. A terminal reads them as text,
 * a script reads them as JSON lines, and a parent agent reads the summary
 * of a sub-agent — all from the same stream.
 *
 * Run: pnpm --filter @cli-agent/core demo:consumers
 * Needs GEMINI_API_KEY (or OPENAI_API_KEY).
 */

import { gemini, openaiCompat } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import {
  collectAgent,
  createState,
  renderJsonLines,
  renderText,
  run,
  runSubAgent,
  type AgentEvent,
} from "../src/index.js";

const echo: Tool = {
  name: "echo",
  description: "Echoes the text back to you. Use it to test that you can call tools.",
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  async run(args: { text: string }) {
    return { output: `echo: ${args.text}` };
  },
};

const geminiKey = process.env.GEMINI_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();

function makeState() {
  if (geminiKey !== undefined && geminiKey.length > 0) {
    return createState(gemini({ apiKey: geminiKey }), {
      model: "gemini-2.5-flash",
      tools: [echo],
      system:
        "You are a coding agent. Always use the echo tool when asked to echo something, then report what it returned.",
    });
  }
  return createState(
    openaiCompat({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiKey ?? "",
    }),
    {
      model: "gpt-5.5",
      tools: [echo],
      system:
        "You are a coding agent. Always use the echo tool when asked to echo something, then report what it returned.",
    },
  );
}

const prompt =
  "Call the echo tool with the text 'hello from the loop', then tell me what it returned.";

// --- the one stream -------------------------------------------------------

const state = makeState();
const events: AgentEvent[] = [];
for await (const event of run(state, prompt, new AbortController().signal)) {
  events.push(event);
}

// --- a terminal ------------------------------------------------------------

console.log("=== text (what a terminal shows) ===");
for await (const chunk of renderText(events)) {
  process.stdout.write(chunk);
}

// --- a script -------------------------------------------------------------

console.log("\n=== json lines (what --json writes) ===");
for await (const line of renderJsonLines(events)) {
  process.stdout.write(line);
}

// --- a parent agent -------------------------------------------------------

console.log("=== summary (what a parent agent keeps) ===");
const summary = await collectAgent(events);
console.log(`text: ${summary.text}`);
console.log(`tools: ${summary.toolCalls.map((call) => call.name).join(", ")}`);
console.log(`reason: ${summary.reason}  usage: ${JSON.stringify(summary.usage)}`);

// --- a sub-agent ----------------------------------------------------------

console.log("\n=== a sub-agent (the same loop, its own transcript) ===");
const parent = makeState();
const sub = await collectAgent(
  runSubAgent({
    parent,
    prompt: "Call the echo tool with the text 'from the sub-agent'.",
    signal: new AbortController().signal,
  }),
);
console.log(`sub-agent said: ${sub.text}`);
console.log(`parent transcript untouched: ${parent.messages.length} messages`);
