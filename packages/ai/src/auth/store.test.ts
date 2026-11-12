import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "./errors.js";
import { AuthStore, defaultAuthPath } from "./store.js";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-auth-"));
  path = join(directory, "auth.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function store() {
  return new AuthStore({ path });
}

describe("auth store", () => {
  it("round-trips credentials and keeps unknown providers intact", async () => {
    const auth = store();
    await auth.set("openai", { type: "key", key: "sk-1" });
    await auth.set("codex", {
      type: "oauth",
      access: "a1",
      refresh: "r1",
      expires: 1_760_000_000,
      scope: "openid",
    });

    expect(await auth.get("openai")).toEqual({ type: "key", key: "sk-1" });
    expect(await auth.get("codex")).toMatchObject({
      type: "oauth",
      access: "a1",
      refresh: "r1",
      expires: 1_760_000_000,
      scope: "openid",
    });

    const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(["codex", "openai"]);
  });

  it("preserves fields it does not understand when another provider is written", async () => {
    await writeFile(
      path,
      JSON.stringify({
        codex: {
          type: "oauth",
          access: "a1",
          refresh: "r1",
          accountId: "acct_9",
          futureField: { nested: true },
        },
      }),
    );

    const auth = store();
    await auth.set("openai", { type: "key", key: "sk-2" });

    const file = JSON.parse(await readFile(path, "utf8")) as {
      codex: Record<string, unknown>;
    };
    expect(file.codex.accountId).toBe("acct_9");
    expect(file.codex.futureField).toEqual({ nested: true });
  });

  it("creates the file 0600 inside a 0700 directory", async () => {
    await store().set("openai", { type: "key", key: "sk-1" });

    if (process.platform === "win32") return; // POSIX modes are not enforced here
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("starts empty when the file does not exist", async () => {
    expect(await store().read()).toEqual({});
    expect(await store().get("openai")).toBeUndefined();
  });

  it("explains a malformed file instead of silently logging out", async () => {
    await writeFile(path, "{ not json");

    await expect(store().read()).rejects.toBeInstanceOf(AuthError);
    await expect(store().read()).rejects.toMatchObject({ code: "config" });
  });

  it("ignores entries whose shape is wrong", async () => {
    await writeFile(
      path,
      JSON.stringify({
        openai: { type: "key" },
        codex: { type: "oauth", access: "" },
        gemini: { type: "oauth", access: "a1" },
      }),
    );

    const auth = store();
    expect(await auth.read()).toEqual({
      gemini: { type: "oauth", access: "a1" },
    });
  });

  it("serialises concurrent writes so neither is lost", async () => {
    const auth = store();
    await Promise.all([
      auth.set("openai", { type: "key", key: "a" }),
      auth.set("anthropic", { type: "key", key: "b" }),
      auth.set("gemini", { type: "key", key: "c" }),
    ]);

    const file = await auth.read();
    expect(Object.keys(file).sort()).toEqual(["anthropic", "gemini", "openai"]);
  });

  it("deletes one provider without touching the rest", async () => {
    const auth = store();
    await auth.set("openai", { type: "key", key: "a" });
    await auth.set("gemini", { type: "key", key: "b" });

    await auth.delete("openai");
    expect(await auth.read()).toEqual({ gemini: { type: "key", key: "b" } });
  });

  it("resolves the default path from MYAGENT_HOME", () => {
    expect(defaultAuthPath({ MYAGENT_HOME: "C:/tmp/agent" })).toBe(
      join("C:/tmp/agent", "auth.json"),
    );
    expect(defaultAuthPath({ MYAGENT_HOME: "  " })).toMatch(/\.myagent[\\/]auth\.json$/);
  });
});