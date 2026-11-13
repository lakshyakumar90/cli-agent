import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { run } from "./loop.js";
import {
  collectAgent,
  renderEvent,
  renderJsonLines,
  renderText,
} from "./render.js";
import { runSubAgent } from "./subagent.js";
import {
  collect,
  echoTool,
  scriptedProvider,
  stateWith,
} from "./loop.test-helpers.js";

// ---------------------------------------------------------------------------
// One run, three consumers.
// ---------------------------------------------------------------------------

/** A run where the model calls the echo tool and then answers. */
function echoRun() {
  const provider = scriptedProvider([
    { calls: [{ id: "call-1", name: "echo", args: { text: "ping" } }] },
    { text: "the tool said ping" },
  ]);
  const echo = echoTool();
  const state = stateWith(provider, [echo]);
  return { provider, echo, state };
}

describe("emit events, not prints", () => {
  it("yields the events the guide names", async () => {
    const { state } = echoRun();

    const events = await collect(
      run(state, "what does echo say?", new AbortController().signal),
    );

    expect(events.map((event) => event.t)).toEqual([
      "toolStart",
      "toolEnd",
      "text",
      "text",
      "text",
      "text",
      "text",
      "done",
    ]);
  });

  it("prints nothing while it runs", async () => {
    const { state } = echoRun();

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await collect(
        run(state, "what does echo say?", new AbortController().signal),
      );
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

describe("the text consumer", () => {
  it("prints the answer and the tool call", async () => {
    const { state } = echoRun();

    const chunks = [];
    for await (const chunk of renderText(
      run(state, "what does echo say?", new AbortController().signal),
    )) {
      chunks.push(chunk);
    }

    const text = chunks.join("");
    expect(text).toContain("> echo(");
    expect(text).toContain("echo: ping");
    expect(text).toContain("the tool said ping");
  });
});

describe("the JSON consumer", () => {
  it("writes one JSON object per line", async () => {
    const { state } = echoRun();

    const lines = [];
    for await (const line of renderJsonLines(
      run(state, "what does echo say?", new AbortController().signal),
    )) {
      lines.push(line);
    }

    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);

    const parsed = lines.map((line) => JSON.parse(line) as { t: string });
    expect(parsed.map((event) => event.t)).toEqual([
      "toolStart",
      "toolEnd",
      "text",
      "text",
      "text",
      "text",
      "text",
      "done",
    ]);

    const done = parsed.at(-1) as { t: string; reason: string };
    expect(done.reason).toBe("end");
  });
});

describe("the parent consumer", () => {
  it("keeps what it needs from the stream", async () => {
    const { state } = echoRun();

    const summary = await collectAgent(
      run(state, "what does echo say?", new AbortController().signal),
    );

    expect(summary.text).toBe("the tool said ping");
    expect(summary.toolCalls).toEqual([
      { id: "call-1", name: "echo", args: { text: "ping" } },
    ]);
    expect(summary.reason).toBe("end");
    expect(summary.stop).toBe("end");
    expect(summary.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });
});

describe("renderEvent", () => {
  it("says nothing for the done event", () => {
    expect(
      renderEvent({
        t: "done",
        stop: "end",
        turns: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        reason: "end",
      }),
    ).toBeUndefined();
  });

  it("shortens long tool arguments", () => {
    const text = renderEvent({
      t: "toolStart",
      call: {
        type: "toolCall",
        id: "c1",
        name: "echo",
        args: { text: "x".repeat(200) },
      },
    });

    expect(text).toContain("...");
    expect(text?.length).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
// Sub-agents
// ---------------------------------------------------------------------------

describe("a sub-agent", () => {
  it("yields the same events, from its own transcript", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "echo", args: { text: "ping" } }] },
      { text: "the sub-agent is done" },
    ]);
    const parent = stateWith(provider, [echoTool()]);

    const events = await collect(
      runSubAgent({
        parent,
        prompt: "do the thing",
        signal: new AbortController().signal,
      }),
    );

    // The same shape as the parent's stream: a tool call, its result, the
    // answer, and the end.
    const types = events.map((event) => event.t);
    expect(types[0]).toBe("toolStart");
    expect(types[1]).toBe("toolEnd");
    expect(types.at(-1)).toBe("done");
    expect(types.slice(2, -1).every((type) => type === "text")).toBe(true);
    expect(types.filter((type) => type === "text").length).toBeGreaterThan(0);

    // The parent's transcript is untouched: the sub-agent has its own.
    expect(parent.messages).toEqual([]);
  });

  it("gets its own tools when it is given them", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "other", args: {} }] },
      { text: "ok" },
    ]);
    const parent = stateWith(provider, [echoTool()]);

    const other = {
      name: "other",
      description: "Another tool.",
      schema: z.object({}),
      async run() {
        return { output: "other ran" };
      },
    };

    const summary = await collectAgent(
      runSubAgent({
        parent,
        prompt: "do the thing",
        signal: new AbortController().signal,
        tools: [other],
      }),
    );

    expect(summary.text).toBe("ok");
  });

  it("reports back to the parent as a summary", async () => {
    const provider = scriptedProvider([{ text: "the answer is 42" }]);
    const parent = stateWith(provider, []);

    const summary = await collectAgent(
      runSubAgent({
        parent,
        prompt: "what is the answer",
        signal: new AbortController().signal,
      }),
    );

    expect(summary.text).toBe("the answer is 42");
    expect(summary.reason).toBe("end");
  });
});

