#!/usr/bin/env node
// @cli-agent/cli — the terminal interface: interactive, print and JSON modes.

import { stdin as input, stdout as output } from "node:process";
import { parseArgs, HELP } from "./args.js";
import { runJson, runPrint, runRpc } from "./commands.js";
import { createSession } from "./session.js";
import { InteractiveUi } from "./ui/interactive.js";
import { setColors, shouldUseColors } from "./ui/colors.js";
import { loadAgents } from "./agents.js";
import { createProvider } from "@cli-agent/ai";
import { AuthManager } from "@cli-agent/ai";
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
      model: options.model,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      rules: options.rules,
      ask: askPermission,
      continueLast: options.continueLast,
      ...(options.resume === undefined ? {} : { resume: options.resume }),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const { state, store, sessionId, roles } = built;

  switch (options.mode) {
    case "print":
      return runPrint({
        state,
        prompt: options.prompt ?? "",
        streams: { out: process.stdout, err: process.stderr },
        signal: session.signal,
        verbose: options.verbose,
      });

    case "json":
      return runJson({
        state,
        prompt: options.prompt ?? "",
        streams: { out: process.stdout, err: process.stderr },
        signal: session.signal,
      });

    case "rpc":
      return runRpc({
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
        model: options.model,
        permissionMode: options.permissionMode,
        cwd: options.cwd,
        sessionId,
        store,
        checkpoints: state.checkpoints,
        agents: await loadAgents(),
        roles,
        onModel: async (ref) => {
          try {
            const provider = await createProvider(ref.split("/")[0] as string);
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

      return ui.run();
    }
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
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
