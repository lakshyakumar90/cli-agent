import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { createState, type AgentState } from "@cli-agent/core";
import { runInteractive, runJson, runPrint, runRpc } from "./commands.js";

// ---------------------------------------------------------------------------
// A provider that answers, so the modes can be exercised without a network.
// ---------------------------------------------------------------------------

function answeringProvider(text = "the answer"): Provider {
  return {
    id: "test",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(_request: StreamRequest): AsyncGenerator<Event> {
      for (const piece of text.match(/.{1,6}/gs) ?? []) {
        yield { t: "text", delta: piece };
      }
      yield {
        t: "done",
        usage: { inputTokens: 3, outputTokens: 2 },
        stop: "end",
      };
    },
  };
}

/** A stream that collects what is written to it. */
function collector(): NodeJS.WritableStream & { text: string } {
  const chunks: string[] = [];
  const stream = {
    text: "",
    write(chunk: string | Uint8Array): boolean {
      chunks.push(chunk.toString());
      stream.text += chunk.toString();
      return true;
    },
    end(): void {
      /* nothing to close */
    },
    on(): typeof stream {
      return stream;
    },
    once(): typeof stream {
      return stream;
    },
    emit(): boolean {
      return false;
    },
    removeListener(): typeof stream {
      return stream;
    },
  } as unknown as NodeJS.WritableStream & { text: string };
  return stream;
}

function stateWith(provider: Provider): AgentState {
  return createState(provider, { model: "test-model" });
}

const signal = new AbortController().signal;

describe("print mode", () => {
  it("writes the answer to stdout", async () => {
    const out = collector();
    const err = collector();

    const code = await runPrint({
      state: stateWith(answeringProvider()),
      prompt: "what is the answer",
      streams: { out, err },
      signal,
    });

    expect(code).toBe(0);
    expect(out.text).toBe("the answer\n");
    // The activity is not in the answer.
    expect(err.text).toBe("");
  });

  it("keeps the tool activity on stderr when asked", async () => {
    const out = collector();
    const err = collector();

    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        yield {
          t: "toolCall",
          call: { type: "toolCall", id: "c1", name: "read", args: {} },
        };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    await runPrint({
      state: stateWith(provider),
      prompt: "go",
      streams: { out, err },
      signal,
      verbose: true,
    });

    expect(err.text).toContain("> read");
  });
});

describe("json mode", () => {
  it("writes one event per line", async () => {
    const out = collector();

    await runJson({
      state: stateWith(answeringProvider("hi")),
      prompt: "go",
      streams: { out, err: collector() },
      signal,
    });

    const lines = out.text.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(1);

    const events = lines.map((line) => JSON.parse(line) as { t: string });
    expect(events[0]?.t).toBe("text");
    expect(events.at(-1)?.t).toBe("done");
  });
});

describe("rpc mode", () => {
  it("answers a prompt request with the events", async () => {
    const out = collector();

    const code = await runRpc({
      state: stateWith(answeringProvider("hello")),
      streams: { out, err: collector() },
      requests: (async function* () {
        yield JSON.stringify({ type: "prompt", text: "hi" });
      })(),
      signal,
    });

    expect(code).toBe(0);
    const events = out.text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { t: string });
    expect(events.some((event) => event.t === "text")).toBe(true);
    expect(events.at(-1)?.t).toBe("done");
  });

  it("says so when the request is not JSON", async () => {
    const out = collector();

    await runRpc({
      state: stateWith(answeringProvider()),
      streams: { out, err: collector() },
      requests: (async function* () {
        yield "not json";
      })(),
      signal,
    });

    expect(JSON.parse(out.text.trim())).toMatchObject({ type: "error" });
  });

  it("stops on a stop request", async () => {
    const out = collector();

    const code = await runRpc({
      state: stateWith(answeringProvider()),
      streams: { out, err: collector() },
      requests: (async function* () {
        yield JSON.stringify({ type: "stop" });
      })(),
      signal,
    });

    expect(code).toBe(0);
    expect(out.text).toBe("");
  });
});

describe("interactive mode", () => {
  it("answers what it is asked, until the user leaves", async () => {
    const out = collector();
    const answers = ["what is the answer", "/exit"];

    const code = await runInteractive({
      state: stateWith(answeringProvider("the answer")),
      streams: { out, err: collector() },
      ask: async () => answers.shift() ?? "/exit",
      signalFor: () => signal,
    });

    expect(code).toBe(0);
    expect(out.text).toContain("the answer");
  });

  it("ignores an empty line", async () => {
    const out = collector();
    const answers = ["", "hello", "/exit"];

    await runInteractive({
      state: stateWith(answeringProvider("hi")),
      streams: { out, err: collector() },
      ask: async () => answers.shift() ?? "/exit",
      signalFor: () => signal,
    });

    // The empty line was not sent to the model.
    expect(out.text).toContain("hi");
  });
});
