/**
 * File checkpoints.
 *
 * Before a tool changes a file, the file is snapshotted, so the change can be
 * undone. It is the same idea as a git stash, without needing a repository:
 * the snapshot is the content of the file before the change.
 *
 * A file that did not exist is snapshotted as "not there", so undoing removes
 * it again.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One snapshot. */
export interface Checkpoint {
  /** Its id. */
  id: string;
  /** The file it snapshotted. */
  path: string;
  /** The content before the change. Undefined when the file was not there. */
  before?: string;
  /** When it was taken. */
  at: string;
  /** The tool call that caused the change. */
  callId: string;
}

/** What undoing a checkpoint did. */
export type RestoreResult = "restored" | "removed";

export class CheckpointStore {
  private readonly checkpoints: Checkpoint[] = [];

  /** Take a snapshot of a file. */
  take(
    callId: string,
    path: string,
    before?: string,
  ): Checkpoint {
    const checkpoint: Checkpoint = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      path,
      ...(before === undefined ? {} : { before }),
      at: new Date().toISOString(),
      callId,
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /** Snapshot a file as it is now, if it is there. */
  async snapshot(callId: string, path: string): Promise<Checkpoint | undefined> {
    let before: string | undefined;
    try {
      before = await readFile(path, "utf8");
    } catch {
      // The file is not there: undoing will remove it.
    }
    return this.take(callId, path, before);
  }

  /** Every checkpoint, oldest first. */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** The last checkpoint, for a file or for any file. */
  latest(path?: string): Checkpoint | undefined {
    const matching =
      path === undefined
        ? this.checkpoints
        : this.checkpoints.filter((checkpoint) => checkpoint.path === path);

    return matching[matching.length - 1];
  }

  /** Put a file back the way it was. */
  async restore(checkpoint: Checkpoint): Promise<RestoreResult> {
    if (checkpoint.before === undefined) {
      // The file was not there before: undoing removes it.
      await rm(checkpoint.path, { force: true });
      return "removed";
    }

    await mkdir(dirname(checkpoint.path), { recursive: true });
    await writeFile(checkpoint.path, checkpoint.before, "utf8");
    return "restored";
  }

  /** Undo the last change to a file (or to any file). */
  async undo(
    path?: string,
  ): Promise<{ checkpoint: Checkpoint; result: RestoreResult } | undefined> {
    const checkpoint = this.latest(path);
    if (checkpoint === undefined) return undefined;

    const result = await this.restore(checkpoint);
    return { checkpoint, result };
  }
}
