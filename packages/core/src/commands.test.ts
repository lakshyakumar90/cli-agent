import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCommands, renderCommand } from "./commands.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-commands-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A command file in the project. */
async function writeCommand(
  name: string,
  content: string,
): Promise<void> {
  const folder = join(directory, ".myagent", "commands");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.md`), content, "utf8");
}

describe("the custom commands", () => {
  it("are found by their file name", async () => {
    await writeCommand("deploy", "Deploy the app.");

    const commands = await findCommands(directory, { global: false });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "/deploy",
      content: "Deploy the app.",
    });
  });

  it("read their description and their hint", async () => {
    await writeCommand(
      "deploy",
      [
        "---",
        "description: Deploy the app",
        "argument-hint: <environment>",
        "---",
        "Deploy to $1.",
      ].join("\n"),
    );

    const commands = await findCommands(directory, { global: false });

    expect(commands[0]?.description).toBe("Deploy the app");
    expect(commands[0]?.argumentHint).toBe("<environment>");
    expect(commands[0]?.content).toBe("Deploy to $1.");
  });

  it("are nothing when there is no folder", async () => {
    const commands = await findCommands(directory, { global: false });

    expect(commands).toEqual([]);
  });

  it("leave out a file with nothing in it", async () => {
    await writeCommand("empty", "---\ndescription: nothing\n---\n");

    const commands = await findCommands(directory, { global: false });

    expect(commands).toEqual([]);
  });
});

describe("what a command sends", () => {
  const command = (content: string) => ({
    name: "/deploy",
    path: "/tmp/deploy.md",
    content,
  });

  it("is the file, when there are no arguments", () => {
    expect(renderCommand(command("Deploy the app."), "")).toBe(
      "Deploy the app.",
    );
  });

  it("puts the arguments where the file says", () => {
    expect(renderCommand(command("Deploy to $1."), "staging")).toBe(
      "Deploy to staging.",
    );
  });

  it("puts all the arguments where the file says", () => {
    expect(
      renderCommand(command("Deploy to $1 with $2."), "staging --force"),
    ).toBe("Deploy to staging with --force.");
  });

  it("knows the arguments as a whole", () => {
    expect(renderCommand(command("Do $ARGUMENTS."), "a b c")).toBe("Do a b c.");
  });

  it("adds the arguments when the file does not use them", () => {
    expect(renderCommand(command("Deploy the app."), "staging")).toBe(
      "Deploy the app.\n\nstaging",
    );
  });

  it("leaves a missing argument empty", () => {
    expect(renderCommand(command("Deploy to $1."), "")).toBe("Deploy to .");
  });
});
