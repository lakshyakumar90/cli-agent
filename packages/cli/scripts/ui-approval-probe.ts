/**
 * Render the permission dialog headless and dump what the user sees.
 *
 * Run: pnpm --filter @cli-agent/cli exec tsx scripts/ui-approval-probe.ts
 */
import xterm from "@xterm/headless";
const { Terminal } = xterm;
import { PassThrough } from "node:stream";
import { createState } from "@cli-agent/core";
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

const provider = {
  id: "test",
  models: async () => [],
  async *stream() {
    yield { t: "text" as const, delta: "ok" };
    yield {
      t: "done" as const,
      stop: "end" as const,
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};

const ui = new InteractiveUi({
  state: createState(provider, { model: "model" }),
  model: "test/model",
  permissionMode: "ask",
  cwd: process.cwd(),
  input,
  out,
  err: out,
  onModel: async () => provider,
  onModels: async () => [],
});

void ui.run();
await new Promise((r) => setTimeout(r, 300));

const approval = ui.permissions.authorize(
  {
    tool: "bash",
    effect: "execute",
    args: {
      command:
        "git commit -am 'fix the thing that was broken in the last release'",
    },
    subject:
      "git commit -am 'fix the thing that was broken in the last release'",
    reason: "Save the work that is done, with the message of the branch.",
    cwd: "C:\\Lakshya\\cli-agent",
  },
  new AbortController().signal,
);

await new Promise((r) => setTimeout(r, 600));
await writes;

console.log("======== THE DIALOG ========");
const buf = terminal.buffer.active;
for (let i = 0; i < buf.length; i++) {
  const line = buf.getLine(i)?.translateToString(true) ?? "";
  if (line.trim().length > 0) console.log(String(i).padStart(2) + "|" + line + "|");
}

input.write("\r");
console.log("======== AFTER THE ANSWER ========");
console.log("allowed:", await approval);
await ui.close();
await writes;
terminal.dispose();
input.destroy();
out.destroy();
