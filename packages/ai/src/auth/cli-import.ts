/**
 * Import a credential from a CLI that is already logged in.
 *
 * The Codex CLI keeps its ChatGPT login in `~/.codex/auth.json`. Copying that
 * login in is convenient, but the refresh token is **single use**: refreshing
 * rotates it, and the old one is rejected afterwards ("refresh_token_reused").
 *
 * So the import never borrows a refresh token without giving the new one
 * back: it refreshes if the access token has expired, writes the rotated
 * tokens back into the CLI's file, and keeps a copy in this app's own store.
 * The CLI stays logged in, and later runs start from a token that is still
 * valid.
 */

import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError } from "./errors.js";
import { refreshAccessToken } from "./oauth.js";
import { AuthStore } from "./store.js";
import type { OAuthCredential } from "./types.js";

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Refresh this long before the access token expires. */
const DEFAULT_SKEW_MS = 60_000;

export interface CodexCliFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  [field: string]: unknown;
}

export interface CodexCliImportOptions {
  /** Path to the Codex CLI's `auth.json`. Defaults to `~/.codex/auth.json`. */
  path?: string;
  /** Where the imported credential is stored. Defaults to `~/.myagent`. */
  store?: AuthStore;
  /** Token endpoint. Defaults to OpenAI's. */
  tokenUrl?: string;
  /** Injection point for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Clock in milliseconds, for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Write rotated tokens back to the CLI's file. Defaults to true. */
  writeBack?: boolean;
}

export interface ImportedCredential {
  /** Bearer token to send. */
  access: string;
  /** Refresh token, when the CLI had one. */
  refresh?: string;
  /** Expiry, epoch seconds. */
  expires?: number;
  /** ChatGPT account id the Codex backend routes on. */
  accountId?: string;
  /** OAuth client the token was issued for; needed to refresh it later. */
  clientId?: string;
  /** True when the token was renewed during the import. */
  refreshed: boolean;
}

/** Decode a JWT payload without verifying it — only claims are read. */
function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const json = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `aud` claim: the client the token was issued for. OpenAI sends a list. */
function clientIdFrom(claims: Record<string, unknown> | undefined): string | undefined {
  const audience = claims?.aud;
  if (Array.isArray(audience)) {
    const first = audience.find((value) => typeof value === "string");
    return typeof first === "string" ? first : undefined;
  }
  if (typeof audience === "string") return audience;
  return typeof claims?.client_id === "string" ? claims.client_id : undefined;
}

function accountIdFrom(
  claims: Record<string, unknown> | undefined,
  file: CodexCliFile,
): string | undefined {
  const fromFile = file.tokens?.account_id;
  if (typeof fromFile === "string" && fromFile.length > 0) return fromFile;

  const auth = claims?.["https://api.openai.com/auth"] as
    | { chatgpt_account_id?: string }
    | undefined;
  return typeof auth?.chatgpt_account_id === "string"
    ? auth.chatgpt_account_id
    : undefined;
}

export function defaultCodexAuthPath(): string {
  return join(homedir(), ".codex", "auth.json");
}

/**
 * Import the Codex CLI's login, refreshing it when it has expired.
 *
 * Throws an {@link AuthError} when the CLI has no login, or when its refresh
 * token has already been used — in that case the CLI has to sign in again.
 */
export async function importCodexCliAuth(
  options: CodexCliImportOptions = {},
): Promise<ImportedCredential> {
  const {
    path = defaultCodexAuthPath(),
    store = new AuthStore(),
    tokenUrl = CODEX_TOKEN_URL,
    fetch: doFetch = globalThis.fetch,
    now = Date.now,
    writeBack = true,
  } = options;

  let file: CodexCliFile;
  try {
    file = JSON.parse(await readFile(path, "utf8")) as CodexCliFile;
  } catch (error) {
    throw new AuthError(
      `auth: cannot read the Codex CLI's login at ${path} — run \`codex login\` first`,
      { code: "config", provider: "codex", cause: error },
    );
  }

  const access = file.tokens?.access_token;
  if (access === undefined || access.length === 0) {
    throw new AuthError(
      `auth: the Codex CLI's login at ${path} has no access token — run \`codex login\` first`,
      { code: "config", provider: "codex" },
    );
  }

  const claims =
    file.tokens?.id_token === undefined
      ? undefined
      : jwtPayload(file.tokens.id_token);
  const clientId = clientIdFrom(claims);
  const accountId = accountIdFrom(claims, file);
  const expires =
    typeof claims?.exp === "number" ? claims.exp : undefined;

  let refreshed = false;
  let currentAccess = access;
  let currentRefresh = file.tokens?.refresh_token;
  let currentExpires = expires;

  const expired =
    expires === undefined ? false : expires * 1000 - now() <= DEFAULT_SKEW_MS;

  if (expired && currentRefresh !== undefined && clientId !== undefined) {
    let token;
    try {
      token = await refreshAccessToken({
        tokenUrl,
        refreshToken: currentRefresh,
        clientId,
        fetch: doFetch,
        now,
      });
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        throw new AuthError(
          "auth: the Codex CLI's refresh token has already been used — run `codex login` to sign in again",
          { code: "oauth", provider: "codex", status: 401, cause: error },
        );
      }
      throw error;
    }

    refreshed = true;
    currentAccess = token.access;
    currentRefresh = token.refresh ?? currentRefresh;
    currentExpires = token.expires;

    // The old refresh token is dead now; give the CLI the new one.
    if (writeBack) {
      await writeBackToCli(path, file, {
        access: currentAccess,
        ...(currentRefresh === undefined ? {} : { refresh: currentRefresh }),
      });
    }
  }

  const credential: OAuthCredential = {
    type: "oauth",
    access: currentAccess,
    ...(currentRefresh === undefined ? {} : { refresh: currentRefresh }),
    ...(currentExpires === undefined ? {} : { expires: currentExpires }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(accountId === undefined ? {} : { accountId }),
  };
  await store.set("codex", credential);

  return {
    access: currentAccess,
    ...(currentRefresh === undefined ? {} : { refresh: currentRefresh }),
    ...(currentExpires === undefined ? {} : { expires: currentExpires }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(clientId === undefined ? {} : { clientId }),
    refreshed,
  };
}

/** Replace the CLI's tokens, keeping everything else in the file. */
async function writeBackToCli(
  path: string,
  file: CodexCliFile,
  tokens: { access: string; refresh?: string },
): Promise<void> {
  const updated: CodexCliFile = {
    ...file,
    tokens: {
      ...file.tokens,
      access_token: tokens.access,
      ...(tokens.refresh === undefined ? {} : { refresh_token: tokens.refresh }),
    },
    last_refresh: new Date().toISOString(),
  };

  const temporary = `${path}.${process.pid}.tmp`;
  // Keep the permissions the CLI's own file had.
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // No mode to copy; the default is fine.
  }

  await writeFile(
    temporary,
    `${JSON.stringify(updated, null, 2)}\n`,
    mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode },
  );
  await rename(temporary, path);
}

export { CODEX_TOKEN_URL };
