/** Native PTY smoke fixture. No credentials, network requests, or session files. */
import { InteractiveUi } from "../src/ui/interactive.js";
import { createState } from "@cli-agent/core";
const provider = {
  id: "fixture",
  models: async () => [],
  async *stream() {
    yield { t: "thinking" as const, delta: "Checking the terminal renderer." };
    yield { t: "text" as const, delta: "Terminal smoke check completed." };
    yield {
      t: "done" as const,
      stop: "end" as const,
      usage: { inputTokens: 3, outputTokens: 4 },
    };
  },
};
const ui = new InteractiveUi({
  state: createState(provider, { model: "model" }),
  model: "fixture/model",
  permissionMode: "ask",
  cwd: process.cwd(),
  out: process.stdout,
  err: process.stderr,
  input: process.stdin,
  onModels: async () =>
    Array.from({ length: 63 }, (_, i) => ({
      ref: `fixture/model-${i}`,
      provider: "fixture",
      id: `model-${i}`,
      free: true,
    })),
  onModel: async () => provider,
});
process.exitCode = await ui.run();
