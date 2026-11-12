import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anthropic } from "./providers/anthropic.js";
import { openaiCompat } from "./providers/openai-compat.js";
import { ProviderRegistry, RegistryError } from "./registry.js";
import { startMockProviderServer, type MockProviderServer } from "./testing/mock-providers.js";
import type { Event } from "./types.js";

let server: MockProviderServer;

beforeEach(async () => {
  server = await startMockProviderServer({
    openai: "Hello from OpenAI.",
    anthropic: "Hello from Anthropic.",
    models: [{ id: "gpt-5.5", context_length: 1_050_000 }],
  });
});

afterEach(async () => {
  await server.close();
});

function registry(): ProviderRegistry {
  const reg = new ProviderRegistry();
  reg.register(
    openaiCompat({
      id: "openai",
      baseUrl: `${server.url}/v1`,
      apiKey: "sk-test",
    }),
  );
  reg.register(
    anthropic({
      id: "anthropic",
      baseUrl: `${server.url}/v1`,
      apiKey: "sk-ant-test",
    }),
  );
  return reg;
}

describe("provider registry", () => {
  it("resolves a provider/model ref", () => {
    const resolved = registry().resolve("anthropic/claude-sonnet-5-5");

    expect(resolved.providerId).toBe("anthropic");
    expect(resolved.model).toBe("claude-sonnet-5-5");
    expect(resolved.provider.id).toBe("anthropic");
    expect(resolved.info?.pricing).toMatchObject({ input: 2, output: 10 });
  });

  it("splits the ref on the first slash so router ids keep their vendor", () => {
    const reg = new ProviderRegistry();
    reg.register(
      openaiCompat({ id: "openrouter", baseUrl: `${server.url}/v1` }),
    );

    const resolved = reg.resolve("openrouter/anthropic/claude-opus-5-5");
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.model).toBe("anthropic/claude-opus-5-5");
    // The vendor hint inside the id still finds the table entry.
    expect(resolved.info?.name).toBe("Claude Opus 5.5");
  });

  it("refuses to register the same provider twice", () => {
    const reg = registry();
    const error = (() => {
      try {
        reg.register(openaiCompat({ id: "openai", baseUrl: "https://x/v1" }));
        return undefined;
      } catch (caught) {
        return caught as RegistryError;
      }
    })();

    expect(error).toBeInstanceOf(RegistryError);
    expect(error?.code).toBe("duplicate");
  });

  it("replaces a provider when asked to", () => {
    const reg = registry();
    reg.register(
      openaiCompat({ id: "openai", baseUrl: `${server.url}/v1` }),
      { replace: true },
    );
    expect(reg.list()).toEqual(["anthropic", "openai"]);
  });

  it("explains an unknown provider", () => {
    const error = (() => {
      try {
        registry().resolve("mistral/mistral-large");
        return undefined;
      } catch (caught) {
        return caught as RegistryError;
      }
    })();

    expect(error?.code).toBe("not-found");
    expect(error?.message).toContain("mistral");
    expect(error?.message).toContain("anthropic, openai");
  });

  it("rejects a ref that is not provider/model", () => {
    const error = (() => {
      try {
        registry().resolve("claude-sonnet-5-5");
        return undefined;
      } catch (caught) {
        return caught as RegistryError;
      }
    })();

    expect(error?.code).toBe("invalid-ref");
  });

  it("lists and fetches providers", () => {
    const reg = registry();

    expect(reg.list()).toEqual(["anthropic", "openai"]);
    expect(reg.has("openai")).toBe(true);
    expect(reg.get("openai")?.id).toBe("openai");
    expect(reg.get("nope")).toBeUndefined();
  });

  it("merges per-provider model overrides over the table", () => {
    const reg = new ProviderRegistry();
    reg.register(
      openaiCompat({ id: "openai", baseUrl: `${server.url}/v1` }),
      { models: { "gpt-5.5": { contextWindow: 500_000 } } },
    );

    const info = reg.model("openai/gpt-5.5");
    expect(info?.contextWindow).toBe(500_000);
    // The rest of the table entry survives.
    expect(info?.pricing).toMatchObject({ input: 5, output: 30 });
    expect(info?.provider).toBe("openai");
  });

  it("lists the models the providers report and the table knows", async () => {
    const models = await registry().models();
    const ids = models.map((model) => `${model.provider}/${model.id}`);

    // Reported by the mock `/models` endpoint.
    expect(ids).toContain("openai/gpt-5.5");
    // From the table, for the provider's own vendor.
    expect(ids).toContain("anthropic/claude-opus-5-5");
    // From the table, through the provider family.
    expect(ids).toContain("openai/gpt-6-astra");
  });
});

describe("streaming through the registry", () => {
  it("streams text from two providers with the same code", async () => {
    const reg = registry();
    const refs = ["openai/gpt-5.5", "anthropic/claude-sonnet-5-5"];

    const outputs: string[] = [];
    for (const ref of refs) {
      const events: Event[] = [];
      for await (const event of reg.stream(ref, {
        messages: [{ role: "user", content: "hi" }],
      })) {
        events.push(event);
      }

      const text = events
        .filter((event): event is Extract<Event, { t: "text" }> => event.t === "text")
        .map((event) => event.delta)
        .join("");
      outputs.push(text);

      const done = events.at(-1);
      expect(done?.t).toBe("done");
      if (done?.t === "done") {
        expect(done.usage.inputTokens).toBe(11);
        expect(done.stop).toBe("end");
      }
    }

    expect(outputs[0]).toBe("Hello from OpenAI.");
    expect(outputs[1]).toBe("Hello from Anthropic.");
  });

  it("sends the ref's model to the provider", async () => {
    const reg = registry();
    for await (const _event of reg.stream("openai/gpt-5.5", {
      messages: [{ role: "user", content: "hi" }],
    })) {
      // consume
    }

    const body = server.requests.at(-1)?.body as {
      model?: string;
    } | undefined;
    expect(body?.model).toBe("gpt-5.5");
  });
});
