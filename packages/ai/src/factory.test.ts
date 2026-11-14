import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "./types.js";
import { createProvider } from "./factory.js";

/** A provider that answers with a fixed text. */
function answering(id: string): Provider {
  return {
    id,
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      yield { t: "text", delta: `hello from ${id}` };
      yield {
        t: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
        stop: "end",
      };
    },
  };
}

describe("the provider factory", () => {
  it("builds the providers it knows", async () => {
    const provider = await createProvider("openai", {
      env: { OPENAI_API_KEY: "test-key" },
    });

    expect(provider.id).toBe("openai");
  });

  it("does not know a provider it has never heard of", async () => {
    await expect(createProvider("nope")).rejects.toThrow(/no provider/);
  });

  it("uses a provider an extension added", async () => {
    const added = answering("extra");
    const providers = new Map([["extra", added]]);

    const provider = await createProvider("extra", { providers });

    expect(provider).toBe(added);
  });

  it("lets an extension swap a provider that is already there", async () => {
    const added = answering("openai");
    const providers = new Map([["openai", added]]);

    const provider = await createProvider("openai", {
      env: { OPENAI_API_KEY: "test-key" },
      providers,
    });

    expect(provider).toBe(added);
  });
});
