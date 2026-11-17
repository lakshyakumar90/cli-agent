/**
 * A list you can pick from.
 *
 * It is drawn under the prompt, and the keys that are not the picker's go
 * to the line as usual: the list is a list, not a mode. The arrows move,
 * Enter takes, Escape puts it away.
 *
 * The list is drawn and taken away again on every move, so the terminal is
 * never left with half a list on it.
 */

import { bold, cyan, dim, green, highlight } from "./colors.js";
import { box } from "./frame.js";

/** One thing to pick. */
export interface PickerItem {
  /** What is shown. */
  label: string;
  /** What it means, when there is something to say. */
  description?: string;
  /** What it means. */
  value: string;
  /** The heading it sits under. */
  group?: string;
  /** It is the one in use. */
  current?: boolean;
}

/** How many lines of the list are shown at once. */
export const VISIBLE = 12;

export interface PickerOptions {
  /** Where the list is drawn. */
  out: NodeJS.WritableStream;
  /** The heading of the box, when there is a box. */
  title?: string;
  /** The line under the list. */
  hint?: string;
  /** The list is in a box. */
  boxed?: boolean;
  /** The items are numbered. */
  numbered?: boolean;
}

export class Picker {
  private index = 0;
  private drawn = 0;
  private list: PickerItem[];
  private everything: PickerItem[];

  constructor(
    items: PickerItem[],
    private readonly options: PickerOptions,
  ) {
    this.list = items;
    this.everything = items;
  }

  /** The things on the list. */
  get all(): PickerItem[] {
    return this.list;
  }

  /** The one that is on. */
  get selected(): PickerItem | undefined {
    return this.list[this.index];
  }

  /** Put the list back together, with the new items. */
  set items(items: PickerItem[]) {
    this.list = items;
    this.everything = items;
    if (this.index >= items.length) this.index = Math.max(0, items.length - 1);
  }

  /**
   * Narrow the list down to what has been typed.
   *
   * The name, the value, the description and the group are all looked at,
   * so "gem" finds a model called "gemini" and a provider called "gemini"
   * too.
   */
  narrow(filter: string): void {
    const typed = filter.trim().toLowerCase();

    this.list =
      typed.length === 0
        ? this.everything
        : this.everything.filter(
            (item) =>
              item.label.toLowerCase().includes(typed) ||
              item.value.toLowerCase().includes(typed) ||
              (item.description ?? "").toLowerCase().includes(typed) ||
              (item.group ?? "").toLowerCase().includes(typed),
          );

    if (this.index >= this.list.length) {
      this.index = Math.max(0, this.list.length - 1);
    }
  }

  /** Move the selection. The list wraps around. */
  move(delta: number): void {
    if (this.list.length === 0) return;
    this.index = (this.index + delta + this.list.length) % this.list.length;
  }

  /** Draw the list under the prompt. */
  render(): void {
    this.erase();

    const lines = this.lines();
    if (lines.length === 0) return;

    for (const line of lines) this.options.out.write(`${line}\n`);
    this.drawn = lines.length;
  }

  /** Take the list off the screen. */
  erase(): void {
    if (this.drawn === 0) return;
    this.options.out.write(`\x1b[${this.drawn}A\r\x1b[J`);
    this.drawn = 0;
  }

  /** The lines of the list, with the window on the selection. */
  private lines(): string[] {
    if (this.list.length === 0) return [];

    if (this.options.boxed === true) {
      return box(this.boxedLines(), {
        ...(this.options.title === undefined ? {} : { title: this.options.title }),
        ...(this.options.hint === undefined ? {} : { hint: this.options.hint }),
      }).split("\n");
    }

    return this.plainLines();
  }

  /** The lines inside the box. */
  private boxedLines(): string[] {
    const lines: string[] = [""];
    const start = windowStart(this.index, this.list.length);
    const end = Math.min(this.list.length, start + VISIBLE);

    let group: string | undefined;
    for (let index = start; index < end; index += 1) {
      const item = this.list[index];
      if (item === undefined) continue;

      if (item.group !== undefined && item.group !== group) {
        group = item.group;
        lines.push(dim(item.group));
      }

      lines.push(this.itemLine(item, index === this.index));
    }

    const hidden = this.list.length - (end - start);
    if (hidden > 0) lines.push(dim(`… ${hidden} more`));

    return lines;
  }

  /** The lines without a box. */
  private plainLines(): string[] {
    const lines: string[] = [];
    if (this.options.title !== undefined) lines.push(dim(this.options.title));

    const start = windowStart(this.index, this.list.length);
    const end = Math.min(this.list.length, start + VISIBLE);

    let group: string | undefined;
    for (let index = start; index < end; index += 1) {
      const item = this.list[index];
      if (item === undefined) continue;

      if (item.group !== undefined && item.group !== group) {
        group = item.group;
        lines.push(dim(item.group));
      }

      lines.push(this.itemLine(item, index === this.index));
    }

    const hidden = this.list.length - (end - start);
    if (hidden > 0) lines.push(dim(`… ${hidden} more`));

    return lines;
  }

  /** One item, with its description. */
  private itemLine(item: PickerItem, selected: boolean): string {
    const number =
      this.options.numbered === true ? `${this.indexOf(item) + 1}. ` : "";
    const mark = selected ? cyan(">") : " ";

    const name = `${number}${item.label}`;
    const current = item.current === true ? dim(" (current)") : "";

    const description =
      item.description === undefined ? "" : `  ${dim(item.description)}`;

    const line = `${mark} ${name}${current}${description}`;

    return selected ? highlight(line) : line;
  }

  /** Where an item sits in the whole list. */
  private indexOf(item: PickerItem): number {
    return this.everything.indexOf(item);
  }
}

/** Where the window on a long list starts. */
export function windowStart(index: number, total: number): number {
  if (total <= VISIBLE) return 0;
  // The selection stays in the middle of the window, so the list does not
  // jump under the cursor.
  return Math.max(0, Math.min(index - Math.floor(VISIBLE / 2), total - VISIBLE));
}
