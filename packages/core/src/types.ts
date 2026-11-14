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
import type { ActiveContext } from "./skills.js";
import type { CheckpointStore } from "./checkpoints.js";

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
  /** The system prompt. It is the base layer of the layered prompt. */
  system?: string;
  /** Directory the tools work in. */
  cwd?: string;
  /** The loop's limits. */
  limits?: AgentLimits;
  /** The skills, the plan and the checklist: the dynamic layer. */
  active?: ActiveContext;
  /** Where the conversation is written down, when it is written down at all. */
  journal?: Journal;
  /** The snapshots that make an edit undoable. */
  checkpoints?: CheckpointStore;
  /** How deep the agent is: the lead is 0, its workers 1. */
  depth?: number;
  /** How far off the token estimate was, so the next one is closer. */
  tokens?: TokenCalibration;
}

/**
 * Where a conversation is written down.
 *
 * The journal is append-only: every message is one more entry, and the entry
 * names the one before it, so the sessions of a project are a tree.
 */
export interface Journal {
  /** Append a message; returns the entry id. */
  append(
    msg: Msg,
    options?: { compacted?: boolean; model?: string },
  ): Promise<string>;
}

/**
 * The correction to the token estimate.
 *
 * The provider says how many tokens it really used; the ratio between that
 * and the estimate is applied to the next estimate.
 */
export interface TokenCalibration {
  /** Real tokens over estimated tokens. */
  ratio: number;
}

/** The loop's guards. */
export interface AgentLimits {
  /**
   * How many times the model may be called for one prompt. Default 25.
   * The loop stops with `"max-turns"` when the limit is reached.
   */
  maxTurns?: number;
  /**
   * How often the same tool call may repeat in one prompt. Default 3: the
   * same call may happen three times, the fourth stops the loop with
   * `"repeated-call"`.
   */
  maxRepeatedCalls?: number;
  /** How many times a failed provider call is retried. Default 3. */
  maxRetries?: number;
  /**
   * The context window to assume, when the model table does not know the
   * model. Without it, a model the table does not know has no budget, and
   * the conversation is never compacted.
   */
  contextWindow?: number;
  /** What to keep back for the answer. Defaults to the model's own limit. */
  outputReserve?: number;
  /**
   * The most lines a tool result may have. Longer results keep their head
   * and their tail. Default 60.
   */
  maxToolLines?: number;
  /** The most characters a tool result may have. Default 4000. */
  maxToolChars?: number;
  /**
   * The tokens the agent may use in one prompt. When it is used up, the
   * loop stops with `"budget-exhausted"`.
   */
  tokenBudget?: number;
  /**
   * The US dollars the agent may spend in one prompt. When it is used up,
   * the loop stops with `"budget-exhausted"`.
   */
  costBudget?: number;
  /**
   * How many turns a tool result stays readable. An older one is replaced by
   * a one-line stub. Default 3.
   */
  keepToolTurns?: number;
  /** The first backoff wait. Default 500ms. */
  retryDelayMs?: number;
  /** The longest backoff wait. Default 8s. */
  maxRetryDelayMs?: number;
}

export const DEFAULT_LIMITS: Required<
  Pick<
    AgentLimits,
    | "maxTurns"
    | "maxRepeatedCalls"
    | "maxRetries"
    | "retryDelayMs"
    | "maxRetryDelayMs"
  >
> & AgentLimits = {
  maxTurns: 25,
  maxRepeatedCalls: 3,
  maxRetries: 3,
  retryDelayMs: 500,
  maxRetryDelayMs: 8_000,
};

/** Why the loop stopped. */
export type LoopEnd =
  /** The model answered and asked for nothing else. */
  | "end"
  /** The model hit its output limit. */
  | "length"
  /** The turn limit was reached. */
  | "max-turns"
  /** The model kept asking for the same thing. */
  | "repeated-call"
  /** The user pressed Esc. */
  | "aborted"
  /** The token budget was used up. */
  | "budget-exhausted";

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
  /** The provider call failed and is being tried again. */
  | { t: "retry"; attempt: number; delayMs: number; reason: string }
  /**
   * The conversation was summarised because it no longer fit.
   */
  | { t: "compacted"; tokens: number; budget: number }
  /** The agent is done. */
  | { t: "done"; stop: StopReason; turns: number; usage: Usage; reason: LoopEnd };

/** A state with the usual defaults. */
export function createState(
  provider: Provider,
  options: {
    model: string;
    tools?: Tool[];
    messages?: Msg[];
    system?: string;
    cwd?: string;
    /** The loop's limits. */
    limits?: AgentLimits;
    /** The skills, the plan and the checklist: the dynamic layer. */
    active?: ActiveContext;
    /** Where the conversation is written down. */
    journal?: Journal;
    /** The snapshots that make an edit undoable. */
    checkpoints?: CheckpointStore;
    /** How deep the agent is: the lead is 0, its workers 1. */
    depth?: number;
  },
): AgentState {
  return {
    provider,
    model: options.model,
    tools: options.tools ?? [],
    messages: options.messages ?? [],
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.active === undefined ? {} : { active: options.active }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    ...(options.checkpoints === undefined
      ? {}
      : { checkpoints: options.checkpoints }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
  };
}
