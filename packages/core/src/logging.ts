/**
 * The log.
 *
 * Every request, every tool call and every usage is written down as one
 * JSON object per line. The log is what the agent did, in order, in a
 * shape a program can read: the sessions are for the conversation, the
 * log is for the work.
 *
 * What goes in is redacted first: the log is a file that is kept, and
 * the agent reads files that hold keys.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./redact.js";

/** What happened. */
export type LogEvent =
  /** The model was asked something. */
  | {
      event: "request";
      /** The model it was asked. */
      model: string;
      /** How many messages the conversation had. */
      messages: number;
      /** How many tools it could call. */
      tools: number;
      /** How long the system prompt was. */
      systemChars: number;
    }
  /** A tool was asked for. */
  | {
      event: "toolStart";
      /** The tool. */
      tool: string;
      /** What it was asked to do. */
      args: unknown;
    }
  /** A tool finished. */
  | {
      event: "toolEnd";
      /** The tool. */
      tool: string;
      /** It worked. */
      ok: boolean;
      /** How long it took, in milliseconds. */
      ms: number;
      /** How much it said. */
      outputChars: number;
    }
  /** The model answered, and said what it used. */
  | {
      event: "usage";
      /** The tokens it read. */
      inputTokens: number;
      /** The tokens it wrote. */
      outputTokens: number;
      /** What it cost, in US dollars. */
      cost?: number;
    }
  /** A turn ended. */
  | {
      event: "turn";
      /** Which turn it was. */
      turn: number;
      /** Why the loop stopped. */
      reason: string;
    }
  /** Something else worth knowing. */
  | {
      event: "note";
      /** What it says. */
      message: string;
    };

/** One line of the log. */
export type LogEntry = LogEvent & {
  /** When it happened. */
  at: string;
};

/** Where the log goes. */
export interface LogOptions {
  /** The file. */
  path: string;
  /** The secret values to take out. */
  secrets?: string[];
}

/**
 * The log.
 *
 * It is written as it happens, so a session that is stopped still has
 * what it did.
 */
export class Log {
  /** The file it is written to. */
  readonly path: string;

  private readonly secrets: string[] | undefined;

  constructor(options: LogOptions) {
    this.path = options.path;
    this.secrets = options.secrets;

    try {
      mkdirSync(dirname(options.path), { recursive: true });
    } catch {
      // The log is a help, not a requirement: if the folder cannot be
      // made, the log is simply not written.
    }
  }

  /** Write one thing down. */
  write(entry: LogEvent): void {
    const safe = redactValue(entry, { secrets: this.secrets ?? [] });
    const line = JSON.stringify({
      at: new Date().toISOString(),
      ...(safe as Record<string, unknown>),
    });

    try {
      appendFileSync(this.path, `${line}\n`, "utf8");
    } catch {
      // A log that cannot be written is not a reason to stop the agent.
    }
  }

  /** Write a note. */
  note(message: string): void {
    this.write({ event: "note", message });
  }
}

/** A log that keeps nothing. */
export const nullLog = {
  path: "",
  write(): void {
    // Nothing is written.
  },
  note(): void {
    // Nothing is written.
  },
};
