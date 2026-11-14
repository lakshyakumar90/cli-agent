import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canWrite,
  createWorktree,
  isRepository,
  mergeWorktree,
  removeWorktree,
} from "./isolation.js";

const run = promisify(execFile);

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-worktree-"));
});

afterEach(async () => {
  // The worktrees have to go before the directory does.
  await run("git", ["worktree", "remove", "--force", directory], {
    cwd: directory,
  }).catch(() => undefined);
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

async function makeRepository(): Promise<void> {
  await run("git", ["init", "-q"], { cwd: directory });
  await run("git", ["config", "user.email", "test@example.com"], {
    cwd: directory,
  });
  await run("git", ["config", "user.name", "Test"], { cwd: directory });
  await writeFile(join(directory, "a.txt"), "hello", "utf8");
  await run("git", ["add", "."], { cwd: directory });
  await run("git", ["commit", "-qm", "first"], { cwd: directory });
}

describe("the isolation", () => {
  it("knows which roles change things", () => {
    expect(canWrite(["read", "grep"])).toBe(false);
    expect(canWrite(["read", "edit"])).toBe(true);
    expect(canWrite(undefined)).toBe(true);
  });

  it("knows a directory that is not a repository", async () => {
    expect(await isRepository(directory)).toBe(false);
  });

  it("gives a worker a worktree of its own", async () => {
    await makeRepository();

    const worktree = await createWorktree(directory, "coder-t1");

    expect(worktree).toBeDefined();
    expect(worktree?.branch).toBe("agent/coder-t1");
    expect(worktree?.path).toContain(".myagent");
    // The worktree is a checkout of the repository.
    expect(await isRepository(worktree?.path as string)).toBe(true);

    await removeWorktree(directory, worktree as never);
  }, 30_000);

  it("merges the branch of a worker", async () => {
    await makeRepository();

    const worktree = await createWorktree(directory, "coder-t1");
    expect(worktree).toBeDefined();

    await writeFile(join(worktree?.path as string, "b.txt"), "new file", "utf8");
    await run("git", ["add", "."], { cwd: worktree?.path as string });
    await run("git", ["commit", "-qm", "the work"], {
      cwd: worktree?.path as string,
    });

    const merged = await mergeWorktree(directory, worktree?.branch as string);

    expect(merged.merged).toBe(true);
    // The file is in the main workspace now.
    await expect(
      (await import("node:fs/promises")).readFile(
        join(directory, "b.txt"),
        "utf8",
      ),
    ).resolves.toBe("new file");
  }, 30_000);

  it("says so when the branch cannot be merged", async () => {
    await makeRepository();

    const worktree = await createWorktree(directory, "coder-t1");
    await writeFile(join(worktree?.path as string, "a.txt"), "theirs", "utf8");
    await run("git", ["add", "."], { cwd: worktree?.path as string });
    await run("git", ["commit", "-qm", "theirs"], {
      cwd: worktree?.path as string,
    });

    await writeFile(join(directory, "a.txt"), "mine", "utf8");
    await run("git", ["add", "."], { cwd: directory });
    await run("git", ["commit", "-qm", "mine"], { cwd: directory });

    const merged = await mergeWorktree(directory, worktree?.branch as string);

    // A conflict is reported, not thrown.
    expect(merged.merged).toBe(false);
    expect(merged.message.length).toBeGreaterThan(0);
  }, 30_000);
});

