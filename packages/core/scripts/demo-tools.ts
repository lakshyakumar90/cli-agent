/**
 * Phase 3 demo: a real model with real tools.
 *
 * The model is given a small project and asked to fix it. It reads the file,
 * edits it, and checks its work — through the same loop, the same tools and
 * the same event stream as everything else.
 *
 * Run: pnpm --filter @cli-agent/core demo:tools
 * Needs GEMINI_API_KEY (or OPENAI_API_KEY).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gemini, openaiCompat } from "@cli-agent/ai";
import { createTools } from "@cli-agent/tools";
import { createState, run } from "../src/index.js";

const workspace = await mkdtemp(join(tmpdir(), "cli-agent-demo-"));

await writeFile(
  join(workspace, "greet.ts"),
  `export function greet(name: string): string {
  return "Hello, " + name;
}
`,
);

const geminiKey = process.env.GEMINI_API_KEY?.trim();
const openaiKey = process.env.OPENAI_API_KEY?.trim();

const provider =
  geminiKey !== undefined && geminiKey.length > 0
    ? gemini({ apiKey: geminiKey })
    : openaiCompat({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: openaiKey ?? "",
      });

const model = geminiKey !== undefined ? "gemini-2.5-flash" : "gpt-5.5";

const state = createState(provider, {
  model,
  tools: createTools(),
  system:
    "You are a coding agent working in a directory. Read the files before you change them, make the change with the edit tool, and check your work.",
  cwd: workspace,
});

for await (const event of run(
  state,
  "greet.ts returns a greeting without an exclamation mark. Add the exclamation mark, then read the file again to check it.",
  new AbortController().signal,
)) {
  switch (event.t) {
    case "text":
      process.stdout.write(event.delta);
      break;
    case "toolStart":
      console.log(`\n> ${event.call.name}(${JSON.stringify(event.call.args)})`);
      break;
    case "toolEnd":
      console.log(`< ${event.call.name}: ${event.output.split("\n")[0]}`);
      break;
    case "done":
      console.log(
        `\n[done] reason=${event.reason} turns=${event.turns} usage=${event.usage.inputTokens} in / ${event.usage.outputTokens} out`,
      );
      break;
  }
}

console.log("\n--- the file now ---");
console.log(await readFileText(join(workspace, "greet.ts")));

await rm(workspace, { recursive: true, force: true });

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
