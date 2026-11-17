import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createState } from "@cli-agent/core";
import { executeReview, parseReview, reviewSnapshot } from "./review.js";
const exec = promisify(execFile);
describe("read-only code review", () => {
  it("validates structured findings", () => {
    expect(parseReview('{"summary":"OK","findings":[]}').findings).toEqual([]);
    expect(() => parseReview("Everything is fine")).toThrow();
    expect(() =>
      parseReview('{"summary":"x","findings":[{"line":-1}]}'),
    ).toThrow();
  });
  it("captures diffs, detects staleness, and never exposes editing or shell tools", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-review-"));
    const signal = new AbortController().signal;
    const git = (args: string[]) =>
      exec("git", args, { cwd, windowsHide: true });
    try {
      await git(["init"]);
      await git(["config", "user.name", "Test"]);
      await git(["config", "user.email", "test@example.com"]);
      await writeFile(join(cwd, "a.txt"), "one\n");
      await git(["add", "."]);
      await git(["commit", "-m", "initial"]);
      await writeFile(join(cwd, "a.txt"), "two\n");
      const snapshot = await reviewSnapshot(
        cwd,
        { kind: "uncommitted" },
        signal,
      );
      const state = createState(
        {
          id: "test",
          models: async () => [],
          async *stream(request) {
            expect(
              request.tools.every(
                (tool) =>
                  !["write", "edit", "bash", "task"].includes(tool.name),
              ),
            ).toBe(true);
            yield { t: "text", delta: '{"summary":"No bugs","findings":[]}' };
            yield {
              t: "done",
              stop: "end",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
        { model: "model", cwd },
      );
      const result = await executeReview(
        state,
        { kind: "uncommitted" },
        "",
        signal,
        () => undefined,
      );
      expect(result.status).toBe("completed");
      expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("two\n");
      await writeFile(join(cwd, "a.txt"), "three\n");
      expect(
        (await reviewSnapshot(cwd, { kind: "uncommitted" }, signal))
          .fingerprint,
      ).not.toBe(snapshot.fingerprint);
      await expect(
        reviewSnapshot(cwd, { kind: "commit", ref: "--help" }, signal),
      ).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
