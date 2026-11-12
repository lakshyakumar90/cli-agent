/**
 * Per-provider auth policy.
 *
 * Two kinds of provider:
 *
 * - API-key providers (OpenAI, Anthropic, Gemini, OpenCode Zen, local servers):
 *   the key is read from an environment variable first, then from `auth.json`.
 * - Subscription providers (Codex, Antigravity): they only accept OAuth bearer
 *   tokens, so they have an OAuth preset instead of an env key. A pre-issued
 *   access token can still be supplied through an env var for scripting.
 *
 * OAuth presets deliberately do **not** ship a client id. A subscription login
 * reuses the vendor product's own OAuth client, which is a third-party use of
 * that client: whether it is permitted is decided by the vendor's terms, not by
 * this code. Bring your own registered client id through the environment (or
 * `oauth.clientId`) after checking the terms; official API keys remain the safe
 * default. Gemini, for example, is fully usable with `GEMINI_API_KEY`.
 */

export interface OAuthPreset {
  /** Shown in prompts and status output. */
  label: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Client id value, when the caller supplied one. */
  clientId?: string;
  /** Client secret value, for providers that require a confidential client. */
  clientSecret?: string;
  /** Env var holding the client id, when `clientId` is absent. */
  clientIdEnv?: string;
  /** Env var holding the client secret, when `clientSecret` is absent. */
  clientSecretEnv?: string;
  /** Extra authorize-URL parameters (`access_type=offline`, …). */
  authorizeParams?: Record<string, string>;
  /** Extra token-request parameters (`audience`, …). */
  tokenParams?: Record<string, string>;
}

export interface ProviderAuthSpec {
  /** Env vars that may hold an API key, checked in order. */
  env?: string[];
  /** Env vars that may hold a pre-issued OAuth access token. */
  oauthEnv?: string[];
  oauth?: OAuthPreset;
}

export const CODEX_OAUTH: OAuthPreset = {
  label: "ChatGPT (Codex)",
  authorizationUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  // `offline_access` is what asks for a refresh token.
  scopes: ["openid", "profile", "email", "offline_access"],
  clientIdEnv: "MYAGENT_CODEX_CLIENT_ID",
  authorizeParams: {
    // Codex's flow pops the consent screen; keep the same shape.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  },
};

export const GOOGLE_OAUTH: OAuthPreset = {
  label: "Google (Antigravity)",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  scopes: [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/cloud-platform",
  ],
  clientIdEnv: "MYAGENT_GOOGLE_CLIENT_ID",
  clientSecretEnv: "MYAGENT_GOOGLE_CLIENT_SECRET",
  authorizeParams: {
    // Without these Google issues no refresh token on a repeat consent.
    access_type: "offline",
    prompt: "consent",
  },
};

/** Built-in policy, keyed by provider id. Unknown ids derive an env var name. */
export const AUTH_SPECS: Record<string, ProviderAuthSpec> = {
  openai: { env: ["OPENAI_API_KEY"] },
  anthropic: { env: ["ANTHROPIC_API_KEY"] },
  gemini: { env: ["GEMINI_API_KEY"] },
  opencode: { env: ["OPENCODE_API_KEY"] },
  codex: {
    oauthEnv: ["CODEX_ACCESS_TOKEN"],
    oauth: CODEX_OAUTH,
  },
  antigravity: {
    oauthEnv: ["ANTIGRAVITY_ACCESS_TOKEN"],
    oauth: GOOGLE_OAUTH,
  },
};

/** `"my-provider"` -> `"MY_PROVIDER_API_KEY"`. */
export function defaultEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/** Built-in spec merged with caller overrides; unknown providers get the default. */
export function resolveAuthSpec(
  provider: string,
  overrides: Record<string, ProviderAuthSpec> = {},
): ProviderAuthSpec {
  const base = AUTH_SPECS[provider] ?? { env: [defaultEnvVar(provider)] };
  const override = overrides[provider];
  if (override === undefined) return base;

  // Per-field merge, so an override can add just a client id without having to
  // repeat the endpoints and scopes.
  const oauth =
    base.oauth === undefined
      ? override.oauth
      : { ...base.oauth, ...override.oauth };

  return {
    ...base,
    ...override,
    ...(oauth === undefined ? {} : { oauth }),
  };
}