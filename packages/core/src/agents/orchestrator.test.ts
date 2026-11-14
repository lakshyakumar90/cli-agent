import { describe, expect, it } from "vitest";
import {
  fanOut,
  generatorCritic,
  orchestrate,
  runPipeline,
  type Worker,
} from "./orchestrator.js";

describe("the orchestrator", () => {
  it("runs the workers in parallel and gathers the reports", async () => {
    let running = 0;
    let peak = 0;

    const reports = await fanOut(
      [
        { agent: "explorer", prompt: "one" },
        { agent: "explorer", prompt: "two" },
        { agent: "explorer", prompt: "three" },
      ],
      async (worker: Worker) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return `the report for ${worker.prompt}`;
      },
      { concurrency: 3 },
    );

    expect(reports).toEqual([
      "the report for one",
      "the report for two",
      "the report for three",
    ]);
    // They ran at the same time.
    expect(peak).toBeGreaterThan(1);
  });

  it("keeps the order of the workers, whatever order they finish in", async () => {
    const reports = await fanOut(
      [
        { agent: "explorer", prompt: "slow" },
        { agent: "explorer", prompt: "fast" },
      ],
      async (worker: Worker) => {
        await new Promise((resolve) =>
          setTimeout(resolve, worker.prompt === "slow" ? 40 : 5),
        );
        return worker.prompt;
      },
      { concurrency: 2 },
    );

    expect(reports).toEqual(["slow", "fast"]);
  });

  it("never runs more workers than the cap", async () => {
    let running = 0;
    let peak = 0;

    await fanOut(
      Array.from({ length: 8 }, (_, index) => ({
        agent: "explorer",
        prompt: `w${index}`,
      })),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 10));
        running -= 1;
        return "ok";
      },
      { concurrency: 2 },
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it("synthesises the answer from the reports", async () => {
    const result = await orchestrate({
      workers: [
        { agent: "explorer", prompt: "one" },
        { agent: "explorer", prompt: "two" },
      ],
      runWorker: async (worker) => `report: ${worker.prompt}`,
      synthesize: async (reports) => `the answer, from ${reports.length} reports`,
    });

    expect(result.reports).toHaveLength(2);
    expect(result.synthesis).toBe("the answer, from 2 reports");
  });
});

describe("the pipeline", () => {
  it("hands each step what the last one found", async () => {
    const seen: string[] = [];

    const outputs = await runPipeline({
      steps: [
        { agent: "explorer", prompt: "explore" },
        { agent: "planner", prompt: "plan" },
        { agent: "coder", prompt: "code" },
      ],
      runWorker: async (worker) => {
        seen.push(worker.prompt);
        return `${worker.agent} finished`;
      },
    });

    expect(outputs).toHaveLength(3);
    // The planner was told what the explorer found.
    expect(seen[1]).toContain("explore");
    expect(seen[1]).toContain("explorer finished");
    // And the coder what the planner found.
    expect(seen[2]).toContain("planner finished");
  });
});

describe("the generator and the critic", () => {
  it("goes round until the critic is happy", async () => {
    let round = 0;

    const result = await generatorCritic({
      coder: { agent: "coder", prompt: "write it" },
      critic: { agent: "reviewer", prompt: "review it" },
      rounds: 4,
      runWorker: async (worker) => {
        if (worker.agent === "coder") return `the code, round ${++round}`;
        return round < 3 ? "there are problems" : "approved";
      },
    });

    expect(result.approved).toBe(true);
    expect(result.rounds).toBe(3);
    expect(result.result).toContain("round 3");
  });

  it("stops after the rounds run out", async () => {
    const result = await generatorCritic({
      coder: { agent: "coder", prompt: "write it" },
      critic: { agent: "reviewer", prompt: "review it" },
      rounds: 2,
      runWorker: async (worker) =>
        worker.agent === "coder" ? "the code" : "there are problems",
    });

    expect(result.approved).toBe(false);
    expect(result.rounds).toBe(2);
  });
});
