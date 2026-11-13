/**
 * Live smoke test: stream from every provider you have credentials for.
 *
 * Credentials come from the environment first, then from the CLIs already
 * logged in on this machine:
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

import { importCodexCliAuth } from "../src/auth/cli-import.js";
import { AuthStore } from "../src/auth/store.js";
import { estimateCost } from "../src/models.js";
import { codex } from "../src/providers/codex.js";
import { gemini } from "../src/providers/gemini.js";
import { localOpencode } from "../src/providers/local-opencode.js";
import { openaiCompat } from "../src/providers/openai-compat.js";
import { ProviderRegistry } from "../src/registry.js";
import type { Provider } from "../src/types.js";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface CodexCredential {
  accessToken: string;
  accountId?: string;
  /** Where it came from, for the report. */
  source: string;
  /** True when the access token was renewed with the refresh token. */
  refreshed: boolean;
}

async function codexCredential(): Promise<CodexCredential | undefined> {
  const envToken = process.env.CODEX_ACCESS_TOKEN?.trim();
  if (envToken !== undefined && envToken.length > 0) {
    const accountId = process.env.CODEX_ACCOUNT_ID?.trim();
    return {
      accessToken: envToken,
      ...(accountId === undefined ? {} : { accountId }),
      source: "CODEX_ACCESS_TOKEN",
      refreshed: false,
    };
  }

  // The Codex CLI's own login. Importing it refreshes the token when it has
  // expired and writes the rotated token back, so the CLI keeps working.
  try {
    const imported = await importCodexCliAuth({ store: new AuthStore() });
    return {
      accessToken: imported.access,
      ...(imported.accountId === undefined ? {} : { accountId: imported.accountId }),
      source: imported.refreshed
        ? "~/.codex/auth.json (refreshed)"
        : "~/.codex/auth.json",
      refreshed: imported.refreshed,
    };
  } catch (error) {
    console.log(`   (codex: ${describe(error)})`);
    return undefined;
  }
}

interface OpencodeCredential {
  token: string;
  server: string;
  source: string;
}

async function opencodeCredential(): Promise<OpencodeCredential | undefined> {
  const envKey = process.env.OPENCODE_API_KEY?.trim();
  if (envKey !== undefined && envKey.length > 0) {
    return {
      token: envKey,
      server: "https://opencode.ai/zen/v1",
      source: "OPENCODE_API_KEY",
    };
  }

  return undefined;
}

function envCredential(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Model choice
// ---------------------------------------------------------------------------

/** Preferred models per provider, most wanted first. */
const PREFERRED: Record<string, string[]> = {
  gemini: ["gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-3.8-flash"],
  codex: ["gpt-6.1-sol", "gpt-6-sol", "gpt-6.1-terra"],
  openrouter: [],
  opencode: ["opencode/big-pickle", "opencode/glm-5.3-flash-free"],
};

/** Model ids that are not chat models (images, audio, embeddings, agents). */
const NOT_CHAT = /(-image|-tts|-live|-transcribe|-embedding|-omni|-nano|deep-research|antigravity-preview)/;

function pickModels(provider: string, reported: string[]): string[] {
  const preferred = PREFERRED[provider] ?? [];
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

interface Target {
  id: string;
  label: string;
  provider: Provider;
  credential: string;
  extra?: string;
}

const registry = new ProviderRegistry();
const targets: Target[] = [];

const codexAuth = await codexCredential();
if (codexAuth !== undefined) {
  targets.push({
    id: "codex",
    label: "codex",
    provider: codex({
      id: "codex",
      accessToken: codexAuth.accessToken,
      ...(codexAuth.accountId === undefined
        ? {}
        : { accountId: codexAuth.accountId }),
    }),
    credential: codexAuth.source,
    ...(codexAuth.accountId === undefined
      ? {}
      : { extra: `account ${codexAuth.accountId}` }),
  });
}

const opencodeAuth = await opencodeCredential();
if (opencodeAuth !== undefined) {
  targets.push({
    id: "opencode",
    label: "opencode",
    provider: openaiCompat({
      id: "opencode",
      baseUrl: opencodeAuth.server,
      apiKey: opencodeAuth.token,
    }),
    credential: opencodeAuth.source,
  });
} else {
  // No API key: drive the opencode CLI that is installed and logged in on
  // this machine. It carries its own session, which the Zen API does not
  // accept from outside.
  targets.push({
    id: "opencode",
    label: "opencode (local CLI)",
    provider: localOpencode({ id: "opencode" }),
    credential: "local opencode CLI",
  });
}

const openrouterKey = envCredential("OPENROUTER_API_KEY");
if (openrouterKey !== undefined) {
  targets.push({
    id: "openrouter",
    label: "openrouter",
    provider: openaiCompat({
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      headers: {
        "HTTP-Referer": "https://github.com/lakshya/cli-agent",
        "X-Title": "cli-agent",
      },
    }),
    credential: "OPENROUTER_API_KEY",
  });
}

const geminiKey = envCredential("GEMINI_API_KEY");
if (geminiKey !== undefined) {
  targets.push({
    id: "gemini",
    label: "gemini",
    provider: gemini({ id: "gemini", apiKey: geminiKey }),
    credential: "GEMINI_API_KEY",
  });
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
    console.log(`   catalog: ${reported.length} model(s)${reported.length > 0 ? ` — e.g. ${reported.slice(0, 3).join(", ")}` : ""}`);
  } catch (error) {
    console.log(`   catalog: unavailable (${describe(error)})`);
  }

  const candidates = pickModels(target.id, reported);
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
    signal: AbortSignal.timeout(60_000),
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

