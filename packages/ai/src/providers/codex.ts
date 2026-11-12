/**
 * OpenAI Codex provider.
 *
 * This is the backend the Codex CLI itself talks to: a ChatGPT subscription
 * endpoint, not the public API. It speaks the Responses wire format, so the
 * whole translation lives in `responses.ts`; only four things differ here:
 *
 * - the base URL (`chatgpt.com/backend-api/codex`), which also means the path is
 *   `/responses` rather than `/v1/responses`;
 * - auth is a ChatGPT OAuth access token, plus the account id header the backend
 *   routes on;
 * - `originator` identifies the client, and the CLI sends `codex_cli_rs`;
 * - there is no usable model list: the Codex catalog is a different shape from
 *   the public `/v1/models`, so models come from the static table below (merged
 *   with whatever the caller passes).
 *
 * Token refresh lives in the auth layer; this adapter takes a fresh token.
 */

import type { ModelInfo, Provider } from "../types.js";
import { openaiResponses, type ResponsesOptions } from "./responses.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_ORIGINATOR = "codex_cli_rs";

/**
 * Wire ids Codex currently serves. Context windows come from the CLI's own
 * fallback metadata; pricing is subscription-based, so it is left unset (the
 * model table in @cli-agent/core can add it if a budget needs one).
 */
const CODEX_MODELS: Record<string, Partial<ModelInfo>> = {
  "gpt-5.5": {
    name: "GPT-5.5 (Codex)",
    contextWindow: 272_000,
    supports: { tools: true, reasoning: true },
  },
  "gpt-5.5-codex": {
    name: "GPT-5.5 Codex",
    contextWindow: 272_000,
    supports: { tools: true, reasoning: true },
  },
};

export interface CodexOptions {
  /** Provider id used in `"provider/model"` refs. Defaults to `"codex"`. */
  id?: string;
  /** ChatGPT OAuth access token. Without one the backend answers 401. */
  accessToken?: string;
  /** Account id from the token's claims; the backend requires it. */
  accountId?: string;
  /** Client name sent as `originator`. Defaults to `"codex_cli_rs"`. */
  originator?: string;
  /** Defaults to `"https://chatgpt.com/backend-api/codex"`. */
  baseUrl?: string;
  /** Extra headers merged last. */
  headers?: Record<string, string>;
  /** Reasoning effort (`"low"` … `"xhigh"`). */
  reasoningEffort?: string;
  /** Ask for encrypted reasoning so it can be replayed locally. Defaults to true. */
  includeEncryptedReasoning?: boolean;
  /** Merged into every request body. */
  body?: Record<string, unknown>;
  /** Static model metadata, merged over the built-in table. */
  modelInfo?: Record<string, Partial<ModelInfo>>;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export function codex(options: CodexOptions = {}): Provider {
  const {
    id = "codex",
    accessToken,
    accountId,
    originator = CODEX_ORIGINATOR,
    baseUrl = CODEX_BASE_URL,
    headers = {},
    reasoningEffort,
    includeEncryptedReasoning = true,
    body,
    modelInfo,
    fetch,
  } = options;

  // Per-model merge, so overriding e.g. the display name keeps the built-in
  // context window.
  const models: Record<string, Partial<ModelInfo>> = { ...CODEX_MODELS };
  for (const [modelId, info] of Object.entries(modelInfo ?? {})) {
    models[modelId] = { ...models[modelId], ...info };
  }

  const responses: ResponsesOptions = {
    id,
    baseUrl,
    ...(accessToken === undefined ? {} : { accessToken }),
    headers: {
      ...(accountId === undefined
        ? {}
        : { "chatgpt-account-id": accountId }),
      originator,
      ...headers,
    },
    // Codex never stores responses server-side; the CLI replays its own session.
    store: false,
    modelsMode: "overrides",
    modelInfo: models,
    includeEncryptedReasoning,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(body === undefined ? {} : { body }),
    ...(fetch === undefined ? {} : { fetch }),
  };

  return openaiResponses(responses);
}