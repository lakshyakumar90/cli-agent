/**
 * Drive the interactive session the way a person would: one key at a time,
 * with a pause between them.
 *
 * Run: pnpm exec tsx scripts/drive.ts "<keys>"
 * The keys: text is typed, "<enter>" presses Enter, "<esc>" presses Escape,
 * "<down>" and "<up>" are the arrows.
 */

import { PassThrough } from "node:stream";
import { InteractiveUi } from "../src/ui/interactive.js";

const keys = (process.argv[2] ?? "").split(",").map((key) => key.trim());

const input = new PassThrough();
let text = "";
const out = {
  text: "",
  write(chunk: string | Uint8Array): boolean {
    text += chunk.toString();
    return true;
  },
  end(): void {
    /* nothing to close */
  },
  on(): unknown {
    return out;
  },
  once(): unknown {
    return out;
  },
  emit(): boolean {
    return false;
  },
  removeListener(): unknown {
    return out;
  },
};

const ui = new InteractiveUi({
  state: {
    provider: {
      id: "test",
      models: async () => [],
      async *stream() {
        yield {
          t: "done",
          usage: { inputTokens: 10, outputTokens: 5 },
          stop: "end",
        };
      },
    },
    model: "test/model",
    tools: [],
    messages: [],
  } as never,
  out: out as never,
  err: out as never,
  input,
  model: "test/model",
  permissionMode: "ask",
  cwd: process.cwd(),
  onModels: async () => [
    {
      ref: "codex/gpt-6.1-sol",
      provider: "codex",
      id: "gpt-6.1-sol",
      free: false,
    },
    {
      ref: "codex/gpt-6-astra",
      provider: "codex",
      id: "gpt-6-astra",
      free: false,
    },
    {
      ref: "openrouter/nvidia/nemotron-3.5-lightning:free",
      provider: "openrouter",
      id: "nvidia/nemotron-3.5-lightning:free",
      free: true,
    },
  ],
  onModel: async () => undefined,
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const running = ui.run();

for (const key of keys) {
  await wait(250);
  if (key === "<enter>") input.write("\r");
  else if (key === "<esc>") input.write("\x1b");
  else if (key === "<down>") input.write("\x1b[B");
  else if (key === "<up>") input.write("\x1b[A");
  else if (key === "<tab>") input.write("\t");
  else input.write(key);
}

await wait(600);
await Promise.race([running, wait(2000)]);

// What the terminal would show: the last screen.
const screen = text.split("\n").slice(-24).join("\n");
process.stdout.write(`${screen}\n`);
process.exit(0);
