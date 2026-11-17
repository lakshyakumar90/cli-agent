import { localOpencode } from "../packages/ai/src/providers/local-opencode.js";

const out = (...a: unknown[]) => console.log("[diag]", ...a);

async function main() {
  const p = localOpencode({ id: "opencode-cli" });
  out("=== models() ===");
  try {
    const models = await p.models();
    out("models OK:", models.length, models.slice(0, 3).map((m) => m.id));
  } catch (e) {
    out("models FAILED:", e instanceof Error ? e.message : String(e));
  }

  out("=== stream() ===");
  try {
    const events: string[] = [];
    for await (const ev of p.stream({
      model: "opencode/big-pickle",
      system: "Reply with exactly: PONG",
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      tools: [],
      signal: AbortSignal.timeout(90_000),
    })) {
      events.push(ev.t === "text" || ev.t === "thinking" ? `${ev.t}:${ev.delta}` : JSON.stringify(ev));
    }
    out("stream events:", events.slice(0, 20).join(" | "));
  } catch (e) {
    out("stream FAILED:", e instanceof Error ? e.message : String(e));
  }
  await p.close?.();
  out("=== done ===");
}
main().catch((e) => out("fatal", e));
