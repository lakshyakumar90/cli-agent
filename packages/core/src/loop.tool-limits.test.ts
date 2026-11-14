import { describe, expect, it } from "vitest";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { run } from "./loop.js";
import { stubOldToolResults } from "./shrink.js";
import { stateWith, scriptedProvider, collect } from "./loop.test-helpers.js";

/** A tool that returns a long text, and says how long it may be. */
function longTool(over: Partial<Tool> = {}): Tool {
  return {
    name: "long",
    description: "Returns a long text.",
    schema: z.object({}),
    async run() {
      return {
        output: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
        ...(over.run === undefined ? {} : {}),
      };
    },
    ...over,
  } as Tool;
}

describe("a tool that returns a lot", () => {
  it("is shortened by the agent's limit", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "long", args: {} }] },
      { text: "done" },
    ]);
    const state = stateWith(provider, [longTool()]);
    state.limits = { maxToolLines: 10, maxToolChars: 10_000 };

    await collect(run(state, "go", new AbortController().signal));

    const result = state.messages.find((message) => message.role === "tool");
    expect(result?.role === "tool" ? result.content : "").toContain(
      "lines omitted",
    );
  });

  it("keeps its own limit when it has one", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "long", args: {} }] },
      { text: "done" },
    ]);
    const state = stateWith(provider, [longTool({ maxLines: 2_000 })]);
    state.limits = { maxToolLines: 10, maxToolChars: 10_000 };

    await collect(run(state, "go", new AbortController().signal));

    const result = state.messages.find((message) => message.role === "tool");
    const content = result?.role === "tool" ? result.content : "";
    // Nothing was left out: the tool's own limit is the one that counts.
    expect(content).not.toContain("lines omitted");
    expect(content).toContain("line 99");
  });
});

describe("a tool that says its result must be kept", () => {
  it("is not replaced by a stub when the turn gets old", async () => {
    const provider = scriptedProvider([
      { calls: [{ id: "c1", name: "skill", args: { name: "deploy" } }] },
      { text: "done" },
      { text: "still here" },
    ]);
    const tool: Tool = {
      name: "skill",
      description: "Loads a skill.",
      schema: z.object({ name: z.string() }),
      async run() {
        return { output: "the instructions of the skill", keep: true };
      },
    };
    const state = stateWith(provider, [tool]);

    await collect(run(state, "go", new AbortController().signal));

    const result = state.messages.find((message) => message.role === "tool");
    expect(result?.role === "tool" ? result.content : "").toBe(
      "the instructions of the skill",
    );

    // Even when it is old, it stays.
    const sent = stubOldToolResults(state.messages, { keepTurns: 0 });
    const sentResult = sent.find((message) => message.role === "tool");
    expect(sentResult?.role === "tool" ? sentResult.content : "").toBe(
      "the instructions of the skill",
    );
  });
});
