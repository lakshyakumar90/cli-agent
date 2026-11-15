import { describe, expect, it } from "vitest";
import { lookupModel } from "@cli-agent/ai";
import { color, stripAnsi, widthOf } from "./colors.js";
import { inline, MarkdownStream, renderMarkdown } from "./markdown.js";
import { diffLines, renderDiff } from "./diff.js";
import { formatTokens, renderToolBlock } from "./status.js";
import { renderFooter } from "./frame.js";

describe("colors", () => {
  it("puts a colour on the text", () => {
    expect(color("hi", "red")).toContain("hi");
    expect(stripAnsi(color("hi", "red"))).toBe("hi");
  });

  it("measures the width without the escapes", () => {
    expect(widthOf(color("hello", "bold"))).toBe(5);
  });
});

describe("markdown", () => {
  it("styles bold, italic and code", () => {
    const rendered = stripAnsi(renderMarkdown("**bold** and *soft* and `code`"));

    expect(rendered).toContain("bold");
    expect(rendered).toContain("soft");
    expect(rendered).toContain("code");
  });

  it("styles headings and lists", () => {
    const rendered = stripAnsi(renderMarkdown("# Title\n\n- one\n- two"));

    expect(rendered).toContain("Title");
    expect(rendered).toContain("• one");
    expect(rendered).toContain("• two");
  });

  it("keeps code blocks as they are", () => {
    const rendered = stripAnsi(renderMarkdown("```\nconst a = 1;\n```"));

    expect(rendered).toContain("const a = 1;");
  });

  it("styles inline code without styling what is inside it", () => {
    expect(stripAnsi(inline("`a **b**`"))).toContain("a **b**");
  });
});

describe("the streaming markdown", () => {
  it("holds a line back until it is complete", () => {
    const stream = new MarkdownStream();

    expect(stream.write("hel")).toBe("");
    expect(stream.write("lo\n")).toContain("hello");
  });

  it("gives the rest of the last line at the end", () => {
    const stream = new MarkdownStream();

    stream.write("one\ntwo");
    expect(stream.flush()).toContain("two");
  });

  it("keeps the text it was given", () => {
    const stream = new MarkdownStream();
    stream.write("hello");

    expect(stream.text).toBe("hello");
  });
});

describe("diffs", () => {
  it("shows what was added and what went", () => {
    const diff = diffLines("a\nb\nc", "a\nx\nc");

    expect(diff.map((line) => line.kind)).toEqual([
      "same",
      "remove",
      "add",
      "same",
    ]);
  });

  it("renders the diff with a sign in front of every line", () => {
    const rendered = renderDiff("a\nb", "a\nc");

    expect(stripAnsi(rendered)).toBe("  a\n- b\n+ c");
  });

  it("finds no difference in the same text", () => {
    expect(diffLines("same", "same").every((line) => line.kind === "same")).toBe(
      true,
    );
  });
});

describe("the footer", () => {
  it("says the model, the usage and the mode", () => {
    const status = stripAnsi(
      renderFooter({
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 1200, outputTokens: 340 },
        permissionMode: "ask",
        width: 100,
      }),
    );

    expect(status).toContain("claude-sonnet-5-5");
    expect(status).toContain("1.2k in");
    expect(status).toContain("340 out");
    expect(status).toContain("ask");
  });

  it("counts the tokens in a readable shape", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });

  it("says what the session has cost", () => {
    const status = stripAnsi(
      renderFooter({
        model: "gemini-3.1-flash-lite",
        cwd: "/work",
        usage: { inputTokens: 10_000, outputTokens: 2_000 },
        info: lookupModel("gemini", "gemini-3.1-flash-lite"),
        turns: 4,
        left: { used: 1_000, total: 10_000 },
        permissionMode: "ask",
        hints: ["? for shortcuts"],
        width: 100,
      }),
    );

    // The cost is what the whole session has cost, not what the last turn
    // cost.
    expect(status).toContain("10.0k in");
    expect(status).toContain("$");
    expect(status).toContain("90% left");
    expect(status).toContain("4 turns");
    expect(status).toContain("? for shortcuts");
  });
});

describe("tool blocks", () => {
  it("shows the name and what it was asked to do", () => {
    const block = renderToolBlock({
      id: "c1",
      name: "read",
      args: { path: "src/index.ts" },
      expanded: false,
    });

    expect(stripAnsi(block)).toContain("read src/index.ts");
  });

  it("hides the output until it is expanded", () => {
    const collapsed = renderToolBlock({
      id: "c1",
      name: "bash",
      args: { command: "npm test" },
      output: "12 passing",
      expanded: false,
    });
    const expanded = renderToolBlock({
      id: "c1",
      name: "bash",
      args: { command: "npm test" },
      output: "12 passing",
      expanded: true,
    });

    expect(stripAnsi(collapsed)).not.toContain("12 passing");
    expect(stripAnsi(expanded)).toContain("12 passing");
  });

  it("shows the diff of an edit", () => {
    const block = renderToolBlock({
      id: "c1",
      name: "edit",
      args: {},
      expanded: true,
      replacement: { oldString: "a + b - 1", newString: "a + b" },
    });

    const text = stripAnsi(block);
    expect(text).toContain("- a + b - 1");
    expect(text).toContain("+ a + b");
  });
});


