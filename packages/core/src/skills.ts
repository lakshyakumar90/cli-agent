/**
 * Skills and the plan.
 *
 * The dynamic part of the prompt: what the agent can draw on, and what it
 * said it would do. It changes while the session runs, so it belongs at the
 * bottom of the prompt.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";

/** Where skills are looked for, in the working directory and in the home. */
export const SKILL_DIRECTORIES = [
  ".myagent/skills",
  ".claude/skills",
  ".codex/skills",
  ".agent/skills",
] as const;

/** One skill. */
export interface Skill {
  /** Its name. */
  name: string;
  /** Where it is. */
  path: string;
  /** The first line of its description, if it has one. */
  description?: string;
}

/**
 * The skills that are available.
 *
 * A skill is a directory with a SKILL.md in it; the description is the
 * frontmatter's "description", or the first line that says what it is.
 */
export async function findSkills(cwd: string): Promise<Skill[]> {
  const roots: string[] = SKILL_DIRECTORIES.map((directory) => join(cwd, directory));
  roots.push(join(homedir(), ".myagent", "skills"));

  const skills: Skill[] = [];

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, "SKILL.md");
      const description = await describeSkill(path);
      if (description === undefined) continue;
      skills.push({ name: entry.name, path, description });
    }
  }

  return skills;
}

/** What a skill says it is for. */
async function describeSkill(path: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (frontmatter !== null) {
    const description = /^description:\s*(.+)$/m.exec(frontmatter[1] as string);
    if (description !== null) {
      return (description[1] as string).trim().replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
}

/** The plan and the checklist, as the model reads them. */
export interface ActiveContext {
  /** The skills that are available. */
  skills?: Skill[];
  /** The plan, in the model's own words. */
  plan?: string;
  /** The checklist, one item per line. */
  todo?: string[];
  /**
   * Notes that are always in the prompt.
   *
   * The session hook writes here: what it says is read in every turn.
   */
  notes?: string[];
}

/** The dynamic block, or nothing when there is nothing to say. */
export function renderActiveContext(active: ActiveContext | undefined): string {
  if (active === undefined) return "";

  const parts: string[] = [];

  if (active.plan !== undefined && active.plan.trim().length > 0) {
    parts.push(`Plan:\n${active.plan.trim()}`);
  }

  if (active.todo !== undefined && active.todo.length > 0) {
    parts.push(`Checklist:\n${active.todo.map((item) => `- ${item}`).join("\n")}`);
  }

  if (active.skills !== undefined && active.skills.length > 0) {
    const lines = active.skills.map(
      (skill) =>
        `- ${skill.name}${skill.description === undefined ? "" : `: ${skill.description}`}`,
    );
    parts.push(`Skills available:\n${lines.join("\n")}`);
  }

  if (active.notes !== undefined && active.notes.length > 0) {
    parts.push(`Notes:\n${active.notes.join("\n\n")}`);
  }

  return parts.join("\n\n");
}

/** A path as the model should see it. */
export function displaySkillPath(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return path;
  return relativePath.split(sep).join("/");
}

/**
 * The body of a skill: what is left when the frontmatter is taken off.
 *
 * The frontmatter is ours - the name, the description - so the model is
 * given what is left: the instructions.
 */
export async function readSkillBody(path: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return "";
  }

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (frontmatter === null) return content.trim();

  return content.slice(frontmatter[0].length).trim();
}

export interface SkillToolOptions {
  /** The directory the skills are in. */
  cwd: string;
  /** The skills that are known. They are looked up when this is left out. */
  skills?: Skill[];
}

/**
 * The tool the model calls to load a skill.
 *
 * Only the name and the description of a skill are in the prompt: the
 * body can be long, and most of it is not needed unless the task calls
 * for it. So the model asks for the one it wants, and the body arrives
 * then - and stays, because the instructions are still needed later.
 */
export function createSkillTool(options: SkillToolOptions): Tool {
  return {
    name: "skill",
    description: [
      "Load a skill: the full instructions for a kind of task.",
      "",
      "The prompt lists the skills that are available, with what each one",
      "is for. When one of them fits the task, load it and follow it.",
    ].join("\n"),
    effect: "read",
    schema: z.object({
      name: z.string().describe("The name of the skill to load."),
    }),
    // The instructions must arrive whole: the middle of them is as
    // important as the beginning.
    maxChars: 40_000,
    maxLines: 2_000,
    async run(args: { name: string }) {
      const skills = options.skills ?? (await findSkills(options.cwd));
      const skill = skills.find((candidate) => candidate.name === args.name);

      if (skill === undefined) {
        const known = skills.map((candidate) => candidate.name).join(", ");
        return {
          output: `there is no skill called "${args.name}"${
            known.length > 0 ? ` — known: ${known}` : ""
          }`,
          isError: true,
        };
      }

      const body = await readSkillBody(skill.path);
      if (body.length === 0) {
        return {
          output: `the skill "${skill.name}" is empty`,
          isError: true,
        };
      }

      return {
        output: body,
        // The instructions stay in the context: they are needed long after
        // this call is forgotten.
        keep: true,
      };
    },
  };
}
