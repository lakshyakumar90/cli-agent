import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createTools } from "./tools.js";
import type { ToolContext } from "./types.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-files-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function context(over: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: directory,
    signal: new AbortController().signal,
    ...over,
  };
}

describe("read", () => {
  it("shows the file with line numbers", async () => {
    await writeFile(join(directory, "a.txt"), "one\ntwo\nthree\n");

    const result = await createReadTool().run(
      { path: "a.txt" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toBe("a.txt\n1\tone\n2\ttwo\n3\tthree");
  });

  it("reads from an offset", async () => {
    await writeFile(join(directory, "a.txt"), "one\ntwo\nthree\nfour\n");

    const result = await createReadTool().run(
      { path: "a.txt", offset: 2, limit: 2 },
      context(),
    );

    expect(result.output).toContain("2\ttwo");
    expect(result.output).toContain("3\tthree");
    expect(result.output).not.toContain("1\tone");
    expect(result.output).toContain("showing lines 2-3 of 4");
  });

  it("says when the file is not there", async () => {
    const result = await createReadTool().run({ path: "nope.txt" }, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("no such file");
  });

  it("refuses a directory", async () => {
    await mkdir(join(directory, "sub"), { recursive: true });

    const result = await createReadTool().run({ path: "sub" }, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("directory");
  });

  it("refuses a binary file", async () => {
    await writeFile(join(directory, "a.bin"), Buffer.from([0, 1, 2, 0]));

    const result = await createReadTool().run({ path: "a.bin" }, context());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("binary");
  });

  it("caps what it reads", async () => {
    await writeFile(join(directory, "big.txt"), "x".repeat(5_000));

    const result = await createReadTool({ maxBytes: 100 }).run(
      { path: "big.txt" },
      context(),
    );

    expect(result.output).toContain("larger than 100 bytes");
  });

  it("caps the lines it shows", async () => {
    await writeFile(
      join(directory, "many.txt"),
      Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
    );

    const result = await createReadTool({ maxLines: 5 }).run(
      { path: "many.txt" },
      context(),
    );

    expect(result.output).toContain("5\tline 4");
    expect(result.output).not.toContain("line 5");
  });
});

describe("write", () => {
  it("creates a file", async () => {
    const result = await createWriteTool().run(
      { path: "a.txt", content: "hello\n" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("wrote 6 bytes");
    expect(result.output).toContain("a.txt");
  });

  it("creates the directories it needs", async () => {
    await createWriteTool().run(
      { path: "deep/deeper/a.txt", content: "x" },
      context(),
    );

    const result = await createReadTool().run(
      { path: "deep/deeper/a.txt" },
      context(),
    );
    expect(result.output).toContain("1\tx");
  });

  it("overwrites what is there", async () => {
    await writeFile(join(directory, "a.txt"), "old");

    await createWriteTool().run(
      { path: "a.txt", content: "new" },
      context(),
    );

    const result = await createReadTool().run({ path: "a.txt" }, context());
    expect(result.output).toContain("1\tnew");
    expect(result.output).not.toContain("old");
  });
});

describe("edit", () => {
  it("replaces a unique string", async () => {
    await writeFile(join(directory, "a.txt"), "hello world\n");

    const result = await createEditTool().run(
      { path: "a.txt", old_string: "world", new_string: "there" },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("replaced 1 occurrence");

    const read = await createReadTool().run({ path: "a.txt" }, context());
    expect(read.output).toContain("hello there");
  });

  it("fails when the string is not there", async () => {
    await writeFile(join(directory, "a.txt"), "hello\n");

    const result = await createEditTool().run(
      { path: "a.txt", old_string: "missing", new_string: "x" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("not in the file");
  });

  it("fails when the string is not unique", async () => {
    await writeFile(join(directory, "a.txt"), "a\na\na\n");

    const result = await createEditTool().run(
      { path: "a.txt", old_string: "a", new_string: "b" },
      context(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("appears 3 times");
    expect(result.output).toContain("not unique");
  });

  it("replaces every occurrence when asked to", async () => {
    await writeFile(join(directory, "a.txt"), "a\na\na\n");

    const result = await createEditTool().run(
      { path: "a.txt", old_string: "a", new_string: "b", replace_all: true },
      context(),
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("replaced 3 occurrences");

    const read = await createReadTool().run({ path: "a.txt" }, context());
    expect(read.output).toContain("1\tb");
    expect(read.output).toContain("3\tb");
  });

  it("leaves the file alone when it fails", async () => {
    await writeFile(join(directory, "a.txt"), "a\na\n");

    await createEditTool().run(
      { path: "a.txt", old_string: "a", new_string: "b" },
      context(),
    );

    const read = await createReadTool().run({ path: "a.txt" }, context());
    expect(read.output).toContain("1\ta");
  });

  it("refuses an edit that changes nothing", async () => {
    await writeFile(join(directory, "a.txt"), "a\n");

    const result = await createEditTool().run(
      { path: "a.txt", old_string: "a", new_string: "a" },
      context(),
    );

    expect(result.isError).toBe(true);
  });
});

describe("the tool set", () => {
  it("has the six tools", () => {
    const names = createTools().map((tool) => tool.name);
    expect(names).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "glob",
      "todo",
    ]);
  });

  it("gives every tool a name, a description and a schema", () => {
    for (const tool of createTools()) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.schema).toBeDefined();
    }
  });
});
