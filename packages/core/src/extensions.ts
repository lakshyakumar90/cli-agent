/**
 * Extensions.
 *
 * An extension is a TypeScript module in `.myagent/extensions` that
 * exports a `register` function. It is given an API and adds what it
 * likes: tools, commands and providers.
 *
 *   // .myagent/extensions/hello.ts
 *   import { z } from "zod";
 *
 *   export function register(api) {
 *     api.addTool({
 *       name: "hello",
 *       description: "Says hello to somebody.",
 *       schema: z.object({ name: z.string() }),
 *       async run(args) {
 *         return { output: `hello ${args.name}` };
 *       },
 *     });
 *   }
 *
 * The module is loaded by Node itself, so it can be TypeScript: the types
 * are taken off and the rest is ordinary JavaScript.
 *
 * An extension that cannot be loaded is reported and left behind. It must
 * not stop the agent from working.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Provider } from "@cli-agent/ai";
import type { Tool } from "@cli-agent/tools";
import { z } from "@cli-agent/tools";
import type { Command } from "./commands.js";

/** Where the extensions are looked for. */
export const EXTENSION_DIRECTORIES = [".myagent/extensions"] as const;

/** What an extension is given. */
export interface ExtensionApi {
  /** The directory the agent is working in. */
  cwd: string;
  /**
   * The zod the tools use.
   *
   * A tool that takes arguments needs a schema. Using this one means the
   * extension does not have to have zod of its own.
   */
  z: typeof z;
  /** Adds a tool the model may call. */
  addTool(tool: Tool): void;
  /** Adds a command the user may type. */
  addCommand(command: {
    name: string;
    description?: string;
    argumentHint?: string;
    content: string;
  }): void;
  /** Adds a provider the model may be served by. */
  addProvider(provider: Provider, options?: { replace?: boolean }): void;
  /** Says something about the extension. */
  log(message: string): void;
}

/** An extension that could not be loaded. */
export interface ExtensionProblem {
  /** The file it was in. */
  path: string;
  /** What went wrong. */
  message: string;
}

/** What the extensions gave us. */
export interface LoadedExtensions {
  /** The tools they added. */
  tools: Tool[];
  /** The commands they added. */
  commands: Command[];
  /** The providers they added, by id. */
  providers: Map<string, Provider>;
  /** The ones that could not be loaded. */
  problems: ExtensionProblem[];
  /** What they said. */
  logs: string[];
}

export interface ExtensionOptions {
  /** The directory the extensions are in. */
  cwd: string;
}

/**
 * Load the extensions of a project.
 *
 * Every file in the folder is tried: one that fails does not stop the
 * others from being loaded.
 */
export async function loadExtensions(
  options: ExtensionOptions,
): Promise<LoadedExtensions> {
  const tools: Tool[] = [];
  const commands: Command[] = [];
  const providers = new Map<string, Provider>();
  const problems: ExtensionProblem[] = [];
  const logs: string[] = [];

  for (const directory of EXTENSION_DIRECTORIES) {
    const folder = join(options.cwd, directory);

    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
      if (!/\.(ts|mts|js|mjs)$/.test(entry)) continue;

      const path = join(folder, entry);
      const name = entry.replace(/\.(ts|mts|js|mjs)$/, "");

      try {
        const loaded = await loadOne(path, name, options.cwd, {
          tools,
          commands,
          providers,
          logs,
        });
        if (loaded !== undefined) logs.push(`loaded the extension ${name}`);
      } catch (error) {
        problems.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { tools, commands, providers, problems, logs };
}

/** Load one extension and let it add what it wants. */
async function loadOne(
  path: string,
  name: string,
  cwd: string,
  into: {
    tools: Tool[];
    commands: Command[];
    providers: Map<string, Provider>;
    logs: string[];
  },
): Promise<void> {
  // Node loads the module itself: a TypeScript file is read, its types
  // are taken off, and the rest is ordinary JavaScript.
  const module = (await import(pathToFileURL(path).href)) as {
    register?: (api: ExtensionApi) => void | Promise<void>;
    default?: (api: ExtensionApi) => void | Promise<void>;
  };

  const register = module.register ?? module.default;
  if (register === undefined) {
    throw new Error(
      "the extension does not export a register function",
    );
  }

  const api: ExtensionApi = {
    cwd,
    z,
    addTool(tool) {
      if (typeof tool?.name !== "string" || tool.name.length === 0) {
        throw new Error("a tool needs a name");
      }
      into.tools.push(tool);
    },
    addCommand(command) {
      const commandName = command.name.startsWith("/")
        ? command.name
        : `/${command.name}`;
      into.commands.push({
        name: commandName.toLowerCase(),
        path,
        content: command.content,
        ...(command.description === undefined
          ? {}
          : { description: command.description }),
        ...(command.argumentHint === undefined
          ? {}
          : { argumentHint: command.argumentHint }),
      });
    },
    addProvider(provider, providerOptions) {
      if (typeof provider?.id !== "string" || provider.id.length === 0) {
        throw new Error("a provider needs an id");
      }
      const replace = providerOptions?.replace === true;
      if (into.providers.has(provider.id) && !replace) {
        throw new Error(
          `the provider "${provider.id}" is already registered — pass { replace: true } to swap it`,
        );
      }
      into.providers.set(provider.id, provider);
    },
    log(message) {
      into.logs.push(message);
    },
  };

  await register(api);
}
