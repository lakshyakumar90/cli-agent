/**
 * The fake provider.
 *
 * A provider that answers what it is told to answer, so a test can say
 * what the model says and what it does. It is the same thing for every
 * test: the loop, the tools, the permissions and the sessions can all be
 * tried without a network and without a key.
 *
 *   const provider = fakeProvider([
 *     { calls: [{ name: "read", args: { path: "a.ts" } }] },
 *     { text: "the file says hello" },
 *   ]);
 *
 * The turns are played back in order. When they run out, the provider
 * answers that it is done.
 */

import type {
  Event,
  ModelInfo,
  Provider,
  StopReason,
  StreamRequest,
  Usage,
} from "./types.js";

/** One turn of the fake model. */
export interface FakeTurn {
  /** What the model says. */
  text?: string;
  /** What the model thinks. */
  thinking?: string;
  /** The tools the model asks for. */
  calls?: Array<{ id?: string; name: string; args?: unknown }>;
  /** The usage it reports. */
  usage?: Usage;
  /** Why it stopped. */
  stop?: StopReason;
  /** It fails with this instead of answering. */
  error?: string;
  /** It waits this long before it answers. */
  delayMs?: number;
}

/** A provider that answers what it is told to answer. */
export interface FakeProvider extends Provider {
  /** The requests it was given. */
  requests: StreamRequest[];
  /** How many turns it has answered. */
  turns: number;
}

export interface FakeOptions {
  /** The id of the provider. Default "fake". */
  id?: string;
  /** The models it says it has. */
  models?: ModelInfo[];
  /** It answers these turns, and then says it is done. */
  turns?: FakeTurn[];
}

/** A provider that plays back the turns it is given. */
export function fakeProvider(
  turns: FakeTurn[] = [],
  options: FakeOptions = {},
): FakeProvider {
  const requests: StreamRequest[] = [];
  let index = 0;

  const provider: FakeProvider = {
    id: options.id ?? "fake",
    requests,
    get turns() {
      return index;
    },
    models: async () => options.models ?? [],
    async *stream(request: StreamRequest): AsyncGenerator<Event> {
      requests.push(request);

      const turn = turns[index];
      index += 1;

      if (turn === undefined) {
        yield {
          t: "done",
          usage: { inputTokens: 0, outputTokens: 0 },
          stop: "end",
        };
        return;
      }

      if (turn.delayMs !== undefined && turn.delayMs > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, turn.delayMs);
          request.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }

      if (turn.error !== undefined) {
        throw new Error(turn.error);
      }

      if (turn.thinking !== undefined) {
        yield { t: "thinking", delta: turn.thinking };
      }

      if (turn.text !== undefined) {
        for (const piece of turn.text.match(/.{1,4}/gs) ?? []) {
          yield { t: "text", delta: piece };
        }
      }

      for (const [callIndex, call] of (turn.calls ?? []).entries()) {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: call.id ?? `call_${index}_${callIndex}`,
            name: call.name,
            args: call.args ?? {},
          },
        };
      }

      yield {
        t: "done",
        usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
        stop: turn.stop ?? ((turn.calls ?? []).length > 0 ? "tool" : "end"),
      };
    },
  };

  return provider;
}

/** The events a provider gives, as one list. */
export async function collectEvents(
  provider: Provider,
  request: StreamRequest,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}
