import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRoles, loadRoles, parseRole } from "./roles.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-roles-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("an agent role", () => {
  it("reads its frontmatter and its prompt", () => {
    const role = parseRole(
      [
        "---",
        "name: reviewer",
        "model: gemini/gemini-2.5-pro",
        "tools: [read, grep, glob]",
        "description: Reviews changes.",
        "---",
        "You review diffs for bugs.",
      ].join("\n"),
    );

    expect(role).toMatchObject({
      name: "reviewer",
      model: "gemini/gemini-2.5-pro",
      tools: ["read", "grep", "glob"],
      description: "Reviews changes.",
      prompt: "You review diffs for bugs.",
    });
  });

  it("is nothing without a name", () => {
    expect(parseRole("no frontmatter here")).toBeUndefined();
    expect(parseRole("---\nmodel: x\n---\nbody")).toBeUndefined();
  });

  it("takes every tool when it names none", () => {
    const role = parseRole("---\nname: anything\n---\nbody");

    expect(role?.tools).toBeUndefined();
  });
});

describe("the roles", () => {
  it("has four built in", () => {
    const roles = defaultRoles();

    expect([...roles.keys()].sort()).toEqual([
      "coder",
      "explorer",
      "planner",
      "reviewer",
    ]);
  });

  it("gives the explorer only the tools that read", () => {
    const explorer = defaultRoles().get("explorer");

    expect(explorer?.tools).toEqual(["read", "grep", "glob"]);
  });

  it("reads the roles of a project", async () => {
    const folder = join(directory, ".myagent", "agents");
    await writeFile(
      join(directory, "placeholder.txt"),
      "",
      "utf8",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "tester.md"),
      "---\nname: tester\nmodel: openai/gpt-5.5\ntools: [read]\n---\nYou test things.",
      "utf8",
    );

    const roles = await loadRoles({ cwd: directory, global: false });

    expect(roles.get("tester")).toMatchObject({
      name: "tester",
      model: "openai/gpt-5.5",
      tools: ["read"],
      prompt: "You test things.",
    });
    // The built-in ones are still there.
    expect(roles.has("explorer")).toBe(true);
  });
});
