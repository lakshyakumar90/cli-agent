/**
 * Saved conversations.
 *
 * A session is the transcript, the model it was using and when it was last
 * touched. It is saved as plain JSON, so it can be read, edited and
 * replayed — which is what /resume is for.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Msg } from "@cli-agent/ai";

export interface SavedSession {
  /** The id, which is also the file name. */
  id: string;
  /** The model the conversation was using. */
  model: string;
  /** When the session was created. */
  createdAt: string;
  /** When the session was last touched. */
  updatedAt: string;
  /** The conversation. */
  messages: Msg[];
}

export interface SessionStoreOptions {
  /** Where the sessions are kept. Defaults to ~/.myagent/sessions. */
  dir?: string;
}

/** The directory the sessions live in. */
export function defaultSessionsDir(): string {
  return join(homedir(), ".myagent", "sessions");
}

export class SessionStore {
  readonly dir: string;

  constructor(options: SessionStoreOptions = {}) {
    this.dir = options.dir ?? defaultSessionsDir();
  }

  /** Every session, newest first. */
  async list(): Promise<SavedSession[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }

    const sessions: SavedSession[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const session = await this.load(name.replace(/\.json$/, ""));
      if (session !== undefined) sessions.push(session);
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** One session. */
  async load(id: string): Promise<SavedSession | undefined> {
    try {
      const content = await readFile(join(this.dir, `${id}.json`), "utf8");
      return JSON.parse(content) as SavedSession;
    } catch {
      return undefined;
    }
  }

  /** Write a session. */
  async save(session: SavedSession): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      join(this.dir, `${session.id}.json`),
      `${JSON.stringify(session, null, 2)}\n`,
      "utf8",
    );
  }
}

/** An id for a new session: the time, so the names sort. */
export function newSessionId(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}
