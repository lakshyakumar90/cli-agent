import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tool } from "@cli-agent/tools";
import { z } from "zod";
import { buildPromptLayers, buildSystemPrompt, renderTools } from "./prompt.js";
import { directoriesUp, findMemoryFiles } from "./memory.js";
import { readBranch, readEnvironment, renderEnvironment } from "./environment.js";
import { findSkills, renderActiveContext } from "./skills.js";

const echo: Tool = {
  name: "echo",
  description: "Echoes the text back.",
  schema: z.object({}),
  effect: "read",
  async run() {
    return { output: "" };
  },
};

const read: Tool = {
  name: "read",
  description: "Reads a file.",
  schema: z.object({}),
  effect: "read",
  async run() {
    return { output: "" };
  },
};

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-prompt-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the layers", () => {
  it("puts the stable layers first", async () => {
    const layers = await buildPromptLayers({
      cwd: directory,
      tools: [echo],
      memory: [],
      environment: {
        cwd: directory,
        os: "linux",
        date: "2026-11-13",
      },
      active: { skills: [{ name: "a-skill", path: "/a" }] },
    });

    expect(layers.map((layer) => layer.name)).toEqual([
      "base",
      "tools",
      "environment",
      "active",
    ]);

    // The layers that do not change come before the ones that do.
    const firstChanging = layers.findIndex((layer) => !layer.stable);
    expect(layers.slice(0, firstChanging).every((layer) => layer.stable)).toBe(
      true,
    );
    expect(layers.slice(firstChanging).every((layer) => !layer.stable)).toBe(
      true,
    );
  });

  it("puts the identity first and the tools after it", async () => {
    const prompt = await buildSystemPrompt({
      cwd: directory,
      tools: [echo, read],
      memory: [],
    });

    const base = prompt.indexOf("You are a coding agent");
    const tools = prompt.indexOf("Tools:");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(tools).toBeGreaterThan(base);
  });

  it("keeps the tool order the same whatever the order they came in", () => {
    expect(renderTools([read, echo])).toBe(renderTools([echo, read]));
    expect(renderTools([read, echo])).toContain("- echo:");
  });

  it("uses the given base when there is one", async () => {
    const prompt = await buildSystemPrompt({
      cwd: directory,
      base: "Be terse.",
      memory: [],
    });

    expect(prompt.startsWith("Be terse.")).toBe(true);
  });
});

describe("the project memory", () => {
  it("walks up from the working directory", async () => {
    const root = join(directory, "one", "two");
    await mkdir(root, { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), "the top of it", "utf8");
    await writeFile(join(directory, "one", "CLAUDE.md"), "the middle of it", "utf8");
    await writeFile(join(root, "AGENTS.md"), "the nearest of them", "utf8");

    const memory = await findMemoryFiles(root, { global: false });

    expect(memory.map((file) => file.content)).toEqual([
      "the top of it",
      "the middle of it",
      "the nearest of them",
    ]);
  });

  it("reads the user's own memory as well", async () => {
    const memory = await findMemoryFiles(directory, { global: false });

    expect(memory.every((file) => file.content.length > 0)).toBe(true);
  });

  it("knows the directories above a directory", () => {
    const deepest = join(directory, "a", "b");
    const directories = directoriesUp(deepest);

    // The root first, the deepest last: the broadest memory comes first.
    expect(directories[0]).toBe(parse(deepest).root);
    expect(directories[directories.length - 1]).toBe(deepest);
    expect(directories.length).toBeGreaterThan(2);
  });
});

describe("the environment", () => {
  it("says where the agent is", async () => {
    const environment = await readEnvironment(directory);
    const rendered = renderEnvironment(environment);

    expect(rendered).toContain(`Working directory: ${directory}`);
    expect(rendered).toContain("Operating system:");
    expect(rendered).toContain("Date:");
  });

  it("has no branch outside a repository", async () => {
    const branch = await readBranch(directory);

    // The temporary directory is not a repository.
    expect(branch).toBeUndefined();
  });
});

describe("the active context", () => {
  it("lists the skills, the plan and the checklist", () => {
    const rendered = renderActiveContext({
      skills: [{ name: "a-skill", path: "/a", description: "does a thing" }],
      plan: "read, then edit",
      todo: ["read the file", "fix it"],
    });

    expect(rendered).toContain("Skills available:");
    expect(rendered).toContain("a-skill: does a thing");
    expect(rendered).toContain("Plan:");
    expect(rendered).toContain("- read the file");
  });

  it("says nothing when there is nothing to say", () => {
    expect(renderActiveContext(undefined)).toBe("");
    expect(renderActiveContext({})).toBe("");
  });

  it("finds the skills in the working directory", async () => {
    const skills = join(directory, ".myagent", "skills", "a-skill");
    await mkdir(skills, { recursive: true });
    await writeFile(
      join(skills, "SKILL.md"),
      "---\ndescription: does a thing\n---\n\nthe body\n",
      "utf8",
    );

    const found = await findSkills(directory);

    expect(found.map((skill) => skill.name)).toContain("a-skill");
    expect(found[0]?.description).toBe("does a thing");
  });
});



