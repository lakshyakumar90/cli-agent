import { describe, expect, it } from "vitest";
import { AuthManager } from "./auth/manager.js";
import { AuthStore } from "./auth/store.js";
import { freeModels, isFreeModel } from "./models.js";
import type { ModelInfo, Provider } from "./types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function storeIn(
  directory: string,
): Promise<AuthStore> {
  return new AuthStore({ path: join(directory, "auth.json") });
}

describe("what a provider can serve", () => {
  it("says so when the environment holds the key", async () => {
    const auth = new AuthManager({
      env: { OPENAI_API_KEY: "sk-test" },
      store: await storeIn(await mkdtemp(join(tmpdir(), "cli-agent-has-"))),
    });

    expect(await auth.has("openai")).toBe(true);
  });

  it("says so when the store holds it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-agent-has-"));
    const store = await storeIn(directory);
    await store.set("openai", { type: "key", key: "sk-stored" });

    const auth = new AuthManager({ env: {}, store });

    expect(await auth.has("openai")).toBe(true);
  });

  it("says no when there is nothing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-agent-has-"));
    const auth = new AuthManager({
      env: {},
      store: await storeIn(directory),
    });

    expect(await auth.has("openai")).toBe(false);
    expect(await auth.has("gemini")).toBe(false);
  });

  it("lists the providers there is something for", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-agent-has-"));
    const store = await storeIn(directory);
    await store.set("gemini", { type: "key", key: "key" });

    const auth = new AuthManager({
      env: { OPENAI_API_KEY: "sk-test" },
      store,
    });

    const available = await auth.available();

    expect(available).toContain("openai");
    expect(available).toContain("gemini");
    expect(available).not.toContain("anthropic");
  });
});

describe("the free models", () => {
  it("are the ones marked as free", () => {
    expect(isFreeModel("nvidia/nemotron-3.5-lightning:free")).toBe(true);
    expect(isFreeModel("openai/gpt-5.5")).toBe(false);
  });

  it("are the ones the provider lists as free", async () => {
    const provider: Provider = {
      id: "openrouter",
      models: async (): Promise<ModelInfo[]> => [
        { id: "a:free", name: "A", provider: "openrouter", contextWindow: 1000, supports: {} },
        { id: "b", name: "B", provider: "openrouter", contextWindow: 1000, supports: {} },
        { id: "c:free", name: "C", provider: "openrouter", contextWindow: 1000, supports: {} },
      ],
      async *stream() {
        // nothing
      },
    };

    const free = await freeModels(provider);

    expect(free.map((model) => model.id)).toEqual(["a:free", "c:free"]);
  });

  it("are none when the provider cannot say", async () => {
    const provider: Provider = {
      id: "openrouter",
      models: async () => {
        throw new Error("no");
      },
      async *stream() {
        // nothing
      },
    };

    expect(await freeModels(provider)).toEqual([]);
  });
});
