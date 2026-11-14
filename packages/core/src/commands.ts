/**
 * Custom commands.
 *
 * A command is a markdown file in `.myagent/commands`. The name of the
 * file is the name of the command: `deploy.md` is `/deploy`. What the file
 * says is what the model is asked, so a command is a prompt you do not
 * have to type again.
 *
 *   # .myagent/commands/deploy.md
 *   ---
 *   description: Deploy the app
 *   argument-hint: <environment>
 *   ---
 *   Deploy the app to $1. Run the tests first, and say what you did.
 *
 * `$ARGUMENTS` is everything the user typed after the command, and `$1`
 * to `$9` are the words of it. When the file says neither, the arguments
 * are added at the end.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the commands are looked for. */
export const COMMAND_DIRECTORIES = [".myagent/commands"] as const;

/** One command. */
export interface Command {
  /** The name the user types: "/deploy". */
  name: string;
  /** What it does, for the list of commands. */
  description?: string;
  /** A hint about the arguments, for the list of commands. */
  argumentHint?: string;
  /** Where it is. */
  path: string;
  /** The prompt it sends. */
  content: string;
}

/**
 * The commands that are available.
 *
 * The project's own commands come first, then the user's, so a project can
 * have a command of its own without losing the rest.
 */
export async function findCommands(
  cwd: string,
  options: { global?: boolean } = {},
): Promise<Command[]> {
  const roots: string[] = [];
  if (options.global !== false) {
    roots.push(join(homedir(), ".myagent", "commands"));
  }
  for (const relative of COMMAND_DIRECTORIES) {
    roots.push(join(cwd, relative));
  }

  const commands = new Map<string, Command>();

  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const path = join(root, entry);
      try {
        const command = await readCommand(path, entry);
        if (command !== undefined) commands.set(command.name, command);
      } catch {
        // A command that cannot be read is simply not there.
      }
    }
  }

  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one command from its file. */
async function readCommand(
  path: string,
  fileName: string,
): Promise<Command | undefined> {
  const content = await readFile(path, "utf8");
  const name = `/${fileName.slice(0, -3)}`.toLowerCase();
  if (name.length <= 1) return undefined;

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  const body =
    frontmatter === null ? content.trim() : content.slice(frontmatter[0].length).trim();

  if (body.length === 0) return undefined;

  const command: Command = { name, path, content: body };

  if (frontmatter !== null) {
    const description = /^description:\s*(.+)$/m.exec(frontmatter[1] as string);
    if (description !== null) {
      command.description = (description[1] as string)
        .trim()
        .replace(/^["']|["']$/g, "");
    }

    const hint = /^(?:argument-hint|argumentHint):\s*(.+)$/m.exec(
      frontmatter[1] as string,
    );
    if (hint !== null) {
      command.argumentHint = (hint[1] as string)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  return command;
}

/**
 * The prompt a command sends.
 *
 * `$ARGUMENTS` is everything the user typed, `$1` to `$9` are the words of
 * it. When the command says neither, the arguments are added at the end.
 */
export function renderCommand(command: Command, args: string): string {
  const trimmed = args.trim();
  const words = trimmed.length > 0 ? trimmed.split(/\s+/) : [];

  let prompt = command.content;

  // The numbered words first, and then the whole of them: what the user
  // typed is put in as it was, and is not looked at again.
  for (let index = 1; index <= 9; index += 1) {
    prompt = prompt.replace(
      new RegExp(`\\$${index}\\b`, "g"),
      words[index - 1] ?? "",
    );
  }
  prompt = prompt.replace(/\$ARGUMENTS\b/g, trimmed);

  // A command that does not use the arguments still gets them.
  if (trimmed.length > 0 && !/\$ARGUMENTS\b|\$[1-9]\b/.test(command.content)) {
    prompt = `${prompt}\n\n${trimmed}`;
  }

  return prompt.trim();
}
