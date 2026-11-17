import type { Msg } from "@cli-agent/ai";
import type { AgentEvent } from "@cli-agent/core";

export interface TranscriptBlock {
  id: string;
  kind: "user" | "text" | "thinking" | "tool" | "notice";
  text: string;
  name?: string;
  args?: unknown;
  status?: "running" | "succeeded" | "failed" | "cancelled";
  /** The model that gave this answer, when it is known. */
  model?: string;
}

/** Display state only: folding, progress and dialogs never enter model history. */
export class UiStore {
  blocks: TranscriptBlock[] = [];
  activity = "";
  notice = "";
  pending: string[] = [];
  /** The model that is in use, so an answer says who gave it. */
  model = "";
  private sequence = 0;
  private prefix = "";
  private lastKind = "";
  private tools = new Map<string, TranscriptBlock>();
  private id(): string {
    return `${this.prefix}:${++this.sequence}`;
  }
  modelChanged(from: string, to: string): void {
    this.blocks.push({
      id: this.id(),
      kind: "notice",
      text: `Model changed: ${from} → ${to}`,
    });
    this.model = to;
    this.lastKind = "";
  }
  restore(
    messages: Msg[],
    prefix: string,
    changes: { after: number; from: string; to: string }[] = [],
    model = "",
  ): void {
    this.blocks = [];
    this.tools.clear();
    this.prefix = prefix;
    this.lastKind = "";
    if (model.length > 0) this.model = model;
    for (let index = 0; index <= messages.length; index++) {
      for (const change of changes.filter((change) => change.after === index))
        this.modelChanged(change.from, change.to);
      const message = messages[index];
      if (!message) break;
      if (message.role === "user")
        this.blocks.push({
          id: this.id(),
          kind: "user",
          text: message.content,
        });
      else if (message.role === "tool") {
        const block = this.tools.get(message.callId);
        if (block) {
          block.text = message.content;
          block.status = message.isError ? "failed" : "succeeded";
        }
      } else
        for (const block of message.content) {
          if (block.type === "toolCall") {
            const tool: TranscriptBlock = {
              id: this.id(),
              kind: "tool",
              name: block.name,
              args: block.args,
              text: "",
              status: "cancelled",
            };
            this.tools.set(block.id, tool);
            this.blocks.push(tool);
          } else if (block.text)
            this.blocks.push({
              id: this.id(),
              kind: block.type,
              text: block.text,
              model: this.model,
            });
        }
    }
  }
  begin(prompt: string): void {
    this.notice = "";
    this.blocks.push({ id: this.id(), kind: "user", text: prompt });
    this.lastKind = "";
    this.tools.clear();
    this.activity = "Thinking";
  }
  event(event: AgentEvent): void {
    if (event.t === "text" || event.t === "thinking") {
      if (event.delta) {
        const last = this.blocks.at(-1);
        if (last && last.kind === event.t && this.lastKind === event.t)
          last.text += event.delta;
        else
          this.blocks.push({
            id: this.id(),
            kind: event.t,
            text: event.delta,
            model: this.model,
          });
      }
      this.lastKind = event.t;
      this.activity = event.t === "thinking" ? "Thinking" : "Responding";
    } else if (event.t === "toolStart") {
      if (!this.tools.has(event.call.id)) {
        const block: TranscriptBlock = {
          id: this.id(),
          kind: "tool",
          name: event.call.name,
          args: event.call.args,
          text: "",
          status: "running",
        };
        this.tools.set(event.call.id, block);
        this.blocks.push(block);
      }
      this.lastKind = "";
      this.activity = `Running ${event.call.name}`;
    } else if (event.t === "toolEnd") {
      const block = this.tools.get(event.call.id);
      if (block) {
        block.text = event.output;
        block.status = event.isError ? "failed" : "succeeded";
      }
      this.lastKind = "";
    } else if (event.t === "retry") {
      this.blocks.push({
        id: this.id(),
        kind: "notice",
        text: `Attempt ${event.attempt} failed; partial output above. Retrying in ${event.delayMs}ms.`,
      });
      this.lastKind = "";
      this.activity = "Retrying";
    } else if (event.t === "done") this.finish(event.reason === "aborted");
  }
  finish(aborted = false): void {
    for (const block of this.tools.values())
      if (block.status === "running") block.status = "cancelled";
    this.activity = "";
    this.lastKind = "";
    if (aborted) this.notice = "interrupted";
  }
}
