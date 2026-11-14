/**
 * Sessions.
 *
 * A session is a file of entries, one JSON object per line, appended and
 * never rewritten:
 *
 *   {"id":"a1","parent":null,"msg":{...}}
 *   {"id":"a2","parent":"a1","msg":{...}}
 *
 * Every entry names the one before it, so the sessions of a project are a
 * tree: you can fork from any earlier message, and a compaction is just
 * another entry rather than a rewrite of what came before.
 *
 * The files live in ~/.myagent/sessions/<hash of the working directory>/, so
 * two projects never share a session and a session always belongs to the
 * directory it was started in.
 */

import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Msg } from "@cli-agent/ai";

/** One line of a session file. */
export interface SessionEntry {
  /** The id of this entry. */
  id: string;
  /** The entry before this one, or null for the first. */
  parent: string | null;
  /** The message. */
  msg: Msg;
  /**
   * True when this entry replaced the conversation before it.
   *
   * A compaction: the summary is the message, and everything before it is
   * dropped from the transcript (but kept in the file).
   */
  compacted?: boolean;
  /** When it was written. */
  at?: string;
  /** The model that was in use. */
  model?: string;
}

/** What the picker needs to know about a session. */
export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** How many entries the session has. */
  entries: number;
  /** The first thing that was asked, for the list. */
  title?: string;
}

/** A node of the session tree. */
export interface SessionNode {
  entry: SessionEntry;
  children: SessionNode[];
}

export interface SessionStoreOptions {
  /** Where the sessions live. Defaults to ~/.myagent/sessions. */
  root?: string;
  /** The working directory the sessions belong to. */
  cwd?: string;
}

/** Where the sessions live. */
export function defaultSessionsRoot(): string {
  return join(homedir(), ".myagent", "sessions");
}

/** The name of a project's session directory: a hash of its path. */
export function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** An id for a new session or entry: the time, so the names sort. */
export function newId(prefix = "s"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class SessionStore {
  /** Where the sessions live. */
  readonly root: string;
  /** The project the sessions belong to. */
  readonly cwd: string;

  /** The session that is open. */
  private current?: string;
  /** The last entry written, which the next one hangs off. */
  private lastEntry?: string;

  constructor(options: SessionStoreOptions = {}) {
    this.root = options.root ?? defaultSessionsRoot();
    this.cwd = options.cwd ?? process.cwd();
  }

  /** The directory this project's sessions live in. */
  dir(): string {
    return join(this.root, hashCwd(this.cwd));
  }

  /** The file of a session. */
  path(id: string): string {
    return join(this.dir(), `${id}.jsonl`);
  }

  /** The file of a session's details. */
  metaPath(id: string): string {
    return join(this.dir(), `${id}.json`);
  }

  /** The session that is open. */
  get id(): string | undefined {
    return this.current;
  }

  /** Start a new session. */
  async create(options: { model?: string } = {}): Promise<string> {
    const id = newId();
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.path(id), "", "utf8");

    const now = new Date().toISOString();
    await this.writeMeta(id, {
      cwd: this.cwd,
      model: options.model ?? "",
      createdAt: now,
      updatedAt: now,
      entries: 0,
    });

    this.current = id;
    this.lastEntry = undefined;
    return id;
  }

  /** Open a session: the one named, or the last one of this project. */
  async open(options: { id?: string } = {}): Promise<string | undefined> {
    if (options.id !== undefined) {
      const entries = await this.read(options.id);
      if (entries.length === 0 && !(await this.exists(options.id))) {
        return undefined;
      }
      this.current = options.id;
      this.lastEntry = entries.at(-1)?.id;
      return options.id;
    }

    const sessions = await this.list();
    const last = sessions[0];
    if (last === undefined) return undefined;

    const entries = await this.read(last.id);
    this.current = last.id;
    this.lastEntry = entries.at(-1)?.id;
    return last.id;
  }

  /** Is there a session with this id? */
  async exists(id: string): Promise<boolean> {
    try {
      await readFile(this.metaPath(id), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Append a message.
   *
   * The entry hangs off the last one written, which is what makes the
   * sessions a tree. Returns the id of the new entry.
   */
  async append(
    msg: Msg,
    options: { compacted?: boolean; model?: string; parent?: string | null } = {},
  ): Promise<string> {
    const id = this.current ?? (await this.create({ model: options.model }));

    const entry: SessionEntry = {
      id: newId("a"),
      parent: options.parent === undefined ? (this.lastEntry ?? null) : options.parent,
      msg,
      at: new Date().toISOString(),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.compacted === true ? { compacted: true } : {}),
    };

    await mkdir(this.dir(), { recursive: true });
    await appendFile(this.path(id), `${JSON.stringify(entry)}\n`, "utf8");

    this.current = id;
    this.lastEntry = entry.id;

    const meta = await this.meta(id);
    await this.writeMeta(id, {
      ...meta,
      updatedAt: entry.at ?? new Date().toISOString(),
      entries: meta.entries + 1,
    });

    return entry.id;
  }

  /** The entries of a session, in the order they were written. */
  async read(id: string): Promise<SessionEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path(id), "utf8");
    } catch {
      return [];
    }

    const entries: SessionEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as SessionEntry);
      } catch {
        // A line that is not an entry is skipped, not fatal.
      }
    }
    return entries;
  }

  /** The sessions of this project, newest first. */
  async list(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return [];
    }

    const sessions: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const meta = await this.meta(name.replace(/\.json$/, ""));
      if (meta !== undefined) sessions.push(meta);
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** The conversation of a session, as it stands. */
  async transcript(id: string): Promise<Msg[]> {
    const entries = await this.read(id);
    const messages: Msg[] = [];

    for (const entry of entries) {
      if (entry.compacted === true) {
        // The summary replaces everything before it.
        messages.length = 0;
      }
      messages.push(entry.msg);
    }

    return messages;
  }

  /**
   * Fork a session from an entry.
   *
   * The new session starts there: its first entry hangs off the entry it was
   * forked from, so the two histories stay joined.
   */
  async fork(
    sessionId: string,
    fromEntryId: string,
    options: { model?: string } = {},
  ): Promise<string | undefined> {
    const entries = await this.read(sessionId);
    const from = entries.find((entry) => entry.id === fromEntryId);
    if (from === undefined) return undefined;

    const id = newId();
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.path(id), "", "utf8");

    const now = new Date().toISOString();
    await this.writeMeta(id, {
      cwd: this.cwd,
      model: options.model ?? "",
      createdAt: now,
      updatedAt: now,
      entries: 0,
    });

    this.current = id;
    this.lastEntry = from.id;
    return id;
  }

  /** The tree of a session: every entry and what hangs off it. */
  async tree(sessionId: string): Promise<SessionNode[]> {
    const entries = await this.read(sessionId);
    const nodes = new Map<string, SessionNode>();

    for (const entry of entries) {
      nodes.set(entry.id, { entry, children: [] });
    }

    const roots: SessionNode[] = [];
    for (const entry of entries) {
      const node = nodes.get(entry.id);
      if (node === undefined) continue;

      const parent =
        entry.parent === null ? undefined : nodes.get(entry.parent);
      if (parent === undefined) roots.push(node);
      else parent.children.push(node);
    }

    return roots;
  }

  /** The entries of every session of this project, by id. */
  async allEntries(): Promise<Map<string, SessionEntry>> {
    const entries = new Map<string, SessionEntry>();
    for (const session of await this.list()) {
      for (const entry of await this.read(session.id)) {
        entries.set(entry.id, entry);
      }
    }
    return entries;
  }

  /** Delete a session. */
  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true });
    await rm(this.metaPath(id), { force: true });
  }

  private async meta(id: string): Promise<SessionMeta> {
    try {
      const meta = JSON.parse(
        await readFile(this.metaPath(id), "utf8"),
      ) as SessionMeta;
      return meta;
    } catch {
      return {
        id,
        cwd: this.cwd,
        model: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries: 0,
      };
    }
  }

  private async writeMeta(id: string, meta: Omit<SessionMeta, "id">): Promise<void> {
    await mkdir(this.dir(), { recursive: true });
    await writeFile(
      this.metaPath(id),
      `${JSON.stringify({ ...meta, id }, null, 2)}\n`,
      "utf8",
    );
  }
}
