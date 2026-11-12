/** Failures from the auth layer, distinct from provider call failures. */

export type AuthErrorCode =
  | "config"
  | "network"
  | "http"
  | "oauth"
  | "state"
  | "timeout"
  | "aborted";

export interface AuthErrorOptions {
  code: AuthErrorCode;
  provider?: string;
  status?: number;
  cause?: unknown;
}

export class AuthError extends Error {
  readonly name = "AuthError";
  readonly code: AuthErrorCode;
  readonly provider?: string;
  readonly status?: number;

  constructor(message: string, options: AuthErrorOptions) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.provider = options.provider;
    this.status = options.status;
  }
}