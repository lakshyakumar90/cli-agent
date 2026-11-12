/**
 * Google Antigravity (Cloud Code Assist) provider.
 *
 * Antigravity and the Gemini CLI talk to the same private backend, and its wire
 * format is the Gemini one: `contents`, `parts`, `functionCall`, SSE chunks.
 * Only three things differ, all of them confined to this file:
 *
 * - the endpoint is `cloudcode-pa.googleapis.com/v1internal`, not
 *   `generativelanguage.googleapis.com`;
 * - auth is an OAuth bearer token from a Google sign-in, not an API key;
 * - the model travels in the body (`{ model, project?, request }`), and every
 *   stream chunk arrives wrapped in `{ response: … }`.
 *
 * Token storage, refresh and the PKCE flow live in the auth layer; this adapter
 * only needs a (fresh) access token. Create a new provider if the token rotates,
 * or pass a getter through `loadAccessToken` when that layer lands.
 */

import { ProviderError } from "../errors.js";
import type { ModelInfo, Provider } from "../types.js";
import { createGeminiProvider } from "./gemini.js";

export const ANTIGRAVITY_BASE_URL =
  "https://cloudcode-pa.googleapis.com/v1internal";

export interface AntigravityOptions {
  /** Provider id used in `"provider/model"` refs. Defaults to `"antigravity"`. */
  id?: string;
  /** Defaults to `"https://cloudcode-pa.googleapis.com/v1internal"`. */
  baseUrl?: string;
  /** OAuth access token. Without one the backend answers 401. */
  accessToken?: string;
  /**
   * Google Cloud project id the subscription is attached to. `discoverProject()`
   * can fetch it from `loadCodeAssist`.
   */
  project?: string;
  /** Extra headers merged last. */
  headers?: Record<string, string>;
  /** Merged into `generationConfig` (`temperature`, `thinkingConfig`, …). */
  generation?: Record<string, unknown>;
  /** Static metadata merged over `fetchAvailableModels` results. */
  modelInfo?: Record<string, Partial<ModelInfo>>;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export function antigravity(options: AntigravityOptions = {}): Provider {
  const {
    id = "antigravity",
    baseUrl = ANTIGRAVITY_BASE_URL,
    accessToken,
    project,
    headers = {},
    generation,
    modelInfo,
    fetch,
  } = options;

  return createGeminiProvider({
    id,
    baseUrl,
    wire: "cloudcode",
    auth: "bearer",
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(project === undefined ? {} : { project }),
    ...(generation === undefined ? {} : { generation }),
    ...(modelInfo === undefined ? {} : { modelInfo }),
    ...(fetch === undefined ? {} : { fetch }),
    headers,
  });
}

/**
 * Fetch the Cloud project and tier attached to this Google account.
 *
 * `loadCodeAssist` is also the cheapest way to tell a usable token from an
 * expired one, so the auth flow can use it as a probe.
 */
export async function discoverProject(options: {
  baseUrl?: string;
  accessToken: string;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}): Promise<{ project?: string; tier?: string }> {
  const {
    baseUrl = ANTIGRAVITY_BASE_URL,
    accessToken,
    headers = {},
    fetch: doFetch = globalThis.fetch,
  } = options;

  const root = baseUrl.replace(/\/+$/, "");
  let response: Response;
  try {
    response = await doFetch(`${root}:loadCodeAssist`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
        ...headers,
      },
      body: JSON.stringify({
        metadata: { pluginType: "GEMINI" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderError(`antigravity: request failed — ${message}`, {
      provider: "antigravity",
      code: "network",
      cause: error,
    });
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // The status is still actionable without the body.
    }
    throw new ProviderError(
      `antigravity: HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`,
      {
        provider: "antigravity",
        code: "http",
        status: response.status,
        body: body.slice(0, 2_000),
      },
    );
  }

  const payload = (await response.json()) as {
    cloudaicompanionProject?: unknown;
    allowedTiers?: Array<{ id?: unknown; name?: unknown; isDefault?: unknown }>;
  };

  const project =
    typeof payload.cloudaicompanionProject === "string"
      ? payload.cloudaicompanionProject
      : undefined;
  const tiers = Array.isArray(payload.allowedTiers)
    ? payload.allowedTiers
    : [];
  const preferred = tiers.find((tier) => tier.isDefault === true) ?? tiers[0];
  const tier =
    typeof preferred?.name === "string"
      ? preferred.name
      : typeof preferred?.id === "string"
        ? preferred.id
        : undefined;

  return {
    ...(project === undefined ? {} : { project }),
    ...(tier === undefined ? {} : { tier }),
  };
}