/**
 * The agent loop.
 *
 * model -> tool calls -> results -> model, until the model stops asking for
 * tools. The loop yields events and never prints, so the CLI, a JSON mode and
 * a sub-agent all consume the same stream.
 */

import type {
  Event,
  StopReason,
  ToolCall,
  Usage,
} from "@cli-agent/ai";
import { buildContext, type Context } from "./context.js";
import type {
  AgentEvent,
  AgentState,
  AssistantTurn,
  ToolResultMsg,
} from "./types.js";

/**
 * Run one prompt to completion.
 *
 * The conversation grows in `state.messages`; the caller reads the events as
 * they arrive. The generator returns when the model answers without asking
 * for another tool.
 */
export async function* run(
  state: AgentState,
  input: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  state.messages.push({ role: "user", content: input });

  let turns = 0;
  let stop: StopReason = "end";
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };

  while (true) {
    const ctx: Context = buildContext(state);
    const turn: AssistantTurn = { role: "assistant", content: [] };
    turns += 1;

    for await (const event of state.provider.stream({ ...ctx, signal })) {
      if (event.t === "done") {
        stop = event.stop;
        usage = event.usage;
        turn.usage = event.usage;
        continue;
      }
      const emitted = accumulate(turn, event);
      if (emitted !== undefined) yield emitted;
    }

    state.messages.push(turn);

    const calls = turn.content.filter(
      (block): block is ToolCall => block.type === "toolCall",
    );

    // The model is finished.
    if (calls.length === 0) {
      yield { t: "done", stop, turns, usage };
      return;
    }

    // The tools run together; their results go back in the order the model
    // asked for them.
    const results = await Promise.all(
      calls.map((call) => execTool(call, state, signal)),
    );

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
 * A tool that is missing or throws does not stop the loop: the model is told
 * what went wrong and can try something else.
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
    return {
      role: "tool",
      callId: call.id,
      content: `tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
