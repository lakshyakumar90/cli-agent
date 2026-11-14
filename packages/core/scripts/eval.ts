/**
 * The eval suite, run against a real model.
 *
 * Each task is a small repository, a question, and a test. The report
 * says how many passed, how many turns it took and what it cost.
 *
 * Run: pnpm --filter @cli-agent/core eval
 *
 * It needs a key. MYAGENT_EVAL_MODEL says which model, and it defaults
 * to the one the agent uses.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "@cli-agent/ai";
import { EVAL_TASKS } from "../src/evals/tasks.js";
import { renderReport, runEvals } from "../src/evals/runner.js";

const model = process.env.MYAGENT_EVAL_MODEL?.trim() ?? "gemini/gemini-3.1-flash-lite";

const providerId = model.includes("/")
  ? (model.slice(0, model.indexOf("/")) as string)
  : model;

const provider = await createProvider(providerId);

console.log(`the eval suite, with ${model}\n`);

const workDir = await mkdtemp(join(tmpdir(), "cli-agent-evals-"));

try {
  const report = await runEvals({
    provider,
    model,
    tasks: EVAL_TASKS,
    workDir,
    onTask(result) {
      const mark = result.passed ? "✓" : "✗";
      process.stdout.write(
        `${mark} ${result.name} (${result.turns} turns, $${result.cost.toFixed(4)})\n`,
      );
    },
  });

  console.log("");
  console.log(renderReport(report));

  // The report is written down, so two runs can be compared.
  const path = join(process.cwd(), "eval-report.json");
  await writeFile(
    path,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(`\nthe report is in ${path}`);

  // The suite is green when every task passed.
  process.exitCode = report.passed === report.total ? 0 : 1;
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}
