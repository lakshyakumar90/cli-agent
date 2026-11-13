/**
 * The modes.
 *
 * All four read the same event stream; they only differ in what they do with
 * it. The answer goes to stdout, so `agent -p "..." > answer.txt` works and
 * the tool activity stays on stderr where it does not pollute the answer.
 */

import { run, type AgentEvent, type AgentState } from "@cli-agent/core";
import { renderJsonLines, renderText } from "@cli-agent/core";

/** Where a mode writes. */
export interface Streams {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
}

/** What a turn produced. */
export interface TurnResult {
  /** The text of the answer. */
  text: string;
  /** Why the loop stopped. */
  reason?: string;
  /** How many times the model was called. */
  turns: number;
}

/** Run one prompt and collect what it said. */
export async function runTurn(
  state: AgentState,
  prompt: string,
  signal: AbortSignal,
  onEvent?: (event: AgentEvent) => void,
): Promise<TurnResult> {
  let text = "";
  let reason: string | undefined;
  let turns = 0;

  for await (const event of run(state, prompt, signal)) {
    if (event.t === "text") text += event.delta;
    if (event.t === "done") {
      reason = event.reason;
      turns = event.turns;
    }
    onEvent?.(event);
  }

  return { text, ...(reason === undefined ? {} : { reason }), turns };
}

/**
 * Print mode: the answer on stdout, the activity on stderr.
 *
 * For scripts and CI: the exit code says whether it worked.
 */
export async function runPrint(options: {
  state: AgentState;
  prompt: string;
  streams: Streams;
  signal: AbortSignal;
  verbose?: boolean;
}): Promise<number> {
  const { state, prompt, streams, signal } = options;

  const result = await runTurn(state, prompt, signal, (event) => {
    if (!options.verbose) return;
    if (event.t === "toolStart") {
      streams.err.write(`> ${event.call.name}\n`);
    }
    if (event.t === "toolEnd") {
      streams.err.write(`< ${event.call.name}\n`);
    }
  });

  if (result.text.length > 0) streams.out.write(`${result.text}\n`);
  return result.reason === "aborted" ? 130 : 0;
}

/**
 * JSON mode: the events, one JSON object per line.
 *
 * The answer is not printed as text: everything is in the stream, so a
 * program can follow the agent without parsing prose.
 */
export async function runJson(options: {
  state: AgentState;
  prompt: string;
  streams: Streams;
  signal: AbortSignal;
}): Promise<number> {
  const { state, prompt, streams, signal } = options;

  for await (const line of renderJsonLines(
    run(state, prompt, signal),
  )) {
    streams.out.write(line);
  }

  return 0;
}

/**
 * Interactive mode: ask, answer, ask again.
 *
 * Esc interrupts the turn: the stream and the running tools stop, and the
 * transcript stays valid.
 */
export async function runInteractive(options: {
  state: AgentState;
  streams: Streams;
  /** Asks the user a question; the answer is a line of text. */
  ask: (question: string) => Promise<string>;
  /** The signal for the current turn, so Esc can stop it. */
  signalFor: () => AbortSignal;
  /** Called when the user asks to leave. */
  onExit?: () => void;
  verbose?: boolean;
}): Promise<number> {
  const { state, streams, ask } = options;

  for (;;) {
    const prompt = await ask("> ");
    const trimmed = prompt.trim();

    if (trimmed.length === 0) continue;
    if (trimmed === "/exit" || trimmed === "/quit") {
      options.onExit?.();
      return 0;
    }

    const controller = new AbortController();
    const signal = options.signalFor();
    // The turn follows the session's signal, and can be stopped on its own.
    signal.addEventListener("abort", () => controller.abort(), { once: true });

    streams.out.write("\n");
    await runTurn(state, trimmed, controller.signal, (event) => {
      switch (event.t) {
        case "text":
          streams.out.write(event.delta);
          break;
        case "thinking":
          if (options.verbose) streams.out.write(event.delta);
          break;
        case "toolStart":
          streams.out.write(`\n> ${event.call.name}\n`);
          break;
        case "toolEnd":
          if (options.verbose) {
            streams.out.write(`< ${event.call.name}: ${event.output.split("\n")[0]}\n`);
          }
          break;
        case "done":
          streams.out.write("\n");
          break;
      }
    });
  }
}

/**
 * RPC mode: JSON lines in, JSON lines out.
 *
 * The requests are:
 *   {"type":"prompt","text":"..."}   run a turn
 *   {"type":"abort"}                 stop the turn that is running
 *   {"type":"stop"}                  leave
 *
 * The answers are the same events the other modes read.
 */
export async function runRpc(options: {
  state: AgentState;
  streams: Streams;
  /** The requests, one JSON object at a time. */
  requests: AsyncIterable<string>;
  signal: AbortSignal;
}): Promise<number> {
  const { state, streams, requests } = options;

  let controller: AbortController | undefined;

  for await (const line of requests) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let request: { type?: string; text?: string };
    try {
      request = JSON.parse(trimmed) as { type?: string; text?: string };
    } catch {
      streams.out.write(
        `${JSON.stringify({ type: "error", message: "not JSON" })}\n`,
      );
      continue;
    }

    switch (request.type) {
      case "prompt": {
        controller = new AbortController();
        const turn = controller;
        options.signal.addEventListener("abort", () => turn.abort(), {
          once: true,
        });

        for await (const chunk of renderJsonLines(
          run(state, request.text ?? "", turn.signal),
        )) {
          streams.out.write(chunk);
        }
        controller = undefined;
        break;
      }

      case "abort":
        controller?.abort();
        streams.out.write(`${JSON.stringify({ type: "aborted" })}\n`);
        break;

      case "stop":
        return 0;

      default:
        streams.out.write(
          `${JSON.stringify({
            type: "error",
            message: `unknown request: ${request.type ?? "?"}`,
          })}\n`,
        );
    }
  }

  return 0;
}
