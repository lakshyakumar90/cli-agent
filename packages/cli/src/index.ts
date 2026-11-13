#!/usr/bin/env node
// @cli-agent/cli — the terminal interface: interactive, print and JSON modes.

import { createInterface, emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, HELP } from "./args.js";
import { runInteractive, runJson, runPrint, runRpc } from "./commands.js";
import { createSession } from "./session.js";
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

  // Esc stops the turn that is running.
  const session = new AbortController();
  let turn = new AbortController();
  emitKeypressEvents(input);
  input.on("keypress", (_key, key) => {
    if (key.name === "escape") turn.abort();
  });

  // The permission prompt: one line, one answer.
  const askPermission: AskPermission = async (request) => {
    process.stderr.write(`\n${request.reason}\n[y]es / [n]o / [a]lways? `);
    const answer = (await readLine("")).trim().toLowerCase();
    if (answer.startsWith("a")) return "allow-always";
    return answer.startsWith("y") ? "allow" : "deny";
  };

  let state;
  try {
    ({ state } = await createSession({
      model: options.model,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      rules: options.rules,
      ask: askPermission,
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

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
    default:
      return runInteractive({
        state,
        streams: { out: process.stdout, err: process.stderr },
        ask: readLine,
        signalFor: () => turn.signal,
        onExit: () => session.abort(),
        verbose: options.verbose,
      });
  }
}

/** One line of input from the user. */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** The input, line by line. */
async function* readLines(): AsyncGenerator<string> {
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
