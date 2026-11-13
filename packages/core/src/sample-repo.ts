/**
 * A small project with a failing test.
 *
 * The scenario the guide asks for: the agent reads the failing test, fixes
 * the code and runs the test again. It is small on purpose — the point is
 * that read, edit and bash work together, not that the bug is hard.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SampleRepo {
  /** The directory the project is in. */
  dir: string;
  /** The file with the bug. */
  source: string;
  /** The test that fails until the bug is fixed. */
  test: string;
}

/** The source with the bug: it takes one off the sum. */
export const SAMPLE_SOURCE = `export function sum(a, b) {
  return a + b - 1;
}
`;

/** The test that catches it. */
export const SAMPLE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.mjs";

test("sum adds two numbers", () => {
  assert.equal(sum(2, 3), 5);
});
`;

/** Write the project into a directory. */
export async function createSampleRepo(dir: string): Promise<SampleRepo> {
  await mkdir(dir, { recursive: true });

  const source = join(dir, "sum.mjs");
  const test = join(dir, "sum.test.mjs");

  await writeFile(source, SAMPLE_SOURCE, "utf8");
  await writeFile(test, SAMPLE_TEST, "utf8");

  return { dir, source, test };
}

/** The command that runs the test. */
export const SAMPLE_TEST_COMMAND = "node --test";
