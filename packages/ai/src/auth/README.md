# packages/ai/src/auth

API key precedence, credential storage, OAuth/PKCE flows, loopback callbacks, and CLI credential import.

<!-- BEGIN SOURCE INDEX -->
## Folder guide

### Files

| File | Responsibility |
| --- | --- |
| [browser.ts](./browser.ts) | Best-effort browser launch for the OAuth flow. Headless machines are normal (SSH, containers, CI), so a failure here is not an error: the caller also prints the URL, and the user can paste it anywhere. |
| [cli-import.test.ts](./cli-import.test.ts) | Regression tests for importing the Codex CLI login. |
| [cli-import.ts](./cli-import.ts) | Import a credential from a CLI that is already logged in. The Codex CLI keeps its ChatGPT login in `~/.codex/auth.json`. Copying that login in is convenient, but the refresh token is **single use**: refreshing rotates it, and the old one is rejected afterwards ("refresh_token_reused"). |
| [errors.ts](./errors.ts) | Failures from the auth layer, distinct from provider call failures. |
| [index.ts](./index.ts) | Public exports for this module boundary. |
| [loopback.ts](./loopback.ts) | Temporary localhost callback server for the authorization-code flow. The OAuth app redirects the browser to `http://127.0.0.1:<port>/callback`; this server answers exactly one request, hands the code back to the login flow and shuts down. Binding to 127.0.0.1 (not 0.0.0.0) keeps the listener off the network, and the `state` check rejects callbacks this process did not initiate. |
| [manager.test.ts](./manager.test.ts) | Regression tests for credential resolution, oauth refresh, oauth login. |
| [manager.ts](./manager.ts) | Credential resolution and the interactive OAuth login. `get()` is the only call the rest of the app needs: it checks the environment first, then `auth.json`, and transparently refreshes an expiring OAuth token. `refreshOnUnauthorized()` covers the other half of the contract — a token can be revoked before its `expires` timestamp, so a 401 triggers one refresh and one retry at the call site. |
| [oauth.test.ts](./oauth.test.ts) | Regression tests for pkce, buildAuthorizeUrl, exchangeCode. |
| [oauth.ts](./oauth.ts) | OAuth token endpoint calls: the authorization-code exchange and refresh. Both are `application/x-www-form-urlencoded` POSTs (RFC 6749 §4.1.3, §6). The response parser only trusts what it validates: a missing `access_token` is a protocol failure, and an `expires_in` string is coerced to seconds so callers never have to think about it. |
| [pkce.ts](./pkce.ts) | PKCE (RFC 7636) primitives. The verifier never leaves this process; the challenge goes to the browser. `S256` is the only method modern providers accept, so it is the only one implemented. |
| [specs.ts](./specs.ts) | Per-provider auth policy. Two kinds of provider: |
| [store.test.ts](./store.test.ts) | Regression tests for auth store. |
| [store.ts](./store.ts) | `auth.json` on disk. Location: `$MYAGENT_HOME/auth.json`, defaulting to `~/.myagent/auth.json`. The file holds refresh tokens, so it is created `0600` in a `0700` directory and rewritten atomically (temp file + rename) — a reader never sees a half-written file, and a crash cannot leave a truncated credential store. |
| [types.ts](./types.ts) | Credential shapes shared by the store and the auth manager. On disk (`~/.myagent/auth.json`) this is exactly the format the guide uses: |

Regenerate this marked section with `node scripts/document-repository.mjs --readmes` from the repository root. Handwritten content outside the markers is preserved.
<!-- END SOURCE INDEX -->
