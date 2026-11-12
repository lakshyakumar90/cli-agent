/**
 * Test helpers: a provider that plays back scripted turns, and a fake echo
 * tool. Shared by the loop tests.
 */

import type {
  Event,
  ModelInfo,
  Provider,
  StopReason,
  StreamRequest,
  Usage,
} from "@cli-agent/ai";
import type { Tool, ToolContext } from "@cli-agent/tools";
import { createState, type AgentState } from "./types.js";

export interface ScriptedTurn {
  /** Text the model says. */
  text?: string;
  /** Tools the model asks for. */
  calls?: Array<{ id: string; name: string; args: unknown }>;
  usage?: Usage;
  stop?: StopReason;
}

export interface ScriptedProvider extends Provider {
  requests: StreamRequest[];
}

export function scriptedProvider(turns: ScriptedTurn[]): ScriptedProvider {
  const requests: StreamRequest[] = [];
  let index = 0;

  return {
    id: "scripted",
    requests,
    models: async (): Promise<ModelInfo[]> => [],
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

      for (const piece of (turn.text ?? "").match(/.{1,4}/gs) ?? []) {
        yield { t: "text", delta: piece };
      }
      for (const call of turn.calls ?? []) {
        yield {
          t: "toolCall",
          call: {
            type: "toolCall",
            id: call.id,
            name: call.name,
            args: call.args,
          },
        };
      }
      yield {
        t: "done",
        usage: turn.usage ?? { inputTokens: 10, outputTokens: 5 },
        stop: turn.stop ?? (turn.calls === undefined ? "end" : "tool"),
      };
    },
  };
}

export interface EchoTool extends Tool {
  calls: Array<{ args: any; ctx: ToolContext }>;
}

export function echoTool(onRun?: (args: any, ctx: ToolContext) => void): EchoTool {
  const calls: Array<{ args: any; ctx: ToolContext }> = [];
  return {
    name: "echo",
    description: "Echoes the text back.",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    calls,
    async run(args: any, ctx: ToolContext) {
      calls.push({ args, ctx });
      onRun?.(args, ctx);
      return { output: `echo: ${args.text}` };
    },
  };
}

export async function collect(
  events: AsyncIterable<import("./types.js").AgentEvent>,
): Promise<import("./types.js").AgentEvent[]> {
  const collected: import("./types.js").AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

export function stateWith(
  provider: Provider,
  tools: Tool[] = [],
  overrides: Partial<AgentState> = {},
): AgentState {
  return {
    ...createState(provider, { model: "test-model", tools }),
    ...overrides,
  };
}
