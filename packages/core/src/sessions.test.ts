import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCwd, SessionStore } from "./sessions.js";

let root: string;
let cwd: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-agent-sessions-"));
  cwd = await mkdtemp(join(tmpdir(), "cli-agent-project-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("the session store", () => {
  it("writes one JSON object per line", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "test-model" });

    await store.append({ role: "user", content: "hello" });
    await store.append({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });

    const text = await readFile(store.path(id), "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);

    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] as string) as {
      id: string;
      parent: string | null;
      msg: { role: string; content: string };
    };
    expect(first.parent).toBeNull();
    expect(first.msg).toEqual({ role: "user", content: "hello" });

    const second = JSON.parse(lines[1] as string) as { parent: string };
    expect(second.parent).toBe(first.id);
  });

  it("keeps the sessions of a project apart", () => {
    expect(hashCwd("/a/project")).not.toBe(hashCwd("/b/project"));
    expect(hashCwd("/a/project")).toBe(hashCwd("/a/project"));
    expect(hashCwd("/a/project")).toHaveLength(16);
  });

  it("lists the sessions of the project, newest first", async () => {
    const store = new SessionStore({ root, cwd });

    const first = await store.create({ model: "one" });
    await store.append({ role: "user", content: "in the first one" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.create({ model: "two" });
    await store.append({ role: "user", content: "in the second one" });

    const sessions = await store.list();

    expect(sessions.map((session) => session.id)).toEqual([second, first]);
    expect(sessions[0]?.model).toBe("two");
    expect(sessions[0]?.entries).toBe(1);
  });

  it("does not list the sessions of another project", async () => {
    const store = new SessionStore({ root, cwd });
    await store.create({ model: "one" });

    const elsewhere = new SessionStore({ root, cwd: join(cwd, "other") });

    expect(await elsewhere.list()).toEqual([]);
  });

  it("opens the last session of the project", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "one" });
    await store.append({ role: "user", content: "hello" });

    const opened = await store.open();

    expect(opened).toBe(id);
    expect(await store.transcript(id)).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("reads the conversation back", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "one" });

    await store.append({ role: "user", content: "hello" });
    await store.append({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });

    expect(await store.transcript(id)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("treats a compaction as another entry, not a rewrite", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "one" });

    await store.append({ role: "user", content: "the old thing" });
    await store.append(
      { role: "user", content: "Summary of earlier work: the goal" },
      { compacted: true },
    );
    await store.append({ role: "user", content: "the new thing" });

    // The file still holds everything.
    expect(await store.read(id)).toHaveLength(3);

    // The conversation starts at the summary.
    expect(await store.transcript(id)).toEqual([
      { role: "user", content: "Summary of earlier work: the goal" },
      { role: "user", content: "the new thing" },
    ]);
  });

  it("forks from an earlier message", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "one" });

    const first = await store.append({ role: "user", content: "the first" });
    await store.append({ role: "user", content: "the second" });

    const forked = await store.fork(id, first);
    expect(forked).toBeDefined();

    await store.append({ role: "user", content: "from the fork" });

    // The fork is its own file, hanging off the message it was forked from.
    const entries = await store.read(forked as string);
    expect(entries[0]?.parent).toBe(first);
    expect(entries[0]?.msg).toEqual({ role: "user", content: "from the fork" });
  });

  it("shows the tree of a conversation", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "one" });

    await store.append({ role: "user", content: "one" });
    await store.append({ role: "user", content: "two" });

    const tree = await store.tree(id);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.entry.msg).toEqual({
      role: "user",
      content: "two",
    });
  });

  it("removes a session", async () => {
    const store = new SessionStore({ root, cwd });
    const id = await store.create({ model: "one" });
    await store.append({ role: "user", content: "hello" });

    await store.remove(id);

    expect(await store.list()).toEqual([]);
    expect(await store.read(id)).toEqual([]);
  });
});
