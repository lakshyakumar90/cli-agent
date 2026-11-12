/**
 * Credential resolution and the interactive OAuth login.
 *
 * `get()` is the only call the rest of the app needs: it checks the environment
 * first, then `auth.json`, and transparently refreshes an expiring OAuth token.
 * `refreshOnUnauthorized()` covers the other half of the contract — a token can
 * be revoked before its `expires` timestamp, so a 401 triggers one refresh and
 * one retry at the call site.
 */

import { AuthError } from "./errors.js";
import { openBrowser } from "./browser.js";
import { startLoopbackServer } from "./loopback.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  type OAuthToken,
} from "./oauth.js";
import { pkcePair, randomState } from "./pkce.js";
import { resolveAuthSpec, type OAuthPreset, type ProviderAuthSpec } from "./specs.js";
import { AuthStore, type AuthStoreOptions } from "./store.js";
import type { Credential, OAuthCredential, ResolvedAuth } from "./types.js";

/** Renew this long before `expires`, so a request cannot race the clock. */
const DEFAULT_REFRESH_SKEW_SECONDS = 60;

export interface AuthManagerOptions {
  store?: AuthStore;
  /** Directory for `auth.json`; see `AuthStore`. */
  authStore?: AuthStoreOptions;
  /** Environment consulted before the store. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  refreshSkewSeconds?: number;
  /** Per-provider policy, merged over the built-in table. */
  providers?: Record<string, ProviderAuthSpec>;
}

export interface LoginOptions {
  /** Merge over the provider's preset, e.g. `{ clientId: "..." }`. */
  oauth?: Partial<OAuthPreset>;
  /**
   * Receives the authorize URL and the loopback redirect URI. Use it to print a
   * link on headless machines. When omitted, a browser is opened.
   */
  onUrl?: (url: string, redirectUri: string) => void | Promise<void>;
  /** Set false to never open a browser. Ignored when `onUrl` is given. */
  open?: boolean;
  /** How long to wait for the callback. Defaults to 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class AuthManager {
  readonly store: AuthStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly providers: Record<string, ProviderAuthSpec>;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly skew: number;

  constructor(options: AuthManagerOptions = {}) {
    const {
      store,
      authStore,
      env = process.env,
      fetch: doFetch = globalThis.fetch,
      now = Date.now,
      refreshSkewSeconds = DEFAULT_REFRESH_SKEW_SECONDS,
      providers = {},
    } = options;
    this.store = store ?? new AuthStore(authStore ?? { env });
    this.env = env;
    this.providers = providers;
    this.doFetch = doFetch;
    this.clock = now;
    this.skew = refreshSkewSeconds;
  }

  /**
   * A usable token for `provider`: env first, then the store, refreshing an
   * OAuth token that is expired or about to expire.
   */
  async get(provider: string): Promise<ResolvedAuth> {
    const spec = this.spec(provider);

    const fromEnv = this.envCredential(provider, spec);
    if (fromEnv !== undefined) return fromEnv;

    const stored = await this.store.get(provider);
    if (stored === undefined) throw this.missing(provider, spec);

    if (stored.type === "key") {
      return {
        provider,
        type: "key",
        token: stored.key,
        source: "store",
      };
    }

    const expires = typeof stored.expires === "number" ? stored.expires : undefined;
    if (!this.needsRefresh(expires)) {
      return {
        provider,
        type: "oauth",
        token: stored.access,
        source: "store",
        ...(expires === undefined ? {} : { expires }),
      };
    }

    if (stored.refresh === undefined) {
      if (this.isExpired(expires)) {
        throw new AuthError(
          `auth: the ${provider} access token expired and there is no refresh token — run \`agent login ${provider}\``,
          { code: "oauth", provider },
        );
      }
      // Still valid for a few more seconds; let the request try.
      return {
        provider,
        type: "oauth",
        token: stored.access,
        source: "store",
        ...(expires === undefined ? {} : { expires }),
      };
    }

    return this.refresh(provider);
  }

  /**
   * Authorization-code + PKCE, with a temporary localhost listener. The refresh
   * token (when the provider issues one) is stored, so later runs never prompt.
   */
  async login(provider: string, options: LoginOptions = {}): Promise<ResolvedAuth> {
    const { oauth, onUrl, open = true, timeoutMs, signal } = options;

    const base = this.spec(provider).oauth;
    if (base === undefined) {
      throw new AuthError(
        `auth: "${provider}" has no OAuth flow — set an API key instead`,
        { code: "config", provider },
      );
    }
    const preset: OAuthPreset = { ...base, ...oauth };
    const clientId = this.requireClientId(provider, preset);

    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const server = await startLoopbackServer({
      state,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });

    try {
      const url = buildAuthorizeUrl({
        authorizationUrl: preset.authorizationUrl,
        clientId,
        redirectUri: server.redirectUri,
        state,
        codeChallenge: challenge,
        scopes: preset.scopes,
        ...(preset.authorizeParams === undefined
          ? {}
          : { params: preset.authorizeParams }),
      });

      if (onUrl !== undefined) {
        await onUrl(url, server.redirectUri);
      } else if (open) {
        openBrowser(url);
      }

      const code = await server.waitForCode();
      const clientSecret = this.clientSecret(preset);
      const token = await exchangeCode({
        tokenUrl: preset.tokenUrl,
        code,
        redirectUri: server.redirectUri,
        clientId,
        codeVerifier: verifier,
        ...(clientSecret === undefined ? {} : { clientSecret }),
        ...(preset.tokenParams === undefined
          ? {}
          : { extraParams: preset.tokenParams }),
        fetch: this.doFetch,
        now: this.clock,
        ...(signal === undefined ? {} : { signal }),
      });

      return await this.persist(provider, token, "store");
    } finally {
      await server.close();
    }
  }

  /**
   * Force a refresh using the stored refresh token. Throws when the provider has
   * no refresh token, which is the signal to run `login` again.
   */
  async refresh(
    provider: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ResolvedAuth> {
    const { signal } = options;
    const stored = await this.store.get(provider);
    if (stored?.type !== "oauth") {
      throw new AuthError(
        `auth: "${provider}" has no OAuth credential to refresh`,
        { code: "config", provider },
      );
    }
    if (stored.refresh === undefined || stored.refresh.length === 0) {
      throw new AuthError(
        `auth: "${provider}" has no refresh token — run \`agent login ${provider}\``,
        { code: "oauth", provider },
      );
    }

    const preset = this.requirePreset(provider);
    const clientSecret = this.clientSecret(preset);
    const token = await refreshAccessToken({
      tokenUrl: preset.tokenUrl,
      refreshToken: stored.refresh,
      clientId: this.requireClientId(provider, preset),
      ...(clientSecret === undefined ? {} : { clientSecret }),
      ...(preset.tokenParams === undefined
        ? {}
        : { extraParams: preset.tokenParams }),
      fetch: this.doFetch,
      now: this.clock,
      ...(signal === undefined ? {} : { signal }),
    });

    return this.persist(provider, token, "refreshed", stored);
  }

  /**
   * Retry hook for the provider layer: returns true when a 401 was handled by
   * refreshing, so the caller can run the same request once more. Any other
   * failure returns false and is left to the caller.
   */
  async refreshOnUnauthorized(
    provider: string,
    error: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<boolean> {
    if (!isUnauthorized(error)) return false;

    const stored = await this.store.get(provider);
    if (stored?.type !== "oauth" || stored.refresh === undefined) return false;

    await this.refresh(provider, options);
    return true;
  }

  /** Store a credential directly (`agent auth set`, tests, migrations). */
  async set(provider: string, credential: Credential): Promise<void> {
    await this.store.set(provider, credential);
  }

  async logout(provider: string): Promise<void> {
    await this.store.delete(provider);
  }

  private async persist(
    provider: string,
    token: OAuthToken,
    source: ResolvedAuth["source"],
    previous?: OAuthCredential,
  ): Promise<ResolvedAuth> {
    const refresh = token.refresh ?? previous?.refresh;
    // Do not carry the old expiry forward: if the server omits `expires_in` the
    // stale timestamp would be in the past and every `get()` would refresh in a
    // loop. Without an expiry the token is used until a 401 says otherwise.
    const expires = token.expires;

    // Keep provider-specific extras (account ids, scope) but never stale token
    // fields from the previous credential.
    const extras: Record<string, unknown> = { ...previous };
    for (const key of ["type", "access", "refresh", "expires"]) delete extras[key];

    const credential: OAuthCredential = {
      ...extras,
      type: "oauth",
      access: token.access,
      ...(refresh === undefined ? {} : { refresh }),
      ...(expires === undefined ? {} : { expires }),
      ...(token.tokenType === undefined ? {} : { tokenType: token.tokenType }),
      ...(token.scope === undefined ? {} : { scope: token.scope }),
    };
    await this.store.set(provider, credential);

    return {
      provider,
      type: "oauth",
      token: token.access,
      source,
      ...(expires === undefined ? {} : { expires }),
    };
  }

  private spec(provider: string): ProviderAuthSpec {
    return resolveAuthSpec(provider, this.providers);
  }

  private envCredential(
    provider: string,
    spec: ProviderAuthSpec,
  ): ResolvedAuth | undefined {
    for (const name of spec.env ?? []) {
      const value = this.env[name]?.trim();
      if (value !== undefined && value.length > 0) {
        return { provider, type: "key", token: value, source: "env" };
      }
    }
    for (const name of spec.oauthEnv ?? []) {
      const value = this.env[name]?.trim();
      if (value !== undefined && value.length > 0) {
        return { provider, type: "oauth", token: value, source: "env" };
      }
    }
    return undefined;
  }

  private needsRefresh(expires: number | undefined): boolean {
    if (expires === undefined) return false;
    return expires - this.nowSeconds() <= this.skew;
  }

  private isExpired(expires: number | undefined): boolean {
    return expires !== undefined && expires <= this.nowSeconds();
  }

  private nowSeconds(): number {
    return Math.floor(this.clock() / 1000);
  }

  private missing(provider: string, spec: ProviderAuthSpec): AuthError {
    const ways: string[] = [];
    for (const name of spec.env ?? []) ways.push(`set ${name}`);
    for (const name of spec.oauthEnv ?? []) ways.push(`set ${name}`);
    if (spec.oauth !== undefined) ways.push(`run \`agent login ${provider}\``);
    ways.push(`add an entry to ${this.store.path}`);
    return new AuthError(
      `auth: no credentials for "${provider}" — ${ways.join(", or ")}`,
      { code: "config", provider },
    );
  }

  private requirePreset(provider: string): OAuthPreset {
    const preset = this.spec(provider).oauth;
    if (preset === undefined) {
      throw new AuthError(
        `auth: "${provider}" has no OAuth flow — set an API key instead`,
        { code: "config", provider },
      );
    }
    return preset;
  }

  private requireClientId(provider: string, preset: OAuthPreset): string {
    const fromEnv =
      preset.clientIdEnv === undefined
        ? undefined
        : this.env[preset.clientIdEnv]?.trim();
    const clientId = preset.clientId ?? fromEnv;
    if (clientId === undefined || clientId.length === 0) {
      const hint =
        preset.clientIdEnv === undefined
          ? "pass oauth.clientId"
          : `set ${preset.clientIdEnv} or pass oauth.clientId`;
      throw new AuthError(
        `auth: no OAuth client id for "${provider}" — ${hint}. ` +
          `A subscription login reuses the product's own OAuth client; confirm its terms allow third-party clients, ` +
          `or use an official API key (e.g. GEMINI_API_KEY for Gemini).`,
        { code: "config", provider },
      );
    }
    return clientId;
  }

  private clientSecret(preset: OAuthPreset): string | undefined {
    const fromEnv =
      preset.clientSecretEnv === undefined
        ? undefined
        : this.env[preset.clientSecretEnv]?.trim();
    const secret = preset.clientSecret ?? fromEnv;
    return secret !== undefined && secret.length > 0 ? secret : undefined;
  }
}

/** Duck-typed so this layer does not depend on a provider error class. */
export function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { status?: unknown }).status === 401
  );
}