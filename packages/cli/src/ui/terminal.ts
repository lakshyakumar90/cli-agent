import {
  ProcessTerminal,
  StdinBuffer,
  type Terminal,
} from "@earendil-works/pi-tui";

/** Injectable streams for PTY/headless tests; production uses pi's native terminal. */
export function terminalFor(
  input: NodeJS.ReadableStream,
  out: NodeJS.WritableStream,
): Terminal {
  if (input === process.stdin && out === process.stdout)
    return new ProcessTerminal();
  return new StreamTerminal(input, out);
}
class StreamTerminal extends ProcessTerminal {
  private buffer?: StdinBuffer;
  private data?: (chunk: Buffer | string) => void;
  private resize?: () => void;
  private previousRaw = false;
  constructor(
    private input: NodeJS.ReadableStream,
    private out: NodeJS.WritableStream,
  ) {
    super();
  }
  override get columns(): number {
    return (this.out as NodeJS.WriteStream).columns || 100;
  }
  override get rows(): number {
    return (this.out as NodeJS.WriteStream).rows || 30;
  }
  override start(onInput: (data: string) => void, onResize: () => void): void {
    const stream = this.input as NodeJS.ReadStream;
    this.previousRaw = stream.isRaw;
    stream.setRawMode?.(true);
    this.buffer = new StdinBuffer();
    this.buffer.on("data", onInput);
    this.buffer.on("paste", (data) => onInput(`\x1b[200~${data}\x1b[201~`));
    this.data = (chunk) => this.buffer?.process(chunk);
    this.resize = onResize;
    this.input.on("data", this.data);
    this.out.on("resize", onResize);
    this.write("\x1b[?2004h");
  }
  override stop(): void {
    if (this.data) this.input.removeListener("data", this.data);
    if (this.resize) this.out.removeListener("resize", this.resize);
    this.buffer?.destroy();
    (this.input as NodeJS.ReadStream).setRawMode?.(this.previousRaw);
    this.write("\x1b[?2004l\x1b[?25h");
  }
  override write(data: string): void {
    this.out.write(data);
  }
  override moveBy(lines: number): void {
    if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
  }
  override hideCursor(): void {
    this.write("\x1b[?25l");
  }
  override showCursor(): void {
    this.write("\x1b[?25h");
  }
  override clearLine(): void {
    this.write("\x1b[K");
  }
  override clearFromCursor(): void {
    this.write("\x1b[J");
  }
  override clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }
  override setTitle(_title: string): void {}
  override setProgress(_active: boolean): void {}
  override setProgramStatus(): void {}
  override async drainInput(): Promise<void> {}
  override restoreOnExit(before: string, after: string): void {
    this.write(before + "\x1b[?2004l\x1b[?25h" + after);
  }
}
