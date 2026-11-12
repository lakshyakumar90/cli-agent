/**
 * The agent's state and the events it emits.
 */

import type {
  Block,
  Msg,
  Provider,
  StopReason,
  ToolCall,
  Usage,
} from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";

/**
 * One assistant turn, while it is being built.
 *
 * `Msg` is a union (a user message carries plain text, an assistant message
 * carries blocks), so the turn has its own type while it is being filled in.
 */
export interface AssistantTurn {
  role: "assistant";
  content: Block[];
  usage?: Usage;
}

/** A tool's answer, on its way back to the model. */
export interface ToolResultMsg {
  role: "tool";
  callId: string;
  content: string;
  isError?: boolean;
}

/**
 * Everything the loop needs to keep a conversation going.
 *
 * `messages` is the transcript: plain JSON, so a session can be saved and
 * replayed later.
 */
export interface AgentState {
  /** The backend that answers. */
  provider: Provider;
  /** The model id, as the provider knows it. */
  model: string;
  /** The tools the model may call. */
  tools: Tool[];
  /** The conversation so far. */
  messages: Msg[];
  /** The system prompt. */
  system?: string;
  /** Directory the tools work in. */
  cwd?: string;
}

/**
 * What the loop yields.
 *
 * The CLI, a JSON mode and a sub-agent all read this stream, so it carries
 * everything they need and nothing they have to parse out of text.
 */
export type AgentEvent =
  /** A piece of the answer. */
  | { t: "text"; delta: string }
  /** A piece of the model's reasoning. */
  | { t: "thinking"; delta: string }
  /** The model asked for this tool; the loop runs it when the turn ends. */
  | { t: "toolStart"; call: ToolCall }
  /** The tool finished. */
  | { t: "toolEnd"; call: ToolCall; output: string; isError?: boolean }
  /** The agent is done. */
  | { t: "done"; stop: StopReason; turns: number; usage: Usage };

/** A state with the usual defaults. */
export function createState(
  provider: Provider,
  options: {
    model: string;
    tools?: Tool[];
    messages?: Msg[];
    system?: string;
    cwd?: string;
  },
): AgentState {
  return {
    provider,
    model: options.model,
    tools: options.tools ?? [],
    messages: options.messages ?? [],
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  };
}
