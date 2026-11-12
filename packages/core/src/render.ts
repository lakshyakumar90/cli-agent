/**
 * Consumers of the event stream.
 *
 * The loop never prints: it yields events, and every surface reads that one
 * stream its own way. A terminal prints text, a script reads JSON lines, and
 * a parent agent reads the summary of what a sub-agent did.
 */

import type { AgentEvent, LoopEnd } from "./types.js";
import type { StopReason, ToolCall, Usage } from "@cli-agent/ai";

/** One event, as text. `undefined` means "nothing to show". */
export function renderEvent(event: AgentEvent): string | undefined {
  switch (event.t) {
    case "text":
      return event.delta;

    case "thinking":
      // Reasoning is a side channel: it is shown, but it is not the answer.
      return event.delta.length > 0 ? `· ${event.delta}` : undefined;

    case "toolStart":
      return `\n> ${event.call.name}(${safeArgs(event.call)})\n`;

    case "toolEnd":
      return `< ${event.call.name} ${event.isError === true ? "failed:" : ""}${event.output}\n`;

    case "retry":
      return `\n! retry ${event.attempt} in ${event.delayMs}ms: ${event.reason}\n`;

    case "done":
      return undefined;
  }
}

/** The stream, as text. */
export async function* renderText(
  events: AsyncIterable<AgentEvent>,
): AsyncGenerator<string> {
  for await (const event of events) {
    const text = renderEvent(event);
    if (text !== undefined) yield text;
  }
}

/**
 * The stream, as JSON Lines: one event per line.
 *
 * This is what `--json` and `--rpc` write, so an editor or a script can
 * follow the agent without parsing prose.
 */
export async function* renderJsonLines(
  events: AsyncIterable<AgentEvent>,
): AsyncGenerator<string> {
  for await (const event of events) {
    yield `${JSON.stringify(event)}\n`;
  }
}

/** What a parent agent wants to know about a run. */
export interface AgentSummary {
  /** Everything the model said. */
  text: string;
  /** Everything the model thought. */
  thinking: string;
  /** The tools it called. */
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  /** The usage of the last turn. */
  usage?: Usage;
  /** The provider's stop reason. */
  stop?: StopReason;
  /** Why the loop stopped. */
  reason?: LoopEnd;
}

/**
 * Drain a stream into a summary.
 *
 * This is how a parent agent consumes a sub-agent: it reads the same events
 * and keeps what it needs.
 */
export async function collectAgent(
  events: AsyncIterable<AgentEvent>,
): Promise<AgentSummary> {
  const summary: AgentSummary = { text: "", thinking: "", toolCalls: [] };

  for await (const event of events) {
    switch (event.t) {
      case "text":
        summary.text += event.delta;
        break;
      case "thinking":
        summary.thinking += event.delta;
        break;
      case "toolStart":
        summary.toolCalls.push({
          id: event.call.id,
          name: event.call.name,
          args: event.call.args,
        });
        break;
      case "toolEnd":
      case "retry":
        break;
      case "done":
        summary.usage = event.usage;
        summary.stop = event.stop;
        summary.reason = event.reason;
        break;
    }
  }

  return summary;
}

/** The tool arguments, as a short string. */
function safeArgs(call: ToolCall): string {
  try {
    const args = JSON.stringify(call.args ?? {});
    return args.length > 80 ? `${args.slice(0, 77)}...` : args;
  } catch {
    return "";
  }
}
