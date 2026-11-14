import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { createState, type AgentState } from "@cli-agent/core";
import { InteractiveUi } from "./interactive.js";

/**
 * A provider that answers slowly, so there is a turn to interrupt.
 *
 * It stops the moment the turn is aborted, the way a real provider does,
 * so the test does not have to wait out the whole delay.
 */
function slowProvider(delay = 3_000): Provider {
  return {
    id: "slow",
    models: async (): Promise<ModelInfo[]> => [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      yield { t: "text", delta: "thinking about it" };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        request.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
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

  it("runs a command of the user's own", async () => {
    const input = new PassThrough();
    const out = collector();
    const asked: string[] = [];

    const provider: Provider = {
      id: "test",
      models: async () => [],
      async *stream(request: StreamRequest): AsyncGenerator<Event> {
        const last = request.messages[request.messages.length - 1];
        asked.push(
          last === undefined || last.role !== "user" ? "" : last.content,
        );
        yield { t: "text", delta: "deployed" };
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
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
      commands: [
        {
          name: "/deploy",
          description: "Deploy the app",
          argumentHint: "<where>",
          path: "/tmp/deploy.md",
          content: "Deploy to $1.",
        },
      ],
    });

    const running = ui.run();
    input.write("/deploy staging\n");
    await wait(500);
    input.write("/exit\n");

    await running;

    // The command sent its own prompt, with the argument in it.
    expect(asked.some((prompt) => prompt.includes("Deploy to staging."))).toBe(
      true,
    );
    expect(out.text).toContain("deployed");
  });

  it("lists the commands, and the ones of the user", async () => {
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
      commands: [
        {
          name: "/deploy",
          description: "Deploy the app",
          argumentHint: "<where>",
          path: "/tmp/deploy.md",
          content: "Deploy to $1.",
        },
      ],
    });

    const running = ui.run();
    input.write("/help\n");
    await wait(300);
    input.write("/exit\n");

    await running;

    expect(out.text).toContain("/model");
    expect(out.text).toContain("/deploy");
    expect(out.text).toContain("Deploy the app");
  });
});


