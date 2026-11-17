/**
 * Live check of the local OpenCode provider against the installed CLI.
 *
 * It answers the questions the unit tests cannot:
 *   1. can the catalog of the CLI be read (the "Unavailable" report)?
 *   2. does a turn come back with text (the "no response" report)?
 *   3. how long does each part take (the "too slow" report)?
 *
 * Run: pnpm --filter @cli-agent/ai exec tsx scripts/live-check.ts
 */
import { localOpencode } from "../src/providers/local-opencode.js";

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;

/** The models to try, best first. */
const PREFERRED = [
  "nvidia/openai/gpt-oss-20b",
  "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  "ollama/llama3.2:latest",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/minimax-m3.1-flash-free",
  "opencode/muse-ember-1.0",
  "opencode/big-pickle",
];

async function main() {
  const provider = localOpencode({ id: "opencode-cli" });
  let failures = 0;

  console.log(`${stamp()} reading the catalog of the CLI…`);
  let models: string[] = [];
  try {
    const listed = await provider.models();
    models = listed.map((m) => m.id);
    console.log(`${stamp()} catalog OK: ${models.length} model(s)`);
  } catch (error) {
    failures += 1;
    console.log(
      `${stamp()} catalog FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidates = [
    ...PREFERRED.filter((m) => models.includes(m)),
    ...models.filter((m) => !PREFERRED.includes(m)).slice(0, 4),
  ];
  if (candidates.length === 0) {
    console.log("no model to try");
    await provider.close?.();
    process.exit(1);
  }

  let answered = false;
  for (const model of candidates) {
    const began = Date.now();
    try {
      let text = "";
      for await (const event of provider.stream({
        model,
        system: "Reply with exactly one short word.",
        messages: [{ role: "user", content: "Reply with exactly one short word." }],
        tools: [],
        signal: AbortSignal.timeout(120_000),
      })) {
        if (event.t === "text") text += event.delta;
      }
      const took = ((Date.now() - began) / 1000).toFixed(1);
      if (text.trim().length === 0) {
        console.log(`${stamp()} ${model}: no text (${took}s)`);
        continue;
      }
      console.log(`${stamp()} ${model}: TEXT ${JSON.stringify(text.trim().slice(0, 80))} (${took}s)`);
      answered = true;
      break;
    } catch (error) {
      const took = ((Date.now() - began) / 1000).toFixed(1);
      const message = error instanceof Error ? error.message : String(error);
      // A model that is out of quota says so; that is not a failure of the
      // bridge, and the next model is tried.
      const limit = /limit reached|quota|429/i.test(message);
      console.log(
        `${stamp()} ${model}: ${limit ? "out of quota" : "FAILED"} — ${message} (${took}s)`,
      );
      if (!limit) failures += 1;
    }
  }

  await provider.close?.();
  if (!answered) {
    failures += 1;
    console.log("no model answered");
  }
  console.log(failures === 0 ? "ALL GOOD" : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.log("FATAL", error);
  process.exit(1);
});
