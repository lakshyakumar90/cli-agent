/**
 * Agents.
 *
 * An agent is a model, a prompt and a set of tools under a name. The main
 * agent is the one you are talking to; the others are profiles you can
 * switch to, and the ones a sub-agent can be given.
 *
 * They live in ~/.myagent/agents.json, so they are yours to change.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgentProfile {
  /** The name the user types. */
  name: string;
  /** The "provider/model" ref. */
  model: string;
  /** The system prompt. */
  system?: string;
  /** The tools it may use. All of them when this is left out. */
  tools?: string[];
  /** What it is for, shown in the list. */
  description?: string;
}

/** Where the agents are kept. */
export function defaultAgentsPath(): string {
  return join(homedir(), ".myagent", "agents.json");
}

/** The agent you get when nothing else is chosen. */
export const DEFAULT_AGENT: AgentProfile = {
  name: "main",
  model: "",
  description: "The agent you are talking to.",
};

/**
 * The agents that are configured.
 *
 * A file that is not there, or not readable, means there are none — that is
 * not an error, it just means nobody has written one.
 */
export async function loadAgents(
  path: string = defaultAgentsPath(),
): Promise<AgentProfile[]> {
  try {
    const content = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const profile = entry as Partial<AgentProfile>;
      if (typeof profile.name !== "string" || typeof profile.model !== "string") {
        return [];
      }
      return [profile as AgentProfile];
    });
  } catch {
    return [];
  }
}
