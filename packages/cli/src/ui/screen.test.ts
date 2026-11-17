import { Terminal } from "@xterm/headless";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createState } from "@cli-agent/core";
import type { Event } from "@cli-agent/ai";
import { InteractiveUi } from "./interactive.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});
function setup(
  models?: Array<{ ref: string; provider: string; id: string; free: boolean }>,
  stream?: AsyncGenerator<Event>,
) {
  const input = new PassThrough();
  const out = new PassThrough();
  Object.assign(out, { columns: 100, rows: 30 });
  const terminal = new Terminal({
    cols: 100,
    rows: 30,
    scrollback: 1000,
    allowProposedApi: true,
  });
  let writes = Promise.resolve();
  out.on("data", (chunk: Buffer) => {
    writes = writes.then(
      () => new Promise<void>((resolve) => terminal.write(chunk, resolve)),
    );
  });
  const provider = {
    id: "test",
    models: async () => [],
    async *stream() {
      if (stream !== undefined) {
        yield* stream;
        return;
      }
      yield { t: "thinking" as const, delta: "a private thought" };
      yield { t: "text" as const, delta: "A single answer" };
      yield {
        t: "done" as const,
        stop: "end" as const,
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    },
  };
  const ui = new InteractiveUi({
    state: createState(provider, { model: "model" }),
    model: "test/model",
    permissionMode: "ask",
    cwd: process.cwd(),
    input,
    out,
    err: out,
    onModel: async () => provider,
    onModels: async () =>
      models ??
      Array.from({ length: 63 }, (_, i) => ({
        ref: `test/model-${i}`,
        provider: "test",
        id: `model-${i}`,
        free: false,
      })),
  });
  void ui.run();
  open.push(async () => {
    await ui.close();
    await writes;
    terminal.dispose();
    input.destroy();
    out.destroy();
  });
  const screen = async (): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writes;
    return Array.from(
      { length: terminal.buffer.active.length },
      (_, i) =>
        terminal.buffer.active.getLine(i)?.translateToString(true) ?? "",
    ).join("\n");
  };
  return { ui, input, out, terminal, screen };
}
describe("rendered terminal", () => {
  it("tells the question of the user from the answer of the agent", async () => {
    const { ui, input, screen } = setup();
    input.write("what does the code do?\r");
    await vi.waitFor(
      () =>
        expect(ui.view.blocks.some((b) => b.text === "A single answer")).toBe(
          true,
        ),
      { timeout: 10000 },
    );
    const text = await screen();

    // The question is at the margin and marked; the answer is indented and
    // says which model gave it.
    expect(text).toContain("› what does the code do?");
    expect(text).toMatch(/\n\s+test\/model\n/);
    expect(text).toContain("A single answer");
    // The two never look alike.
    const question = text.indexOf("what does the code do?");
    const answer = text.indexOf("A single answer");
    expect(question).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(question);
    expect(text.slice(question, answer)).not.toContain("A single answer");
  });

  it("shows the thought of the model as a thought", async () => {
    const { ui, input, screen } = setup();
    input.write("hello\r");
    await vi.waitFor(
      () =>
        expect(ui.view.blocks.some((b) => b.kind === "thinking")).toBe(true),
      { timeout: 10000 },
    );
    const text = await screen();
    expect(text).toContain("thinking");
    expect(text).toContain("a private thought");
    // The thought is not the answer: it is marked, and it is apart from it.
    expect(text).not.toContain("Thinking\n");
  });

  it("draws the question of a permission as a box with the answers in it", async () => {
    const { ui, input, screen } = setup();
    const approval = ui.permissions.authorize(
      {
        tool: "bash",
        effect: "execute",
        args: { command: "git status" },
        subject: "git status",
        reason: "See what changed",
      },
      new AbortController().signal,
    );
    await vi.waitFor(async () =>
      expect(await screen()).toContain("Permission required"),
    );
    const text = await screen();

    // It is a box, not a line of the answer.
    expect(text).toContain("╭─ Permission required");
    expect(text).toContain("╰");
    expect(text).toContain("See what changed");
    expect(text).toContain("Allow once");
    expect(text).toContain("Deny");
    expect(text).toContain("Esc denies");

    // The choice that is picked is the one the cursor is on.
    expect(text).toContain("› Allow once");

    // The answer is given, and the dialog goes away.
    input.write("\r");
    expect(await approval).toBe(true);
    await vi.waitFor(async () =>
      expect(await screen()).not.toContain("Permission required"),
    );
  });

  it("denies the call when the question is put away with Escape", async () => {
    const { ui, input, screen } = setup();
    const approval = ui.permissions.authorize(
      {
        tool: "bash",
        effect: "execute",
        args: { command: "git status" },
        subject: "git status",
        reason: "See what changed",
      },
      new AbortController().signal,
    );
    await vi.waitFor(async () =>
      expect(await screen()).toContain("Permission required"),
    );
    input.write("\x1b");
    expect(await approval).toBe(false);
  });

  it("keeps the frame inside the screen, however long the answer is", async () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `line ${i} of a very long answer that goes on and on`,
    ).join("\n\n");

    async function* stream(): AsyncGenerator<Event> {
      yield { t: "text" as const, delta: long };
      yield {
        t: "done" as const,
        stop: "end" as const,
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    }

    const { ui, input, terminal, screen } = setup(undefined, stream());
    input.write("a long question\r");
    await vi.waitFor(
      () =>
        expect(ui.view.blocks.some((b) => b.text.includes("line 39"))).toBe(true),
      { timeout: 10000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const text = await screen();

    // The frame is written over the terminal when it is taller than the
    // screen, and the conversation ends up on the screen twice. The frame
    // stays inside the rows, and the conversation that did not fit is said
    // to be above.
    expect(terminal.buffer.active.length).toBeLessThanOrEqual(30);
    expect(text).toContain("lines above");
    expect(text).toContain("line 39 of a very long answer");
  });

  it("shows the models of every provider under its name", async () => {
    const { input, screen } = setup([
      ...Array.from({ length: 20 }, (_, i) => ({
        ref: `openrouter/model-${i}`,
        provider: "openrouter",
        id: `model-${i}`,
        free: true,
      })),
      {
        ref: "opencode-cli/opencode/big-pickle",
        provider: "opencode-cli",
        id: "opencode/big-pickle",
        free: false,
      },
    ]);
    input.write("/model\r");
    await vi.waitFor(async () => expect(await screen()).toContain("OpenRouter"));

    // The name of the provider is on the screen while the list is
    // scrolled, so the models of the OpenCode CLI are never a nameless
    // wall of ids.
    for (let i = 0; i < 25; i++) input.write("\x1b[B");
    await vi.waitFor(async () =>
      expect(await screen()).toContain("OpenCode CLI"),
    );
    expect(await screen()).toContain("opencode/big-pickle");
  });

  it("suspends selectors for approvals, restores their search, and denies on Escape", async () => {
    const { ui, input, screen } = setup();
    input.write("/model\r");
    await vi.waitFor(async () => expect(await screen()).toContain("model-0"));
    input.write("model-12");
    const approval = ui.permissions.authorize(
      {
        tool: "bash",
        effect: "execute",
        args: { command: "echo *" },
        subject: "echo *",
        reason: "Run echo *",
        agentId: "worker-1",
      },
      new AbortController().signal,
    );
    await vi.waitFor(async () =>
      expect(await screen()).toContain("Permission required"),
    );
    input.write("d");
    await vi.waitFor(async () =>
      expect(await screen()).toContain("full details"),
    );
    input.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    input.write("\x1b");
    expect(await approval).toBe(false);
    await vi.waitFor(async () => expect(await screen()).toContain("model-12"));
    expect(ui.view.blocks).toHaveLength(0);
  });
  it("shows model changes in the conversation and opens inspection with the command fallback", async () => {
    const { ui, input, screen } = setup();
    input.write("/model test/other\r");
    await vi.waitFor(async () =>
      expect(await screen()).toContain(
        "Model changed: test/model → test/other",
      ),
    );
    input.write("hello\r");
    await vi.waitFor(
      () =>
        expect(ui.view.blocks.some((b) => b.text === "A single answer")).toBe(
          true,
        ),
      { timeout: 10000 },
    );
    input.write("/inspect\r");
    await vi.waitFor(async () =>
      expect(await screen()).toContain("a private thought"),
    );
    input.write("\x1b");
    await vi.waitFor(async () =>
      expect(await screen()).toContain(
        "Model changed: test/model → test/other",
      ),
    );
  });
  it("reflows selectors and the editor after a terminal resize", async () => {
    const { input, out, terminal, screen } = setup();
    input.write("/model\r");
    await vi.waitFor(async () => expect(await screen()).toContain("model-0"));
    Object.assign(out, { columns: 32, rows: 14 });
    terminal.resize(32, 14);
    out.emit("resize");
    await vi.waitFor(async () =>
      expect(await screen()).toContain("Select Model"),
    );
    input.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    input.write("a draft after resize");
    await vi.waitFor(async () =>
      expect(await screen()).toContain("a draft after resize"),
    );
  });
  it("changes modes 100 times without leaving duplicate rows in scrollback", async () => {
    const { ui, input, screen } = setup();
    for (let i = 0; i < 100; i++) input.write("\x1b[Z");
    await vi.waitFor(() => expect(ui.permissions.mode).toBe("auto-edit"));
    const text = await screen();
    expect(text.match(/permission mode:/g)).toHaveLength(1);
    expect(ui.view.blocks).toHaveLength(0);
    expect(text).not.toContain("yolo");
  });
  it("cleans up model selectors and preserves a draft across inspection", async () => {
    const { ui, input, screen } = setup();
    input.write("/model\r");
    await vi.waitFor(async () => expect(await screen()).toContain("model-0"));
    input.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 40));
    input.write("draft text");
    input.write("\x0f");
    await vi.waitFor(async () =>
      expect(await screen()).toContain("Transcript"),
    );
    input.write("\x1b");
    await vi.waitFor(() => expect(ui.editor.getText()).toBe("draft text"));
    expect(await screen()).not.toContain("model-0");
    expect(ui.view.blocks).toHaveLength(0);
  });
  it("keeps one thinking block when repeatedly inspecting it", async () => {
    const { ui, input, screen } = setup();
    input.write("hello\r");
    await vi.waitFor(
      () =>
        expect(ui.view.blocks.some((b) => b.text === "A single answer")).toBe(
          true,
        ),
      { timeout: 10000 },
    );
    for (let i = 0; i < 3; i++) {
      input.write("\x1bi");
      await new Promise((resolve) => setTimeout(resolve, 30));
      input.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const text = await screen();
    expect(text.match(/A single answer/g)).toHaveLength(1);
    expect(text).toContain("a private thought");
    expect(ui.view.blocks.filter((b) => b.kind === "thinking")).toHaveLength(1);
  });
});
