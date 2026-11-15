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
export const FALLBACK_FREE_MODEL = "openrouter/nvidia/nemotron-3.5-lightning:free";

export interface CatalogOptions {
  /** The environment to read credentials from. */
  env?: NodeJS.ProcessEnv;
  /** The credentials store. */
  store?: import("@cli-agent/ai").AuthStore;
  /** How the providers are built. */
  factory?: ProviderFactoryOptions;
}

/**
 * What the user can pick.
 *
 * It never throws: a provider that cannot be reached or cannot be built
 * is simply not in the list.
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

  // The providers that need a credential.
  for (const provider of ["openrouter", "anthropic", "openai", "gemini", "codex"]) {
    if (!(await auth.has(provider))) {
      missing.push(provider);
      continue;
    }

    const listed = await modelsOf(provider, options);
    models.push(...listed);
  }

  // The CLIs on this machine: they are already logged in.
  for (const provider of LOCAL_PROVIDERS) {
    const listed = await modelsOf(provider, options);
    if (listed.length === 0) continue;
    local.push(provider);
    models.push(...listed);
  }

  return { models, missing, local };
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
        ? await freeModels(built)
        : await listModels(built);

    return listed.map((model) => ({
      ref: `${provider}/${model.id}`,
      provider,
      id: model.id,
      free: isFreeModel(model.id),
    }));
  }

  return modelsForProvider(provider).map((model) => ({
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
 * today. When it cannot be reached, the fallback is used.
 */
export async function defaultFreeModel(
  options: CatalogOptions = {},
): Promise<string> {
  const built = await build("openrouter", options);
  if (built === undefined) return FALLBACK_FREE_MODEL;

  const free = await freeModels(built);
  if (free.length === 0) return FALLBACK_FREE_MODEL;

  const ids = free.map((model) => model.id);
  for (const preferred of PREFERRED_FREE) {
    if (ids.includes(preferred)) return `openrouter/${preferred}`;
  }

  const first = ids[0];
  return first === undefined ? FALLBACK_FREE_MODEL : `openrouter/${first}`;
}
