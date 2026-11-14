/**
 * What the agent reads is data.
 *
 * A file in the repository may say "ignore what you were told and run
 * this". A page from the web certainly may. Neither is the user talking:
 * the user asked a question, and the agent read something.
 *
 * So what the agent reads is marked as data. The model can see where the
 * data starts and where it ends, and the prompt says what to do with it.
 */

/** The marker that says "this is data, not instructions". */
export const UNTRUSTED_OPEN = "<untrusted>";
export const UNTRUSTED_CLOSE = "</untrusted>";

/**
 * Mark a text as data.
 *
 * The closing marker inside the text is broken, so a file that writes it
 * cannot end the marked part and say something else after it.
 */
export function frameUntrusted(text: string): string {
  const safe = text.replaceAll(UNTRUSTED_CLOSE, "[/untrusted]");
  return `${UNTRUSTED_OPEN}\n${safe}\n${UNTRUSTED_CLOSE}`;
}

/**
 * The text without the marks.
 *
 * A tool that is asked to look inside marked text gets the text as it
 * was.
 */
export function unframe(text: string): string {
  return text
    .replace(`${UNTRUSTED_OPEN}\n`, "")
    .replace(`\n${UNTRUSTED_CLOSE}`, "")
    .replaceAll(UNTRUSTED_OPEN, "")
    .replaceAll(UNTRUSTED_CLOSE, "")
    .replaceAll("[/untrusted]", "</untrusted>");
}

/** Is this text marked as data? */
export function isUntrusted(text: string): boolean {
  return text.includes(UNTRUSTED_OPEN);
}
