import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importCodexCliAuth } from "./cli-import.js";
import { AuthError } from "./errors.js";
import { AuthStore } from "./store.js";

const NOW_MS = 1_760_000_000_000;

let directory: string;
let cliPath: string;
let storePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-import-"));
  cliPath = join(directory, "codex-auth.json");
  storePath = join(directory, "auth.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A JWT whose payload carries the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

async function writeCliFile(file: Record<string, unknown>): Promise<void> {
  await writeFile(cliPath, JSON.stringify(file, null, 2), "utf8");
}

function store(): AuthStore {
  return new AuthStore({ path: storePath });
}

describe("importing the Codex CLI login", () => {
  it("copies a valid login into our store", async () => {
    await writeCliFile({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: jwt({
          aud: ["app_client_1"],
          exp: (NOW_MS / 1000) + 3600,
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
        account_id: "acct-1",
      },
      last_refresh: "2026-11-06T12:44:43.160Z",
    });

    const imported = await importCodexCliAuth({
      path: cliPath,
      store: store(),
      now: () => NOW_MS,
    });

    expect(imported).toMatchObject({
      access: "access-1",
      refresh: "refresh-1",
      accountId: "acct-1",
      clientId: "app_client_1",
      refreshed: false,
    });

    await expect(store().get("codex")).resolves.toMatchObject({
      type: "oauth",
      access: "access-1",
      refresh: "refresh-1",
      clientId: "app_client_1",
      accountId: "acct-1",
    });
  });

  it("refreshes an expired login and gives the CLI the new token back", async () => {
    await writeCliFile({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        id_token: jwt({
          aud: ["app_client_1"],
          exp: NOW_MS / 1000 - 10,
        }),
      },
      last_refresh: "2026-11-06T12:44:43.160Z",
    });

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    const imported = await importCodexCliAuth({
      path: cliPath,
      store: store(),
      now: () => NOW_MS,
      fetch: fetchImpl,
    });

    expect(imported).toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
      refreshed: true,
    });

    // The CLI's own file gets the rotated token, so its login keeps working.
    const file = JSON.parse(await readFile(cliPath, "utf8")) as {
      tokens: { access_token: string; refresh_token: string };
      last_refresh: string;
    };
    expect(file.tokens.access_token).toBe("new-access");
    expect(file.tokens.refresh_token).toBe("new-refresh");
    expect(file.last_refresh).not.toBe("2026-11-06T12:44:43.160Z");

    // And so does our store.
    await expect(store().get("codex")).resolves.toMatchObject({
      access: "new-access",
      refresh: "new-refresh",
    });
  });

  it("explains that the CLI has to sign in again when the refresh token was used", async () => {
    await writeCliFile({
      tokens: {
        access_token: "old-access",
        refresh_token: "used-refresh",
        id_token: jwt({ aud: ["app_client_1"], exp: NOW_MS / 1000 - 10 }),
      },
    });

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              "Your refresh token has already been used to generate a new access token. Please try signing in again.",
            code: "refresh_token_reused",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      )) as typeof globalThis.fetch;

    const error = await importCodexCliAuth({
      path: cliPath,
      store: store(),
      now: () => NOW_MS,
      fetch: fetchImpl,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as Error).message).toContain("codex login");
  });

  it("says where the CLI's login should be when it is missing", async () => {
    const error = await importCodexCliAuth({
      path: join(directory, "nope.json"),
      store: store(),
      now: () => NOW_MS,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "config" });
    expect((error as Error).message).toContain("codex login");
  });
});

