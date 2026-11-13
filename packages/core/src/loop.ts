/**
 * The agent loop.
 *
 * model -> tool calls -> results -> model, until the model stops asking for
 * tools. The loop yields events and never prints, so the CLI, a JSON mode and
 * a sub-agent all consume the same stream.
 *
 * Three guards keep a runaway agent in check:
 * - a limit on the turns of one prompt;
 * - a detector for the model asking for the same thing over and over;
 * - an abort path (Esc) that stops the stream and the running tools, and
 *   leaves the transcript valid by answering every call that was made.
 *
 * A provider call that fails with 429 or 5xx is retried with a backoff, but
 * only while nothing has happened yet: once a tool has run, the side effects
 * are real and the model must not be asked again.
 */

import type {
  Event,
  StopReason,
  ToolCall,
  Usage,
} from "@cli-agent/ai";
import { validateArgs } from "@cli-agent/tools";
import { buildContext, type Context } from "./context.js";
import { budgetFor, estimateRequest, shouldCompact } from "./budget.js";
import { compactMessages } from "./compact.js";
import { correctRatio } from "./tokens.js";
import { isAbort, isRetryNotice, withRetry } from "./retry.js";
import {
  DEFAULT_LIMITS,
  type AgentEvent,
  type AgentLimits,
  type AgentState,
  type AssistantTurn,
  type LoopEnd,
  type ToolResultMsg,
} from "./types.js";

/** What goes into the transcript for a call that was never run. */
export const INTERRUPTED = "[interrupted]";

/**
 * Run one prompt to completion.
 *
 * The conversation grows in `state.messages`; the caller reads the events as
 * they arrive. The generator returns when the model answers without asking
 * for another tool, or when one of the guards stops it.
 */
export async function* run(
  state: AgentState,
  input: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  state.messages.push({ role: "user", content: input });

  const limits: Required<
    Pick<
      AgentLimits,
      | "maxTurns"
      | "maxRepeatedCalls"
      | "maxRetries"
      | "retryDelayMs"
      | "maxRetryDelayMs"
    >
  > &
    AgentLimits = {
    ...DEFAULT_LIMITS,
    ...state.limits,
  };

  // How often each distinct call has been asked for in this prompt.
  const seen = new Map<string, number>();

  let turns = 0;
  let toolsExecuted = 0;
  let stop: StopReason = "end";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  // Calls of the last turn that have no answer yet.
  let unanswered: ToolCall[] = [];

  /** End the loop, answering any call that is still open. */
  function* finish(reason: LoopEnd): Generator<AgentEvent> {
    if (unanswered.length > 0) {
      const results = unanswered.map((call) => notRun(call, reason));
      state.messages.push(...results);
      for (const [index, call] of unanswered.entries()) {
        const result = results[index];
        if (result === undefined) continue;
        yield {
          t: "toolEnd",
          call,
          output: result.content,
          isError: true,
        };
      }
      unanswered = [];
    }
    yield { t: "done", stop, turns, usage, reason };
  }

  while (true) {
    if (signal.aborted) {
      yield* finish("aborted");
      return;
    }
    if (turns >= limits.maxTurns) {
      yield* finish("max-turns");
      return;
    }

    let ctx: Context = await buildContext(state);

    // Does the conversation still fit? If not, the old part of it is
    // summarised and the turn goes on with the smaller conversation.
    const budget = budgetFor({
      provider: providerIdOf(state),
      model: state.model,
      ...(limits.contextWindow === undefined
        ? {}
        : { contextWindow: limits.contextWindow }),
      ...(limits.outputReserve === undefined
        ? {}
        : { outputReserve: limits.outputReserve }),
    });

    if (budget.total !== undefined) {
      const used = estimateRequest(ctx, state.tokens?.ratio ?? 1);
      if (shouldCompact(used, budget)) {
        // Be precise before anything is thrown away — but only when the
        // decision is close. When the quick count is twice the threshold,
        // the answer is the same either way, and the exact count would
        // cost a second to load a tokenizer.
        const precise =
          used >= budget.total * budget.threshold * 2
            ? used
            : estimateRequest(ctx, state.tokens?.ratio ?? 1, { precise: true });

        if (shouldCompact(precise, budget)) {
          const compacted = await compactMessages({
            provider: state.provider,
            model: state.model,
            messages: state.messages,
            ...(budget.total === undefined ? {} : { budget: budget.total }),
            signal,
          });

          if (compacted !== undefined) {
            state.messages = compacted;
            ctx = await buildContext(state);
            yield { t: "compacted", tokens: precise, budget: budget.total };
          }
        }
      }
    }

    const turn: AssistantTurn = { role: "assistant", content: [] };
    turns += 1;
    let aborted = false;

    try {
      const events = withRetry(
        () => state.provider.stream({ ...ctx, signal }),
        {
          maxRetries: limits.maxRetries,
          baseDelayMs: limits.retryDelayMs,
          maxDelayMs: limits.maxRetryDelayMs,
          // Once a tool has run, asking the model again could run it twice.
          canRetry: () => toolsExecuted === 0,
          signal,
        },
      );

      for await (const item of events) {
        if (isRetryNotice(item)) {
          yield item;
          continue;
        }
        if (item.t === "done") {
          stop = item.stop;
          usage = item.usage;
          turn.usage = item.usage;
          // The provider says how many tokens it really used; the estimate is
          // corrected with it.
          state.tokens = {
            ratio: correctRatio(
              state.tokens?.ratio,
              estimateRequest(ctx, state.tokens?.ratio ?? 1),
              item.usage.inputTokens,
            ),
          };
          continue;
        }
        const emitted = accumulate(turn, item);
        if (emitted !== undefined) yield emitted;
      }
    } catch (error) {
      if (!isAbort(error, signal)) {
        // The turn is kept: the caller saw its text, so the transcript has
        // to match. The failure itself is the caller's problem.
        state.messages.push(turn);
        throw error;
      }
      aborted = true;
    }

    state.messages.push(turn);

    const calls = turn.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );
    unanswered = calls;

    if (aborted) {
      yield* finish("aborted");
      return;
    }

    // The model is finished.
    if (calls.length === 0) {
      yield* finish(stop === "length" ? "length" : "end");
      return;
    }

    // The same call over and over means the model is stuck.
    const repeated = calls.find((call) => {
      const signature = callSignature(call);
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);
      return count > limits.maxRepeatedCalls;
    });
    if (repeated !== undefined) {
      yield* finish("repeated-call");
      return;
    }

    // The tools of one turn run together; their results go back in the order
    // the model asked for them.
    const results = await Promise.all(
      calls.map((call) => execTool(call, state, signal)),
    );
    toolsExecuted += calls.length;

    for (const [index, call] of calls.entries()) {
      const result = results[index];
      if (result === undefined) continue;
      yield {
        t: "toolEnd",
        call,
        output: result.content,
        ...(result.isError === true ? { isError: true } : {}),
      };
    }

    state.messages.push(...results);
    unanswered = [];

    if (signal.aborted) {
      yield* finish("aborted");
      return;
    }
  }
}

/**
 * Add a provider event to the turn, and say what the caller should see.
 *
 * Text and thinking deltas are merged into one block each, so the transcript
 * reads like a message rather than a stream of fragments.
 */
export function accumulate(
  turn: AssistantTurn,
  event: Exclude<Event, { t: "done" }>,
): AgentEvent | undefined {
  switch (event.t) {
    case "text": {
      const last = turn.content.at(-1);
      if (last?.type === "text") {
        last.text += event.delta;
      } else {
        turn.content.push({ type: "text", text: event.delta });
      }
      return { t: "text", delta: event.delta };
    }

    case "thinking": {
      const last = turn.content.at(-1);
      if (last?.type === "thinking") {
        last.text += event.delta;
      } else {
        turn.content.push({ type: "thinking", text: event.delta });
      }
      return { t: "thinking", delta: event.delta };
    }

    case "toolCall": {
      turn.content.push({
        type: "toolCall",
        id: event.call.id,
        name: event.call.name,
        args: event.call.args,
      });
      // The model asked for this tool; the loop runs it once the turn ends.
      return { t: "toolStart", call: event.call };
    }
  }
}

/**
 * Run one tool call and turn it into the message that goes back to the model.
 *
 * The arguments are checked against the tool's schema first: a call that
 * does not match never runs. A tool that is missing, whose arguments do not
 * fit, or that throws does not stop the loop — the model is told what went
 * wrong and can try something else. A tool that was interrupted says so, so
 * the transcript stays valid.
 */
export async function execTool(
  call: ToolCall,
  state: AgentState,
  signal: AbortSignal,
): Promise<ToolResultMsg> {
  const tool = state.tools.find((candidate) => candidate.name === call.name);

  if (tool === undefined) {
    return {
      role: "tool",
      callId: call.id,
      content: `unknown tool: ${call.name}`,
      isError: true,
    };
  }

  // The schema the model was given is the schema it is held to.
  const validation = validateArgs(tool, call.args);
  if (!validation.ok) {
    return {
      role: "tool",
      callId: call.id,
      content: validation.message,
      isError: true,
    };
  }

  try {
    const result = await tool.run(call.args, {
      cwd: state.cwd ?? process.cwd(),
      signal,
    });
    return {
      role: "tool",
      callId: call.id,
      content: result.output,
      ...(result.isError === true ? { isError: true } : {}),
    };
  } catch (error) {
    if (isAbort(error, signal)) {
      return {
        role: "tool",
        callId: call.id,
        content: INTERRUPTED,
        isError: true,
      };
    }
    return {
      role: "tool",
      callId: call.id,
      content: `tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** The result for a call that was never run, so the transcript stays valid. */
/** The provider id of a "provider/model" ref. */
function providerIdOf(state: AgentState): string {
  const provider = state.provider.id;
  return provider.length > 0 ? provider : "unknown";
}

function notRun(call: ToolCall, reason: LoopEnd): ToolResultMsg {
  const content =
    reason === "aborted"
      ? INTERRUPTED
      : reason === "repeated-call"
        ? "[not run: the same call repeated]"
        : "[not run: the agent stopped]";
  return { role: "tool", callId: call.id, content, isError: true };
}

/** Two calls are the same when they ask for the same thing with the same arguments. */
function callSignature(call: ToolCall): string {
  let args: string;
  try {
    args = JSON.stringify(call.args ?? null);
  } catch {
    args = String(call.args);
  }
  return `${call.name}:${args}`;
}



