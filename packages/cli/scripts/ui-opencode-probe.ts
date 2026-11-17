/**
 * The real session, the real OpenCode CLI, the real terminal.
 *
 * The UI is rendered into a headless terminal, the question is typed into
 * it, and what the user would see is printed. Nothing is stubbed: the
 * OpenCode CLI on this machine answers.
 *
 * Run: pnpm --filter @cli-agent/cli exec tsx scripts/ui-opencode-probe.ts
 */
import xterm from "@xterm/headless";
const { Terminal } = xterm;
import { PassThrough } from "node:stream";
import { createState } from "@cli-agent/core";
import { localOpencode } from "@cli-agent/ai";
import { InteractiveUi } from "../src/ui/interactive.js";

const input = new PassThrough();
const out = new PassThrough();
Object.assign(out, { columns: 100, rows: 30 });
const terminal = new Terminal({
  cols: 100,
  rows: 30,
  scrollback: 1000,
  allowProposedApi: true,
});
let writes = Promise.resolve();
out.on("data", (chunk: Buffer) => {
  writes = writes.then(() => new Promise<void>((r) => terminal.write(chunk, r)));
});

const provider = localOpencode({ id: "opencode-cli" });
const ref = "opencode-cli/nvidia/nvidia/nemotron-3.5-lightning-30b-a3b";

const ui = new InteractiveUi({
  state: createState(provider, { model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b" }),
  model: ref,
  permissionMode: "ask",
  cwd: process.cwd(),
  input,
  out,
  err: out,
  onModel: async () => provider,
  onModels: async () => [],
});

const started = Date.now();
void ui.run();
await new Promise((r) => setTimeout(r, 300));

// The question is typed into the session, as a person would type it.
input.write("In one short sentence, what is this project?\r");

// The answer is waited for.
const answer = await new Promise<string>((resolve) => {
  const timer = setInterval(() => {
    const block = ui.view.blocks.findLast((b) => b.kind === "text");
    if (block !== undefined && block.text.trim().length > 0) {
      clearInterval(timer);
      resolve(block.text);
    }
  }, 200);
  setTimeout(() => {
    clearInterval(timer);
    resolve("(no answer)");
  }, 180_000);
});

await writes;
console.log(`took: ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log("======== THE SCREEN ========");
const buf = terminal.buffer.active;
for (let i = 0; i < buf.length; i++) {
  const line = buf.getLine(i)?.translateToString(true) ?? "";
  console.log(String(i).padStart(2) + "|" + line + "|");
}
console.log("======== THE ANSWER ========");
console.log(answer.trim());

await ui.close();
await writes;
terminal.dispose();
input.destroy();
out.destroy();
process.exit(0);
