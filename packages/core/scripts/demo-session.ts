/**
 * Phase 6 demo: quit in the middle, come back, carry on.
 *
 * The first session asks for a tool and is then closed. The second session
 * opens the same file, reads the conversation back and continues it — the
 * model sees what happened before it was interrupted.
 *
 * Run: pnpm --filter @cli-agent/core demo:session
 * Needs GEMINI_API_KEY (or OPENROUTER_API_KEY).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gemini, openaiCompat } from "@cli-agent/ai";
import { createTools, withPermissions } from "@cli-agent/tools";
import { CheckpointStore, createState, run, SessionStore } from "../src/index.js";

const workspace = await mkdtemp(join(tmpdir(), "cli-agent-session-"));
const sessions = await mkdtemp(join(tmpdir(), "cli-agent-sessions-"));

await writeFile(
  join(workspace, "add.ts"),
  "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
  "utf8",
);

const geminiKey = process.env.GEMINI_API_KEY?.trim();
const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();

const provider =
  geminiKey !== undefined && geminiKey.length > 0
    ? gemini({ apiKey: geminiKey })
    : openaiCompat({
        id: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: openrouterKey ?? "",
        headers: { "X-Title": "cli-agent" },
      });

const model =
  geminiKey !== undefined && geminiKey.length > 0
    ? "gemini-2.5-flash"
    : "baidu/ernie-5.5-flash-preview:free";

const tools = withPermissions(createTools(), {
  mode: "yolo",
  workspace: workspace,
});

const store = new SessionStore({ root: sessions, cwd: workspace });

// --- the first session: it reads the file and is interrupted ----------------

const first = createState(provider, {
  model,
  tools,
  journal: store,
  checkpoints: new CheckpointStore(),
  cwd: workspace,
});
await store.create({ model });

console.log("--- the first session ---");
for await (const event of run(
  first,
  "Read add.ts and tell me what is wrong with it. Do not change it yet.",
  new AbortController().signal,
)) {
  if (event.t === "text") process.stdout.write(event.delta);
  if (event.t === "toolStart") console.log(`\n[tool] ${event.call.name}`);
  if (event.t === "done") console.log(`\n[done] turns=${event.turns}`);
}

const sessionId = store.id;
console.log(`\nthe session is ${sessionId}, in ${sessions}`);

// --- the agent quits and comes back ----------------------------------------

const store2 = new SessionStore({ root: sessions, cwd: workspace });
const resumed = await store2.open();
console.log(`\n--- the second session (resumed ${resumed}) ---`);

const transcript = await store2.transcript(resumed as string);
console.log(`it remembers ${transcript.length} messages`);

const second = createState(provider, {
  model,
  tools,
  journal: store2,
  checkpoints: new CheckpointStore(),
  cwd: workspace,
  messages: transcript,
});

for await (const event of run(
  second,
  "Now fix it, and say what you changed.",
  new AbortController().signal,
)) {
  if (event.t === "text") process.stdout.write(event.delta);
  if (event.t === "toolStart") console.log(`\n[tool] ${event.call.name}`);
  if (event.t === "done") console.log(`\n[done] turns=${event.turns}`);
}

console.log("\n--- add.ts now ---");
console.log(await readFile(join(workspace, "add.ts"), "utf8"));

console.log("--- the sessions of this project ---");
for (const session of await store2.list()) {
  console.log(
    `  ${session.id}  ${session.entries} entries  ${session.updatedAt}  ${session.model}`,
  );
}

await rm(workspace, { recursive: true, force: true });
await rm(sessions, { recursive: true, force: true });
