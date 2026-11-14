/**
 * Agent roles.
 *
 * A role is a name, a model, a set of tools and a system prompt. It lives in
 * a file:
 *
 *   # .myagent/agents/reviewer.md
 *   ---
 *   name: reviewer
 *   model: gemini/gemini-2.5-pro
 *   tools: [read, grep, glob]
 *   ---
 *   You review diffs for bugs and security issues. Return a ranked list.
 *
 * The project directory is read first, then the user's own directory, so a
 * project can override a role without losing the rest.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** One role. */
export interface AgentRole {
  /** The name the parent calls it by. */
  name: string;
  /** The "provider/model" the role runs on. */
  model?: string;
  /** The tools it may use. All of them when this is left out. */
  tools?: string[];
  /** What it is for, shown in the list. */
  description?: string;
  /** The body: its system prompt. */
  prompt: string;
  /** Where it came from. */
  path?: string;
}

/** The roles that are always there. */
export function defaultRoles(): Map<string, AgentRole> {
  const roles = new Map<string, AgentRole>();

  roles.set("explorer", {
    name: "explorer",
    description: "Finds the code that matters and reports what it does.",
    tools: ["read", "grep", "glob"],
    prompt: [
      "You explore a codebase and report what you found.",
      "",
      "Find the files that matter for the question, read what is needed, and",
      "report: what is there, how it works, and which files a change would",
      "touch. Quote the paths. Do not change anything.",
      "",
      "Your report is the only thing the agent that asked you will see, so",
      "write it for someone who has not seen the code.",
    ].join("\n"),
  });

  roles.set("planner", {
    name: "planner",
    description: "Turns a task into a plan.",
    tools: ["read", "grep", "glob"],
    prompt: [
      "You turn a task into a plan another agent can carry out.",
      "",
      "Read enough of the code to know what the plan touches. Then write the",
      "plan: the steps, in order, with the files each step changes and how",
      "it will be checked.",
    ].join("\n"),
  });

  roles.set("coder", {
    name: "coder",
    description: "Writes the change.",
    tools: ["read", "write", "edit", "bash", "grep", "glob"],
    prompt: [
      "You make the change another agent asked for.",
      "",
      "Follow the plan you are given. Read before you write, change as little",
      "as possible, and run the tests when there are tests. Report what you",
      "changed and what the tests said.",
    ].join("\n"),
  });

  roles.set("reviewer", {
    name: "reviewer",
    description: "Reviews a change for bugs and risks.",
    tools: ["read", "grep", "glob", "bash"],
    prompt: [
      "You review a change other agents made.",
      "",
      "Look for bugs, security problems, and missing cases. Return a ranked",
      "list: what is wrong, where it is, and how it shows up. Say plainly if",
      "you found nothing.",
    ].join("\n"),
  });

  return roles;
}

/** Read a role from its markdown. */
export function parseRole(
  markdown: string,
  path?: string,
): AgentRole | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (match === null) return undefined;

  const frontmatter = match[1] as string;
  const prompt = (match[2] as string).trim();

  const role: AgentRole = { name: "", prompt, ...(path === undefined ? {} : { path }) };

  for (const line of frontmatter.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    switch (key) {
      case "name":
        role.name = value.replace(/^["']|["']$/g, "");
        break;
      case "model":
        role.model = value.replace(/^["']|["']$/g, "");
        break;
      case "description":
        role.description = value.replace(/^["']|["']$/g, "");
        break;
      case "tools":
        role.tools = value
          .replace(/^\[/, "")
          .replace(/\]$/, "")
          .split(",")
          .map((tool) => tool.trim().replace(/^["']|["']$/g, ""))
          .filter((tool) => tool.length > 0);
        break;
      default:
        break;
    }
  }

  if (role.name.length === 0) return undefined;
  return role;
}

/**
 * The roles that are available.
 *
 * The project's own roles come first, then the user's, then the built-in
 * ones.
 */
export async function loadRoles(
  options: { cwd?: string; global?: boolean } = {},
): Promise<Map<string, AgentRole>> {
  const cwd = options.cwd ?? process.cwd();
  const roles = defaultRoles();

  if (options.global !== false) {
    const global = await readRolesIn(join(homedir(), ".myagent", "agents"));
    for (const [name, role] of global) roles.set(name, role);
  }

  const project = await readRolesIn(join(cwd, ".myagent", "agents"));
  for (const [name, role] of project) roles.set(name, role);

  return roles;
}

/** The roles in one directory. */
async function readRolesIn(directory: string): Promise<Map<string, AgentRole>> {
  const roles = new Map<string, AgentRole>();

  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return roles;
  }

  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const path = join(directory, name);
    try {
      const role = parseRole(await readFile(path, "utf8"), path);
      if (role !== undefined) roles.set(role.name, role);
    } catch {
      // A role that cannot be read is simply not there.
    }
  }

  return roles;
}
