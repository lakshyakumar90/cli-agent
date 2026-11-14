import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./checkpoints.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-checkpoints-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the checkpoints", () => {
  it("remembers what a file held", async () => {
    const path = join(directory, "a.txt");
    await writeFile(path, "before", "utf8");

    const store = new CheckpointStore();
    await store.snapshot("call-1", path);

    expect(store.latest()?.before).toBe("before");
  });

  it("remembers that a file was not there", async () => {
    const path = join(directory, "new.txt");

    const store = new CheckpointStore();
    await store.snapshot("call-1", path);

    expect(store.latest()?.before).toBeUndefined();
  });

  it("puts a file back", async () => {
    const path = join(directory, "a.txt");
    await writeFile(path, "before", "utf8");

    const store = new CheckpointStore();
    await store.snapshot("call-1", path);

    await writeFile(path, "after", "utf8");
    await store.undo(path);

    expect(await readFile(path, "utf8")).toBe("before");
  });

  it("removes a file that was not there before", async () => {
    const path = join(directory, "new.txt");

    const store = new CheckpointStore();
    await store.snapshot("call-1", path);

    await writeFile(path, "made", "utf8");
    const undone = await store.undo(path);

    expect(undone?.result).toBe("removed");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("undoes the last change to a file", async () => {
    const first = join(directory, "a.txt");
    const second = join(directory, "b.txt");
    await writeFile(first, "one", "utf8");
    await writeFile(second, "two", "utf8");

    const store = new CheckpointStore();
    await store.snapshot("call-1", first);
    await store.snapshot("call-2", second);

    await writeFile(second, "changed", "utf8");
    await store.undo();

    expect(await readFile(second, "utf8")).toBe("two");
    expect(await readFile(first, "utf8")).toBe("one");
  });

  it("says there is nothing to undo", async () => {
    const store = new CheckpointStore();

    expect(await store.undo()).toBeUndefined();
    expect(store.latest()).toBeUndefined();
  });
});
