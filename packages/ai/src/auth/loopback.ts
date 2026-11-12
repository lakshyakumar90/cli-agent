/**
 * Temporary localhost callback server for the authorization-code flow.
 *
 * The OAuth app redirects the browser to `http://127.0.0.1:<port>/callback`;
 * this server answers exactly one request, hands the code back to the login
 * flow and shuts down. Binding to 127.0.0.1 (not 0.0.0.0) keeps the listener
 * off the network, and the `state` check rejects callbacks this process did not
 * initiate.
 */

import { createServer, type ServerResponse } from "node:http";
import { AuthError } from "./errors.js";
import { sameSecret } from "./pkce.js";

export interface LoopbackOptions {
  /** Path the OAuth app redirects to. Defaults to `/callback`. */
  path?: string;
  /** TCP port; `0` (the default) asks the OS for a free one. */
  port?: number;
  /** Interface to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** Value every callback must echo back. */
  state?: string;
  /** Give up after this long. Defaults to 5 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LoopbackServer {
  /** Full redirect URI to register in the authorize request. */
  redirectUri: string;
  /** Resolves with the authorization code of the first valid callback. */
  waitForCode(): Promise<string>;
  /** Idempotent; called automatically once the flow settles. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>cli-agent</title>` +
      `<body style="font:16px system-ui;margin:4rem auto;max-width:32rem">` +
      `<p>${escapeHtml(message)}</p></body>`,
  );
}

export async function startLoopbackServer(
  options: LoopbackOptions = {},
): Promise<LoopbackServer> {
  const {
    path = "/callback",
    port = 0,
    host = "127.0.0.1",
    state,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  let settle!: { resolve: (code: string) => void; reject: (error: unknown) => void };
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A callback can settle this before anyone awaits it (a user following the
  // link immediately, or a state mismatch). Mark it handled from birth so that
  // race cannot surface as an unhandled rejection; consumers still see it.
  void code.catch(() => undefined);

  let settled = false;
  let redirectUri = "";

  const server = createServer((req, res) => {
    if (settled) {
      respond(res, 410, "This login has already finished.");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== path) {
      respond(res, 404, "Not found.");
      return;
    }
    if (req.method !== "GET") {
      respond(res, 405, "Method not allowed.");
      return;
    }

    const error = url.searchParams.get("error");
    if (error !== null) {
      const description =
        url.searchParams.get("error_description") ?? "authorization denied";
      respond(res, 400, `Sign-in failed: ${description}`);
      finish(() =>
        settle.reject(
          new AuthError(`oauth: ${error} — ${description}`, {
            code: "oauth",
          }),
        ),
      );
      return;
    }

    const returnedState = url.searchParams.get("state") ?? "";
    if (state !== undefined && !sameSecret(returnedState, state)) {
      respond(res, 400, "Sign-in failed: state mismatch.");
      finish(() =>
        settle.reject(
          new AuthError(
            "oauth: callback state did not match the login attempt",
            { code: "state" },
          ),
        ),
      );
      return;
    }

    const authorizationCode = url.searchParams.get("code");
    if (authorizationCode === null || authorizationCode.length === 0) {
      respond(res, 400, "Sign-in failed: no authorization code.");
      finish(() =>
        settle.reject(
          new AuthError("oauth: callback carried no authorization code", {
            code: "oauth",
          }),
        ),
      );
      return;
    }

    respond(res, 200, "Signed in. You can close this window.");
    finish(() => settle.resolve(authorizationCode));
  });

  const timer = setTimeout(() => {
    finish(() =>
      settle.reject(
        new AuthError(
          `oauth: no callback after ${Math.round(timeoutMs / 1000)}s`,
          { code: "timeout" },
        ),
      ),
    );
  }, timeoutMs);
  // A pending login must not keep the process alive on its own.
  timer.unref();

  const onAbort = (): void => {
    finish(() =>
      settle.reject(
        new AuthError("oauth: login aborted", { code: "aborted" }),
      ),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  /** Stop accepting work, tear down, then settle exactly once. */
  function finish(action: () => void): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    void close();
    action();
  }

  async function close(): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.off("listening", onListening);
      clearTimeout(timer);
      settled = true;
      reject(
        new AuthError(
          `oauth: cannot listen on ${host}:${port} — ${
            error instanceof Error ? error.message : String(error)
          }`,
          { code: "config", cause: error },
        ),
      );
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      const actualPort =
        typeof address === "object" && address !== null ? address.port : port;
      redirectUri = `http://${host}:${actualPort}${path}`;
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  return {
    redirectUri,
    waitForCode: () => code,
    close,
  };
}