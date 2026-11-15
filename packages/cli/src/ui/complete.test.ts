import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeFile, completePath } from "./complete.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-complete-"));
  await writeFile(join(directory, "alpha.ts"), "a", "utf8");
  await writeFile(join(directory, "beta.ts"), "b", "utf8");
  await writeFile(join(directory, ".hidden"), "h", "utf8");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("completing a path", () => {
  it("offers the directories that match", async () => {
    await mkdir(join(directory, "src"), { recursive: true });

    const candidates = await completePath("s", directory);

    expect(candidates).toContain("src/");
  });

  it("offers nothing when nothing matches", async () => {
    const candidates = await completePath("zzz", directory);

    expect(candidates).toEqual([]);
  });
});

describe("completing a file", () => {
  it("offers the files that match", async () => {
    const candidates = await completeFile("al", directory);

    expect(candidates).toContain("alpha.ts");
    expect(candidates).not.toContain("beta.ts");
  });

  it("leaves the hidden files out", async () => {
    const candidates = await completeFile(".", directory);

    expect(candidates).not.toContain(".hidden");
  });

  it("walks into a folder that is being typed", async () => {
    const candidates = await completeFile("src/", join(directory, "src"));

    expect(candidates).toEqual([]);
  });

  it("offers every file when nothing has been typed", async () => {
    const candidates = await completeFile("", directory);

    expect(candidates).toContain("alpha.ts");
    expect(candidates).toContain("beta.ts");
  });
});
