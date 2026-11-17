import type { Msg } from "@cli-agent/ai";
import type { AgentState } from "@cli-agent/core";
/**
 * The models the agent knows about, for /model.
 *
 * This is the fallback: the real list is asked of the providers when the
 * picker is opened, so the free models of a router are the ones that
 * exist today.
 */
export function knownModels(): string[] {
  return [
    "openrouter/nvidia/nemotron-3.5-lightning:free",
    "openrouter/inclusionai/ling-3.2-flash:free",
    "openrouter/cohere/north-mini-code:free",
    "codex/gpt-6.1-sol",
    "opencode-cli/opencode/big-pickle",
    "anthropic/claude-sonnet-5-5",
    "openai/gpt-6.1-sol",
    "gemini/gemini-3.1-flash-lite",
  ];
}

/** The model id of a "provider/model" ref. */
export function modelIdOf(ref: string): string {
  const slash = ref.indexOf("/");
  return slash <= 0 ? ref : ref.slice(slash + 1);
}

/**
 * Summarise a conversation, so the context can start again from the summary.
 */
export async function summarise(
  state: AgentState,
  messages: Msg[],
): Promise<string | undefined> {
  const transcript = messages
    .map((message) => `${message.role}: ${contentOf(message)}`)
    .join("\n\n");

  const pieces: string[] = [];
  try {
    for await (const event of state.provider.stream({
      model: state.model,
      system:
        "Summarise this conversation in a few lines: what was asked, what was done, and what is left. Keep the details that matter for continuing.",
      messages: [{ role: "user", content: transcript }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.t === "text") pieces.push(event.delta);
    }
  } catch {
    return undefined;
  }

  const summary = pieces.join("").trim();
  return summary.length > 0 ? summary : undefined;
}

function contentOf(message: Msg): string {
  if (message.role === "user" || message.role === "tool")
    return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
