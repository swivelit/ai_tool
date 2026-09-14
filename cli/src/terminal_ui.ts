import type { Readable, Writable } from 'node:stream'
import type { SSEEvent } from './sse.js'
import { CommandUsageError, INTERACTIVE_COMMANDS, parseInteractiveCommand, type InteractiveCommand } from './command_registry.js'

type Message = { role: 'user' | 'assistant' | 'notice'; text: string }

export type RichTerminalCommandContext = {
  notice: (text: string) => void
  block: (text: string) => void
  prompt: (text: string) => Promise<string>
  clearConversation: () => void
  setThread: (threadId: string | null) => void
}

export type RichTerminalOptions = {
  input: Readable & { isTTY?: boolean; setRawMode?: (value: boolean) => void; on: (event: string, listener: (...args: any[]) => void) => any; removeListener: (event: string, listener: (...args: any[]) => void) => any }
  output: Writable & { isTTY?: boolean; columns?: number; rows?: number; on?: (event: string, listener: (...args: any[]) => void) => any; removeListener?: (event: string, listener: (...args: any[]) => void) => any }
  version: string
  tierLabel: string
  directory: string
  branch: string | null
  onMessage: (message: string, events: (event: SSEEvent) => void) => Promise<{ text: string; threadId: string | null }>
  onCommand: (command: Extract<InteractiveCommand, { kind: 'command' }>, context: RichTerminalCommandContext) => Promise<boolean | void>
}

const ESC = '\u001b['
const commandNames = INTERACTIVE_COMMANDS.map(item => item.name)

function color(enabled: boolean, code: string, value: string): string { return enabled ? `${ESC}${code}m${value}${ESC}0m` : value }

function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment: (value: string) => Iterable<{ segment: string }> } }).Segmenter
  return Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment) : Array.from(value)
}

function moveGrapheme(value: string, cursor: number, direction: -1 | 1): number {
  const parts = graphemes(value), offsets: number[] = [0]
  for (const part of parts) offsets.push(offsets[offsets.length - 1] + part.length)
  const current = offsets.findIndex(item => item === cursor)
  const index = current < 0 ? parts.length : Math.max(0, Math.min(parts.length, current + direction))
  return offsets[index]
}

function wrap(value: string, width: number): string[] {
  const result: string[] = []
  for (const line of value.split('\n')) {
    const chars = graphemes(line)
    if (!chars.length) { result.push(''); continue }
    for (let index = 0; index < chars.length; index += Math.max(1, width)) result.push(chars.slice(index, index + Math.max(1, width)).join(''))
  }
  return result
}

/**
 * A dependency-free typed terminal renderer. It owns raw input only while the
 * rich screen is active, and delegates Chat, authorization, approvals, and
 * cancellation to the existing CLI controller.
 */
export class RichTerminalUI {
  private readonly useColor = !process.env.NO_COLOR
  private readonly messages: Message[] = []
  private readonly history: string[] = []
  private draft = ''
  private cursor = 0
  private historyIndex = -1
  private menuIndex = 0
  private menuDismissed = false
  private scrollOffset = 0
  private running = false
  private busy = false
  private paste = false
  private inputBuffer = ''
  private cancelCurrent: (() => void) | undefined
  private finishRun: (() => void) | undefined
  private promptWaiter: ((value: string) => void) | undefined
  private readonly onInput = (chunk: Buffer | string) => this.consume(String(chunk))
  private readonly onResize = () => this.render()
  private readonly onSignal = () => this.exit()

  constructor(private readonly options: RichTerminalOptions) {}

  setCancel(callback: (() => void) | undefined): void { this.cancelCurrent = callback }

  async run(): Promise<void> {
    this.running = true
    this.options.input.setRawMode?.(true)
    this.options.input.on('data', this.onInput)
    this.options.output.on?.('resize', this.onResize)
    process.once('SIGINT', this.onSignal)
    process.once('SIGTERM', this.onSignal)
    this.write(`${ESC}?25l${ESC}?2004h`)
    this.notice(`Ready · Enter sends · Ctrl+J inserts a newline · Ctrl+C cancels · /help for commands`)
    this.render()
    await new Promise<void>(resolve => { this.finishRun = resolve })
    this.cleanup()
  }

  notice(text: string): void {
    this.messages.push({ role: 'notice', text })
    this.render()
  }

  block(text: string): void {
    this.messages.push({ role: 'notice', text })
    this.render()
  }

  clearConversation(): void { this.messages.splice(0); this.render() }

  setThread(_threadId: string | null): void { /* controller state is kept by the caller */ }

  async prompt(text: string): Promise<string> {
    const result = new Promise<string>(resolve => { this.promptWaiter = resolve })
    this.notice(text)
    return await result
  }

  private write(value: string): void { this.options.output.write(value) }

  private consume(value: string): void {
    this.inputBuffer += value
    while (this.inputBuffer && this.running) {
      if (this.inputBuffer.startsWith('\u001b[200~')) { this.paste = true; this.inputBuffer = this.inputBuffer.slice(6); continue }
      if (this.paste) {
        const end = this.inputBuffer.indexOf('\u001b[201~')
        if (end < 0) { this.insert(this.inputBuffer); this.inputBuffer = ''; break }
        this.insert(this.inputBuffer.slice(0, end)); this.inputBuffer = this.inputBuffer.slice(end + 6); this.paste = false; continue
      }
      if (this.inputBuffer.startsWith('\u001b[201~')) { this.inputBuffer = this.inputBuffer.slice(6); continue }
      const sequences: Array<[string, () => void]> = [
        ['\u001b[200~', () => { this.paste = true }],
        ['\u001b[13;2u', () => this.insert('\n')], ['\u001b[27;2;13~', () => this.insert('\n')],
        ['\u001b[A', () => this.filteredCommands().length ? this.menuMove(-1) : this.historyMove(-1)], ['\u001b[B', () => this.filteredCommands().length ? this.menuMove(1) : this.historyMove(1)],
        ['\u001b[C', () => { this.cursor = moveGrapheme(this.draft, this.cursor, 1); this.render() }],
        ['\u001b[D', () => { this.cursor = moveGrapheme(this.draft, this.cursor, -1); this.render() }],
        ['\u001b[5~', () => { this.scrollOffset += 5; this.render() }], ['\u001b[6~', () => { this.scrollOffset = Math.max(0, this.scrollOffset - 5); this.render() }],
        ['\u001b', () => { this.inputBuffer = this.inputBuffer.slice(1); this.menuDismissed = true; this.menuIndex = 0; this.render() }],
      ]
      const sequence = sequences.find(([prefix]) => this.inputBuffer.startsWith(prefix))
      if (sequence) { this.inputBuffer = this.inputBuffer.slice(sequence[0].length); sequence[1](); continue }
      const code = this.inputBuffer.codePointAt(0)
      if (code === undefined) break
      const char = String.fromCodePoint(code), size = char.length
      this.inputBuffer = this.inputBuffer.slice(size)
      if (char === '\u0003') { if (this.busy && this.cancelCurrent) { this.cancelCurrent(); this.notice('Cancellation requested.'); this.cancelCurrent = undefined } else if (this.draft) { this.draft = ''; this.cursor = 0; this.render() } else this.exit(); continue }
      if (char === '\u0004') { if (!this.draft && !this.busy) this.exit(); else this.deleteForward(); continue }
      if (char === '\u0009') { this.selectMenu(); continue }
      if (char === '\u000a') { this.insert('\n'); continue }
      if (char === '\r') { void this.submit(); continue }
      if (char === '\u007f') { this.deleteBackward(); continue }
      if (code < 0x20) continue
      this.insert(char)
    }
  }

  private insert(value: string): void {
    if (!value) return
    this.draft = this.draft.slice(0, this.cursor) + value + this.draft.slice(this.cursor)
    this.cursor += value.length; this.historyIndex = -1; this.scrollOffset = 0; this.menuDismissed = false; this.render()
  }

  private deleteBackward(): void {
    if (!this.cursor) return
    const start = moveGrapheme(this.draft, this.cursor, -1)
    this.draft = this.draft.slice(0, start) + this.draft.slice(this.cursor); this.cursor = start; this.render()
  }

  private deleteForward(): void {
    if (this.cursor >= this.draft.length) return
    const end = moveGrapheme(this.draft, this.cursor, 1)
    this.draft = this.draft.slice(0, this.cursor) + this.draft.slice(end); this.render()
  }

  private historyMove(direction: -1 | 1): void {
    if (!this.history.length) return
    if (this.historyIndex < 0) this.historyIndex = this.history.length
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction))
    this.draft = this.historyIndex === this.history.length ? '' : this.history[this.historyIndex]
    this.cursor = this.draft.length; this.render()
  }

  private filteredCommands(): readonly (typeof INTERACTIVE_COMMANDS[number])[] {
    if (this.menuDismissed || !this.draft.startsWith('/') || /\s/.test(this.draft)) return []
    const query = this.draft.slice(1).toLowerCase()
    return INTERACTIVE_COMMANDS.filter(item => item.name.startsWith(query))
  }

  private selectMenu(): void {
    const items = this.filteredCommands()
    if (!items.length) return
    const selected = items[Math.max(0, Math.min(items.length - 1, this.menuIndex))]
    this.draft = `/${selected.name}${['ask', 'agent', 'image', 'resume', 'search', 'mode', 'permissions', 'tier', 'model'].includes(selected.name) ? ' ' : ''}`
    this.cursor = this.draft.length; this.menuIndex = 0; this.menuDismissed = true; this.render()
  }

  private menuMove(direction: -1 | 1): void {
    const items = this.filteredCommands()
    if (!items.length) return
    this.menuIndex = (this.menuIndex + direction + items.length) % items.length
    this.render()
  }

  private async submit(): Promise<void> {
    if (this.promptWaiter) { const waiter = this.promptWaiter; this.promptWaiter = undefined; waiter(this.draft); this.draft = ''; this.cursor = 0; this.render(); return }
    if (this.busy) return
    const value = this.draft
    if (!value.trim()) return
    this.history.push(value); this.historyIndex = -1; this.draft = ''; this.cursor = 0; this.scrollOffset = 0
    let parsed: InteractiveCommand
    try { parsed = parseInteractiveCommand(value) } catch (error) { this.notice(error instanceof Error ? error.message : 'Invalid interactive command.'); return }
    if (parsed.kind === 'command') {
      if (parsed.name === 'exit') { this.exit(); return }
      if (parsed.name === 'ask') { await this.sendMessage(parsed.argument ?? ''); return }
      try { await this.options.onCommand(parsed, { notice: text => this.notice(text), block: text => this.block(text), prompt: text => this.prompt(text), clearConversation: () => this.clearConversation(), setThread: () => undefined }) } catch (error) { this.notice(error instanceof Error ? error.message : 'Swico operation failed.') }
      return
    }
    await this.sendMessage(parsed.text)
  }

  private async sendMessage(text: string): Promise<void> {
    if (!text.trim() || this.busy) return
    this.messages.push({ role: 'user', text }, { role: 'assistant', text: '' }); this.busy = true; this.render()
    try {
      const answer = await this.options.onMessage(text, event => this.receive(event))
      const last = this.messages[this.messages.length - 1]
      if (last?.role === 'assistant' && !last.text) last.text = answer.text
      this.busy = false; this.cancelCurrent = undefined; this.render()
    } catch (error) {
      this.busy = false; this.cancelCurrent = undefined
      this.notice(error instanceof Error ? error.message : 'Swico operation failed.')
    }
  }

  private receive(event: SSEEvent): void {
    const last = this.messages[this.messages.length - 1]
    const assistant = last?.role === 'assistant' ? last : undefined
    if (event.event === 'delta' && assistant && event.data && typeof event.data === 'object') assistant.text += String((event.data as { text?: unknown }).text ?? '')
    if (event.event === 'status' && event.data && typeof event.data === 'object') this.notice(`Status · ${String((event.data as { phase?: unknown }).phase ?? 'working')}`)
    if (event.event === 'quality' && event.data && typeof event.data === 'object') this.notice(`Quality · ${String((event.data as { status?: unknown }).status ?? 'reported')}`)
    if (event.event === 'sources') this.notice('Sources · available')
    if (event.event === 'error' && event.data && typeof event.data === 'object') this.notice(`Error · ${String((event.data as { message?: unknown }).message ?? 'Swico request failed.')}`)
    this.render()
  }

  private exit(): void { this.running = false; this.finishRun?.() }

  private cleanup(): void {
    this.options.input.removeListener('data', this.onInput)
    this.options.input.pause?.()
    if (this.options.output.removeListener) this.options.output.removeListener('resize', this.onResize)
    process.removeListener('SIGINT', this.onSignal)
    process.removeListener('SIGTERM', this.onSignal)
    this.options.input.setRawMode?.(false)
    this.write(`${ESC}?2004l${ESC}?25h\n`)
  }

  private render(): void {
    if (!this.running) return
    const width = Math.max(40, this.options.output.columns ?? 80), rows = Math.max(12, this.options.output.rows ?? 24)
    const cyan = (value: string) => color(this.useColor, '36', value), dim = (value: string) => color(this.useColor, '2', value), green = (value: string) => color(this.useColor, '32', value)
    const branch = this.options.branch ? ` · ${this.options.branch}` : ''
    const directory = this.options.directory.length > width - 12 ? `…${this.options.directory.slice(-(width - 13))}` : this.options.directory
    const cardWidth = Math.min(width - 2, 68), card = [
      `╭${'─'.repeat(Math.max(4, cardWidth - 2))}╮`,
      `│ ${cyan(`Swico ${this.options.version}`)} · ${this.options.tierLabel}`.padEnd(cardWidth - 1) + '│',
      `│ ${dim(`${directory}${branch}`)}`.padEnd(cardWidth - 1) + '│',
      `╰${'─'.repeat(Math.max(4, cardWidth - 2))}╯`,
    ]
    const transcript: string[] = []
    for (const message of this.messages) {
      const label = message.role === 'user' ? green('You') : message.role === 'assistant' ? cyan('Swico') : dim('·')
      const prefix = `${label} `
      for (const line of wrap(message.text, Math.max(10, width - 4))) transcript.push(`${prefix}${line}`)
    }
    const menu = this.filteredCommands().slice(0, 6).map((item, index) => `${index === this.menuIndex ? '›' : ' '} /${item.name.padEnd(14)} ${dim(item.description)}`)
    const composerLines = this.draft ? this.draft.split('\n').map((line, index) => `${index === 0 ? '> ' : '· '}${line}`) : ['> ' + dim('Ask Swico anything…')]
    const footer = [dim(this.busy ? 'Working · Ctrl+C cancels' : 'Enter send · Ctrl+J newline · ↑↓ history · Ctrl+D exit')]
    const available = Math.max(1, rows - card.length - composerLines.length - menu.length - footer.length - 2)
    const start = Math.max(0, transcript.length - available - this.scrollOffset), visible = transcript.slice(start, start + available)
    const lines = [...card, ...visible, ...menu, '', ...composerLines, ...footer]
    const padded = lines.slice(0, rows).map(line => line.slice(0, width))
    const cursorLine = Math.min(padded.length - 1, card.length + visible.length + menu.length + 1 + this.draft.slice(0, this.cursor).split('\n').length - 1)
    const cursorColumn = 3 + (this.draft.slice(0, this.cursor).split('\n').at(-1)?.length ?? 0)
    this.write(`${ESC}2J${ESC}H${padded.join('\n')}\n${ESC}${Math.max(1, cursorLine + 1)};${Math.max(1, cursorColumn)}H`)
  }
}

export { commandNames }
