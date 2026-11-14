import { describe, expect, it } from "vitest";
import { ProviderError, type Provider, type StreamRequest } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { INTERRUPTED, run } from "./loop.js";
import { backoffDelay, isRetryableError, sleep } from "./retry.js";
import {
  createState,
  type AgentEvent,
  type AgentState,
  type LoopEnd,
} from "./types.js";
import {
  echoTool,
  scriptedProvider,
  collect,
  stateWith,
  type ScriptedProvider,
  type ScriptedTurn,
} from "./loop.test-helpers.js";

// ---------------------------------------------------------------------------
// Providers that misbehave on purpose.
// ---------------------------------------------------------------------------

/** A provider that always asks for the same tool. */
function loopingProvider(name = "echo", args: unknown = { text: "again" }) {
  let count = 0;
  const provider = scriptedProvider(
    Array.from({ length: 20 }, (): ScriptedTurn => ({
      calls: [{ id: `call-${count++}`, name, args }],
    })),
  );
  return { provider, calls: () => count };
}

/** A provider that fails with the given error, then answers. */
function failingProvider(
  error: unknown,
  then: ScriptedTurn = { text: "recovered" },
): ScriptedProvider {
  let first = true;
  const requests: StreamRequest[] = [];
  return {
    id: "failing",
    requests,
    models: async () => [],
    async *stream(request: StreamRequest) {
      requests.push(request);
      if (first) {
        first = false;
        throw error;
      }
      for (const piece of (then.text ?? "").match(/.{1,4}/gs) ?? []) {
        yield { t: "text", delta: piece };
      }
      yield {
        t: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
        stop: "end",
      };
    },
  };
}

/** A provider that says something and then fails. */
function partialThenFailingProvider(error: unknown): ReturnType<
  typeof scriptedProvider
> {
  return {
    id: "partial",
    requests: [],
    models: async () => [],
    async *stream() {
      yield { t: "text", delta: "half an answer" };
      throw error;
    },
  } as ReturnType<typeof scriptedProvider>;
}

const rateLimited = (): ProviderError =>
  new ProviderError("openai: HTTP 429 — rate limited", {
    provider: "openai",
    code: "http",
    status: 429,
  });

const serverError = (): ProviderError =>
  new ProviderError("openai: HTTP 503 — unavailable", {
    provider: "openai",
    code: "http",
    status: 503,
  });

// ---------------------------------------------------------------------------
// Loop guards
// ---------------------------------------------------------------------------

describe("loop guards", () => {
  it("stops after the turn limit", async () => {
    const { provider } = loopingProvider();
    const state = stateWith(provider, [echoTool()], {
      limits: { maxTurns: 3 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({
      t: "done",
      reason: "max-turns",
      turns: 3,
    });
    // Three turns, three tool calls, three answers.
    expect(provider.requests).toHaveLength(3);
    expect(
      state.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(3);
  });

  it("stops when the model keeps asking for the same thing", async () => {
    const { provider } = loopingProvider("echo", { text: "same" });
    const echo = echoTool();
    const state = stateWith(provider, [echo], {
      limits: { maxRepeatedCalls: 3 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({
      t: "done",
      reason: "repeated-call",
    });
    // The call ran three times; the fourth was not run.
    expect(echo.calls).toHaveLength(3);
    expect(
      state.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(4);
    expect(state.messages.at(-1)).toEqual({
      role: "tool",
      callId: "call-3",
      content: "[not run: the same call repeated]",
      isError: true,
    });
  });

  it("counts a different argument as a different call", async () => {
    const echo = echoTool();
    const provider = scriptedProvider([
      { calls: [{ id: "a", name: "echo", args: { text: "one" } }] },
      { calls: [{ id: "b", name: "echo", args: { text: "two" } }] },
      { calls: [{ id: "c", name: "echo", args: { text: "one" } }] },
      { text: "done" },
    ]);
    const state = stateWith(provider, [echo], {
      limits: { maxRepeatedCalls: 2 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    expect(events.at(-1)).toMatchObject({ t: "done", reason: "end" });
    expect(echo.calls).toHaveLength(3);
  });

  it("stops when the token budget is used up", async () => {
    const provider = scriptedProvider([
      {
        calls: [{ id: "call-1", name: "echo", args: { text: "ping" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        calls: [{ id: "call-2", name: "echo", args: { text: "ping" } }],
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      { text: "never reached", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const state = stateWith(provider, [echoTool()], {
      limits: { tokenBudget: 100 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    // The first turn used 150 tokens, over the budget of 100.
    expect(events.at(-1)).toMatchObject({
      t: "done",
      reason: "budget-exhausted",
      turns: 1,
    });
    // The second turn never happened.
    expect(provider.requests).toHaveLength(1);
  });

  it("stops when the cost budget is used up", async () => {
    // Gemini 4 Carbon costs 2 dollars a million input tokens.
    const requests: StreamRequest[] = [];
    const provider: Provider = {
      id: "gemini",
      models: async () => [],
      async *stream(request: StreamRequest) {
        requests.push(request);
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: "call-1",
            name: "echo",
            args: { text: "ping" },
          },
        };
        yield {
          t: "done",
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
          stop: "tool",
        };
      },
    };
    const state = stateWith(provider, [echoTool()], {
      model: "gemini-4-carbon",
      limits: { costBudget: 1 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    // The turn cost 2 dollars, over the budget of 1.
    expect(events.at(-1)).toMatchObject({
      t: "done",
      reason: "budget-exhausted",
      turns: 1,
    });
    expect(requests).toHaveLength(1);
  });

  it("does not stop on a model without a price", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "echo", args: { text: "ping" } }] },
      { text: "done" },
    ]);
    const state = stateWith(provider, [echoTool()], {
      limits: { costBudget: 0.0001 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    // The model is not in the table, so it has no price: the budget does
    // not apply, and the turn runs to the end.
    expect(events.at(-1)).toMatchObject({ t: "done", reason: "end" });
    expect(provider.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("abort", () => {
  it("stops the stream and answers the open call with [interrupted]", async () => {
    const controller = new AbortController();
    const provider = {
      id: "aborting",
      requests: [],
      models: async () => [],
      async *stream() {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: "call-1",
            name: "echo",
            args: { text: "hi" },
          },
        };
        // The user pressed Esc mid-stream.
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    } as unknown as ReturnType<typeof scriptedProvider>;

    const state = stateWith(provider, [echoTool()]);

    const events = await collect(run(state, "go", controller.signal));

    expect(events.at(-1)).toMatchObject({
      t: "done",
      reason: "aborted",
    });

    // The transcript stays valid: the call the model made has an answer.
    expect(state.messages.at(-1)).toEqual({
      role: "tool",
      callId: "call-1",
      content: INTERRUPTED,
      isError: true,
    });
    expect(
      state.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(1);
  });

  it("marks a tool that was interrupted", async () => {
    const controller = new AbortController();

    // The tool says when it has started, so the interrupt cannot land
    // before there is anything to interrupt.
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const slow: Tool = {
      name: "slow",
      description: "Waits.",
      schema: z.object({}),
      async run(_args, ctx) {
        markStarted();
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        return { output: "never" };
      },
    };
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "slow", args: {} }] },
    ]);

    const state = stateWith(provider, [slow]);

    const events = collect(run(state, "go", controller.signal));
    await started;
    controller.abort();

    const collected = await events;

    expect(collected.at(-1)).toMatchObject({
      t: "done",
      reason: "aborted",
    });
    expect(collected.find((event) => event.t === "toolEnd")).toMatchObject({
      output: INTERRUPTED,
      isError: true,
    });
    expect(state.messages.at(-1)).toEqual({
      role: "tool",
      callId: "call-1",
      content: INTERRUPTED,
      isError: true,
    });
  });

  it("does not start another turn after an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scriptedProvider([{ text: "never" }]);
    const state = stateWith(provider, [echoTool()]);

    const events = await collect(run(state, "go", controller.signal));

    expect(events).toEqual([
      { t: "done", stop: "end", turns: 0, usage: { inputTokens: 0, outputTokens: 0 }, reason: "aborted" },
    ]);
    expect(provider.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("retries a rate-limited call and says so", async () => {
    const provider = failingProvider(rateLimited());
    const state = stateWith(provider, [], {
      limits: { retryDelayMs: 1 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    const retry = events.find((event) => event.t === "retry");
    expect(retry).toMatchObject({ t: "retry", attempt: 1 });
    expect(events.at(-1)).toMatchObject({ t: "done", reason: "end" });
    expect(provider.requests).toHaveLength(2);
  });

  it("retries a 5xx call", async () => {
    const provider = failingProvider(serverError());
    const state = stateWith(provider, [], {
      limits: { retryDelayMs: 1 },
    });

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    expect(events.some((event) => event.t === "retry")).toBe(true);
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  it("gives up after the retry limit", async () => {
    let attempts = 0;
    const alwaysFails = {
      id: "always",
      requests: [],
      models: async () => [],
      async *stream() {
        attempts += 1;
        throw rateLimited();
      },
    } as unknown as ScriptedProvider;

    const state = stateWith(alwaysFails, [], {
      limits: { maxRetries: 2, retryDelayMs: 1 },
    });

    const error = await collect(
      run(state, "go", new AbortController().signal),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(attempts).toBe(3); // the call plus two retries
  });

  it("does not retry once a tool has run", async () => {
    const echo = echoTool();
    let attempts = 0;
    const provider: ScriptedProvider = {
      id: "mixed",
      requests: [],
      models: async () => [],
      async *stream(request: StreamRequest) {
        provider.requests.push(request);
        attempts += 1;
        if (attempts === 1) {
          yield {
            t: "toolCall",
            call: {
              type: "toolCall",
              id: "call-1",
              name: "echo",
              args: { text: "x" },
            },
          };
          yield {
            t: "done",
            usage: { inputTokens: 1, outputTokens: 1 },
            stop: "tool",
          };
          return;
        }
        throw serverError();
      },
    };

    const state = stateWith(provider, [echo], {
      limits: { retryDelayMs: 1 },
    });

    const error = await collect(
      run(state, "go", new AbortController().signal),
    ).catch((caught: unknown) => caught);

    // The tool ran, so the failure is not retried: the side effect stands
    // and the model is not asked again.
    expect(error).toBeInstanceOf(ProviderError);
    expect(echo.calls).toHaveLength(1);
    expect(attempts).toBe(2); // not three: no retry after the tool
  });

  it("does not retry a call that already produced output", async () => {
    const provider = partialThenFailingProvider(serverError());
    const state = stateWith(provider, [], {
      limits: { retryDelayMs: 1 },
    });

    const error = await collect(
      run(state, "go", new AbortController().signal),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    // The half-answer is kept, and it was not delivered twice.
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "half an answer" }],
    });
  });
});

// ---------------------------------------------------------------------------
// The retry policy itself
// ---------------------------------------------------------------------------

describe("retry policy", () => {
  it("knows which failures are worth waiting out", () => {
    expect(isRetryableError(rateLimited())).toBe(true);
    expect(isRetryableError(serverError())).toBe(true);
    expect(
      isRetryableError(
        new ProviderError("bad request", {
          provider: "openai",
          code: "http",
          status: 400,
        }),
      ),
    ).toBe(false);
    expect(isRetryableError(new Error("nope"))).toBe(false);
  });

  it("backs off exponentially, up to the cap", () => {
    expect(backoffDelay(1, 500, 8_000)).toBe(500);
    expect(backoffDelay(2, 500, 8_000)).toBe(1_000);
    expect(backoffDelay(3, 500, 8_000)).toBe(2_000);
    expect(backoffDelay(10, 500, 8_000)).toBe(8_000);
  });

  it("gives up waiting when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(50, controller.signal)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The shape of the loop's end
// ---------------------------------------------------------------------------

describe("the end of a run", () => {
  it("says why it stopped", async () => {
    const provider = scriptedProvider([{ text: "the answer" }]);
    const state = stateWith(provider, []);

    const events = await collect(
      run(state, "hi", new AbortController().signal),
    );

    const done = events.at(-1) as Extract<AgentEvent, { t: "done" }>;
    expect(done.reason).toBe("end");
    expect(["end", "length", "max-turns", "repeated-call", "aborted"]).toContain(
      done.reason as LoopEnd,
    );
  });
});

