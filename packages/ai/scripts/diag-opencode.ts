/**
 * Temporary diagnostic: drive the real local opencode provider and print
 * everything it does. Used while fixing the "Unavailable" and "no response"
 * reports. Delete when done.
 */
import { localOpencode } from "../src/providers/local-opencode.js";

const started = Date.now();
const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;

async function main() {
  const provider = localOpencode({ id: "opencode-cli" });
  console.log(`${stamp()} provider built`);

  try {
    const models = await provider.models();
    console.log(`${stamp()} models: ${models.length} -> ${models.slice(0, 5).map((m) => m.id).join(", ")}`);
  } catch (error) {
    console.log(`${stamp()} MODELS FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    let text = "";
    let thinking = "";
    const events = provider.stream({
      model: "opencode/big-pickle",
      system: "Be brief.",
      messages: [{ role: "user", content: "Say the single word: PONG" }],
      tools: [],
      signal: AbortSignal.timeout(90_000),
    });
    for await (const event of events) {
      if (event.t === "text") text += event.delta;
      else if (event.t === "thinking") thinking += event.delta;
      console.log(`${stamp()} event ${event.t}${event.t === "text" || event.t === "thinking" ? ` ${JSON.stringify(event.delta)}` : ""}`);
    }
    console.log(`${stamp()} TEXT: ${JSON.stringify(text)}`);
    console.log(`${stamp()} THINKING: ${JSON.stringify(thinking.slice(0, 200))}`);
  } catch (error) {
    console.log(`${stamp()} STREAM FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  await provider.close?.();
  console.log(`${stamp()} done`);
}

main().catch((error) => console.log(`FATAL: ${error instanceof Error ? error.stack : String(error)}`));
