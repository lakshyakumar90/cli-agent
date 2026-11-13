/**
 * Context building.
 *
 * The system prompt is built in layers (see prompt.ts): the parts that do
 * not change come first, so the provider can cache them, and the
 * conversation follows as messages. Phase 5 replaces the message half with
 * budgeting — trimming the transcript to the model's context window,
 * summarising the middle, keeping the ends.
 */

import type { Msg, ToolSpec } from "@cli-agent/ai";
import { toToolSpec } from "@cli-agent/tools";
import { readEnvironment, type Environment } from "./environment.js";
import { findMemoryFiles, type MemoryFile } from "./memory.js";
import { buildSystemPrompt, type PromptOptions } from "./prompt.js";
import { buildRepoMap, type RepoMapEntry } from "./repomap.js";
import { findSkills, type Skill } from "./skills.js";
import { stubOldToolResults } from "./shrink.js";
import type { AgentState } from "./types.js";

/** What a provider needs for one turn. */
export interface Context {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
}

/** How the prompt is built, when it is not simply the state's. */
export interface ContextOptions {
  /** The layers of the system prompt. */
  prompt?: PromptOptions;
  /** The active skills, the plan and the checklist. */
  active?: PromptOptions["active"];
}

/**
 * What has been read for a session.
 *
 * The project memory, the skills and the branch are read once: they do not
 * change while the agent works, and reading them again on every turn would
 * cost a walk up the directory tree each time.
 */
interface SessionReads {
  memory?: MemoryFile[];
  skills?: Skill[];
  environment?: Environment;
  map?: RepoMapEntry[];
}

const reads = new WeakMap<AgentState, SessionReads>();

export async function buildContext(
  state: AgentState,
  options: ContextOptions = {},
): Promise<Context> {
  const cwd = state.cwd ?? process.cwd();
  const session = reads.get(state) ?? {};
  reads.set(state, session);

  const read = options.prompt?.read ?? true;

  if (session.memory === undefined && read) {
    session.memory = await findMemoryFiles(cwd);
  }
  if (session.skills === undefined && read) {
    session.skills = await findSkills(cwd);
  }
  if (session.environment === undefined && read) {
    session.environment = await readEnvironment(cwd);
  }
  if (session.map === undefined && read) {
    session.map = await buildRepoMap(cwd);
  }

  const environment = session.environment;
  const active = options.active ?? state.active;
  const skills = active?.skills ?? session.skills;
  const checklist = checklistOf(state.tools);

  const prompt: PromptOptions = {
    cwd,
    tools: state.tools,
    read: false,
    ...(environment === undefined
      ? {}
      : { environment: { ...environment, date: today() } }),
    ...(session.memory === undefined ? {} : { memory: session.memory }),
    ...(session.map === undefined ? {} : { map: session.map }),
    ...(active === undefined && skills === undefined && checklist === undefined
      ? {}
      : {
          active: {
            ...active,
            ...(skills === undefined ? {} : { skills }),
            ...(checklist === undefined ? {} : { todo: checklist }),
          },
        }),
    ...(state.system === undefined ? {} : { base: state.system }),
    ...(options.prompt ?? {}),
  };

  return {
    model: state.model,
    system: await buildSystemPrompt(prompt),
    // The transcript is shortened before it is sent: an old tool result the
    // model has moved on from is a stub, not a page of output.
    messages: stubOldToolResults(state.messages, {
      ...(state.limits?.keepToolTurns === undefined
        ? {}
        : { keepTurns: state.limits.keepToolTurns }),
    }),
    tools: state.tools.map(toToolSpec),
  };
}

/** Today, in UTC. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The checklist, when one of the tools keeps one.
 *
 * A tool that can say what it holds (the todo tool) is asked for it, so the
 * model sees the list as it stands rather than as it was when the session
 * started.
 */
function checklistOf(tools: AgentState["tools"]): string[] | undefined {
  for (const tool of tools) {
    const list = (tool as { list?: unknown }).list;
    if (typeof list !== "function") continue;

    try {
      const items = (list as () => unknown).call(tool);
      if (!Array.isArray(items)) continue;

      return items
        .map((item) => {
          if (typeof item !== "object" || item === null) return undefined;
          const record = item as { content?: unknown; status?: unknown };
          if (typeof record.content !== "string") return undefined;
          const mark =
            record.status === "completed"
              ? "x"
              : record.status === "in_progress"
                ? ">"
                : " ";
          return `[${mark}] ${record.content}`;
        })
        .filter((line): line is string => line !== undefined);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
