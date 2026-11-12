import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthError } from "./errors.js";
import { startLoopbackServer } from "./loopback.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
} from "./oauth.js";
import { base64url, pkcePair, sameSecret } from "./pkce.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit; body?: URLSearchParams }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body =
      typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined;
    calls.push({ url, init, body });
    return responder(url, init);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const tokenResponse = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const errorResponse = (body: Record<string, unknown>, status = 400) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("pkce", () => {
  it("derives an S256 challenge from the verifier", () => {
    const pair = pkcePair();

    expect(pair.method).toBe("S256");
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(
      base64url(createHash("sha256").update(pair.verifier).digest()),
    );
    expect(pair.challenge).not.toContain("=");
  });

  it("produces a fresh verifier every time", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });

  it("compares secrets without leaking a length prefix", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

describe("buildAuthorizeUrl", () => {
  it("includes the PKCE parameters, scopes and provider extras", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationUrl: "https://auth.example.com/authorize",
        clientId: "client-1",
        redirectUri: "http://127.0.0.1:1234/callback",
        state: "state-1",
        codeChallenge: "challenge-1",
        scopes: ["openid", "offline_access"],
        params: { prompt: "consent" },
      }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "http://127.0.0.1:1234/callback",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      scope: "openid offline_access",
      prompt: "consent",
    });
  });

  it("omits scope when the preset has none", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationUrl: "https://auth.example.com/authorize",
        clientId: "c",
        redirectUri: "http://127.0.0.1:1/callback",
        state: "s",
        codeChallenge: "x",
        scopes: [],
      }),
    );
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

describe("exchangeCode", () => {
  it("posts the authorization code with its verifier and normalises expiry", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      tokenResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid",
      }),
    );

    const before = Math.floor(Date.now() / 1000);
    const token = await exchangeCode({
      tokenUrl: "https://auth.example.com/token",
      code: "code-1",
      redirectUri: "http://127.0.0.1:1234/callback",
      codeVerifier: "verifier-1",
      clientId: "client-1",
      fetch: fetchImpl,
    });

    expect(token.access).toBe("access-1");
    expect(token.refresh).toBe("refresh-1");
    expect(token.tokenType).toBe("Bearer");
    expect(token.scope).toBe("openid");
    expect(token.expires).toBeGreaterThanOrEqual(before + 3600);

    const call = calls[0];
    expect(call?.url).toBe("https://auth.example.com/token");
    expect(call?.init?.method).toBe("POST");
    expect(
      (call?.init?.headers as Record<string, string>)["content-type"],
    ).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(call?.body ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "http://127.0.0.1:1234/callback",
      code_verifier: "verifier-1",
      client_id: "client-1",
    });
  });

  it("sends a client secret when the preset has one", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      tokenResponse({ access_token: "a" }),
    );

    await exchangeCode({
      tokenUrl: "https://auth.example.com/token",
      code: "c",
      redirectUri: "http://127.0.0.1:1/callback",
      codeVerifier: "v",
      clientId: "id",
      clientSecret: "secret",
      fetch: fetchImpl,
    });

    expect(calls[0]?.body?.get("client_secret")).toBe("secret");
  });

  it("treats a missing access_token as a protocol failure", async () => {
    const { fetchImpl } = mockFetch(() => tokenResponse({ token_type: "Bearer" }));

    const error = await exchangeCode({
      tokenUrl: "https://auth.example.com/token",
      code: "c",
      redirectUri: "http://127.0.0.1:1/callback",
      codeVerifier: "v",
      clientId: "id",
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "http" });
  });

  it("surfaces invalid_grant with the provider's description", async () => {
    const { fetchImpl } = mockFetch(() =>
      errorResponse({
        error: "invalid_grant",
        error_description: "code expired",
      }),
    );

    const error = await exchangeCode({
      tokenUrl: "https://auth.example.com/token",
      code: "c",
      redirectUri: "http://127.0.0.1:1/callback",
      codeVerifier: "v",
      clientId: "id",
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "oauth", status: 400 });
    expect((error as Error).message).toContain("invalid_grant");
    expect((error as Error).message).toContain("code expired");
  });

  it("wraps transport failures", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;

    const error = await exchangeCode({
      tokenUrl: "https://auth.example.com/token",
      code: "c",
      redirectUri: "http://127.0.0.1:1/callback",
      codeVerifier: "v",
      clientId: "id",
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "network" });
  });
});

describe("refreshAccessToken", () => {
  it("posts the refresh grant", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      tokenResponse({ access_token: "access-2", expires_in: "1800" }),
    );

    const token = await refreshAccessToken({
      tokenUrl: "https://auth.example.com/token",
      refreshToken: "refresh-1",
      clientId: "client-1",
      fetch: fetchImpl,
    });

    expect(token.access).toBe("access-2");
    expect(token.expires).toBeTypeOf("number");
    expect(Object.fromEntries(calls[0]?.body ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-1",
    });
  });
});

// ---------------------------------------------------------------------------
// Loopback callback server
// ---------------------------------------------------------------------------

describe("loopback server", () => {
  it("captures the code and answers the browser", async () => {
    const server = await startLoopbackServer({ state: "state-1" });
    try {
      expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const response = await fetch(
        `${server.redirectUri}?code=code-1&state=state-1`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("close this window");

      await expect(server.waitForCode()).resolves.toBe("code-1");
    } finally {
      await server.close();
    }
  });

  it("rejects a callback with the wrong state", async () => {
    const server = await startLoopbackServer({ state: "expected" });
    try {
      const response = await fetch(`${server.redirectUri}?code=c&state=other`);
      expect(response.status).toBe(400);

      const error = await server.waitForCode().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "state" });
    } finally {
      await server.close();
    }
  });

  it("rejects when the provider reports an error", async () => {
    const server = await startLoopbackServer({ state: "s" });
    try {
      await fetch(
        `${server.redirectUri}?error=access_denied&error_description=user%20said%20no&state=s`,
      );

      const error = await server.waitForCode().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "oauth" });
      expect((error as Error).message).toContain("user said no");
    } finally {
      await server.close();
    }
  });

  it("times out when no browser ever calls back", async () => {
    const server = await startLoopbackServer({ timeoutMs: 100 });
    const error = await server.waitForCode().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "timeout" });
  });

  it("aborts with the caller's signal", async () => {
    const controller = new AbortController();
    const server = await startLoopbackServer({ signal: controller.signal });
    controller.abort();

    const error = await server.waitForCode().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "aborted" });
  });

  it("ignores unrelated paths", async () => {
    const server = await startLoopbackServer({ state: "s" });
    try {
      const response = await fetch(server.redirectUri.replace("/callback", "/favicon.ico"));
      expect(response.status).toBe(404);

      // The flow is still alive.
      await fetch(`${server.redirectUri}?code=after&state=s`);
      await expect(server.waitForCode()).resolves.toBe("after");
    } finally {
      await server.close();
    }
  });
});