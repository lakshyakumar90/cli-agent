/**
 * Colors.
 *
 * Plain ANSI: no dependency, works everywhere a terminal does, and can be
 * switched off (NO_COLOR, or a terminal that does not want them).
 */

const CODES = {
  reset: "0",
  bold: "1",
  dim: "2",
  italic: "3",
  underline: "4",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  magenta: "35",
  cyan: "36",
  gray: "90",
} as const;

export type ColorName = keyof typeof CODES;

let enabled = true;

/** Turn the colors off (NO_COLOR, or a pipe). */
export function setColors(on: boolean): void {
  enabled = on;
}

/** Are the colors on? */
export function colorsEnabled(): boolean {
  return enabled;
}

/** Should the colors be off, here and now? */
export function shouldUseColors(
  env: NodeJS.ProcessEnv = process.env,
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR.length > 0) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return stream.isTTY === true;
}

/** Put a colour on some text. */
export function color(text: string, name: ColorName): string {
  if (!enabled) return text;
  return `[${CODES[name]}m${text}[0m`;
}

export const bold = (text: string): string => color(text, "bold");
export const dim = (text: string): string => color(text, "dim");
export const italic = (text: string): string => color(text, "italic");
export const red = (text: string): string => color(text, "red");
export const green = (text: string): string => color(text, "green");
export const yellow = (text: string): string => color(text, "yellow");
export const blue = (text: string): string => color(text, "blue");
export const magenta = (text: string): string => color(text, "magenta");
export const cyan = (text: string): string => color(text, "cyan");
export const gray = (text: string): string => color(text, "gray");

/** Remove every escape sequence from some text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

/** The width of some text, without the escapes. */
export function widthOf(text: string): number {
  return stripAnsi(text).length;
}
