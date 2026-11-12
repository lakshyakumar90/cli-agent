/**
 * Context building.
 *
 * For now this is the whole request: the system prompt, the transcript and
 * the tools. Phase 5 replaces it with budgeting — trimming the transcript to
 * the model's context window, summarising the middle, keeping the ends.
 */

import type { Msg, ToolSpec } from "@cli-agent/ai";
import { toToolSpec } from "@cli-agent/tools";
import type { AgentState } from "./types.js";

/** What a provider needs for one turn. */
export interface Context {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
}

export const DEFAULT_SYSTEM = [
  "You are a coding agent.",
  "Work in the user's repository, use the tools you are given, and keep the",
  "transcript short: do not repeat yourself and do not describe what you are",
  "about to do, just do it.",
].join(" ");

export function buildContext(state: AgentState): Context {
  return {
    model: state.model,
    system: state.system ?? DEFAULT_SYSTEM,
    // A snapshot: the loop keeps appending to the transcript, and the
    // provider must see the conversation as it was when the request was made.
    messages: [...state.messages],
    tools: state.tools.map(toToolSpec),
  };
}
