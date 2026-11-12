/**
 * Minimal `text/event-stream` parser.
 *
 * Shared by every adapter that speaks SSE (OpenAI-compatible, Anthropic).
 * Handles chunk boundaries that split a line, CRLF vs LF, multi-line `data:`
 * fields, `:` comments / keep-alives, and streams that end without the final
 * blank line.
 */

export interface SseMessage {
  /** The `event:` field, when the server sends one. */
  event?: string;
  /** All `data:` lines of the message, joined with newlines. */
  data: string;
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  /** Emit the block accumulated so far, if it has any data. */
  const dispatch = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = undefined;
      return undefined;
    }
    const message: SseMessage = {
      data: data.join("\n"),
      ...(event === undefined ? {} : { event }),
    };
    data = [];
    event = undefined;
    return message;
  };

  /** Feed one line (without its terminator) into the current block. */
  const handleLine = (line: string): SseMessage | undefined => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return undefined; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    // `id` and `retry` are irrelevant for one-shot POST streams.
    return undefined;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();

      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const message = handleLine(line);
        if (message) yield message;
        newline = buffer.indexOf("\n");
      }

      if (done) break;
    }

    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      const message = handleLine(line);
      if (message) yield message;
    }

    const trailing = dispatch();
    if (trailing) yield trailing;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored; nothing to clean up.
    }
    reader.releaseLock();
  }
}