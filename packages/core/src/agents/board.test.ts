import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Board } from "./board.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-board-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the board", () => {
  it("keeps a task and what happened to it", () => {
    const board = new Board();

    board.add({ id: "t1", agent: "explorer", prompt: "find the thing" });
    expect(board.get("t1")?.status).toBe("pending");

    board.update("t1", { status: "running", owner: "explorer" });
    expect(board.get("t1")?.status).toBe("running");

    board.update("t1", { status: "done", result: "found it" });
    expect(board.get("t1")?.result).toBe("found it");
  });

  it("lists the tasks that are not finished", () => {
    const board = new Board();

    board.add({ id: "t1", agent: "a", prompt: "one" });
    board.add({ id: "t2", agent: "b", prompt: "two" });
    board.update("t2", { status: "done" });

    expect(board.open().map((task) => task.id)).toEqual(["t1"]);
  });

  it("writes itself out and reads itself back", async () => {
    const path = join(directory, "board.json");
    const board = new Board({ path });

    board.add({ id: "t1", agent: "explorer", prompt: "find it" });
    board.update("t1", { status: "done", result: "found" });
    await board.save();

    const written = JSON.parse(await readFile(path, "utf8")) as Array<{
      id: string;
      status: string;
    }>;
    expect(written[0]?.id).toBe("t1");

    const other = new Board({ path });
    await other.load();
    expect(other.get("t1")?.status).toBe("done");
  });

  it("renders one line per task", () => {
    const board = new Board();
    board.add({ id: "t1", agent: "explorer", prompt: "find the thing" });
    board.update("t1", { status: "done" });

    expect(board.render()).toContain("✓ t1 explorer");
  });
});
