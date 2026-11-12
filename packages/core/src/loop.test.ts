import { describe, expect, it } from "vitest";
import type {
  Event,
  ModelInfo,
  Provider,
  StopReason,
  StreamRequest,
  Usage,
} from "@cli-agent/ai";
import type { Tool, ToolContext } from "@cli-agent/tools";
import { buildContext } from "./context.js";
import { accumulate, execTool, run } from "./loop.js";
import { createState, type AgentEvent, type AgentState, type AssistantTurn } from "./types.js";

// ---------------------------------------------------------------------------
// A provider that plays back scripted turns.
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  /** Text the model says. */
  text?: string;
  /** Tools the model asks for. */
  calls?: Array<{ id: string; name: string; args: unknown }>;
  usage?: Usage;
  stop?: StopReason;
}

function scriptedProvider(turns: ScriptedTurn[]): Provider & {
  requests: StreamRequest[];
} {
  const requests: StreamRequest[] = [];
  let index = 0;

  return {
    id: "scripted",
    requests,
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      requests.push(request);
      const turn = turns[index];
      index += 1;
      if (turn === undefined) {
        yield { t: "done", usage: { inputTokens: 0, outputTokens: 0 }, stop: "end" };
        return;
      }

      for (const piece of (turn.text ?? "").match(/.{1,4}/gs) ?? []) {
        yield { t: "text", delta: piece };
      }
      for (const call of turn.calls ?? []) {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: call.id,
            name: call.name,
            args: call.args,
          },
        };
      }
      yield {
        t: "done",
        usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
        stop: turn.stop ?? (turn.calls === undefined ? "end" : "tool"),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// A fake echo tool.
// ---------------------------------------------------------------------------

function echoTool(
  onRun?: (args: any, ctx: ToolContext) => void,
): Tool & { calls: Array<{ args: any; ctx: ToolContext }> } {
  const calls: Array<{ args: any; ctx: ToolContext }> = [];
  return {
    name: "echo",
    description: "Echoes the text back.",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    calls,
    async run(args: any, ctx: ToolContext) {
      calls.push({ args, ctx });
      onRun?.(args, ctx);
      return { output: `echo: ${args.text}` };
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function stateWith(
  provider: Provider,
  tools: Tool[] = [],
  overrides: Partial<AgentState> = {},
): AgentState {
  return {
    ...createState(provider, { model: "test-model", tools }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("the agent loop", () => {
  it("answers with a tool and continues after the result", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "echo", args: { text: "ping" } }] },
      { text: "the tool said ping" },
    ]);
    const echo = echoTool();
    const state = stateWith(provider, [echo]);

    const events = await collect(
      run(state, "what does echo say?", new AbortController().signal),
    );

    // The model asked for the tool, the tool ran, the answer came after.
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

    expect(events[0]).toMatchObject({
      t: "toolStart",
      call: { id: "call-1", name: "echo" },
    });
    expect(events[1]).toMatchObject({
      t: "toolEnd",
      call: { id: "call-1" },
      output: "echo: ping",
    });

    const done = events.at(-1);
    expect(done).toMatchObject({ t: "done", stop: "end", turns: 2 });

    // The transcript tells the whole story.
    expect(state.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(state.messages[0]).toEqual({
      role: "user",
      content: "what does echo say?",
    });

    const firstTurn = state.messages[1];
    expect(firstTurn?.role).toBe("assistant");
    expect(firstTurn?.content).toEqual([
      { type: "toolCall", id: "call-1", name: "echo", args: { text: "ping" } },
    ]);

    expect(state.messages[2]).toEqual({
      role: "tool",
      callId: "call-1",
      content: "echo: ping",
    });

    const answer = state.messages[3];
    expect(answer?.role).toBe("assistant");
    // The deltas are merged into one block in the transcript.
    expect(answer?.content).toEqual([
      { type: "text", text: "the tool said ping" },
    ]);
  });

  it("sends the model, the transcript and the tools with every request", async () => {
    const provider = scriptedProvider([{ text: "hi" }]);
    const echo = echoTool();
    const state = stateWith(provider, [echo], { system: "Be terse." });

    await collect(run(state, "hello", new AbortController().signal));

    const request = provider.requests[0];
    expect(request?.model).toBe("test-model");
    expect(request?.system).toBe("Be terse.");
    expect(request?.messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    expect(request?.tools).toEqual([
      {
        name: "echo",
        description: "Echoes the text back.",
        schema: echo.schema,
      },
    ]);
  });

  it("runs the tools of one turn together and keeps their order", async () => {
    const provider = scriptedProvider([
      {
        calls: [
          { id: "a", name: "echo", args: { text: "first" } },
          { id: "b", name: "echo", args: { text: "second" } },
        ],
      },
      { text: "done" },
    ]);
    const state = stateWith(provider, [echoTool()]);

    await collect(run(state, "go", new AbortController().signal));

    const results = state.messages.filter((message) => message.role === "tool");
    expect(results).toEqual([
      { role: "tool", callId: "a", content: "echo: first" },
      { role: "tool", callId: "b", content: "echo: second" },
    ]);
  });

  it("tells the model about a tool it does not have, and carries on", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "nope", args: {} }] },
      { text: "understood" },
    ]);
    const state = stateWith(provider, [echoTool()]);

    const events = await collect(
      run(state, "go", new AbortController().signal),
    );

    expect(events[1]).toMatchObject({
      t: "toolEnd",
      output: "unknown tool: nope",
      isError: true,
    });
    expect(state.messages[2]).toEqual({
      role: "tool",
      callId: "call-1",
      content: "unknown tool: nope",
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({ t: "done", stop: "end" });
  });

  it("turns a throwing tool into an error result", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "boom", args: {} }] },
      { text: "ok" },
    ]);
    const boom: Tool = {
      name: "boom",
      description: "Throws.",
      schema: { type: "object" },
      async run() {
        throw new Error("kaboom");
      },
    };
    const state = stateWith(provider, [boom]);

    const events = await collect(run(state, "go", new AbortController().signal));

    expect(events[1]).toMatchObject({
      t: "toolEnd",
      output: "tool failed: kaboom",
      isError: true,
    });
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  it("passes the working directory and the signal to the tool", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "call-1", name: "echo", args: { text: "x" } }] },
      { text: "ok" },
    ]);
    const echo = echoTool();
    const state = stateWith(provider, [echo], { cwd: "/tmp/work" });
    const controller = new AbortController();

    await collect(run(state, "go", controller.signal));

    expect(echo.calls[0]?.ctx.cwd).toBe("/tmp/work");
    expect(echo.calls[0]?.ctx.signal).toBe(controller.signal);
  });

  it("stops after one turn when the model asks for nothing", async () => {
    const provider = scriptedProvider([{ text: "the answer" }]);
    const state = stateWith(provider);

    const events = await collect(run(state, "hi", new AbortController().signal));

    expect(events.at(-1)).toMatchObject({
      t: "done",
      stop: "end",
      turns: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("keeps the assistant's usage on the turn", async () => {
    const provider = scriptedProvider([
      {
        text: "hi",
        usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
      },
    ]);
    const state = stateWith(provider);

    await collect(run(state, "hi", new AbortController().signal));

    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
    });
  });
});

describe("accumulate", () => {
  it("merges text deltas into one block", () => {
    const turn: AssistantTurn = { role: "assistant", content: [] };

    accumulate(turn, { t: "text", delta: "Hel" });
    accumulate(turn, { t: "text", delta: "lo" });

    expect(turn.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("keeps thinking separate from text", () => {
    const turn: AssistantTurn = { role: "assistant", content: [] };

    accumulate(turn, { t: "thinking", delta: "hmm" });
    accumulate(turn, { t: "text", delta: "answer" });

    expect(turn.content).toEqual([
      { type: "thinking", text: "hmm" },
      { type: "text", text: "answer" },
    ]);
  });
});

describe("buildContext", () => {
  it("carries the model, the prompt, the transcript and the tools", () => {
    const provider = scriptedProvider([]);
    const echo = echoTool();
    const state = stateWith(provider, [echo], {
      system: "Be terse.",
      messages: [{ role: "user", content: "earlier" }],
    });

    expect(buildContext(state)).toEqual({
      model: "test-model",
      system: "Be terse.",
      messages: [{ role: "user", content: "earlier" }],
      tools: [
        {
          name: "echo",
          description: "Echoes the text back.",
          schema: echo.schema,
        },
      ],
    });
  });
});

describe("execTool", () => {
  it("returns the tool's output", async () => {
    const provider = scriptedProvider([]);
    const state = stateWith(provider, [echoTool()]);

    const result = await execTool(
      { type: "toolCall", id: "c1", name: "echo", args: { text: "hey" } },
      state,
      new AbortController().signal,
    );

    expect(result).toEqual({
      role: "tool",
      callId: "c1",
      content: "echo: hey",
    });
  });
});
