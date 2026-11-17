import {
  CURSOR_MARKER,
  Input,
  Markdown,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type SelectListTheme,
} from "@earendil-works/pi-tui";
import {
  bold,
  cyan,
  dim,
  green,
  italic,
  red,
  underline,
  yellow,
} from "./colors.js";
import type { UiStore, TranscriptBlock } from "./store.js";

export const selectTheme: SelectListTheme = {
  selectedPrefix: cyan,
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: yellow,
};
export const markdownTheme: MarkdownTheme = {
  heading: bold,
  link: cyan,
  linkUrl: dim,
  code: cyan,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: dim,
  hr: dim,
  listBullet: cyan,
  bold,
  italic,
  strikethrough: dim,
  underline,
};
export function safe(text: string): string {
  // Tool output and model text must not execute terminal controls.
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
export function blockSummary(block: TranscriptBlock): string {
  if (block.kind === "thinking") {
    const lines = block.text.split("\n").length;
    return dim(
      `Thinking · ${lines} ${lines === 1 ? "line" : "lines"} · Alt+I to inspect`,
    );
  }
  if (block.kind === "tool") {
    const args = block.args as Record<string, unknown> | undefined;
    const subject =
      args?.path ?? args?.command ?? args?.pattern ?? args?.agent ?? "";
    const paint =
      block.status === "failed"
        ? red
        : block.status === "running"
          ? yellow
          : green;
    return `${paint(block.status === "running" ? "○" : block.status === "failed" ? "×" : "●")} ${bold(block.name ?? "tool")} ${safe(String(subject))} ${dim(`[${block.status}]`)}`;
  }
  return safe(block.text);
}

/** How far the agent's blocks are indented. */
const BLOCK_INDENT = "  ";
/** How far the text inside a block is indented. */
const CONTENT_INDENT = "    ";
/** How many lines of a thought are shown at once. */
const THINKING_LINES = 6;

/**
 * The conversation, drawn so that a question and an answer never look alike.
 *
 * The question the user asked sits at the margin, marked and in bold. The
 * answer comes from the agent: it is indented, and it says which model gave
 * it. A thought is dimmed and marked as a thought, and it says how much of
 * it is hidden. A call is a call: the name of the tool, and the command or
 * the path it was given, in full.
 */
export class Transcript implements Component {
  /** The markdown of each answer, kept so it is not parsed again. */
  private cache = new Map<string, { md: Markdown; text: string }>();
  /** The wrapped lines of each thought, kept for the same reason. */
  private wrapped = new Map<string, { text: string; lines: string[] }>();

  constructor(readonly store: UiStore) {}

  invalidate(): void {
    for (const value of this.cache.values()) value.md.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const block of this.store.blocks) {
      if (block.kind === "text") {
        lines.push(...this.answer(block, width), "");
      } else if (block.kind === "user") {
        lines.push(...this.question(block, width), "");
      } else if (block.kind === "thinking") {
        lines.push(...this.thought(block, width), "");
      } else if (block.kind === "notice") {
        lines.push(
          ...wrapTextWithAnsi(
            dim(safe(block.text)),
            Math.max(1, width - BLOCK_INDENT.length),
          ).map((line) => `${BLOCK_INDENT}${line}`),
          "",
        );
      } else {
        lines.push(...this.tool(block, width), "");
      }
    }
    return lines;
  }

  /**
   * The conversation, as much of it as the screen has room for.
   *
   * The frame of the session is drawn again and again, and a frame that
   * is taller than the terminal is written over the terminal itself: the
   * text ends up on the screen twice, and the middle of it is cut. The
   * newest lines are the ones that are kept, and the rest is said to be
   * above — the whole of it is one keystroke away.
   */
  renderWithin(width: number, room: number): string[] {
    const lines = this.render(width);
    if (room <= 0) return [];
    if (lines.length <= room) return lines;

    const hidden = lines.length - room + 1;
    const note = `${BLOCK_INDENT}${dim(
      `… ${hidden} lines above · Ctrl+O for the whole transcript`,
    )}`;
    return [note, ...lines.slice(-(room - 1))];
  }

  /**
   * A tool call: what it was, and what it was pointed at.
   *
   * The command is shown in full — a command that is cut in the middle is a
   * command nobody can judge — and the result is kept behind one keypress,
   * so that the conversation does not fill with output.
   */
  private tool(block: TranscriptBlock, width: number): string[] {
    const out: string[] = [];
    const inner = Math.max(1, width - BLOCK_INDENT.length);
    const args = block.args as Record<string, unknown> | undefined;
    const subject = String(
      args?.path ?? args?.command ?? args?.pattern ?? args?.agent ?? "",
    );

    const paint =
      block.status === "failed"
        ? red
        : block.status === "running"
          ? yellow
          : green;
    const mark =
      block.status === "running"
        ? "○"
        : block.status === "failed"
          ? "×"
          : "●";

    // The name of the tool and the status are the small things, and they
    // are the ones in bold. The command itself is what the user reads.
    const head = `${paint(mark)} ${bold(block.name ?? "tool")}`;
    const tail = ` ${dim(`[${block.status ?? "running"}]`)}`;

    const body = subject.length > 0 ? subject : "";
    const lines = wrapTextWithAnsi(
      body.length > 0 ? `${head} ${body}` : head,
      inner,
    );
    const last = lines.pop() ?? "";
    out.push(
      ...lines.map((line) => `${BLOCK_INDENT}${line}`),
      `${BLOCK_INDENT}${last}${tail}`,
    );

    // What the call produced is behind Alt+I, but its size is said, so
    // that nothing is missing without saying so.
    const output = block.text.trim();
    if (output.length > 0) {
      const count = output.split("\n").length;
      out.push(
        `${CONTENT_INDENT}${dim(
          `${count} ${count === 1 ? "line" : "lines"} of output · Alt+I to see it`,
        )}`,
      );
    }
    return out;
  }

  /** What the user asked: at the margin, marked, in bold. */
  private question(block: TranscriptBlock, width: number): string[] {
    const body = wrapTextWithAnsi(
      bold(safe(block.text)),
      Math.max(1, width - 2),
    );
    return body.map((line, index) =>
      index === 0 ? `${cyan("›")} ${line}` : `  ${line}`,
    );
  }

  /** What the agent answered: indented, and it says who answered. */
  private answer(block: TranscriptBlock, width: number): string[] {
    const model = block.model ?? this.store.model;
    const label = model.length > 0 ? model : "agent";
    const content = this.markdown(block, width - CONTENT_INDENT.length);
    return [
      truncateToWidth(`${BLOCK_INDENT}${dim(label)}`, width),
      ...content.map((line) => `${CONTENT_INDENT}${line}`),
    ];
  }

  /** A thought: dimmed, marked, and it says how much of it is hidden. */
  private thought(block: TranscriptBlock, width: number): string[] {
    const lines = this.thoughtLines(
      block,
      Math.max(1, width - CONTENT_INDENT.length),
    );
    const shown = lines.slice(-THINKING_LINES);
    const out = [`${BLOCK_INDENT}${dim(italic("thinking"))}`];
    for (const line of shown) out.push(`${CONTENT_INDENT}${dim(line)}`);
    if (lines.length > THINKING_LINES)
      out.push(
        `${CONTENT_INDENT}${dim(
          `… ${lines.length - THINKING_LINES} earlier lines · Alt+I or /inspect`,
        )}`,
      );
    return out;
  }

  /** The markdown of an answer, parsed only when the text changes. */
  private markdown(block: TranscriptBlock, width: number): string[] {
    let entry = this.cache.get(block.id);
    if (entry === undefined) {
      entry = { md: new Markdown("", 0, 0, markdownTheme), text: "" };
      this.cache.set(block.id, entry);
    }
    if (entry.text !== block.text) {
      entry.md.setText(safe(block.text));
      entry.text = block.text;
    }
    return entry.md.render(Math.max(1, width));
  }

  /** The lines of a thought, wrapped only when the text changes. */
  private thoughtLines(block: TranscriptBlock, width: number): string[] {
    const cached = this.wrapped.get(block.id);
    if (cached !== undefined && cached.text === block.text) return cached.lines;
    const lines = wrapTextWithAnsi(safe(block.text), Math.max(1, width));
    this.wrapped.set(block.id, { text: block.text, lines });
    return lines;
  }
}
export interface Choice {
  value: string;
  label: string;
  description?: string;
  current?: boolean;
  /** The heading it sits under, when the list is grouped. */
  group?: string;
}

/** One answer the user can give when a tool needs permission. */
export interface ApprovalChoice {
  value: string;
  label: string;
  /** What it means, in one line. */
  hint?: string;
}

/**
 * The question the agent asks when a tool needs permission.
 *
 * It is drawn as a box, so it is never mistaken for part of the answer, and
 * the cursor sits on the answer that is picked: the dialog is where the
 * terminal is, not the line behind it.
 *
 * The question says what is wanted, in what directory, and what it would
 * touch, before the answers: a permission the user cannot judge is a
 * permission they have to refuse.
 */
export class Approval implements Component, Focusable {
  focused = true;
  readonly capturesViewportInput = true;
  private index = 0;
  private offset = 0;

  constructor(
    readonly title: string,
    readonly lines: string[],
    readonly choices: ApprovalChoice[],
    readonly choose: (choice?: ApprovalChoice) => void,
    private readonly rows: () => number,
    readonly hint = "↑↓ move · Enter choose · d details · Esc denies",
    public onDetails?: () => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const body: Array<{ text: string; cursor?: number }> = [];
    for (const line of this.lines) {
      // The lines are the ones the caller prepared: the parts that come
      // from the model are made safe there, and the parts that are ours
      // keep their colour. A line that is too long for the box keeps its
      // own indent on the lines that follow it.
      const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      const wrapped = wrapTextWithAnsi(line, Math.max(1, inner - 2 - lead));
      body.push({ text: ` ${wrapped[0] ?? ""}` });
      for (const rest of wrapped.slice(1))
        body.push({ text: ` ${" ".repeat(lead)}${rest}` });
    }
    if (body.length > 0) body.push({ text: "" });
    for (const [position, choice] of this.choices.entries()) {
      const selected = position === this.index;
      const mark = selected ? cyan("›") : " ";
      body.push({
        // The answer that is picked is in bold: it is the one the cursor is
        // on, and it must be obvious which one that is.
        text: ` ${mark} ${selected ? bold(choice.label) : choice.label}`,
        ...(selected ? { cursor: 3 } : {}),
      });
      if (choice.hint !== undefined)
        body.push({ text: `   ${dim(choice.hint)}` });
    }
    body.push({ text: "" });
    body.push({ text: ` ${dim(this.hint)}` });

    // The box is as tall as it needs to be, and never taller than the
    // terminal has rows.
    const room = Math.max(3, this.rows() - 2);
    this.offset = Math.max(
      0,
      Math.min(this.offset, Math.max(0, body.length - room)),
    );
    const visible = body.slice(this.offset, this.offset + room);

    const label = ` ${this.title} `;
    const fill = Math.max(0, inner - 1 - label.length);
    const top = `${dim("╭─")}${dim(label)}${dim("─".repeat(fill) + "╮")}`;
    const bottom = `${dim("╰")}${dim("─".repeat(inner))}${dim("╯")}`;

    return [
      top,
      ...visible.map((entry) => {
        const text = truncateToWidth(entry.text, inner);
        const padded = text + " ".repeat(Math.max(0, inner - visibleWidth(text)));
        const marked =
          entry.cursor === undefined || !this.focused
            ? padded
            : `${padded.slice(0, entry.cursor)}${CURSOR_MARKER}${padded.slice(entry.cursor)}`;
        return `${dim("│")}${marked}${dim("│")}`;
      }),
      bottom,
    ];
  }

  handleInput(data: string): void {
    if (data === "d" && this.onDetails !== undefined) {
      this.onDetails();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.choose();
      return;
    }
    if (matchesKey(data, "enter")) {
      const choice = this.choices[this.index];
      if (choice !== undefined) this.choose(choice);
      return;
    }
    const length = this.choices.length;
    if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, "down"))
      this.index = Math.min(length - 1, this.index + 1);
    else if (matchesKey(data, "home")) this.index = 0;
    else if (matchesKey(data, "end")) this.index = Math.max(0, length - 1);
    else if (matchesKey(data, "pageUp")) this.index = Math.max(0, this.index - 3);
    else if (matchesKey(data, "pageDown"))
      this.index = Math.min(length - 1, this.index + 3);
  }
}

/** A focused selector with its own search input; never shares the prompt editor. */
export class Selector implements Component, Focusable {
  onDetails?: () => void;
  focused = true;
  readonly capturesViewportInput = true;
  readonly input = new Input({ prompt: "Search: " });
  private index = 0;
  private filtered: Choice[];
  private height = 8;
  status = "";
  constructor(
    readonly title: string,
    private items: Choice[],
    private rows: () => number,
    readonly choose: (choice?: Choice) => void,
    readonly searchable = true,
    readonly description = "",
  ) {
    this.filtered = items;
    this.index = Math.max(
      0,
      items.findIndex((item) => item.current),
    );
  }
  setItems(items: Choice[]): void {
    const value = this.filtered[this.index]?.value;
    this.items = items;
    this.filter();
    const index = this.filtered.findIndex(
      (item) => item.value === value || (value === undefined && item.current),
    );
    this.index = Math.max(0, index);
  }
  private filter(): void {
    const query = this.input.getValue();
    this.filtered = query
      ? fuzzyFilter(
          this.items,
          query,
          (item) => `${item.label} ${item.description ?? ""} ${item.value} ${item.group ?? ""}`,
        )
      : this.items;
    this.index = Math.min(this.index, Math.max(0, this.filtered.length - 1));
  }
  invalidate(): void {}
  render(width: number): string[] {
    this.input.focused = this.focused;
    const prefix = [truncateToWidth(bold(this.title), width)];
    if (this.description)
      prefix.push(
        ...wrapTextWithAnsi(safe(this.description), width).slice(0, 5),
      );
    if (this.searchable) prefix.push(...this.input.render(width));
    if (this.status) prefix.push(truncateToWidth(yellow(this.status), width));
    this.height = Math.max(1, Math.min(10, this.rows() - prefix.length - 5));
    const start = Math.max(
      0,
      Math.min(
        this.index - Math.floor(this.height / 2),
        this.filtered.length - this.height,
      ),
    );
    const visible = this.filtered.slice(start, start + this.height);
    const lines: string[] = [];
    // The heading of the group that is on is said first, and stays there
    // while the list is scrolled: the models of a provider are never a
    // nameless wall.
    const first = visible[0];
    let group = first?.group;
    if (group !== undefined) lines.push(truncateToWidth(dim(`  ${group}`), width));
    for (const [position, item] of visible.entries()) {
      // The heading of a group is said once, when the group begins.
      if (item.group !== undefined && item.group !== group) {
        group = item.group;
        lines.push(truncateToWidth(dim(`  ${group}`), width));
      }
      const selected = start + position === this.index;
      const label = safe(item.label).replace(/\n/g, " ");
      lines.push(
        truncateToWidth(
          // The item that is picked is in bold: it is the one the cursor
          // is on, and it must be obvious which one that is.
          `${selected ? cyan("›") : " "} ${selected ? bold(label) : label}${item.current ? dim(" (current)") : ""}`,
          width,
        ),
      );
    }
    const selected = this.filtered[this.index];
    if (selected?.description)
      lines.push(
        ...wrapTextWithAnsi(dim(safe(selected.description)), width).slice(0, 2),
      );
    return [
      ...prefix,
      "",
      ...(lines.length ? lines : [dim("No matching results")]),
      "",
      truncateToWidth(
        dim(
          `${this.filtered.length ? start + 1 : 0}–${start + visible.length} of ${this.filtered.length} · ↑↓ move · Enter select · Esc back${this.onDetails ? " · d details" : ""}`,
        ),
        width,
      ),
    ];
  }
  handleInput(data: string): void {
    if (data === "d" && this.onDetails) {
      this.onDetails();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.choose();
      return;
    }
    if (matchesKey(data, "enter")) {
      const choice = this.filtered[this.index];
      if (choice) this.choose(choice);
      return;
    }
    const length = this.filtered.length;
    if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, "down"))
      this.index = Math.min(length - 1, this.index + 1);
    else if (matchesKey(data, "pageUp"))
      this.index = Math.max(0, this.index - this.height);
    else if (matchesKey(data, "pageDown"))
      this.index = Math.min(length - 1, this.index + this.height);
    else if (matchesKey(data, "home")) this.index = 0;
    else if (matchesKey(data, "end")) this.index = Math.max(0, length - 1);
    else if (this.searchable) {
      this.input.handleInput(data);
      this.index = 0;
      this.filter();
    }
  }
}

export class Detail implements Component {
  readonly capturesViewportInput = true;
  private offset = 0;
  private height = 10;
  constructor(
    readonly title: string,
    readonly content: () => string,
    private rows: () => number,
    readonly close: () => void,
    readonly action?: (key: string) => void,
    readonly hint = "↑↓ / PgUp PgDn scroll · Esc back",
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    this.height = Math.max(1, this.rows() - 7);
    const lines = wrapTextWithAnsi(safe(this.content()), width);
    this.offset = Math.max(
      0,
      Math.min(this.offset, lines.length - this.height),
    );
    return [
      truncateToWidth(bold(this.title), width),
      "",
      ...lines.slice(this.offset, this.offset + this.height),
      "",
      truncateToWidth(dim(this.hint), width),
    ];
  }
  handleInput(data: string): void {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+o") ||
      matchesKey(data, "alt+i")
    )
      this.close();
    else if (matchesKey(data, "up")) this.offset--;
    else if (matchesKey(data, "down")) this.offset++;
    else if (matchesKey(data, "pageUp")) this.offset -= this.height;
    else if (matchesKey(data, "pageDown")) this.offset += this.height;
    else if (matchesKey(data, "home")) this.offset = 0;
    else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
    else this.action?.(data);
  }
}
