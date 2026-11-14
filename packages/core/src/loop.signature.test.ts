import { describe, expect, it } from "vitest";
import type { Event, ModelInfo, Provider, StreamRequest } from "@cli-agent/ai";
import { z } from "zod";
import { accumulate, run } from "./loop.js";
import type { AssistantTurn } from "./types.js";
import { collect, scriptedProvider, stateWith } from "./loop.test-helpers.js";

describe("a signature on a call", () => {
  it("is kept on the block that goes back to the model", () => {
    const turn: AssistantTurn = { role: "assistant", content: [] };

    accumulate(turn, {
      t: "toolCall",
      call: {
        type: "toolCall",
        id: "c1",
        name: "read",
        args: { path: "a.ts" },
        signature: "the-signature",
      },
    });

    // Gemini signs a call, and refuses the next request when the
    // signature is not sent back with it.
    expect(turn.content[0]).toEqual({
      type: "toolCall",
      id: "c1",
      name: "read",
      args: { path: "a.ts" },
      signature: "the-signature",
    });
  });

  it("is left out when there is none", () => {
    const turn: AssistantTurn = { role: "assistant", content: [] };

    accumulate(turn, {
      t: "toolCall",
      call: {
        type: "toolCall",
        id: "c1",
        name: "read",
        args: { path: "a.ts" },
      },
    });

    expect(turn.content[0]).not.toHaveProperty("signature");
  });

  it("reaches the model in the transcript", async () => {
    const provider: Provider = {
      id: "test",
      models: async (): Promise<ModelInfo[]> => [],
      async *stream(request: StreamRequest): AsyncGenerator<Event> {
        if (request.messages.length > 1) {
          const last = request.messages[request.messages.length - 1];
          if (last?.role === "assistant") {
            const block = last.content[0];
            if (block?.type === "toolCall") {
              yield { t: "text", delta: `signature: ${block.signature ?? "none"}` };
            }
          }
        }
        yield {
          t: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
          stop: "end",
        };
      },
    };

    const signed = scriptedProvider([
      {
        calls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
      },
      { text: "done" },
    ]);

    // The provider that signs its calls.
    const signing: Provider = {
      ...signed,
      async *stream(request: StreamRequest): AsyncGenerator<Event> {
        for await (const event of signed.stream(request)) {
          if (event.t === "toolCall") {
            yield {
              ...event,
              call: { ...event.call, signature: "signed-call" },
            };
            continue;
          }
          yield event;
        }
      },
    };

    const state = stateWith(signing, [
      {
        name: "echo",
        description: "Echoes.",
        schema: z.object({ text: z.string() }),
        async run() {
          return { output: "echo" };
        },
      },
    ]);

    await collect(run(state, "go", new AbortController().signal));

    const turn = state.messages.find(
      (message) => message.role === "assistant",
    );
    const block =
      turn?.role === "assistant" ? turn.content[0] : undefined;

    expect(block?.type === "toolCall" ? block.signature : undefined).toBe(
      "signed-call",
    );
  });
});
