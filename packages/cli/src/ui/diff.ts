/**
 * Diffs, for the edits.
 *
 * When the model edits a file, the interesting part is what changed: the
 * lines that go and the lines that come.
 */

import { green, red } from "./colors.js";

/** One line of a diff. */
export interface DiffLine {
  kind: "add" | "remove" | "same";
  text: string;
}

/**
 * The differences between two texts, line by line.
 *
 * A plain longest-common-subsequence diff: the texts a model edits are
 * small enough for it to be fine.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");

  // The LCS table, kept as a rolling two rows so a big file does not eat
  // the memory.
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const row = lengths[i] as number[];
      const next = lengths[i + 1] as number[];
      row[j] =
        left[i] === right[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ kind: "same", text: left[i] as string });
      i += 1;
      j += 1;
      continue;
    }
    const down = (lengths[i + 1] as number[])[j] as number;
    const right_ = (lengths[i] as number[])[j + 1] as number;
    if (down >= right_) {
      lines.push({ kind: "remove", text: left[i] as string });
      i += 1;
    } else {
      lines.push({ kind: "add", text: right[j] as string });
      j += 1;
    }
  }

  while (i < left.length) {
    lines.push({ kind: "remove", text: left[i] as string });
    i += 1;
  }
  while (j < right.length) {
    lines.push({ kind: "add", text: right[j] as string });
    j += 1;
  }

  return lines;
}

/** The diff, as text for the terminal. */
export function renderDiff(before: string, after: string): string {
  return diffLines(before, after)
    .map((line) => {
      if (line.kind === "add") return green(`+ ${line.text}`);
      if (line.kind === "remove") return red(`- ${line.text}`);
      return `  ${line.text}`;
    })
    .join("\n");
}

/** The diff of a replacement, when only the replaced text is known. */
export function renderReplacement(
  oldString: string,
  newString: string,
): string {
  return renderDiff(oldString, newString);
}
