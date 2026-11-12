/**
 * Credential shapes shared by the store and the auth manager.
 *
 * On disk (`~/.myagent/auth.json`) this is exactly the format the guide uses:
 *
 *   { "openai":   { "type": "key", "key": "sk-..." },
 *     "codex":    { "type": "oauth", "access": "...", "refresh": "...",
 *                   "expires": 1760000000 },
 *     "gemini":   { "type": "oauth", "access": "...", "refresh": "...",
 *                   "expires": 1760000000 } }
 *
 * `expires` is epoch **seconds**, not milliseconds, because that is what OAuth
 * servers return in `expires_in` and what the file format documents. Extra
 * fields (scope, token_type, account ids) are preserved verbatim so a login can
 * carry provider-specific state without changing this module.
 */

/** A static API key. */
export interface KeyCredential {
  type: "key";
  key: string;
}

/** An OAuth access token, plus what is needed to renew it. */
export interface OAuthCredential {
  type: "oauth";
  /** Bearer token sent to the provider. */
  access: string;
  /** Refresh token, when the provider issued one. */
  refresh?: string;
  /** Access-token expiry, epoch seconds. */
  expires?: number;
  /** Anything else the flow produced; written back untouched. */
  [field: string]: unknown;
}

export type Credential = KeyCredential | OAuthCredential;

/** The whole file: one credential per provider id. */
export type AuthFile = Record<string, Credential>;

/** A token resolved from env or the store, ready to send. */
export interface ResolvedAuth {
  /** Provider id the credential belongs to, e.g. `"codex"`. */
  provider: string;
  type: Credential["type"];
  /** The secret itself: an API key or an access token. */
  token: string;
  /** Where it came from, for logs and `agent auth status`. */
  source: "env" | "store" | "refreshed";
  /** OAuth only: epoch seconds. */
  expires?: number;
}