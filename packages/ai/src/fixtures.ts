/**
 * The recorded streams.
 *
 * A provider adapter is only as good as the bytes it is given. These are
 * the bytes the vendors actually sent, recorded as they came, and the
 * tests replay them: a change in the wire format shows up as a test that
 * fails, not as an agent that breaks in the middle of a task.
 *
 * The files are the raw bodies of the responses. A recording is made by
 * `packages/ai/scripts/record-fixtures.ts`, which calls the real provider
 * and writes down what came back.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the recordings are. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The folder the recordings are in. */
export const FIXTURE_DIRECTORY = join(HERE, "fixtures");

/** The names of the recordings. */
export const FIXTURES = [
  "gemini-stream",
  "gemini-tool-call",
  "openai-compat-stream",
  "openai-compat-tool-call",
  "anthropic-stream",
  "codex-stream",
] as const;

/** One recording. */
export type FixtureName = (typeof FIXTURES)[number];

/**
 * A recorded stream, exactly as it came.
 *
 * The text is what the vendor sent, byte for byte.
 */
export async function recordedStream(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIRECTORY, `${name}.txt`), "utf8");
}

/**
 * A response that serves a recorded stream.
 *
 * The tests give this to the provider instead of a real network, so the
 * provider sees exactly what it would have seen.
 */
export async function recordedResponse(
  name: string,
  options: { status?: number; contentType?: string } = {},
): Promise<Response> {
  const body = await recordedStream(name);
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // The stream comes in pieces, the way a network delivers it.
        const pieces = body.match(/.{1,512}/gs) ?? [];
        for (const piece of pieces) controller.enqueue(encoder.encode(piece));
        controller.close();
      },
    }),
    {
      status: options.status ?? 200,
      headers: {
        "content-type": options.contentType ?? "text/event-stream",
      },
    },
  );
}

/**
 * A fetch that serves the recordings.
 *
 * The provider under test is given this instead of the global fetch, so
 * nothing leaves the machine.
 */
export function fixtureFetch(
  name: string,
  options: { status?: number; contentType?: string } = {},
): typeof globalThis.fetch {
  return (async () =>
    recordedResponse(name, options)) as typeof globalThis.fetch;
}
