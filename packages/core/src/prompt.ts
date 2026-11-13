/**
 * The layered system prompt.
 *
 * What the model sees on every turn is built in layers, and the order is
 * the point: the parts that do not change come first, so the provider can
 * cache them and only pay for the part that moved.
 *
 *   [1] the base identity and the rules for using tools   stable
 *   [2] the tool definitions                               stable
 *   [3] the project memory (AGENTS.md, CLAUDE.md)          stable
 *   [4] the environment (where, which branch, when)       changes
 *   [5] the active skills, the plan and the checklist      changes
 *
 * The conversation itself is not in the prompt: it goes as messages, after
 * all of this.
 */

import type { Tool } from "@cli-agent/tools";
import {
  readEnvironment,
  renderEnvironment,
  type Environment,
} from "./environment.js";
import {
  displayMemoryPath,
  findMemoryFiles,
  type MemoryFile,
} from "./memory.js";
import { findSkills, renderActiveContext, type ActiveContext } from "./skills.js";

/** The base identity and the rules for using tools. */
export const BASE_PROMPT = `You are a coding agent working in the user's repository.

How to work:
- Read a file before you change it, and read the tests before you change the code.
- Prefer the edit tool for a change to a file you have read; it is exact, and it fails loudly when the text is not there.
- Keep the change as small as it can be. Do not reformat what you were not asked to touch.
- Run the tests when there are tests, and say what failed when something does.
- Do not guess: if you need to see something, read it.

How to answer:
- Say what you did, briefly, and what the reader should do next.
- Leave the code better than you found it, but only where the task asks for it.`;

/** One layer of the prompt. */
export interface PromptLayer {
  /** Which layer it is. */
  name: string;
  /** The text of the layer. */
  text: string;
  /**
   * Does the layer change while the session runs?
   *
   * Everything above the first changing layer is what the provider caches.
   */
  stable: boolean;
}

export interface PromptOptions {
  /** The tools the agent has. */
  tools?: Tool[];
  /** The directory the agent works in. */
  cwd: string;
  /** The base identity and rules. The default is the one above. */
  base?: string;
  /** The environment. Read from the working directory when it is left out. */
  environment?: Environment;
  /** The project memory. Read from the working directory when it is left out. */
  memory?: MemoryFile[];
  /** The skills, the plan and the checklist. */
  active?: ActiveContext;
  /** Read the memory and the environment when they are not given. */
  read?: boolean;
}

/**
 * The layers, in the order they go into the prompt.
 */
export async function buildPromptLayers(
  options: PromptOptions,
): Promise<PromptLayer[]> {
  const layers: PromptLayer[] = [];

  // [1] The identity and the rules.
  layers.push({
    name: "base",
    text: options.base ?? BASE_PROMPT,
    stable: true,
  });

  // [2] The tools. The order is the name, so it does not move between turns.
  const tools = options.tools ?? [];
  if (tools.length > 0) {
    layers.push({
      name: "tools",
      text: renderTools(tools),
      stable: true,
    });
  }

  // [3] The memory of the project.
  const memory =
    options.memory ??
    (options.read === true ? await findMemoryFiles(options.cwd) : []);
  if (memory.length > 0) {
    layers.push({
      name: "memory",
      text: renderMemory(options.cwd, memory),
      stable: true,
    });
  }

  // [4] Where the agent is.
  const environment =
    options.environment ??
    (options.read === true
      ? await readEnvironment(options.cwd)
      : { cwd: options.cwd, os: process.platform, date: today() });
  layers.push({
    name: "environment",
    text: renderEnvironment(environment),
    stable: false,
  });

  // [5] What the agent can draw on, and what it said it would do.
  const active =
    options.active ??
    (options.read === true ? { skills: await findSkills(options.cwd) } : undefined);
  const activeText = renderActiveContext(active);
  if (activeText.length > 0) {
    layers.push({
      name: "active",
      text: activeText,
      stable: false,
    });
  }

  return layers;
}

/**
 * The whole system prompt.
 *
 * The layers are joined with a blank line, in the order they were built:
 * the stable ones first, so the provider can cache them.
 */
export async function buildSystemPrompt(options: PromptOptions): Promise<string> {
  const layers = await buildPromptLayers(options);
  return layers
    .map((layer) => layer.text)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

/** The tool definitions, sorted so the order never moves. */
export function renderTools(tools: Tool[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  const lines = sorted.map((tool) => {
    const description = tool.description.trim().split("\n")[0] ?? "";
    return `- ${tool.name}: ${description}`;
  });

  return `Tools:\n${lines.join("\n")}`;
}

/** The project memory, each file under its name. */
export function renderMemory(cwd: string, memory: MemoryFile[]): string {
  const parts = memory.map((file) => {
    const name = displayMemoryPath(cwd, file.path);
    return `<memory file="${name}">\n${file.content.trim()}\n</memory>`;
  });

  return parts.join("\n\n");
}

/** Today, in UTC. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
