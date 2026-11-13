/**
 * Building a provider from an id.
 *
 * The registry resolves "provider/model" refs; this builds the provider
 * behind the id, with the credentials the auth layer finds (the environment
 * first, then auth.json).
 */

import { AuthManager } from "./auth/manager.js";
import { AuthStore } from "./auth/store.js";
import { ProviderError } from "./errors.js";
import { anthropic } from "./providers/anthropic.js";
import { codex } from "./providers/codex.js";
import { gemini } from "./providers/gemini.js";
import { localOpencode } from "./providers/local-opencode.js";
import { openaiCompat } from "./providers/openai-compat.js";
import type { Provider } from "./types.js";

export interface ProviderFactoryOptions {
  /** The environment to read credentials from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the credentials are kept. Defaults to `~/.myagent/auth.json`. */
  store?: AuthStore;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

/** The base URL of each provider that has one. */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  opencode: "https://opencode.ai/zen/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/**
 * Build the provider behind an id.
 *
 * The id is the part before the slash in a "provider/model" ref.
 */
export async function createProvider(
  id: string,
  options: ProviderFactoryOptions = {},
): Promise<Provider> {
  const { env = process.env, store, fetch } = options;
  const auth = new AuthManager({
    ...(store === undefined ? {} : { store }),
    env,
    ...(fetch === undefined ? {} : { fetch }),
  });

  switch (id) {
    case "openai":
    case "opencode":
    case "openrouter": {
      const { token } = await auth.get(id);
      return openaiCompat({
        id,
        baseUrl: PROVIDER_BASE_URLS[id] as string,
        apiKey: token,
        ...(id === "openrouter"
          ? {
              headers: {
                "HTTP-Referer": "https://github.com/lakshyakumar90/cli-agent",
                "X-Title": "cli-agent",
              },
            }
          : {}),
        ...(fetch === undefined ? {} : { fetch }),
      });
    }

    case "anthropic": {
      const { token } = await auth.get("anthropic");
      return anthropic({
        id: "anthropic",
        baseUrl: PROVIDER_BASE_URLS.anthropic as string,
        apiKey: token,
        ...(fetch === undefined ? {} : { fetch }),
      });
    }

    case "gemini": {
      const { token } = await auth.get("gemini");
      return gemini({
        id: "gemini",
        baseUrl: PROVIDER_BASE_URLS.gemini as string,
        apiKey: token,
        ...(fetch === undefined ? {} : { fetch }),
      });
    }

    case "codex": {
      const { token } = await auth.get("codex");
      const accountId = await accountIdOf(store);
      return codex({
        id: "codex",
        accessToken: token,
        ...(accountId === undefined ? {} : { accountId }),
        ...(fetch === undefined ? {} : { fetch }),
      });
    }

    case "opencode-cli":
      // The opencode CLI that is installed and logged in on this machine.
      return localOpencode({ id: "opencode-cli" });

    default:
      throw new ProviderError(
        `no provider called "${id}" — known: ${[
          ...Object.keys(PROVIDER_BASE_URLS),
          "codex",
          "opencode-cli",
        ].join(", ")}`,
        { provider: id, code: "protocol" },
      );
  }
}

/** The ChatGPT account id, when the credential carries one. */
async function accountIdOf(
  store: AuthStore | undefined,
): Promise<string | undefined> {
  try {
    const credential = await (store ?? new AuthStore()).get("codex");
    if (credential === undefined) return undefined;
    const value = (credential as { accountId?: unknown }).accountId;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
