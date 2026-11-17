/**
 * Live smoke test: stream from every provider you have credentials for.
 *
 * The credentials come from the environment first, then from the store the
 * agent keeps (`~/.myagent/auth.json`), then from the CLIs already logged
 * in on this machine:
 *
 * - codex    — `CODEX_ACCESS_TOKEN` (+ `CODEX_ACCOUNT_ID`), else the Codex
 *              CLI's own login in `~/.codex/auth.json`, imported (and
 *              refreshed, with the rotated token written back) by the auth
 *              layer;
 * - opencode — the opencode CLI installed on this machine, driven as a
 *              provider. Its Zen API refuses the session the CLI holds, so
 *              the CLI itself is the backend;
 * - openrouter — `OPENROUTER_API_KEY`;
 * - gemini   — `GEMINI_API_KEY`.
 *
 * Every provider goes through the same loop, so a difference in the output is
 * a difference in the provider, not in the code.
 *
 * Run: pnpm --filter @cli-agent/ai smoke:live
 * API keys are read from the environment; nothing is written to the repo.
 */

import { createProvider, estimateCost, ProviderRegistry } from "../src/index.js";
import type { Provider } from "../src/types.js";

// ---------------------------------------------------------------------------
// The providers to try
// ---------------------------------------------------------------------------

interface Target {
  id: string;
  label: string;
  provider: Provider;
  credential: string;
  extra?: string;
}

/** The providers that need a key, and the one that needs none. */
const CANDIDATES: Array<{
  id: string;
  label: string;
  env?: string[];
  /** The provider needs no credential at all. */
  local?: boolean;
}> = [
  { id: "openrouter", label: "openrouter", env: ["OPENROUTER_API_KEY"] },
  { id: "gemini", label: "gemini", env: ["GEMINI_API_KEY"] },
  { id: "codex", label: "codex", env: ["CODEX_ACCESS_TOKEN"] },
  { id: "opencode-cli", label: "opencode (local CLI)", local: true },
];

/** The models to try, when the provider does not say which it has. */
const FALLBACK_MODELS: Record<string, string[]> = {
  openrouter: ["nvidia/nemotron-3.5-lightning:free"],
  gemini: ["gemini-3.1-flash-lite", "gemini-2.5-flash"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6.1-terra"],
  "opencode-cli": ["opencode/big-pickle", "opencode/beam-free"],
};

/** Model ids that are not chat models (images, audio, embeddings, agents). */
const NOT_CHAT = /(-image|-tts|-live|-transcribe|-embedding|-omni|-nano|deep-research|antigravity-preview)/;

/** The models of a provider that are worth trying, best first. */
function pickModels(provider: string, reported: string[]): string[] {
  const preferred = FALLBACK_MODELS[provider] ?? [];
  const chosen = preferred.filter((model) => reported.includes(model));
  const rest = reported
    .filter((model) => !chosen.includes(model))
    .filter((model) => (provider === "gemini" ? /^gemini-/.test(model) : true))
    .filter((model) => !NOT_CHAT.test(model))
    .sort();

  // OpenRouter marks free models with ":free", OpenCode Zen with "-free".
  // They answer even when the account has no credits or the free quota is
  // spent on other models.
  const isFree = (model: string): boolean =>
    model.endsWith(":free") || model.endsWith("-free");
  const free = rest.filter(isFree);
  const paid = rest.filter((model) => !isFree(model));

  return [...chosen, ...free, ...paid].slice(0, 6);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const registry = new ProviderRegistry();
const targets: Target[] = [];

for (const candidate of CANDIDATES) {
  try {
    const provider = await createProvider(candidate.id);
    const credential = candidate.local
      ? "the CLI on this machine"
      : (candidate.env ?? []).find((name) => process.env[name] !== undefined) ??
        "the stored credential";
    targets.push({
      id: candidate.id,
      label: candidate.label,
      provider,
      credential,
    });
  } catch (error) {
    console.log(`=== ${candidate.label} ===`);
    console.log(`   skipped: ${describe(error)}`);
    console.log("");
  }
}

if (targets.length === 0) {
  console.log(
    "No credentials found. Set OPENROUTER_API_KEY / GEMINI_API_KEY /\n" +
      "OPENCODE_API_KEY / CODEX_ACCESS_TOKEN, or log in with the Codex and\n" +
      "opencode CLIs.",
  );
  process.exit(1);
}

console.log(`live smoke test — ${targets.length} provider(s) with credentials\n`);

let failures = 0;
let quotaLimited = 0;

for (const target of targets) {
  registry.register(target.provider, { replace: true });

  console.log(`=== ${target.label} ===`);
  console.log(`   credential: ${target.credential}${target.extra ? ` (${target.extra})` : ""}`);

  let reported: string[] = [];
  try {
    const models = await target.provider.models();
    reported = models.map((model) => model.id);
    console.log(
      `   catalog: ${reported.length} model(s)${
        reported.length > 0 ? ` — e.g. ${reported.slice(0, 3).join(", ")}` : ""
      }`,
    );
  } catch (error) {
    console.log(`   catalog: unavailable (${describe(error)})`);
  }

  const candidates =
    pickModels(target.id, reported).length > 0
      ? pickModels(target.id, reported)
      : (FALLBACK_MODELS[target.id] ?? []);
  if (candidates.length === 0) {
    console.log("   SKIP: no model to try\n");
    failures += 1;
    continue;
  }

  let worked = false;
  let hardError = false;
  let hitLimit = false;

  for (const model of candidates) {
    try {
      // 503 means the provider is busy, not that the request was wrong.
      const result = await withRetry(() => runStream(registry, target.id, model));
      console.log(`   model: ${model}`);
      console.log(`   text: ${result.text}`);
      console.log(
        `   usage: ${result.usage?.inputTokens ?? 0} in / ${result.usage?.outputTokens ?? 0} out` +
          (result.cost === undefined ? "" : ` · est. $${result.cost.toFixed(6)}`),
      );
      worked = true;
      break;
    } catch (error) {
      const status = statusOf(error);
      // 402/429 are account limits (no credits, no quota), not adapter bugs.
      const isLimit = status === 402 || status === 429;
      console.log(
        `   model ${model}: ${isLimit ? "account limit" : "FAILED"} — ${describe(error)}`,
      );
      if (isLimit) hitLimit = true;
      else hardError = true;
    }
  }

  if (!worked) {
    if (hitLimit && !hardError) {
      console.log(
        "   -> the account is out of quota/credits; the request reached the provider.",
      );
      quotaLimited += 1;
    } else {
      failures += 1;
    }
  }
  // A provider that owns a process lets it go: nothing outlives the run.
  await target.provider.close?.().catch(() => undefined);
  console.log("");
}

console.log(
  failures === 0
    ? quotaLimited === 0
      ? "all providers answered."
      : `all providers answered (${quotaLimited} out of quota).`
    : `${failures} provider(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** Retry once on a busy-provider error. */
async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!/HTTP 503|high demand|overloaded/i.test(describe(error))) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    return run();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface StreamResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  cost?: number;
}

async function runStream(
  reg: ProviderRegistry,
  providerId: string,
  model: string,
): Promise<StreamResult> {
  let text = "";
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let thinking = "";

  for await (const event of reg.stream(`${providerId}/${model}`, {
    system: "You are a smoke test. Reply with one short sentence.",
    messages: [{ role: "user", content: "Say hello in one short sentence." }],
    // A stalled provider must not hang the whole run.
    signal: AbortSignal.timeout(120_000),
  })) {
    if (event.t === "text") text += event.delta;
    if (event.t === "thinking") thinking += event.delta;
    if (event.t === "done") usage = event.usage;
  }

  const info = reg.model(`${providerId}/${model}`);
  const cost =
    info !== undefined && usage !== undefined
      ? estimateCost(usage, info)
      : undefined;

  return {
    text: text.length > 0 ? text : thinking.length > 0 ? `(thinking only) ${thinking}` : "(no text)",
    ...(usage === undefined ? {} : { usage }),
    ...(cost === undefined ? {} : { cost }),
  };
}
