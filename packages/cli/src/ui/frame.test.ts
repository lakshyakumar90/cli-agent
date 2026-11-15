import { describe, expect, it } from "vitest";
import { stripAnsi } from "./colors.js";
import { box, contextShare, renderHeader, spinnerFrame } from "./frame.js";

describe("the box", () => {
  it("has a line for everything that is in it", () => {
    const drawn = box(["one", "two"]);

    const lines = stripAnsi(drawn).split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines[3]).toMatch(/^└─+┘$/);
    expect(lines[1]).toContain("one");
    expect(lines[2]).toContain("two");
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
    const drawn = stripAnsi(box(["\u001b[31mred\u001b[0m"]));

    const lines = drawn.split("\n");
    const widths = new Set(lines.map((line) => line.length));

    expect(widths.size).toBe(1);
  });
});

describe("the header", () => {
  it("says the model and the directory", () => {
    const header = stripAnsi(
      renderHeader({ model: "openrouter/some/model:free", cwd: "/work" }),
    );

    expect(header).toContain("agent");
    expect(header).toContain("openrouter/some/model:free");
    expect(header).toContain("/work");
    expect(header).toContain("/model to change");
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
