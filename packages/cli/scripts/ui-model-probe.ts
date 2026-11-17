/**
 * The model picker, with the OpenCode CLI of this machine behind it.
 *
 * The picker is opened, the list of the OpenCode CLI is waited for, and one
 * of its models is taken. What the user would see is printed.
 *
 * Run: pnpm --filter @cli-agent/cli exec tsx scripts/ui-model-probe.ts
 */
import xterm from "@xterm/headless";
const { Terminal } = xterm;
import { PassThrough } from "node:stream";
import { createState } from "@cli-agent/core";
import { localOpencode } from "@cli-agent/ai";
import { buildCatalog } from "../src/catalog.js";
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
const providers = new Map([["opencode-cli", provider]]);

/** The provider of a ref, the way the session builds them. */
async function providerFor(ref: string): Promise<typeof provider> {
  const id = ref.slice(0, ref.indexOf("/"));
  const existing = providers.get(id);
  if (existing !== undefined) return existing;
  const made =
    id === "opencode-cli"
      ? provider
      : ({
          id,
          models: async () => [],
          async *stream() {
            yield { t: "done" as const, stop: "end" as const, usage: { inputTokens: 0, outputTokens: 0 } };
          },
        } as unknown as typeof provider);
  providers.set(id, made);
  return made;
}

const ui = new InteractiveUi({
  state: createState(provider, { model: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b" }),
  model: "opencode-cli/nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  permissionMode: "ask",
  cwd: process.cwd(),
  input,
  out,
  err: out,
  onModel: async (ref) => providerFor(ref),
  onModels: async (signal) =>
    buildCatalog({
      ...(signal === undefined ? {} : { signal }),
      providers,
      factory: { providers: new Map() },
    }),
});

void ui.run();
await new Promise((r) => setTimeout(r, 300));

input.write("/model\r");
await new Promise((r) => setTimeout(r, 6000));
await writes;

const dump = (label: string) => {
  console.log("======== " + label + " ========");
  const buf = terminal.buffer.active;
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true) ?? "";
    if (line.trim().length > 0) console.log(String(i).padStart(2) + "|" + line + "|");
  }
};
dump("THE PICKER");

// The list of the OpenCode CLI: the models it can serve.
const listed = ui.view.blocks.length;
input.write("nemotron");
await new Promise((r) => setTimeout(r, 800));
await writes;
dump("AFTER THE SEARCH");

input.write("\r");
await new Promise((r) => setTimeout(r, 1500));
await writes;
dump("AFTER THE CHOICE");

console.log("======== THE MODEL IN USE ========");
console.log("model:", ui.model);
console.log("provider:", ui.options.state.provider.id);
console.log("state model:", ui.options.state.model);
console.log("blocks:", listed);

await ui.close();
await writes;
terminal.dispose();
input.destroy();
out.destroy();
process.exit(0);
