import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "./types.js";
import { AuthStore } from "./auth/store.js";
import { createProvider, opencodeViaCli } from "./factory.js";

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

describe("the opencode provider", () => {
  /** A store with no credentials in it, whatever the machine has. */
  function emptyStore(): AuthStore {
    return new AuthStore({ path: join(tmpdir(), "cli-agent-no-auth.json") });
  }

  it("runs through the local CLI when there is no API key", async () => {
    const provider = await createProvider("opencode", {
      env: {},
      store: emptyStore(),
    });

    // Zen refuses a free model to an API request however it is
    // authenticated; the CLI's own session is the way it is served.
    expect(provider.id).toBe("opencode");
  });

  it("puts the provider back in front of the model id the CLI asks for", async () => {
    const asked: string[] = [];
    const bridge: Provider = {
      id: "opencode-cli",
      models: async () => [
        { id: "opencode/iceman-free", provider: "opencode-cli" },
        { id: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", provider: "opencode-cli" },
      ],
      stream: async function* (request: StreamRequest): AsyncGenerator<Event> {
        asked.push(request.model);
        yield { t: "text", delta: "ok" };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    const via = opencodeViaCli(bridge);

    expect(via.id).toBe("opencode");
    // Only the models of this provider are listed, without the prefix the
    // ref already carries.
    expect((await via.models()).map((model) => model.id)).toEqual([
      "iceman-free",
    ]);

    for await (const _event of via.stream({
      model: "iceman-free",
      system: "",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // Drained: the call is what is under test.
    }

    // The CLI names the model "opencode/iceman-free"; a bare id is not a
    // model reference it knows.
    expect(asked).toEqual(["opencode/iceman-free"]);
  });

  it("does not prefix a model id that already carries the provider", async () => {
    const asked: string[] = [];
    const bridge: Provider = {
      id: "opencode-cli",
      models: async () => [],
      stream: async function* (request: StreamRequest): AsyncGenerator<Event> {
        asked.push(request.model);
        yield { t: "text", delta: "ok" };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    for await (const _event of opencodeViaCli(bridge).stream({
      model: "opencode/iceman-free",
      system: "",
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // Drained.
    }

    expect(asked).toEqual(["opencode/iceman-free"]);
  });
});
