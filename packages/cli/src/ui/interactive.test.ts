import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { createState, type AgentState } from "@cli-agent/core";
import { InteractiveUi } from "./interactive.js";

/** A provider that answers slowly, so there is a turn to interrupt. */
function slowProvider(): Provider {
  return {
    id: "slow",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      yield { t: "text", delta: "thinking about it" };
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      if (request.signal.aborted) {
        throw new Error("aborted");
      }
      yield { t: "text", delta: " and here is the answer" };
      yield {
        t: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
        stop: "end",
      };
    },
  };
}

function collector(): NodeJS.WritableStream & { text: string } {
  let text = "";
  const stream: {
    text: string;
    write(chunk: string | Uint8Array): boolean;
    end(): void;
    on(): typeof stream;
    once(): typeof stream;
    emit(): boolean;
    removeListener(): typeof stream;
  } = {
    get text() {
      return text;
    },
    write(chunk: string | Uint8Array): boolean {
      text += chunk.toString();
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

function stateWith(provider: Provider): AgentState {
  return createState(provider, { model: "test-model" });
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("the interactive session", () => {
  it("answers what the user typed", async () => {
    const input = new PassThrough();
    const out = collector();

    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(): AsyncGenerator<Event> {
        yield { t: "text", delta: "hello there" };
        yield {
          t: "done",
          usage: { inputTokens: 5, outputTokens: 2 },
          stop: "end",
        };
      },
    };

    const ui = new InteractiveUi({
      state: stateWith(provider),
      out,
      err: collector(),
      input,
      model: "test/test-model",
      permissionMode: "ask",
      cwd: process.cwd(),
    });

    const running = ui.run();
    input.write("hello\n");
    await wait(500);
    input.write("/exit\n");

    expect(await running).toBe(0);
    expect(out.text).toContain("hello there");
    // The status line says what the turn cost.
    expect(out.text).toContain("test-model");
  });

  it("interrupts the turn when Esc is pressed", async () => {
    const input = new PassThrough();
    const out = collector();

    const ui = new InteractiveUi({
      state: stateWith(slowProvider()),
      out,
      err: collector(),
      input,
      model: "test/test-model",
      permissionMode: "ask",
      cwd: process.cwd(),
    });

    const running = ui.run();
    input.write("hello\n");
    await wait(150);
    input.write("\x1b"); // Esc
    await wait(500);
    input.write("/exit\n");

    await running;

    expect(out.text).toContain("interrupted");
    // The answer that would have come after the interrupt is not there.
    expect(out.text).not.toContain("here is the answer");
  });

  it("cycles the permission mode with Shift+Tab", async () => {
    const input = new PassThrough();
    const out = collector();

    const ui = new InteractiveUi({
      state: stateWith(slowProvider()),
      out,
      err: collector(),
      input,
      model: "test/test-model",
      permissionMode: "ask",
      cwd: process.cwd(),
    });

    const running = ui.run();
    await wait(100);
    input.write("\x1b[Z"); // Shift+Tab
    await wait(100);
    input.write("/exit\n");

    await running;

    expect(out.text).toContain("permission mode:");
    expect(out.text).toContain("auto-edit");
  });
});


