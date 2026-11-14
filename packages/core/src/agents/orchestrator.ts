/**
 * Orchestration.
 *
 * Three patterns, all over the same worker:
 *
 * - orchestrator and worker: the lead plans, the workers go off in parallel,
 *   the lead gathers the reports and writes the answer
 * - pipeline: each step hands its output to the next
 * - generator and critic: one writes, the other reviews, and they go round
 *   until the reviewer is happy or the rounds run out
 */

import type { Board } from "./board.js";

/** A job for one worker. */
export interface Worker {
  /** The role that does it. */
  agent: string;
  /** What it should do. */
  prompt: string;
}

/** Runs one worker and returns its report. */
export type RunWorker = (worker: Worker) => Promise<string>;

/**
 * Run the workers at once, a few at a time.
 *
 * The reports come back in the order the workers were given, whatever order
 * they finished in.
 */
export async function fanOut(
  workers: Worker[],
  runWorker: RunWorker,
  options: { concurrency?: number } = {},
): Promise<string[]> {
  const { concurrency = 3 } = options;
  const reports: string[] = new Array(workers.length);

  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= workers.length) return;

      const current = workers[index];
      if (current === undefined) return;
      reports[index] = await runWorker(current);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, workers.length) }, () => worker()),
  );

  return reports;
}

export interface OrchestratorOptions {
  /** The jobs for the workers. */
  workers: Worker[];
  /** Runs one worker. */
  runWorker: RunWorker;
  /** The board the tasks are written to. */
  board?: Board;
  /** How many workers at once. */
  concurrency?: number;
  /** Writes the final answer from the reports. */
  synthesize?: (reports: string[]) => Promise<string>;
}

/**
 * The lead plans, the workers go off, the lead gathers.
 *
 * Without a synthesis step the reports are returned as they are: that is
 * still the pattern, minus the last step.
 */
export async function orchestrate(
  options: OrchestratorOptions,
): Promise<{ reports: string[]; synthesis?: string }> {
  const { workers, runWorker, board, concurrency = 3, synthesize } = options;

  for (const worker of workers) {
    board?.add({
      id: `${worker.agent}-${Date.now().toString(36)}`,
      agent: worker.agent,
      prompt: worker.prompt,
      owner: worker.agent,
    });
  }
  await board?.save();

  const reports = await fanOut(workers, runWorker, { concurrency });

  if (synthesize === undefined) return { reports };

  const synthesis = await synthesize(reports);
  return { reports, synthesis };
}

export interface PipelineOptions {
  /** The steps, in order. */
  steps: Worker[];
  /** Runs one worker. */
  runWorker: RunWorker;
  /** How many workers at once within a step. */
  concurrency?: number;
}

/**
 * One step after another: each step gets what the last one found.
 *
 * The last step's report is the result.
 */
export async function runPipeline(
  options: PipelineOptions,
): Promise<string[]> {
  const { steps, runWorker, concurrency } = options;
  const outputs: string[] = [];
  let previous = "";

  for (const step of steps) {
    // Each step is told what the last one found.
    const current: Worker =
      previous.length > 0
        ? {
            ...step,
            prompt: `${step.prompt}\n\nWhat the previous step found:\n${previous}`,
          }
        : step;

    const found = await fanOut([current], runWorker, { concurrency });
    previous = found[0] ?? "";
    outputs.push(previous);
  }

  return outputs;
}

export interface GeneratorCriticOptions {
  /** Writes the thing. */
  coder: Worker;
  /** Reviews it. */
  critic: Worker;
  /** Runs one worker. */
  runWorker: RunWorker;
  /** How many rounds at most. Default 3. */
  rounds?: number;
  /** Says whether the work is good enough. */
  approve?: (report: string) => boolean;
}

/**
 * One writes, the other reviews, and they go round until it is good enough.
 *
 * The critic's report decides: when it says the work is fine, the loop
 * stops.
 */
export async function generatorCritic(
  options: GeneratorCriticOptions,
): Promise<{ result: string; rounds: number; approved: boolean }> {
  const { coder, critic, runWorker, rounds = 3 } = options;
  const approve = options.approve ?? ((report: string) => /approved|looks good|no issues/i.test(report));

  let result = "";
  let round = 0;
  let approved = false;

  while (round < rounds) {
    round += 1;

    const written = await fanOut([coder], runWorker);
    result = written[0] ?? "";

    const reviewed = await fanOut(
      [
        {
          ...critic,
          prompt: `${critic.prompt}\n\nReview this:\n\n${result}`,
        },
      ],
      runWorker,
    );
    const review = reviewed[0] ?? "";

    if (approve(review)) {
      approved = true;
      break;
    }

    // The writer is told what the reviewer said.
    coder.prompt = `${coder.prompt}\n\nThe reviewer said:\n${review}`;
  }

  return { result, rounds: round, approved };
}
