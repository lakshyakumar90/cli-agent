import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSkillTool,
  findSkills,
  readSkillBody,
  renderActiveContext,
} from "./skills.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-agent-skills-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A skill in the project's directory. */
async function writeSkill(
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const folder = join(directory, ".myagent", "skills", name);
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

describe("the skills", () => {
  it("are found by their name and their description", async () => {
    await writeSkill("deploy", "How to deploy the app.", "Run the deploy.");

    const skills = await findSkills(directory);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "deploy",
      description: "How to deploy the app.",
    });
  });

  it("put only the name and the description in the prompt", async () => {
    await writeSkill("deploy", "How to deploy the app.", "Run the deploy.");

    const skills = await findSkills(directory);
    const rendered = renderActiveContext({ skills });

    expect(rendered).toContain("deploy");
    expect(rendered).toContain("How to deploy the app.");
    // The body is not in the prompt: it is loaded when it is needed.
    expect(rendered).not.toContain("Run the deploy.");
  });
});

describe("the body of a skill", () => {
  it("is what is left when the frontmatter is taken off", async () => {
    await writeSkill("deploy", "How to deploy.", "Run the deploy script.");

    const skills = await findSkills(directory);
    const body = await readSkillBody(skills[0]?.path as string);

    expect(body).toBe("Run the deploy script.");
  });
});

describe("the skill tool", () => {
  it("loads the body of the skill the model asks for", async () => {
    await writeSkill("deploy", "How to deploy.", "Run the deploy script.");
    await writeSkill("rollback", "How to undo a deploy.", "Run the rollback.");

    const tool = createSkillTool({ cwd: directory });

    const result = await tool.run(
      { name: "deploy" },
      { cwd: directory, signal: new AbortController().signal },
    );

    expect(result.output).toBe("Run the deploy script.");
    expect(result.isError).toBeUndefined();
  });

  it("keeps the instructions in the context", async () => {
    await writeSkill("deploy", "How to deploy.", "Run the deploy script.");

    const tool = createSkillTool({ cwd: directory });

    const result = await tool.run(
      { name: "deploy" },
      { cwd: directory, signal: new AbortController().signal },
    );

    // The instructions are still needed after the call is forgotten.
    expect(result.keep).toBe(true);
  });

  it("says so when there is no such skill", async () => {
    await writeSkill("deploy", "How to deploy.", "Run the deploy script.");

    const tool = createSkillTool({ cwd: directory });

    const result = await tool.run(
      { name: "nope" },
      { cwd: directory, signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("no skill called");
    // It says what there is.
    expect(result.output).toContain("deploy");
  });

  it("takes the skills it is given, and does not look for them again", async () => {
    const tool = createSkillTool({
      cwd: directory,
      skills: [
        {
          name: "given",
          path: join(directory, "given.md"),
          description: "A skill that was given.",
        },
      ],
    });

    // There is no file at that path, but the skill was given, so it is
    // looked up in the list, not on disk.
    const result = await tool.run(
      { name: "given" },
      { cwd: directory, signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("is empty");
  });
});
