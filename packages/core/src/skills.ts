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

  return parts.join("\n\n");
}

/** A path as the model should see it. */
export function displaySkillPath(cwd: string, path: string): string {
  const relativePath = relative(cwd, path);
  if (relativePath.length === 0 || relativePath.startsWith("..")) return path;
  return relativePath.split(sep).join("/");
}
