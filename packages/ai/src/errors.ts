/** Errors thrown by provider adapters, in a shape the agent loop can act on. */

export type ProviderErrorCode = "network" | "http" | "protocol" | "aborted";

export interface ProviderErrorOptions {
  provider: string;
  code: ProviderErrorCode;
  status?: number;
  /** First part of the response body, kept for logs and debugging. */
  body?: string;
  /** Set when the failure mode is known, overriding the status-based guess. */
  retryable?: boolean;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly name = "ProviderError";
  readonly provider: string;
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly body?: string;
  private readonly retryHint?: boolean;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.provider = options.provider;
    this.code = options.code;
    this.status = options.status;
    this.body = options.body;
    this.retryHint = options.retryable;
  }

  /** Transient failures worth retrying: rate limits, timeouts, 5xx, dropped connections. */
  get retryable(): boolean {
    if (this.retryHint !== undefined) return this.retryHint;
    if (this.code === "network") return true;
    if (this.status === undefined) return false;
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}