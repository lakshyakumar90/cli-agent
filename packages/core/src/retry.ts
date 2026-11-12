/**
 * Retrying a provider call.
 *
 * A provider that answers 429 or 5xx is worth waiting for; a provider that
 * answered with content and then dropped the connection is not, because the
 * answer would be delivered twice. So a call is only retried when nothing
 * came back yet, and never after a tool has run — the side effects of a
 * tool cannot be undone by asking the model again.
 */

import { ProviderError } from "@cli-agent/ai";

/** Emitted while a call is being retried. */
export interface RetryNotice {
  t: "retry";
  /** 1 for the first retry. */
  attempt: number;
  /** How long the loop waits before trying again. */
  delayMs: number;
  /** What the provider said. */
  reason: string;
}

export interface RetryOptions {
  /** How many times to try again. Default 3. */
  maxRetries?: number;
  /** The first wait. Default 500ms. */
  baseDelayMs?: number;
  /** The longest wait. Default 8s. */
  maxDelayMs?: number;
  /** Extra condition: false means "do not retry this one". */
  canRetry?: () => boolean;
  /** Cancels the wait. */
  signal?: AbortSignal;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

/** Is this failure worth waiting out? */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  // A dropped connection is worth another try.
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "UND_ERR_SOCKET"
    );
  }
  return false;
}

/** The wait before attempt number `attempt` (1 for the first retry). */
export function backoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number {
  const delay = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * Run a stream, retrying it when the provider fails in a way worth waiting
 * out.
 *
 * The retry notice is yielded in the same stream, so the caller sees that
 * something is happening instead of a pause.
 */
export async function* withRetry<T>(
  operation: () => AsyncIterable<T>,
  options: RetryOptions = {},
): AsyncGenerator<T | RetryNotice> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    canRetry = () => true,
    signal,
  } = options;

  let attempt = 0;

  while (true) {
    let produced = false;
    try {
      for await (const item of operation()) {
        produced = true;
        yield item;
      }
      return;
    } catch (error) {
      // Something already came back: retrying would deliver it twice.
      if (
        produced ||
        !canRetry() ||
        !isRetryableError(error) ||
        attempt >= maxRetries ||
        signal?.aborted === true
      ) {
        throw error;
      }

      attempt += 1;
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      yield {
        t: "retry",
        attempt,
        delayMs,
        reason: error instanceof Error ? error.message : String(error),
      };
      await sleep(delayMs, signal);
    }
  }
}

/** Is this event the retry notice? */
export function isRetryNotice(value: unknown): value is RetryNotice {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { t?: unknown }).t === "retry"
  );
}

/** Wait, and give up as soon as the caller aborts. */
export async function sleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted === true) throw abortError();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The error an aborted operation throws. */
export function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Did the caller abort?
 *
 * The adapters let a real abort through unwrapped, so this looks at the
 * signal first and at the error's shape second.
 */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "AbortError" ||
    candidate.code === "aborted" ||
    candidate.code === "ABORT_ERR"
  );
}
