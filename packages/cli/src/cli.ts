#!/usr/bin/env node
// @cli-agent/cli — the terminal interface: interactive, print and JSON modes.

import { stdin as input, stdout as output } from "node:process";
import { parseArgs, HELP, DEFAULT_MODEL } from "./args.js";
import { runJson, runPrint, runRpc } from "./commands.js";
import { createSession } from "./session.js";
import { buildCatalog, defaultFreeModel } from "./catalog.js";
import { InteractiveUi } from "./ui/interactive.js";
import { setColors, shouldUseColors } from "./ui/colors.js";
import { loadAgents } from "./agents.js";
import { createProvider } from "@cli-agent/ai";
import { AuthManager } from "@cli-agent/ai";
import { AuthError } from "@cli-agent/ai";
import type { AskPermission } from "@cli-agent/tools";

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.ok) {
    if (parsed.help === true) {
      process.stdout.write(HELP);
      return 0;
    }
    process.stderr.write(`${parsed.error}\n\n${HELP}`);
    return 2;
  }

  const options = parsed.options;
  setColors(shouldUseColors());

  // The default model is one of OpenRouter's free models, and the list of
  // them changes: it is asked for, so the default is one that exists
  // today. A user who chose a model keeps it.
  const model =
    options.model === DEFAULT_MODEL
      ? await defaultFreeModel().catch(() => DEFAULT_MODEL)
      : options.model;

  // Esc stops the turn that is running.
  const session = new AbortController();

  // The permission prompt: one line, one answer.
  const askPermission: AskPermission = async (request) => {
    process.stderr.write(
      `\n${request.reason}\n[y]es / [n]o / [a]lways? `,
    );
    const answer = (await readLine("")).trim().toLowerCase();
    if (answer.startsWith("a")) return "allow-always";
    return answer.startsWith("y") ? "allow" : "deny";
  };

  let built;
  try {
    built = await createSession({
      model,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      rules: options.rules,
      ask: askPermission,
      continueLast: options.continueLast,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.noLog === true ? { noLog: true } : {}),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const { state, store, sessionId, roles, commands } = built;

  // What could not be loaded is said out loud: a server that did not
  // answer, an extension that did not load. The agent carries on without
  // them, but the user should know.
  for (const problem of built.mcp.problems) {
    process.stderr.write(
      `the MCP server "${problem.server}" did not answer: ${problem.message}\n`,
    );
  }
  for (const problem of built.extensions.problems) {
    process.stderr.write(
      `the extension ${problem.path} did not load: ${problem.message}\n`,
    );
  }

  // No credentials is not a reason to close the door: the session opens
  // and says what is missing, so the user can sign in and carry on.
  const missing = built.missing;
  if (missing !== undefined) {
    process.stderr.write(
      `\n${missing.message}\n` +
        `the session is open anyway — /login signs in, /model picks another provider.\n\n`,
    );
  }

  // The session is shut down however it ends: the MCP servers are
  // processes of their own, and they have to be stopped or the agent
  // never finishes.
  try {
    switch (options.mode) {
      case "print":
        return await runPrint({
          state,
          prompt: options.prompt ?? "",
          streams: { out: process.stdout, err: process.stderr },
          signal: session.signal,
          verbose: options.verbose,
        });

      case "json":
        return await runJson({
          state,
          prompt: options.prompt ?? "",
          streams: { out: process.stdout, err: process.stderr },
          signal: session.signal,
        });

      case "rpc":
        return await runRpc({
          state,
          streams: { out: process.stdout, err: process.stderr },
          requests: readLines(),
          signal: session.signal,
        });

      case "interactive":
      default: {
        const ui = new InteractiveUi({
          state,
          out: process.stdout,
          err: process.stderr,
          input,
          model,
          permissionMode: options.permissionMode,
          cwd: options.cwd,
          sessionId,
          store,
          checkpoints: state.checkpoints,
          agents: await loadAgents(),
          roles,
          commands,
          ...(state.log?.path === undefined ? {} : { logPath: state.log.path }),
          // The list is asked for when the picker is opened: the free
          // models of a router change from day to day.
          onModels: async () => (await buildCatalog()).models,
          onModel: async (ref) => {
            try {
              // A provider an extension added is a provider too.
              const provider = await createProvider(
                ref.split("/")[0] as string,
                { providers: built.extensions.providers },
              );
              return provider;
            } catch (error) {
              process.stderr.write(
                `${error instanceof Error ? error.message : String(error)}\n`,
              );
              return undefined;
            }
          },
          onLogin: async (provider) => {
            const auth = new AuthManager();
            try {
              await auth.login(provider);
              return `signed in to ${provider}`;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          },
        });

        return await ui.run();
      }
    }
  } finally {
    await built.close();
  }
}

/** One line of input from the user. */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const { createInterface } = require("node:readline") as typeof import("node:readline");
    const rl = createInterface({ input, output });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** The input, line by line. */
async function* readLines(): AsyncGenerator<string> {
  const { createInterface } = require("node:readline") as typeof import("node:readline");
  const rl = createInterface({ input, terminal: false });
  for await (const line of rl) {
    yield line;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A missing key is the user's problem to fix, not a crash: it gets the
    // message, not a stack.
    if (error instanceof AuthError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
