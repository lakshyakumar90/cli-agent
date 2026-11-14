import { describe, expect, it } from "vitest";
import type { Msg } from "@cli-agent/ai";
import { textOf } from "./budget.js";
import {
  DEFAULT_KEEP_TURNS,
  omittedMarker,
  shrinkText,
  stubOldToolResults,
} from "./shrink.js";

describe("shrinking a tool result", () => {
  it("leaves a short result alone", () => {
    const text = "one\ntwo\nthree";

    expect(shrinkText(text, { maxLines: 10, maxChars: 100 })).toBe(text);
  });

  it("keeps the head and the tail of a long one", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");

    const shrunk = shrinkText(text, { maxLines: 10, maxChars: 10_000 });
    const lines = shrunk.split("\n");

    expect(lines[0]).toBe("line 0");
    expect(lines[lines.length - 1]).toBe("line 99");
    expect(shrunk).toContain(omittedMarker(90));
  });

  it("says how many lines were left out", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");

    const shrunk = shrinkText(text, { maxLines: 10, maxChars: 10_000 });

    expect(shrunk).toContain("... 40 lines omitted ...");
  });

  it("respects the character cap as well", () => {
    const text = "x".repeat(5_000);

    const shrunk = shrinkText(text, { maxLines: 1_000, maxChars: 100 });

    expect(shrunk.length).toBeLessThan(300);
  });

  it("leaves an empty result alone", () => {
    expect(shrinkText("")).toBe("");
  });
});

describe("the old tool results", () => {
  const messages: Msg[] = [
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c1", name: "read", args: { path: "a.ts" } },
      ],
    },
    { role: "tool", callId: "c1", content: "the file, at length" },
    { role: "user", content: "now edit it" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "c2", name: "edit", args: { path: "a.ts" } },
      ],
    },
    { role: "tool", callId: "c2", content: "the edit, at length" },
  ];

  it("keeps the results of the last few turns", () => {
    const sent = stubOldToolResults(messages, { keepTurns: 1 });

    expect(textOf(sent[2] as Msg)).toBe("the file, at length");
    expect(textOf(sent[5] as Msg)).toBe("the edit, at length");
  });

  it("replaces an old result with a one-line stub", () => {
    const sent = stubOldToolResults(messages, { keepTurns: 0 });

    const stub = sent[2] as Extract<Msg, { role: "tool" }>;
    expect(stub.role).toBe("tool");
    expect(stub.content.split("\n")).toHaveLength(1);
    expect(stub.content).toContain("no longer shown");
    // The pairing with the call is kept, so the provider still accepts it.
    expect(stub.callId).toBe("c1");
  });

  it("keeps the error flag", () => {
    const withError: Msg[] = [
      { role: "assistant", content: [] },
      { role: "tool", callId: "c1", content: "it failed", isError: true },
    ];

    const sent = stubOldToolResults(withError, { keepTurns: 0 });

    expect((sent[1] as Extract<Msg, { role: "tool" }>).isError).toBe(true);
  });

  it("has a default of three turns", () => {
    expect(DEFAULT_KEEP_TURNS).toBe(3);
  });

  it("keeps a result that says it must be kept", () => {
    const withKept: Msg[] = [
      { role: "assistant", content: [] },
      {
        role: "tool",
        callId: "c1",
        content: "the instructions of the skill",
        keep: true,
      },
      { role: "assistant", content: [] },
    ];

    const sent = stubOldToolResults(withKept, { keepTurns: 0 });

    // The instructions are still needed long after the call is forgotten.
    expect(textOf(sent[1] as Msg)).toBe("the instructions of the skill");
  });
});
