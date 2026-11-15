import { describe, expect, it } from "vitest";
import { missingProvider } from "./factory.js";

describe("a provider with no credentials", () => {
  it("says what is missing when it is called", async () => {
    const provider = missingProvider(
      "openrouter",
      'auth: no credentials for "openrouter" — set OPENROUTER_API_KEY',
    );

    await expect(
      (async () => {
        for await (const _event of provider.stream({
          model: "openrouter/x",
          system: "",
          messages: [],
          tools: [],
          signal: new AbortController().signal,
        })) {
          // nothing
        }
      })(),
    ).rejects.toThrow(/no credentials/);
  });

  it("has no models to offer", async () => {
    const provider = missingProvider("openrouter", "no credentials");

    expect(await provider.models()).toEqual([]);
  });
});
