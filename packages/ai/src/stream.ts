/**
 * The shared streaming call.
 *
 * Every provider adapter takes the same request, so this is the only place
 * that fills in the defaults. The same loop works for every backend, which is
 * the point of the provider layer.
 */

import type {
  Event,
  Msg,
  Provider,
  StopReason,
  StreamRequest,
  ToolSpec,
  Usage,
} from "./types.js";

export interface StreamOptions {
  /** Model id as the provider knows it. */
  model: string;
  /** System prompt. */
  system?: string;
  /** Conversation so far. */
  messages?: Msg[];
  /** Tools the model may call. */
  tools?: ToolSpec[];
  /** Cancels the request. */
  signal?: AbortSignal;
}

/** Stream a response from one provider. */
export function stream(
  provider: Provider,
  options: StreamOptions,
): AsyncIterable<Event> {
  const request: StreamRequest = {
    model: options.model,
    system: options.system ?? "",
    messages: options.messages ?? [],
    tools: options.tools ?? [],
    signal: options.signal ?? new AbortController().signal,
  };
  return provider.stream(request);
}

export interface CollectedText {
  /** Every text delta, concatenated. */
  text: string;
  /** Thinking deltas, concatenated. */
  thinking: string;
  /** Usage reported by the provider, when it reported any. */
  usage?: Usage;
  /** Why the model stopped. */
  stop?: StopReason;
  /** Tool calls the model asked for. */
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
}

/**
 * Drain a stream into a single result. Handy for `--print` mode and for
 * tests; the agent loop consumes the events instead.
 */
export async function collectText(
  events: AsyncIterable<Event>,
): Promise<CollectedText> {
  const result: CollectedText = { text: "", thinking: "", toolCalls: [] };

  for await (const event of events) {
    switch (event.t) {
      case "text":
        result.text += event.delta;
        break;
      case "thinking":
        result.thinking += event.delta;
        break;
      case "toolCall":
        result.toolCalls.push({
          id: event.call.id,
          name: event.call.name,
          args: event.call.args,
        });
        break;
      case "done":
        result.usage = event.usage;
        result.stop = event.stop;
        break;
    }
  }

  return result;
}
