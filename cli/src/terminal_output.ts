export type TerminalWriter = { isTTY?: boolean; write(value: string): unknown }

/** Keeps streamed answer bytes separate from human-readable diagnostics. */
export class TerminalOutput {
  private answerLineOpen = false
  private answerEndsWithNewline = false

  constructor(
    private readonly stdout: TerminalWriter,
    private readonly stderr: TerminalWriter,
  ) {}

  writeAnswer(value: string): void {
    if (!value) return
    this.stdout.write(value)
    this.answerEndsWithNewline = value.endsWith('\n')
    this.answerLineOpen = !this.answerEndsWithNewline
  }

  writeDiagnostic(value: string): void {
    if (this.answerLineOpen) {
      // A redirected answer must remain byte-for-byte intact until its final
      // newline. A TTY can close the visible line before the diagnostic;
      // stderr gets its own leading boundary for merged stdout/stderr logs.
      if (this.stdout.isTTY) {
        this.stdout.write('\n')
        this.answerLineOpen = false
      } else {
        this.stderr.write('\n')
      }
    }
    this.stderr.write(`${value.replace(/\n+$/g, '')}\n`)
  }

  finishAnswer(): void {
    if (this.answerLineOpen && !this.answerEndsWithNewline) this.stdout.write('\n')
    this.answerLineOpen = false
    this.answerEndsWithNewline = false
  }
}
