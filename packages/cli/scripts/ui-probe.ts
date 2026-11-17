/**
 * Render the interactive UI headless and dump what the user sees.
 *
 * Run: pnpm --filter @cli-agent/cli exec tsx scripts/ui-probe.ts
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

const longAnswer =
  "Here is a long answer that should wrap across many lines in the terminal window so that we can see whether the wrapping keeps the indent intact and nothing is cut off at the right edge of the screen.\n\n" +
  "A second paragraph with `inline code` and a list:\n\n" +
  "- first item that is quite long and wraps around the terminal width to check indentation\n" +
  "- second item\n\n" +
  "```ts\nconst x = 1;\nconst y = 2;\n```";

const provider = {
  id: "test",
  models: async () => [],
  async *stream() {
    yield {
      t: "thinking" as const,
      delta: Array.from({ length: 14 }, (_, i) => `thought ${i}`).join("\n"),
    };
    yield {
      t: "toolCall" as const,
      call: {
        type: "toolCall" as const,
        id: "c1",
        name: "bash",
        args: {
          command:
            "pnpm --filter @cli-agent/cli test -- --reporter=verbose --runInBand",
        },
      },
    };
    yield {
      t: "toolEnd" as const,
      call: {
        type: "toolCall" as const,
        id: "c1",
        name: "bash",
        args: {
          command:
            "pnpm --filter @cli-agent/cli test -- --reporter=verbose --runInBand",
        },
      },
      output: Array.from({ length: 12 }, (_, i) => `output line ${i}`).join("\n"),
    };
    yield { t: "text" as const, delta: longAnswer };
    yield {
      t: "done" as const,
      stop: "end" as const,
      usage: { inputTokens: 2, outputTokens: 3 },
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
input.write("what does the code do?\r");
await new Promise((r) => setTimeout(r, 3000));
await writes;

const dump = (label: string) => {
  console.log("======== " + label + " ========");
  const buf = terminal.buffer.active;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true) ?? "";
    console.log(String(i).padStart(2) + "|" + line + "|");
  }
};
dump("ACTIVE SCREEN");

await ui.close();
await writes;
terminal.dispose();
input.destroy();
out.destroy();
