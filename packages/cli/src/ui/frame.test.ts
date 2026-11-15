import { describe, expect, it } from "vitest";
import { stripAnsi } from "./colors.js";
import {
  box,
  contextShare,
  renderFooter,
  renderHeader,
  renderWelcome,
  rule,
  spinnerFrame,
} from "./frame.js";

describe("the box", () => {
  it("has a line for everything that is in it", () => {
    const drawn = box(["one", "two"]);

    const lines = stripAnsi(drawn).split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[3]).toMatch(/^╰─+╯$/);
    expect(lines[1]).toContain("one");
    expect(lines[2]).toContain("two");
  });

  it("has a title and a hint", () => {
    const drawn = stripAnsi(
      box(["one"], { title: "Select Model", hint: "enter select · esc back" }),
    );

    expect(drawn).toContain("Select Model");
    expect(drawn).toContain("enter select · esc back");
  });

  it("is as wide as the longest line", () => {
    const drawn = stripAnsi(box(["a short one", "a much longer line here"]));

    const lines = drawn.split("\n");

    // Every line is the same width, so the box is not ragged.
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
  });

  it("does not cut a long line off", () => {
    const long = "x".repeat(100);
    const drawn = stripAnsi(box([long]));

    expect(drawn).toContain(long);
  });

  it("does not count the colours as width", () => {
    const drawn = stripAnsi(box(["[31mred[0m"]));

    const lines = drawn.split("\n");
    const widths = new Set(lines.map((line) => line.length));

    expect(widths.size).toBe(1);
  });
});

describe("the header", () => {
  it("says the name, the version and the directory", () => {
    const header = stripAnsi(
      renderHeader({
        model: "openrouter/some/model:free",
        cwd: "/work",
        version: "0.1.0",
      }),
    );

    expect(header).toContain("agent");
    expect(header).toContain("0.1.0");
    expect(header).toContain("/work");
  });
});

describe("the welcome", () => {
  it("offers the commands", () => {
    const welcome = stripAnsi(
      renderWelcome([
        { name: "/model", description: "choose the model" },
        { name: "/help", description: "the commands" },
      ]),
    );

    expect(welcome).toContain("To get started");
    expect(welcome).toContain("/model");
    expect(welcome).toContain("choose the model");
    expect(welcome).toContain("/help");
  });
});

describe("the rule", () => {
  it("is as wide as it is told", () => {
    expect(stripAnsi(rule(20)).length).toBe(20);
  });
});

describe("the footer", () => {
  it("says what is where on the left, and what to press on the right", () => {
    const footer = stripAnsi(
      renderFooter({
        model: "gpt-6.1-sol",
        cwd: "/work",
        turns: 2,
        permissionMode: "ask",
        hints: ["? for shortcuts"],
        width: 80,
      }),
    );

    expect(footer).toContain("gpt-6.1-sol");
    expect(footer).toContain("/work");
    expect(footer).toContain("? for shortcuts");
    // The right side is at the end.
    expect(footer.trimEnd().endsWith("? for shortcuts")).toBe(true);
  });
});

describe("the context that is left", () => {
  it("is what is left of the window", () => {
    expect(contextShare({ used: 25, total: 100 })).toBe(0.75);
  });

  it("is nothing when it cannot be worked out", () => {
    expect(contextShare(undefined)).toBeUndefined();
    expect(contextShare({ used: 10, total: 0 })).toBeUndefined();
  });

  it("never goes below zero or above one", () => {
    expect(contextShare({ used: 200, total: 100 })).toBe(0);
    expect(contextShare({ used: 0, total: 100 })).toBe(1);
  });
});

describe("the spinner", () => {
  it("turns", () => {
    const frames = [0, 1, 2, 3].map(spinnerFrame);

    expect(new Set(frames).size).toBe(4);
  });
});
