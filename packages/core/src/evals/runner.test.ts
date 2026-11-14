import { describe, expect, it } from "vitest";
import { fakeProvider } from "@cli-agent/ai";
import { EVAL_TASKS } from "./tasks.js";
import { renderReport, runEvals } from "./runner.js";

/** A provider that does what the task's solution says. */
function solutionProvider(solution: Array<{ tool: string; args: unknown }>) {
  return fakeProvider([
    {
      calls: solution.map((call) => ({
        name: call.tool,
        args: call.args,
      })),
    },
    { text: "it is done" },
  ]);
}

describe("the eval tasks", () => {
  it("are the ones the guide asks for", () => {
    // Ten to thirty, each with a test of its own.
    expect(EVAL_TASKS.length).toBeGreaterThanOrEqual(10);
    expect(EVAL_TASKS.length).toBeLessThanOrEqual(30);
  });

  it("each have a prompt, a repository and a test", () => {
    for (const task of EVAL_TASKS) {
      expect(task.prompt.length, task.name).toBeGreaterThan(0);
      expect(task.test.length, task.name).toBeGreaterThan(0);
      expect(Object.keys(task.files).length, task.name).toBeGreaterThan(0);
      expect(task.solution.length, task.name).toBeGreaterThan(0);
    }
  });

  it("have names that are all different", () => {
    const names = EVAL_TASKS.map((task) => task.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the eval suite", () => {
  it("passes every task when the work is done", async () => {
    const results: Array<{ name: string; passed: boolean; output?: string }> = [];

    for (const task of EVAL_TASKS) {
      const report = await runEvals({
        provider: solutionProvider(task.solution),
        model: "test/model",
        tasks: [task],
      });

      const result = report.results[0];
      results.push({
        name: task.name,
        passed: result?.passed === true,
        ...(result?.output === undefined ? {} : { output: result.output }),
      });
    }

    const failed = results.filter((result) => !result.passed);
    expect(failed.map((result) => `${result.name}: ${result.output ?? ""}`)).toEqual(
      [],
    );
    expect(results).toHaveLength(EVAL_TASKS.length);
  }, 300_000);

  it("fails a task when the work is not done", async () => {
    const task = EVAL_TASKS[0];
    if (task === undefined) throw new Error("there are no tasks");

    // The agent says it is done and does nothing.
    const report = await runEvals({
      provider: fakeProvider([{ text: "it is done" }]),
      model: "test/model",
      tasks: [task],
    });

    expect(report.passed).toBe(0);
    expect(report.passRate).toBe(0);
    expect(report.results[0]?.passed).toBe(false);
  }, 120_000);

  it("counts the turns, the tokens and the cost", async () => {
    const task = EVAL_TASKS[0];
    if (task === undefined) throw new Error("there are no tasks");

    const report = await runEvals({
      provider: solutionProvider(task.solution),
      model: "test/model",
      tasks: [task],
    });

    expect(report.total).toBe(1);
    expect(report.turns).toBeGreaterThan(0);
    expect(report.results[0]?.inputTokens).toBeGreaterThan(0);
    expect(report.cost).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("says how it went, in a table a person can read", async () => {
    const task = EVAL_TASKS[0];
    if (task === undefined) throw new Error("there are no tasks");

    const report = await runEvals({
      provider: solutionProvider(task.solution),
      model: "test/model",
      tasks: [task],
    });

    const table = renderReport(report);

    expect(table).toContain(task.name);
    expect(table).toContain("1/1 passed");
    expect(table).toContain("turns");
  }, 120_000);

  it("leaves no repository behind", async () => {
    const task = EVAL_TASKS[0];
    if (task === undefined) throw new Error("there are no tasks");

    const workDir = `${process.env.TEMP ?? "/tmp"}/cli-agent-eval-test-${Date.now()}`;

    await runEvals({
      provider: solutionProvider(task.solution),
      model: "test/model",
      tasks: [task],
      workDir,
    });

    const { readdir } = await import("node:fs/promises");
    const left = await readdir(workDir).catch(() => []);
    expect(left).toEqual([]);
  }, 120_000);
});
