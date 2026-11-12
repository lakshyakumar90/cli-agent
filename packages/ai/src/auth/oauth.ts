/**
 * OAuth token endpoint calls: the authorization-code exchange and refresh.
 *
 * Both are `application/x-www-form-urlencoded` POSTs (RFC 6749 §4.1.3, §6).
 * The response parser only trusts what it validates: a missing `access_token`
 * is a protocol failure, and an `expires_in` string is coerced to seconds so
 * callers never have to think about it.
 */

import { AuthError } from "./errors.js";
import { base64url, randomState } from "./pkce.js";

export interface OAuthToken {
  access: string;
  /** Providers send a refresh token on first consent, often not on refresh. */
  refresh?: string;
  /** Epoch seconds, derived from `expires_in` when present. */
  expires?: number;
  tokenType?: string;
  scope?: string;
}

export interface AuthorizeRequest {
  authorizationUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: string[];
  /** Extra authorize parameters (`access_type=offline`, `prompt=consent`, …). */
  params?: Record<string, string>;
}

/** Build the URL the user's browser (or device) is sent to. */
export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(request.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", request.clientId);
  url.searchParams.set("redirect_uri", request.redirectUri);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.scopes && request.scopes.length > 0) {
    url.searchParams.set("scope", request.scopes.join(" "));
  }
  for (const [key, value] of Object.entries(request.params ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

interface TokenRequest {
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  extraParams?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Clock in milliseconds, for deterministic expiry in tests. */
  now?: () => number;
}

export interface ExchangeCodeRequest extends TokenRequest {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface RefreshTokenRequest extends TokenRequest {
  refreshToken: string;
}

export function exchangeCode(request: ExchangeCodeRequest): Promise<OAuthToken> {
  const { code, redirectUri, codeVerifier } = request;

  return postToken(request, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

export function refreshAccessToken(
  request: RefreshTokenRequest,
): Promise<OAuthToken> {
  return postToken(request, {
    grant_type: "refresh_token",
    refresh_token: request.refreshToken,
  });
}

async function postToken(
  request: TokenRequest,
  grant: Record<string, string>,
): Promise<OAuthToken> {
  const {
    tokenUrl,
    clientId,
    clientSecret,
    extraParams,
    fetch: doFetch = globalThis.fetch,
    signal,
    now = Date.now,
  } = request;

  const body = new URLSearchParams({
    ...grant,
    ...extraParams,
    client_id: clientId,
    ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
  });

  let response: Response;
  try {
    response = await doFetch(tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new AuthError(`oauth: token request failed — ${message}`, {
      code: "network",
      cause: error,
    });
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    // The status is still actionable without a body.
  }

  if (!response.ok) {
    const failure = asRecord(text);
    const error =
      typeof failure?.error === "string" ? failure.error : "token request failed";
    const description =
      typeof failure?.error_description === "string"
        ? failure.error_description
        : "";
    throw new AuthError(
      `oauth: ${error}${description ? ` — ${description}` : ""}`,
      { code: "oauth", status: response.status },
    );
  }

  const payload = asRecord(text);
  const access = payload?.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new AuthError("oauth: token response has no access_token", {
      code: "http",
      status: response.status,
    });
  }

  const token: OAuthToken = { access };
  if (typeof payload?.refresh_token === "string") {
    token.refresh = payload.refresh_token;
  }
  const expiresIn = toSeconds(payload?.expires_in);
  if (expiresIn !== undefined) {
    token.expires = Math.floor(now() / 1000) + expiresIn;
  }
  if (typeof payload?.token_type === "string") {
    token.tokenType = payload.token_type;
  }
  if (typeof payload?.scope === "string") {
    token.scope = payload.scope;
  }
  return token;
}

function asRecord(text: string): Record<string, unknown> | undefined {
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toSeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds)
    : undefined;
}

/** Convenience for tests and callers that need a random-but-valid PKCE pair. */
export { base64url, randomState };