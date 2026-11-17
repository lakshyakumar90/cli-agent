/**
 * The models that can be used.
 *
 * The picker in `/model` shows what the user can actually pick: the
 * providers they hold a credential for, and - for OpenRouter - only the
 * free ones, because a paid model behind a key without credits is a
 * surprise waiting to happen.
 *
 * The list of the free models is asked of OpenRouter itself: it changes
 * from day to day, and writing it down here would only make it wrong.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AuthManager,
  createProvider,
  freeModels,
  isFreeModel,
  modelsForProvider,
  type ModelInfo,
  type Provider,
  type ProviderFactoryOptions,
} from "@cli-agent/ai";

/** One model the user can pick. */
export interface AvailableModel {
  name?: string;
  contextWindow?: number;
  pricing?: ModelInfo["pricing"];
  supportedEfforts?: string[];
  /** The "provider/model" ref. */
  ref: string;
  /** The provider it belongs to. */
  provider: string;
  /** The model id on its own. */
  id: string;
  /** It costs nothing. */
  free: boolean;
}

/** What the user can pick, and what is missing. */
export interface Catalog {
  problems?: Array<{
    provider: string;
    message: string;
    /**
     * Why the provider could not be used.
     *
     * `"missing"` says the program itself is not there; `"unreachable"`
     * says it is there but did not answer. The two need different advice,
     * and telling a user to install a CLI that is already installed is
     * worse than saying nothing.
     */
    kind?: "missing" | "unreachable";
  }>;
  /** The models, grouped by provider. */
  models: AvailableModel[];
  /** The providers there is no credential for. */
  missing: string[];
  /** The providers that need no credential at all. */
  local: string[];
}

/**
 * The free models that suit the work, best first.
 *
 * They are a preference, not a promise: when OpenRouter does not have one
 * of them, the next free model is used.
 */
export const PREFERRED_FREE = [
  "nvidia/nemotron-3.5-lightning:free",
  "inclusionai/ling-3.2-flash:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "baidu/ernie-5.5-flash-preview:free",
];

/** The provider that needs no credential: the CLI on this machine. */
export const LOCAL_PROVIDERS = ["opencode-cli"];

/** The free model to use when nothing else is said. */
export const FALLBACK_FREE_MODEL =
  "openrouter/nvidia/nemotron-3.5-lightning:free";

export interface CatalogOptions {
  signal?: AbortSignal;
  /** The environment to read credentials from. */
  env?: NodeJS.ProcessEnv;
  /** The credentials store. */
  store?: import("@cli-agent/ai").AuthStore;
  /** How the providers are built. */
  factory?: ProviderFactoryOptions;
  /** Providers that are already built, by id. */
  providers?: Map<string, Provider>;
  /**
   * The provider of an id, when the session has one already.
   *
   * A provider that owns a process — the OpenCode CLI drives one — must not
   * be built twice, or the session ends up with two of them.
   */
  providerFor?: (id: string) => Promise<Provider | undefined>;
  /** Where the free model is remembered. */
  rememberPath?: string;
}

/**
 * What the user can pick.
 *
 * It never throws: a provider that cannot be reached or cannot be built
 * is simply not in the list. The providers are asked at the same time —
 * one of them alone can take seconds — and the models keep the order they
 * were asked in.
 */
export async function buildCatalog(
  options: CatalogOptions = {},
): Promise<Catalog> {
  const auth = new AuthManager({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.store === undefined ? {} : { store: options.store }),
  });

  const models: AvailableModel[] = [];
  const missing: string[] = [];
  const local: string[] = [];
  const problems: Catalog["problems"] = [];
  const collect = async (provider: string): Promise<AvailableModel[]> => {
    if (options.signal?.aborted) return [];
    try {
      return await modelsOf(provider, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push({
        provider,
        message,
        // A command that cannot be run at all is missing; anything else
        // reached the program and did not answer.
        kind: isMissingCommand(message) ? "missing" : "unreachable",
      });
      return [];
    }
  };

  // The providers that need a credential, and the CLIs on this machine: they
  // are all asked at once, because one slow provider must not hold the rest
  // of the list back.
  const credentialed = [
    "openrouter",
    "anthropic",
    "openai",
    "gemini",
    "codex",
  ];
  const asked = await Promise.all([
    ...credentialed.map(async (provider) => {
      if (!(await auth.has(provider))) {
        return { provider, missing: true, listed: [] as AvailableModel[] };
      }
      return {
        provider,
        missing: false,
        listed: await collect(provider),
      };
    }),
    ...LOCAL_PROVIDERS.map(async (provider) => ({
      provider,
      missing: false,
      listed: await collect(provider),
    })),
  ]);

  for (const result of asked) {
    if (result.missing) {
      missing.push(result.provider);
      continue;
    }
    if (LOCAL_PROVIDERS.includes(result.provider) && result.listed.length === 0)
      continue;
    if (LOCAL_PROVIDERS.includes(result.provider)) local.push(result.provider);
    models.push(...result.listed);
  }

  for (const [id, provider] of options.factory?.providers ?? []) {
    if (options.signal?.aborted) break;
    try {
      for (const model of await provider.models(options.signal)) {
        if (id === "openrouter" && !isFreeModel(model.id)) continue;
        models.push({
          ...model,
          provider: id,
          ref: `${id}/${model.id}`,
          free: id === "openrouter" && isFreeModel(model.id),
        });
      }
    } catch (error) {
      problems.push({
        provider: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    models: [...new Map(models.map((model) => [model.ref, model])).values()],
    missing,
    local,
    problems,
  };
}

/**
 * Is the program itself not there?
 *
 * The command could not be run at all: it is not on the path, or it is not
 * the program it claims to be. Anything else reached it and did not answer,
 * which is a different problem and needs different advice.
 */
export function isMissingCommand(message: string): boolean {
  return (
    message.includes("cannot run") ||
    message.includes("is not recognized") ||
    message.includes("ENOENT") ||
    message.includes("not found")
  );
}

/** The models one provider can serve. */
async function modelsOf(
  provider: string,
  options: CatalogOptions,
): Promise<AvailableModel[]> {
  // The routers know which of their models are free; the table does not
  // cover them, so they are asked.
  if (provider === "openrouter" || provider === "opencode-cli") {
    const built = await build(provider, options);
    if (built === undefined) return [];

    const listed =
      provider === "openrouter"
        ? (await built.models(options.signal)).filter((model) =>
            isFreeModel(model.id),
          )
        : await built.models(options.signal);

    return listed.map((model) => ({
      name: model.name,
      supportedEfforts: model.supportedEfforts,
      contextWindow: model.contextWindow,
      pricing: model.pricing,
      ref: `${provider}/${model.id}`,
      provider,
      id: model.id,
      free: isFreeModel(model.id),
    }));
  }

  return modelsForProvider(provider).map((model) => ({
    name: model.name,
    supportedEfforts: model.supportedEfforts,
    contextWindow: model.contextWindow,
    pricing: model.pricing,
    ref: `${provider}/${model.id}`,
    provider,
    id: model.id,
    free: false,
  }));
}

/** Build a provider, or nothing when it cannot be built. */
async function build(
  provider: string,
  options: CatalogOptions,
): Promise<Provider | undefined> {
  const already = options.providers?.get(provider);
  if (already !== undefined) return already;

  // The session may already have one: it is asked first, so a provider
  // that owns a process is not built a second time.
  if (options.providerFor !== undefined) {
    try {
      const made = await options.providerFor(provider);
      if (made !== undefined) return made;
    } catch {
      // A provider that cannot be built is simply not in the list.
    }
  }

  try {
    return await createProvider(provider, options.factory ?? {});
  } catch {
    return undefined;
  }
}

/** The models a provider lists, or none when it cannot say. */
async function listModels(provider: Provider): Promise<ModelInfo[]> {
  try {
    return await provider.models();
  } catch {
    return [];
  }
}

/**
 * The free model to use by default.
 *
 * The list is asked of OpenRouter, so the default is one that exists
 * today. It is remembered for an hour: the list does not change from one
 * minute to the next, and a second of waiting at every start is a second
 * of waiting too often.
 */
export async function defaultFreeModel(
  options: CatalogOptions = {},
): Promise<string> {
  const remembered = await readRemembered(options.rememberPath);
  if (remembered !== undefined) return remembered;

  const built = await build("openrouter", options);
  if (built === undefined) return FALLBACK_FREE_MODEL;

  const free = await freeModels(built);
  if (free.length === 0) return FALLBACK_FREE_MODEL;

  const ids = free.map((model) => model.id);

  // The first one that suits the work. The fallback is not used as a
  // marker here: it may well be the one that is preferred.
  let chosen: string | undefined;
  for (const preferred of PREFERRED_FREE) {
    if (ids.includes(preferred)) {
      chosen = `openrouter/${preferred}`;
      break;
    }
  }

  if (chosen === undefined) {
    const first = ids[0];
    chosen = first === undefined ? FALLBACK_FREE_MODEL : `openrouter/${first}`;
  }

  await remember(chosen, options.rememberPath);
  return chosen;
}

/**
 * The free model that was remembered, without asking anybody.
 *
 * The session opens with this one, so that the wait for the list of the
 * router does not stand between the user and the first question.
 */
export async function rememberedFreeModel(
  options: CatalogOptions = {},
): Promise<string | undefined> {
  return readRemembered(options.rememberPath);
}

/** How long the list of free models is remembered. */
const REMEMBER_MS = 60 * 60 * 1000;

/** Where the list is remembered. */
function rememberPath(options?: string): string {
  return options ?? join(homedir(), ".myagent", "free-models.json");
}

/** The model that was remembered, when it is still fresh. */
async function readRemembered(path?: string): Promise<string | undefined> {
  try {
    const raw = await readFile(rememberPath(path), "utf8");
    const parsed = JSON.parse(raw) as { at?: unknown; model?: unknown };

    if (typeof parsed.model !== "string" || parsed.model.length === 0) {
      return undefined;
    }
    if (typeof parsed.at !== "string") return undefined;

    const age = Date.now() - Date.parse(parsed.at);
    if (!Number.isFinite(age) || age > REMEMBER_MS) return undefined;

    return parsed.model;
  } catch {
    return undefined;
  }
}

/** Remember the model, so the next start does not have to wait. */
async function remember(model: string, path?: string): Promise<void> {
  try {
    const where = rememberPath(path);
    await mkdir(dirname(where), { recursive: true });
    await writeFile(
      where,
      `${JSON.stringify({ at: new Date().toISOString(), model })}\n`,
      "utf8",
    );
  } catch {
    // A list that cannot be remembered is a list that is asked for again.
  }
}
