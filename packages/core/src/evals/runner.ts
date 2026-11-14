/**
 * The eval runner.
 *
 * Every task runs in a throwaway repository: the files are written, the
 * agent is asked the question, and a test is run in the repository
 * afterwards. It passes when the test exits with zero.
 *
 * The runner keeps what the tasks cost: the turns they took, the tokens
 * they used and the money they came to. That is what says whether the
 * agent got better or cheaper, and a change that makes it worse is
 * visible.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "@cli-agent/ai";
import { createTools, withPermissions } from "@cli-agent/tools";
import { costOf } from "../budget.js";
import { run } from "../loop.js";
import { modelIdOf, providerIdOf } from "../ref.js";
import { createState } from "../types.js";
import type { EvalTask } from "./tasks.js";

/** What one task came to. */
export interface EvalResult {
  /** The task. */
  name: string;
  /** The test passed. */
  passed: boolean;
  /** How many turns it took. */
  turns: number;
  /** The tokens it used. */
  inputTokens: number;
  /** The tokens it wrote. */
  outputTokens: number;
  /** What it cost, in US dollars. */
  cost: number;
  /** How long it took, in milliseconds. */
  ms: number;
  /** What went wrong, when something did. */
  error?: string;
  /** What the test said. */
  output?: string;
}

/** What the whole run came to. */
export interface EvalReport {
  /** Every task. */
  results: EvalResult[];
  /** How many passed. */
  passed: number;
  /** How many there were. */
  total: number;
  /** The share that passed, from 0 to 1. */
  passRate: number;
  /** The turns of all the tasks together. */
  turns: number;
  /** The cost of all the tasks together. */
  cost: number;
  /** How long the whole run took. */
  ms: number;
}

export interface EvalOptions {
  /** The provider the agent is served by. */
  provider: Provider;
  /** The model it is served by. */
  model: string;
  /** The tasks to run. All of them when this is left out. */
  tasks?: EvalTask[];
  /** The folder the repositories are made in. */
  workDir?: string;
  /** How long one task may take. Default 5 minutes. */
  timeoutMs?: number;
  /**
   * How long to wait between the tasks.
   *
   * A free model allows a few requests a minute, and a task makes
   * several. The wait is what keeps the suite from being turned away.
   */
  pauseMs?: number;
  /** What to say as it goes. */
  onTask?: (result: EvalResult) => void;
}

/**
 * Run the tasks and say how they went.
 *
 * The repositories are thrown away afterwards, whatever happened.
 */
export async function runEvals(options: EvalOptions): Promise<EvalReport> {
  const tasks = options.tasks ?? [];
  const started = Date.now();

  const results: EvalResult[] = [];

  for (const task of tasks) {
    const result = await runOne(task, options);
    results.push(result);
    options.onTask?.(result);

    // The wait between the tasks, so the model is not turned away.
    const pause = options.pauseMs ?? 5_000;
    if (pause > 0 && tasks.indexOf(task) < tasks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }

  const passed = results.filter((result) => result.passed).length;

  return {
    results,
    passed,
    total: results.length,
    passRate: results.length === 0 ? 0 : passed / results.length,
    turns: results.reduce((sum, result) => sum + result.turns, 0),
    cost: results.reduce((sum, result) => sum + result.cost, 0),
    ms: Date.now() - started,
  };
}

/** Run one task in a repository of its own. */
async function runOne(
  task: EvalTask,
  options: EvalOptions,
): Promise<EvalResult> {
  const root =
    options.workDir ?? (await mkdtemp(join(tmpdir(), "cli-agent-eval-")));
  const directory = join(root, task.name.replace(/[^\w.-]+/g, "-"));

  try {
    await mkdir(directory, { recursive: true });

    for (const [path, content] of Object.entries(task.files)) {
      const file = join(directory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    }

    const tools = withPermissions(createTools(), {
      mode: "yolo",
      workspace: directory,
    });

    // The provider knows its model by the id it uses on the wire: the
    // "provider/" of "provider/model" is for us, not for it.
    const state = createState(options.provider, {
      model: modelIdOf(options.model),
      tools,
      cwd: directory,
      // A model that is busy is worth waiting for: the quota of a free
      // one comes back after a minute, not after a second.
      limits: {
        maxRetries: 6,
        retryDelayMs: 5_000,
        maxRetryDelayMs: 30_000,
      },
    });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 5 * 60_000,
    );

    const began = Date.now();
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let error: string | undefined;

    try {
      for await (const event of run(state, task.prompt, controller.signal)) {
        if (event.t === "done") {
          turns += event.turns;
          inputTokens += event.usage.inputTokens;
          outputTokens += event.usage.outputTokens;
        }
      }
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    } finally {
      clearTimeout(timeout);
    }

    const test = await runTest(task.test, directory, options.timeoutMs ?? 60_000);

    const cost = costOf(
      providerIdOf(options.model),
      modelIdOf(options.model),
      { inputTokens, outputTokens },
    );

    return {
      name: task.name,
      passed: test.passed && error === undefined,
      turns,
      inputTokens,
      outputTokens,
      cost,
      ms: Date.now() - began,
      ...(error === undefined ? {} : { error }),
      ...(test.output.length === 0 ? {} : { output: test.output }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/** Run the test of a task, in its repository. */
function runTest(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ passed: false, output: error.message });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: output.trim() });
    });
  });
}

/** The report, as a table a person can read. */
export function renderReport(report: EvalReport): string {
  const lines: string[] = [];

  for (const result of report.results) {
    const mark = result.passed ? "✓" : "✗";
    lines.push(
      `${mark} ${result.name.padEnd(34)} ${String(result.turns).padStart(3)} turns  ` +
        `${result.inputTokens + result.outputTokens} tokens  $${result.cost.toFixed(4)}`,
    );
    if (!result.passed && result.error !== undefined) {
      lines.push(`    ${result.error}`);
    }
    if (!result.passed && result.output !== undefined && result.output.length > 0) {
      lines.push(`    ${result.output.split("\n").slice(0, 3).join("\n    ")}`);
    }
  }

  lines.push("");
  lines.push(
    `${report.passed}/${report.total} passed (${Math.round(report.passRate * 100)}%)  ` +
      `${report.turns} turns  $${report.cost.toFixed(4)}  ${Math.round(report.ms / 1000)}s`,
  );

  return lines.join("\n");
}
