/**
 * `auth.json` on disk.
 *
 * Location: `$MYAGENT_HOME/auth.json`, defaulting to `~/.myagent/auth.json`.
 * The file holds refresh tokens, so it is created `0600` in a `0700` directory
 * and rewritten atomically (temp file + rename) — a reader never sees a
 * half-written file, and a crash cannot leave a truncated credential store.
 *
 * Writes are serialised per instance and preserve everything they do not
 * understand, so `agent login` for one provider cannot clobber another's entry
 * or a future field this version does not know about.
 */

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError } from "./errors.js";
import type { AuthFile, Credential } from "./types.js";

export interface AuthStoreOptions {
  /** Exact file to use. Wins over `home`. */
  path?: string;
  /** Directory holding `auth.json`. Defaults to `$MYAGENT_HOME` or `~/.myagent`. */
  home?: string;
  /** Environment used for `MYAGENT_HOME`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export function defaultAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.MYAGENT_HOME?.trim();
  return join(home && home.length > 0 ? home : join(homedir(), ".myagent"), "auth.json");
}

export class AuthStore {
  readonly path: string;

  /** Serialises read-modify-write cycles so concurrent logins cannot race. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AuthStoreOptions = {}) {
    const { path, home, env = process.env } = options;
    this.path = path ?? (home === undefined ? defaultAuthPath(env) : join(home, "auth.json"));
  }

  /** Validated view: malformed entries are ignored rather than trusted. */
  async read(): Promise<AuthFile> {
    const raw = await this.readRaw();
    const file: AuthFile = {};
    for (const [provider, value] of Object.entries(raw)) {
      const credential = toCredential(value);
      if (credential !== undefined) file[provider] = credential;
    }
    return file;
  }

  async get(provider: string): Promise<Credential | undefined> {
    const raw = await this.readRaw();
    return toCredential(raw[provider]);
  }

  /** Replace one provider's credential, leaving every other entry intact. */
  async set(provider: string, credential: Credential): Promise<void> {
    await this.mutate((raw) => {
      raw[provider] = credential;
    });
  }

  async delete(provider: string): Promise<void> {
    await this.mutate((raw) => {
      delete raw[provider];
    });
  }

  private async mutate(change: (raw: Record<string, unknown>) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const raw = await this.readRaw();
      change(raw);
      await this.writeRaw(raw);
    };
    const next = this.queue.then(run, run);
    // Keep the chain alive but do not leak a rejection into the next caller.
    this.queue = next.catch(() => undefined);
    await next;
  }

  private async readRaw(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      throw new AuthError(`auth: cannot read ${this.path}`, {
        code: "config",
        cause: error,
      });
    }

    if (text.trim().length === 0) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AuthError(
        `auth: ${this.path} is not valid JSON — fix or delete it`,
        { code: "config", cause: error },
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AuthError(
        `auth: ${this.path} must contain a JSON object keyed by provider`,
        { code: "config" },
      );
    }
    return { ...(parsed as Record<string, unknown>) };
  }

  private async writeRaw(raw: Record<string, unknown>): Promise<void> {
    const directory = dirname(this.path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new AuthError(`auth: cannot create ${directory}`, {
        code: "config",
        cause: error,
      });
    }

    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new AuthError(`auth: cannot write ${this.path}`, {
        code: "config",
        cause: error,
      });
    }

    // rename keeps the temp file's mode, but an existing file may have been
    // created looser by an older version; tighten it either way.
    await chmod(this.path, 0o600).catch(() => undefined);
  }
}

function toCredential(value: unknown): Credential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "key") {
    return typeof record.key === "string" && record.key.length > 0
      ? { ...record, type: "key", key: record.key }
      : undefined;
  }
  if (record.type === "oauth") {
    if (typeof record.access !== "string" || record.access.length === 0) {
      return undefined;
    }
    return { ...record, type: "oauth", access: record.access };
  }
  return undefined;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}