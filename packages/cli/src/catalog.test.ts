import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "@cli-agent/ai";
import type { ModelInfo, Provider } from "@cli-agent/ai";
import {
  buildCatalog,
  defaultFreeModel,
  FALLBACK_FREE_MODEL,
  PREFERRED_FREE,
} from "./catalog.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-catalog-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A store in a directory of its own. */
function store(): AuthStore {
  return new AuthStore({ path: join(directory, "auth.json") });
}

describe("the catalogue", () => {
  it("has nothing when there are no credentials", async () => {
    const catalog = await buildCatalog({
      env: {},
      store: store(),
      factory: { env: {} },
    });

    // The CLIs on the machine need no credential, so they may be there;
    // the ones that need a key are not.
    const providers = new Set(catalog.models.map((model) => model.provider));

    expect(providers.has("openrouter")).toBe(false);
    expect(providers.has("anthropic")).toBe(false);
    expect(providers.has("openai")).toBe(false);
    expect(providers.has("gemini")).toBe(false);

    expect(catalog.missing).toContain("openrouter");
    expect(catalog.missing).toContain("anthropic");
  });

  it("has the models of the providers there is a key for", async () => {
    const catalog = await buildCatalog({
      env: { OPENAI_API_KEY: "sk-test" },
      store: store(),
      factory: { env: { OPENAI_API_KEY: "sk-test" } },
    });

    const providers = new Set(catalog.models.map((model) => model.provider));

    expect(providers.has("openai")).toBe(true);
    // There is no key for it, so it is not in the list.
    expect(providers.has("anthropic")).toBe(false);
  });

  it("says which providers have no credential", async () => {
    const catalog = await buildCatalog({
      env: {},
      store: store(),
      factory: { env: {} },
    });

    expect(catalog.missing).toContain("gemini");
    expect(catalog.missing).not.toContain("opencode-cli");
  });
});

describe("the default model", () => {
  it("is a free model of OpenRouter", () => {
    expect(FALLBACK_FREE_MODEL.startsWith("openrouter/")).toBe(true);
    expect(FALLBACK_FREE_MODEL.endsWith(":free")).toBe(true);
  });

  it("is one of the free models, and a preferred one when there is one", async () => {
    const provider: Provider = {
      id: "openrouter",
      models: async (): Promise<ModelInfo[]> => [
        {
          id: "some/other-model:free",
          name: "Other",
          provider: "openrouter",
          contextWindow: 1000,
          supports: {},
        },
        {
          id: PREFERRED_FREE[0] as string,
          name: "Preferred",
          provider: "openrouter",
          contextWindow: 1000,
          supports: {},
        },
      ],
      async *stream() {
        // nothing
      },
    };

    const chosen = await defaultFreeModel({
      env: {},
      store: store(),
      providers: new Map([["openrouter", provider]]),
      rememberPath: join(directory, "remembered.json"),
    });

    // The preferred one, not simply the first of the list.
    expect(chosen).toBe(`openrouter/${PREFERRED_FREE[0]}`);
  });

  it("is the first free model when none of them is preferred", async () => {
    const provider: Provider = {
      id: "openrouter",
      models: async (): Promise<ModelInfo[]> => [
        {
          id: "some/other-model:free",
          name: "Other",
          provider: "openrouter",
          contextWindow: 1000,
          supports: {},
        },
      ],
      async *stream() {
        // nothing
      },
    };

    const chosen = await defaultFreeModel({
      env: {},
      store: store(),
      providers: new Map([["openrouter", provider]]),
      rememberPath: join(directory, "remembered.json"),
    });

    expect(chosen).toBe("openrouter/some/other-model:free");
  });

  it("is remembered, so the next start does not have to wait", async () => {
    let asked = 0;

    const provider: Provider = {
      id: "openrouter",
      models: async (): Promise<ModelInfo[]> => {
        asked += 1;
        return [
          {
            id: "some/other-model:free",
            name: "Other",
            provider: "openrouter",
            contextWindow: 1000,
            supports: {},
          },
        ];
      },
      async *stream() {
        // nothing
      },
    };

    const where = join(directory, "remembered.json");
    const options = {
      env: {},
      store: store(),
      providers: new Map([["openrouter", provider]]),
      rememberPath: where,
    };

    await defaultFreeModel(options);
    expect(asked).toBe(1);

    // The second time it does not even ask.
    const again = await defaultFreeModel(options);
    expect(again).toBe("openrouter/some/other-model:free");
    expect(asked).toBe(1);
  });
});
