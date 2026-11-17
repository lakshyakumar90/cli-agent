import { describe, expect, it } from "vitest";
import { UiStore } from "./store.js";
import { Transcript, Selector } from "./components.js";
import { nextPermissionMode } from "./slash.js";
import { visibleWidth } from "@earendil-works/pi-tui";

describe("transcript state", () => {
  it("updates thinking and tool results in place and renders collapsed output", () => {
    const store = new UiStore();
    store.begin("hello");
    store.event({ t: "thinking", delta: "one " });
    store.event({ t: "thinking", delta: "two" });
    const call = {
      type: "toolCall" as const,
      id: "1",
      name: "read",
      args: { path: "a" },
    };
    store.event({ t: "toolStart", call });
    store.event({ t: "toolStart", call });
    store.event({ t: "toolEnd", call, output: "secret tool output" });
    store.event({ t: "toolEnd", call, output: "secret tool output" });
    expect(store.blocks.filter((b) => b.kind === "tool")).toHaveLength(1);
    expect(store.blocks.filter((b) => b.kind === "thinking")).toHaveLength(1);
    expect(store.blocks[1]?.text).toBe("one two");
    expect(new Transcript(store).render(80).join("\n")).not.toContain(
      "secret tool output",
    );
    let mode: "ask" | "auto-edit" | "plan" | "yolo" = "ask";
    for (let i = 0; i < 100; i++) mode = nextPermissionMode(mode);
    expect(store.blocks).toHaveLength(3);
    expect(mode).not.toBe("yolo");
  });
  it("restores model changes at their original conversation boundary", () => {
    const store = new UiStore();
    store.restore(
      [
        { role: "user", content: "before" },
        { role: "user", content: "after" },
      ],
      "s",
      [{ after: 1, from: "a/one", to: "b/two" }],
    );
    expect(store.blocks.map((block) => block.text)).toEqual([
      "before",
      "Model changed: a/one → b/two",
      "after",
    ]);
    expect(
      new Transcript(store)
        .render(24)
        .every((line) => visibleWidth(line) <= 24),
    ).toBe(true);
  });
  it("shows supplied thinking with a bounded preview", () => {
    const store = new UiStore();
    store.begin("go");
    store.event({
      t: "thinking",
      delta: Array.from({ length: 10 }, (_, i) => `thought ${i}`).join("\n"),
    });
    const text = new Transcript(store).render(40).join("\n");
    expect(text).toContain("thought 9");
    expect(text).not.toContain("thought 0");
    expect(text).toContain("4 earlier lines");
  });
  it("keeps repeated text supplied by the model", () => {
    const store = new UiStore();
    store.begin("go");
    store.event({ t: "text", delta: "ha" });
    store.event({ t: "text", delta: "ha" });
    expect(store.blocks.at(-1)?.text).toBe("haha");
  });
  it("fits selectors into narrow terminals and supports search and paging", () => {
    let selected = "";
    const selector = new Selector(
      "Select a model",
      Array.from({ length: 70 }, (_, i) => ({
        value: String(i),
        label: `provider/model-${i}-with-a-long-name`,
        current: i === 50,
      })),
      () => 14,
      (item) => {
        selected = item?.value ?? "";
      },
    );
    expect(selector.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
    selector.handleInput("\r");
    expect(selected).toBe("50");
    selector.handleInput("6");
    selector.handleInput("9");
    selector.handleInput("\r");
    expect(selected).toBe("69");
  });
});
