import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "@cli-agent/ai";
import { buildCatalog, FALLBACK_FREE_MODEL } from "./catalog.js";

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
});
