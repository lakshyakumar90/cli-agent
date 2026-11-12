/**
 * PKCE (RFC 7636) primitives.
 *
 * The verifier never leaves this process; the challenge goes to the browser.
 * `S256` is the only method modern providers accept, so it is the only one
 * implemented.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** base64url without padding, which is what OAuth requires. */
export function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export interface PkcePair {
  /** High-entropy secret kept until the token exchange. */
  verifier: string;
  /** SHA-256 of the verifier, safe to put in a URL. */
  challenge: string;
  method: "S256";
}

/**
 * A verifier of 32 random bytes encodes to 43 base64url characters, inside
 * RFC 7636's 43–128 range.
 */
export function pkcePair(bytes = 32): PkcePair {
  const verifier = base64url(randomBytes(bytes));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/** Opaque `state` value that ties the callback to this login attempt. */
export function randomState(bytes = 16): string {
  return base64url(randomBytes(bytes));
}

/** Constant-time comparison, so a hostile page cannot grind the state. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}