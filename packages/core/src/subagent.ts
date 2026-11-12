/**
 * Sub-agents.
 *
 * A sub-agent is the same loop with its own transcript: it gets its own
 * tools and its own prompt, and it yields the same events, so the parent
 * reads one stream and sees everything the sub-agent did.
 *
 * The parent's transcript stays clean — the sub-agent's messages never enter
 * it — and the parent decides what to keep from the summary.
 */

import { run } from "./loop.js";
import { createState, type AgentEvent, type AgentState } from "./types.js";
import type { Tool } from "@cli-agent/tools";

export interface SubAgentOptions {
  /** The agent that spawns this one. */
  parent: AgentState;
  /** What the sub-agent should do. */
  prompt: string;
  /** Cancels the sub-agent. */
  signal: AbortSignal;
  /** The sub-agent's tools. Defaults to the parent's. */
  tools?: Tool[];
  /** The sub-agent's system prompt. Defaults to the parent's. */
  system?: string;
  /** The model to use. Defaults to the parent's. */
  model?: string;
}

/**
 * Run a sub-agent.
 *
 * The events are the loop's events, unchanged: the parent can forward them
 * to the terminal, to the JSON stream, or read the summary.
 */
export async function* runSubAgent(
  options: SubAgentOptions,
): AsyncGenerator<AgentEvent> {
  const { parent, prompt, signal } = options;

  const system = options.system ?? parent.system;
  const state = createState(parent.provider, {
    model: options.model ?? parent.model,
    tools: options.tools ?? parent.tools,
    ...(system === undefined ? {} : { system }),
    ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
  });

  yield* run(state, prompt, signal);
}
