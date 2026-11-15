import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { stripAnsi } from "./colors.js";
import { InteractiveUi } from "./interactive.js";
import type { AvailableModel } from "../catalog.js";

/** A stream that collects what is written to it. */
function collector(): NodeJS.WritableStream & { text: string } {
  const stream: {
    text: string;
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on(): typeof stream;
    once(): typeof stream;
    emit(): boolean;
    removeListener(): typeof stream;
  } = {
    text: "",
    write(chunk: string | Uint8Array): boolean {
      stream.text += chunk.toString();
      return true;
    },
    end(): void {
      /* nothing to close */
    },
    on(): typeof stream {
      return stream;
    },
    once(): typeof stream {
      return stream;
    },
    emit(): boolean {
      return false;
    },
    removeListener(): typeof stream {
      return stream;
    },
  };
  return stream as unknown as NodeJS.WritableStream & { text: string };
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The models the picker offers. */
const models: AvailableModel[] = [
  { ref: "codex/gpt-6.1-sol", provider: "codex", id: "gpt-6.1-sol", free: false },
  { ref: "codex/gpt-6.1-terra", provider: "codex", id: "gpt-6.1-terra", free: false },
  { ref: "openrouter/some/free:free", provider: "openrouter", id: "some/free:free", free: true },
];

/** A provider that answers. */
const provider: Provider = {
  id: "test",
  models: async (): Promise<ModelInfo[]> => [],
  async *stream(_request: StreamRequest): AsyncGenerator<Event> {
    yield { t: "text", delta: "ok" };
    yield { t: "done", usage: { inputTokens: 1, outputTokens: 1 }, stop: "end" };
  },
};

describe("the model picker", () => {
  it("opens a list of the models that can be used", async () => {
    const input = new PassThrough();
    const out = collector();

    const ui = new InteractiveUi({
      state: {
        provider,
        model: "test/model",
        tools: [],
        messages: [],
      } as never,
      out,
      err: collector(),
      input,
      model: "test/model",
      permissionMode: "ask",
      cwd: process.cwd(),
      onModels: async () => models,
    });

    const running = ui.run();
    input.write("/model\n");
    await wait(300);

    const text = stripAnsi(out.text);

    // The list is there, with the models of each provider.
    expect(text).toContain("codex");
    expect(text).toContain("gpt-6.1-sol");
    expect(text).toContain("gpt-6.1-terra");
    expect(text).toContain("openrouter");
    expect(text).toContain("some/free:free");

    // The one that is on is marked.
    expect(text).toContain("▶");

    // Node holds a lone escape back until it knows the sequence is over.
    input.write("\x1b");
    await wait(700);
    input.write("/exit\n");
    await running;
  });

  it("moves the selection and takes the model that is on", async () => {
    const input = new PassThrough();
    const out = collector();

    const chosen: string[] = [];

    const ui = new InteractiveUi({
      state: {
        provider,
        model: "test/model",
        tools: [],
        messages: [],
      } as never,
      out,
      err: collector(),
      input,
      model: "test/model",
      permissionMode: "ask",
      cwd: process.cwd(),
      onModels: async () => models,
      onModel: async (ref) => {
        chosen.push(ref);
        return provider;
      },
    });

    const running = ui.run();
    input.write("/model\n");
    await wait(300);

    // Down once, and take it.
    input.write("\x1b[B");
    await wait(100);
    input.write("\r");
    await wait(300);

    expect(chosen).toEqual(["codex/gpt-6.1-terra"]);
    expect(stripAnsi(out.text)).toContain("now using");

    input.write("/exit\n");
    await running;
  });

  it("puts the list away when the user presses Escape", async () => {
    const input = new PassThrough();
    const out = collector();

    const chosen: string[] = [];

    const ui = new InteractiveUi({
      state: {
        provider,
        model: "test/model",
        tools: [],
        messages: [],
      } as never,
      out,
      err: collector(),
      input,
      model: "test/model",
      permissionMode: "ask",
      cwd: process.cwd(),
      onModels: async () => models,
      onModel: async (ref) => {
        chosen.push(ref);
        return provider;
      },
    });

    const running = ui.run();
    input.write("/model\n");
    await wait(300);
    input.write("\x1b");
    await wait(700);

    // Nothing was chosen.
    expect(chosen).toEqual([]);

    input.write("/exit\n");
    await running;
  });

  it("opens a list of the files when the user asks for one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cli-agent-picker-"));
    await writeFile(join(directory, "alpha.ts"), "a", "utf8");
    await writeFile(join(directory, "beta.ts"), "b", "utf8");

    const input = new PassThrough();
    const out = collector();

    const ui = new InteractiveUi({
      state: {
        provider,
        model: "test/model",
        tools: [],
        messages: [],
      } as never,
      out,
      err: collector(),
      input,
      model: "test/model",
      permissionMode: "ask",
      cwd: directory,
    });

    const running = ui.run();
    input.write("@al\t");
    await wait(400);

    const text = stripAnsi(out.text);

    // The list is there, with the file that matches.
    expect(text).toContain("pick a file");
    expect(text).toContain("alpha.ts");
    expect(text).not.toContain("beta.ts");

    input.write("\x1b");
    await wait(700);
    // Clear the line the picker left behind, and leave.
    input.write("\x15");
    await wait(100);
    input.write("/exit\n");
    await running;

    await rm(directory, { recursive: true, force: true });
  });
});
