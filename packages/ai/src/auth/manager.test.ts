import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "./errors.js";
import { AuthManager } from "./manager.js";
import { AuthStore } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = 1_760_000_000_000; // fixed clock: 1760000000 epoch seconds
const NOW_S = NOW_MS / 1000;

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-manager-"));
  path = join(directory, "auth.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

interface Call {
  url: string;
  body?: URLSearchParams;
}

function mockFetch(
  responder: (url: string, body: URLSearchParams | undefined) => Response,
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body =
      typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined;
    calls.push({ url, body });
    return responder(url, body);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function manager(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
  } = {},
) {
  return new AuthManager({
    store: new AuthStore({ path }),
    env: options.env ?? {},
    fetch: options.fetch ?? ((async () => json({})) as typeof globalThis.fetch),
    now: options.now ?? (() => NOW_MS),
  });
}

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

describe("credential resolution", () => {
  it("prefers the environment over auth.json", async () => {
    await new AuthStore({ path }).set("openai", { type: "key", key: "sk-stored" });
    const auth = manager({ env: { OPENAI_API_KEY: "sk-env" } });

    await expect(auth.get("openai")).resolves.toEqual({
      provider: "openai",
      type: "key",
      token: "sk-env",
      source: "env",
    });
  });

  it("falls back to the store", async () => {
    await new AuthStore({ path }).set("anthropic", {
      type: "key",
      key: "sk-ant",
    });

    await expect(manager().get("anthropic")).resolves.toMatchObject({
      token: "sk-ant",
      source: "store",
    });
  });

  it("derives an env var name for providers it has never heard of", async () => {
    const auth = manager({ env: { MY_LOCAL_SERVER_API_KEY: "local-key" } });

    await expect(auth.get("my-local-server")).resolves.toMatchObject({
      token: "local-key",
      type: "key",
    });
  });

  it("accepts a pre-issued OAuth access token from the env", async () => {
    const auth = manager({ env: { CODEX_ACCESS_TOKEN: "chatgpt-token" } });

    await expect(auth.get("codex")).resolves.toEqual({
      provider: "codex",
      type: "oauth",
      token: "chatgpt-token",
      source: "env",
    });
  });

  it("ignores blank environment values", async () => {
    await new AuthStore({ path }).set("openai", { type: "key", key: "sk-stored" });
    const auth = manager({ env: { OPENAI_API_KEY: "   " } });

    await expect(auth.get("openai")).resolves.toMatchObject({
      token: "sk-stored",
      source: "store",
    });
  });

  it("says how to fix missing credentials", async () => {
    const error = await manager().get("openai").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "config", provider: "openai" });
    expect((error as Error).message).toContain("OPENAI_API_KEY");
    expect((error as Error).message).toContain("auth.json");
  });
});

// ---------------------------------------------------------------------------
// Expiry and refresh
// ---------------------------------------------------------------------------

describe("oauth refresh", () => {
  const stored = (expires: number, refresh?: string) => ({
    type: "oauth" as const,
    access: "old-access",
    ...(refresh === undefined ? {} : { refresh }),
    expires,
  });

  it("returns a fresh token without touching the network", async () => {
    await new AuthStore({ path }).set("codex", stored(NOW_S + 3600, "r1"));
    const { fetchImpl, calls } = mockFetch(() => json({}));

    const auth = manager({ fetch: fetchImpl });
    await expect(auth.get("codex")).resolves.toMatchObject({
      token: "old-access",
      source: "store",
    });
    expect(calls).toHaveLength(0);
  });

  it("refreshes a token that is about to expire, before it is used", async () => {
    await new AuthStore({ path }).set("codex", stored(NOW_S + 10, "r1"));
    const { fetchImpl, calls } = mockFetch(() =>
      json({ access_token: "new-access", expires_in: 3600 }),
    );

    const auth = manager({
      fetch: fetchImpl,
      env: { MYAGENT_CODEX_CLIENT_ID: "client-1" },
    });
    const resolved = await auth.get("codex");

    expect(resolved).toMatchObject({
      token: "new-access",
      source: "refreshed",
      expires: NOW_S + 3600,
    });
    expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token");
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "r1",
      client_id: "client-1",
    });

    // The rotated access token is persisted, and the old refresh token is kept
    // because the server did not send a new one.
    await expect(new AuthStore({ path }).get("codex")).resolves.toMatchObject({
      access: "new-access",
      refresh: "r1",
      expires: NOW_S + 3600,
    });
  });

  it("stores a rotated refresh token", async () => {
    await new AuthStore({ path }).set("codex", stored(NOW_S + 10, "old-refresh"));
    const { fetchImpl } = mockFetch(() =>
      json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 1800,
      }),
    );

    const auth = manager({
      fetch: fetchImpl,
      env: { MYAGENT_CODEX_CLIENT_ID: "client-1" },
    });
    await auth.refresh("codex");

    await expect(new AuthStore({ path }).get("codex")).resolves.toMatchObject({
      refresh: "new-refresh",
    });
  });

  it("drops the expiry when a refresh response omits expires_in", async () => {
    await new AuthStore({ path }).set("codex", stored(NOW_S + 10, "r1"));
    const { fetchImpl } = mockFetch(() => json({ access_token: "no-expiry" }));

    const auth = manager({
      fetch: fetchImpl,
      env: { MYAGENT_CODEX_CLIENT_ID: "client-1" },
    });
    const resolved = await auth.refresh("codex");

    expect(resolved.expires).toBeUndefined();
    // A second read must not refresh again: there is no stale expiry to trip on.
    const again = await auth.get("codex");
    expect(again).toMatchObject({ token: "no-expiry", source: "store" });
  });

  it("refuses to use an expired token with no way to renew it", async () => {
    await new AuthStore({ path }).set("codex", stored(NOW_S - 1));

    const error = await manager().get("codex").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "oauth" });
    expect((error as Error).message).toContain("agent login codex");
  });

  it("does not refresh when no expiry was reported", async () => {
    await new AuthStore({ path }).set("codex", {
      type: "oauth",
      access: "no-expiry",
    });
    const { fetchImpl, calls } = mockFetch(() => json({}));

    await expect(manager({ fetch: fetchImpl }).get("codex")).resolves.toMatchObject({
      token: "no-expiry",
      source: "store",
    });
    expect(calls).toHaveLength(0);
  });

  it("turns a 401 into one refresh, but leaves other failures alone", async () => {
    await new AuthStore({ path }).set("codex", stored(NOW_S + 3600, "r1"));
    const { fetchImpl, calls } = mockFetch(() =>
      json({ access_token: "after-401", expires_in: 3600 }),
    );
    const auth = manager({
      fetch: fetchImpl,
      env: { MYAGENT_CODEX_CLIENT_ID: "client-1" },
    });

    expect(await auth.refreshOnUnauthorized("codex", { status: 401 })).toBe(true);
    expect(calls).toHaveLength(1);

    expect(await auth.refreshOnUnauthorized("codex", { status: 429 })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("does not pretend a key can be refreshed", async () => {
    await new AuthStore({ path }).set("openai", { type: "key", key: "sk" });
    const { fetchImpl, calls } = mockFetch(() => json({}));

    const auth = manager({ fetch: fetchImpl });
    expect(await auth.refreshOnUnauthorized("openai", { status: 401 })).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Login: authorization code + PKCE through the real loopback server
// ---------------------------------------------------------------------------

describe("oauth login", () => {
  it("runs the full flow and stores the refresh token", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );

    const auth = manager({
      fetch: fetchImpl,
      env: { MYAGENT_CODEX_CLIENT_ID: "client-1" },
    });

    let authorizeUrl: string | undefined;
    const resolved = await auth.login("codex", {
      onUrl: (url, redirectUri) => {
        authorizeUrl = url;
        const state = new URL(url).searchParams.get("state") ?? "";
        void fetch(`${redirectUri}?code=code-1&state=${state}`).catch(() => undefined);
      },
    });

    expect(resolved).toMatchObject({
      provider: "codex",
      type: "oauth",
      token: "access-1",
      source: "store",
      expires: NOW_S + 3600,
    });

    const query = new URL(authorizeUrl ?? "").searchParams;
    expect(query.get("client_id")).toBe("client-1");
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("scope")).toBe("openid profile email offline_access");
    expect(query.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const tokenCall = calls[0];
    expect(tokenCall?.url).toBe("https://auth.openai.com/oauth/token");
    // The verifier sent to the token endpoint must match the challenge.
    const verifier = tokenCall?.body?.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      query.get("code_challenge"),
    );

    const file = JSON.parse(await readFile(path, "utf8")) as {
      codex: Record<string, unknown>;
    };
    expect(file.codex).toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      expires: NOW_S + 3600,
      tokenType: "Bearer",
    });
  });

  it("lets a caller override the preset, e.g. a different Google client", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ access_token: "g-access" }));
    const auth = manager({ fetch: fetchImpl });

    let authorizeUrl = "";
    const resolved = await auth.login("antigravity", {
      oauth: { clientId: "google-client", clientSecret: "google-secret" },
      onUrl: (url, redirectUri) => {
        authorizeUrl = url;
        const state = new URL(url).searchParams.get("state") ?? "";
        void fetch(`${redirectUri}?code=g-code&state=${state}`).catch(() => undefined);
      },
    });

    expect(resolved.token).toBe("g-access");
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]?.body?.get("client_secret")).toBe("google-secret");

    const query = new URL(authorizeUrl).searchParams;
    expect(query.get("client_id")).toBe("google-client");
    // Google needs an offline consent to issue a refresh token at all.
    expect(query.get("access_type")).toBe("offline");
    expect(query.get("prompt")).toBe("consent");
  });

  it("explains what to set when no client id is configured", async () => {
    const auth = manager({ env: {} });

    const error = await auth.login("codex").catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "config", provider: "codex" });
    expect((error as Error).message).toContain("MYAGENT_CODEX_CLIENT_ID");
    expect((error as Error).message).toContain("terms");
  });

  it("refuses a provider that only supports API keys", async () => {
    const error = await manager()
      .login("openai")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "config" });
    expect((error as Error).message).toContain("no OAuth flow");
  });

  it("fails the login when the callback state does not match", async () => {
    const auth = manager({ env: { MYAGENT_CODEX_CLIENT_ID: "client-1" } });

    const error = await auth
      .login("codex", {
        onUrl: (_url, redirectUri) => {
          void fetch(`${redirectUri}?code=code-1&state=wrong`).catch(() => undefined);
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "state" });
  });

  it("times out without storing anything", async () => {
    const auth = manager({ env: { MYAGENT_CODEX_CLIENT_ID: "client-1" } });

    const error = await auth
      .login("codex", { onUrl: () => undefined, timeoutMs: 100 })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "timeout" });
    expect(await new AuthStore({ path }).read()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Manual management
// ---------------------------------------------------------------------------

describe("manual credentials", () => {
  it("stores a key that get() then resolves", async () => {
    const auth = manager();
    await auth.set("gemini", { type: "key", key: "AIza" });

    await expect(auth.get("gemini")).resolves.toMatchObject({
      token: "AIza",
      source: "store",
    });

    await auth.logout("gemini");
    await expect(auth.get("gemini")).rejects.toBeInstanceOf(AuthError);
  });
});