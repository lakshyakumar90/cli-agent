/**
 * Phase 2 demo: the loop with a real model and a fake echo tool.
 *
 * The model is asked to call the tool; the loop runs it, sends the result
 * back, and the model answers. Everything printed here comes out of the
 * loop's event stream — the loop itself never prints.
 *
 * Run: pnpm --filter @cli-agent/core demo:loop
 * Needs GEMINI_API_KEY (or OPENAI_API_KEY).
 */

import { gemini, openaiCompat } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import { createState, run } from "../src/index.js";

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

const state =
  geminiKey !== undefined && geminiKey.length > 0
    ? createState(gemini({ apiKey: geminiKey }), {
        model: "gemini-2.5-flash",
        tools: [echo],
        system:
          "You are a coding agent. Always use the echo tool when asked to echo something, then report what it returned.",
      })
    : createState(
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

const controller = new AbortController();

for await (const event of run(
  state,
  "Call the echo tool with the text 'hello from the loop', then tell me what it returned.",
  controller.signal,
)) {
  switch (event.t) {
    case "text":
      process.stdout.write(event.delta);
      break;
    case "thinking":
      process.stdout.write(`[thinking] ${event.delta}`);
      break;
    case "toolStart":
      console.log(`\n[tool] ${event.call.name}(${JSON.stringify(event.call.args)})`);
      break;
    case "toolEnd":
      console.log(`[tool] ${event.call.name} -> ${event.output}`);
      break;
    case "done":
      console.log(
        `\n[done] reason=${event.reason} stop=${event.stop} turns=${event.turns} usage=${event.usage.inputTokens} in / ${event.usage.outputTokens} out`,
      );
      break;
  }
}

console.log("\ntranscript:");
for (const message of state.messages) {
  console.log(`  ${message.role}: ${JSON.stringify(message.content)}`);
}
