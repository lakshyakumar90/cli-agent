/**
 * Phase 7 demo: the lead delegates to the workers.
 *
 * One prompt, a real model, a real worker: the lead is asked to find out
 * what is in a directory, it hands the job to the explorer, and only the
 * explorer's report comes back — not the files it read.
 *
 * Run: pnpm --filter @cli-agent/core demo:agents
 * Needs OPENROUTER_API_KEY (or GEMINI_API_KEY).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gemini, openaiCompat } from "@cli-agent/ai";
import { createTools, withPermissions } from "@cli-agent/tools";
import {
  Board,
  createState,
  createTaskTool,
  loadRoles,
  run,
} from "../src/index.js";

const workspace = await mkdtemp(join(tmpdir(), "cli-agent-agents-"));

await writeFile(
  join(workspace, "server.ts"),
  [
    "export function start(port: number) {",
    "  return { port, listening: true };",
    "}",
    "",
  ].join("\n"),
  "utf8",
);
await writeFile(
  join(workspace, "README.md"),
  "# Demo\n\nThe server starts on a port.\n",
  "utf8",
);

const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
const geminiKey = process.env.GEMINI_API_KEY?.trim();

const provider =
  openrouterKey !== undefined && openrouterKey.length > 0
    ? openaiCompat({
        id: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: openrouterKey,
        headers: { "X-Title": "cli-agent" },
      })
    : gemini({ apiKey: geminiKey ?? "" });

const model =
  openrouterKey !== undefined && openrouterKey.length > 0
    ? "baidu/ernie-5.5-flash-preview:free"
    : "gemini-2.5-flash";

const roles = await loadRoles({ cwd: workspace });
console.log(
  `the roles: ${[...roles.keys()].join(", ")}\n`,
);

const tools = withPermissions(createTools(), {
  mode: "yolo",
  workspace,
});

const board = new Board();

const task = createTaskTool({
  roles,
  providerFor: async (workerModel) =>
    openrouterKey !== undefined && openrouterKey.length > 0
      ? openaiCompat({
          id: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: openrouterKey,
          headers: { "X-Title": "cli-agent" },
        })
      : gemini({ apiKey: geminiKey ?? "" }),
  defaultModel: model,
  tools,
  cwd: workspace,
  board,
});

const state = createState(provider, {
  model,
  tools: [...tools, task],
  cwd: workspace,
});

for await (const event of run(
  state,
  "Use the task tool to ask the explorer what is in this directory. Then tell me what it found.",
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
      console.log(`\n[done] turns=${event.turns}`);
      break;
  }
}

console.log("\n--- the board ---");
console.log(board.render());

console.log("\n--- what the parent kept ---");
for (const message of state.messages) {
  if (message.role === "tool") {
    console.log(`  tool: ${message.content.slice(0, 160)}`);
  }
}

await rm(workspace, { recursive: true, force: true });
