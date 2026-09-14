import { StringDecoder } from 'node:string_decoder'
import type { Readable, Writable } from 'node:stream'
import type { SSEEvent } from './sse.js'
import { INTERACTIVE_COMMANDS, parseInteractiveCommand, type InteractiveCommand } from './command_registry.js'

type Message = { role: 'user' | 'assistant' | 'notice'; text: string }
type ActiveTurn = { assistant: Message; cancelled: boolean; failed: boolean; active: boolean }

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
  modeLabel?: () => string
  directory: string
  branch: string | null
  onMessage: (message: string, events: (event: SSEEvent) => void) => Promise<{ text: string; threadId: string | null }>
  onCommand: (command: Extract<InteractiveCommand, { kind: 'command' }>, context: RichTerminalCommandContext) => Promise<boolean | void>
}

const CSI = '\u001b['
const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'
const commandNames = INTERACTIVE_COMMANDS.map(item => item.name)
const ansiPattern = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g

function color(enabled: boolean, code: string, value: string): string { return enabled ? `${CSI}${code}m${value}${CSI}0m` : value }

function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: string }) => { segment: (value: string) => Iterable<{ segment: string }> } }).Segmenter
  return Segmenter ? [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment) : Array.from(value)
}

function cellWidth(value: string): number {
  if (!value || /^\p{Mark}/u.test(value) || value.includes('\u200d') || /[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(value)) return 0
  const code = value.codePointAt(0) ?? 0
  return code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff)) ? 2 : 1
}

function safeText(value: string): string { return value.replace(ansiPattern, '').replace(/\u001b/g, '���') }
function textWidth(value: string): number { return graphemes(safeText(value)).reduce((total, part) => total + cellWidth(part), 0) }

function abbreviatedDirectory(value: string, width: number): string {
  const clean = safeText(value).replace(/[\\/]+$/, '') || value
  if (textWidth(clean) <= width) return clean
  const parts = clean.split(/[\\/]/).filter(Boolean)
  const tail = parts.at(-1) ?? clean
  return textWidth(tail) + 4 <= width ? `…/${tail}` : `…${takeCells(tail, Math.max(1, width - 1))}`
}

function takeCells(value: string, width: number): string {
  if (width <= 0) return ''
  value = safeText(value)
  let result = '', used = 0
  for (const part of graphemes(value)) {
    const next = cellWidth(part)
    if (used + next > width) break
    result += part; used += next
  }
  return result
}

function padCells(value: string, width: number): string {
  const plain = safeText(value), clipped = takeCells(plain, width)
  // Preserve styling while the complete segment fits. If it needs clipping,
  // return plain text so a slice can never leave an unterminated ANSI control.
  return (clipped === plain ? value : clipped) + ' '.repeat(Math.max(0, width - textWidth(clipped)))
}

function wrapCells(value: string, width: number): string[] {
  const limit = Math.max(1, width), result: string[] = []
  for (const line of safeText(value).split('\n')) {
    let current = '', used = 0
    if (!line) { result.push(''); continue }
    for (const part of graphemes(line)) {
      const next = cellWidth(part)
      if (current && used + next > limit) { result.push(current); current = ''; used = 0 }
      current += part; used += next
    }
    result.push(current)
  }
  return result
}

function moveGrapheme(value: string, cursor: number, direction: -1 | 1): number {
  const parts = graphemes(value), offsets: number[] = [0]
  for (const part of parts) offsets.push(offsets[offsets.length - 1] + part.length)
  const current = offsets.findIndex(item => item === cursor)
  const index = current < 0 ? parts.length : Math.max(0, Math.min(parts.length, current + direction))
  return offsets[index]
}

function suffixPrefix(value: string, marker: string): number {
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

/** A single input-owning, dependency-free rich terminal controller. */
export class RichTerminalUI {
  private readonly useColor = !process.env.NO_COLOR
  private readonly messages: Message[] = []
  private readonly history: string[] = []
  private readonly decoder = new StringDecoder('utf8')
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
  private ignoreNextLf = false
  private escapeTimer: NodeJS.Timeout | undefined
  private renderTimer: NodeJS.Timeout | undefined
  private lastFrame = ''
  private needsFullClear = true
  private cancelCurrent: (() => void) | undefined
  private finishRun: (() => void) | undefined
  private promptWaiter: { resolve: (value: string) => void; reject: (error: Error) => void } | undefined
  private activeTurn: ActiveTurn | undefined
  private readonly onInput = (chunk: Buffer | string) => this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
  private readonly onInputEnd = () => { this.consume(this.decoder.end()); this.rejectPrompt(new Error('Terminal input closed.')); this.exit() }
  private readonly onResize = () => { this.needsFullClear = true; this.render() }
  private readonly onSignal = () => this.exit()

  constructor(private readonly options: RichTerminalOptions) {}

  setCancel(callback: (() => void) | undefined): void { this.cancelCurrent = callback }

  async run(): Promise<void> {
    this.running = true
    this.options.input.setRawMode?.(true)
    this.options.input.on('data', this.onInput)
    this.options.input.on('end', this.onInputEnd)
    this.options.input.on('close', this.onInputEnd)
    this.options.output.on?.('resize', this.onResize)
    process.once('SIGINT', this.onSignal)
    process.once('SIGTERM', this.onSignal)
    this.write(`${CSI}?1049h${CSI}?25h${CSI}?2004h`)
    this.notice('Ready · Enter sends · Ctrl+J inserts a newline · Ctrl+C cancels · /help for commands')
    this.renderNow()
    try {
      await new Promise<void>(resolve => { this.finishRun = resolve })
    } finally {
      this.cleanup()
    }
  }

  notice(text: string): void { this.messages.push({ role: 'notice', text: safeText(text) }); this.render() }
  block(text: string): void { this.notice(text) }
  clearConversation(): void { this.messages.splice(0); this.render() }
  setThread(_threadId: string | null): void { /* controller state is kept by the caller */ }

  async prompt(text: string): Promise<string> {
    if (this.promptWaiter) throw new Error('Another terminal prompt is already active.')
    const result = new Promise<string>((resolve, reject) => { this.promptWaiter = { resolve, reject } })
    this.notice(text)
    return await result
  }

  private write(value: string): void { this.options.output.write(value) }

  private consume(value: string): void {
    this.inputBuffer += value
    while (this.inputBuffer && this.running) {
      if (!this.paste && this.inputBuffer.startsWith(PASTE_START)) { this.paste = true; this.inputBuffer = this.inputBuffer.slice(PASTE_START.length); continue }
      if (!this.paste && PASTE_START.startsWith(this.inputBuffer)) { this.deferEscape(); return }
      if (this.paste) {
        const end = this.inputBuffer.indexOf(PASTE_END)
        if (end < 0) {
          const held = suffixPrefix(this.inputBuffer, PASTE_END)
          const stable = this.inputBuffer.slice(0, this.inputBuffer.length - held)
          if (stable) this.insert(stable)
          this.inputBuffer = held ? this.inputBuffer.slice(-held) : ''
          return
        }
        this.insert(this.inputBuffer.slice(0, end))
        this.inputBuffer = this.inputBuffer.slice(end + PASTE_END.length)
        this.paste = false
        continue
      }
      if (this.inputBuffer.startsWith(PASTE_END)) { this.inputBuffer = this.inputBuffer.slice(PASTE_END.length); continue }

      const sequences: Array<[string, () => void]> = [
        ['\u001b[13;2u', () => this.insert('\n')], ['\u001b[27;2;13~', () => this.insert('\n')],
        ['\u001b[A', () => this.filteredCommands().length ? this.menuMove(-1) : this.historyMove(-1)], ['\u001b[B', () => this.filteredCommands().length ? this.menuMove(1) : this.historyMove(1)],
        ['\u001b[C', () => { this.cursor = moveGrapheme(this.draft, this.cursor, 1); this.render() }], ['\u001b[D', () => { this.cursor = moveGrapheme(this.draft, this.cursor, -1); this.render() }],
        ['\u001b[5~', () => { this.scrollOffset += 5; this.render() }], ['\u001b[6~', () => { this.scrollOffset = Math.max(0, this.scrollOffset - 5); this.render() }],
      ]
      const sequence = sequences.find(([prefix]) => this.inputBuffer.startsWith(prefix))
      if (sequence) { this.inputBuffer = this.inputBuffer.slice(sequence[0].length); sequence[1](); continue }
      if (this.inputBuffer[0] === '\u001b') {
        if (sequences.some(([prefix]) => prefix.startsWith(this.inputBuffer)) || PASTE_END.startsWith(this.inputBuffer)) { this.deferEscape(); return }
        // A standalone escape is a menu dismissal. The following character is
        // still ordinary input; it must not be consumed by the ESC handler.
        this.inputBuffer = this.inputBuffer.slice(1); this.menuDismissed = true; this.menuIndex = 0; this.render(); continue
      }

      const code = this.inputBuffer.codePointAt(0)
      if (code === undefined) break
      const char = String.fromCodePoint(code), size = char.length
      this.inputBuffer = this.inputBuffer.slice(size)
      if (char === '\u0003') { if (this.busy && this.cancelCurrent) { this.activeTurn && (this.activeTurn.cancelled = true); this.cancelCurrent(); this.notice('Cancellation requested.'); this.cancelCurrent = undefined } else if (this.draft) { this.draft = ''; this.cursor = 0; this.render() } else this.exit(); continue }
      if (char === '\u0004') { if (!this.draft && !this.busy) this.exit(); else this.deleteForward(); continue }
      if (char === '\u0009') { this.selectMenu(); continue }
      if (char === '\n') { if (this.ignoreNextLf) this.ignoreNextLf = false; else this.insert('\n'); continue }
      if (char === '\r') { this.ignoreNextLf = this.inputBuffer.startsWith('\n'); void this.submit(); continue }
      if (char === '\u007f') { this.deleteBackward(); continue }
      if (code < 0x20) continue
      this.insert(char)
    }
  }

  private deferEscape(): void {
    if (this.escapeTimer) return
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined
      if (this.inputBuffer.startsWith('\u001b')) { this.inputBuffer = this.inputBuffer.slice(1); this.menuDismissed = true; this.menuIndex = 0; this.render(); this.consume('') }
    }, 35)
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
    if (this.promptWaiter) { const waiter = this.promptWaiter; this.promptWaiter = undefined; waiter.resolve(this.draft); this.draft = ''; this.cursor = 0; this.render(); return }
    if (this.busy) { this.notice('A Chat request is still running. Ctrl+C cancels it.'); return }
    const value = this.draft
    if (!value.trim()) return
    this.history.push(value); this.historyIndex = -1; this.draft = ''; this.cursor = 0; this.scrollOffset = 0
    let parsed: InteractiveCommand
    try { parsed = parseInteractiveCommand(value) } catch (error) { this.notice(error instanceof Error ? error.message : 'Invalid interactive command.'); return }
    if (parsed.kind === 'command') {
      if (parsed.name === 'exit') { this.exit(); return }
      if (parsed.name === 'ask') { await this.sendMessage(parsed.argument ?? ''); return }
      try { await this.options.onCommand(parsed, { notice: text => this.notice(text), block: text => this.block(text), prompt: text => this.prompt(text), clearConversation: () => this.clearConversation(), setThread: threadId => this.setThread(threadId) }) } catch (error) { this.notice(error instanceof Error ? error.message : 'Swico operation failed.') }
      return
    }
    await this.sendMessage(parsed.text)
  }

  private async sendMessage(text: string): Promise<void> {
    if (!text.trim() || this.busy || !this.running) return
    const assistant: Message = { role: 'assistant', text: '' }
    this.messages.push({ role: 'user', text: safeText(text) }, assistant)
    const turn: ActiveTurn = { assistant, cancelled: false, failed: false, active: true }
    this.activeTurn = turn; this.busy = true; this.render()
    try {
      const answer = await this.options.onMessage(text, event => this.receive(event, turn))
      if (turn.active && !turn.cancelled && !turn.failed && !assistant.text) assistant.text = answer.text ? safeText(answer.text) : assistant.text
      turn.active = false
      if (this.activeTurn === turn) this.activeTurn = undefined
      this.busy = false; this.cancelCurrent = undefined; this.render()
    } catch (error) {
      turn.active = false
      if (this.activeTurn === turn) this.activeTurn = undefined
      this.busy = false; this.cancelCurrent = undefined
      this.notice(error instanceof Error ? error.message : 'Swico operation failed.')
    }
  }

  private receive(event: SSEEvent, turn: ActiveTurn): void {
    if (!turn.active || this.activeTurn !== turn) return
    if (event.event === 'delta' && event.data && typeof event.data === 'object') turn.assistant.text += safeText(String((event.data as { text?: unknown }).text ?? ''))
    if (event.event === 'status' && event.data && typeof event.data === 'object') this.notice(`Status · ${String((event.data as { phase?: unknown }).phase ?? 'working')}`)
    if (event.event === 'quality' && event.data && typeof event.data === 'object') this.notice(`Quality · ${String((event.data as { status?: unknown }).status ?? 'reported')}`)
    if (event.event === 'usage' && event.data && typeof event.data === 'object') this.notice('Usage · recorded')
    if (event.event === 'sources') this.notice('Sources · available')
    if (event.event === 'error' && event.data && typeof event.data === 'object') { turn.failed = true; this.notice(`Error · ${String((event.data as { message?: unknown }).message ?? 'Swico request failed.')}`) }
    if (event.event === 'done' && event.data && typeof event.data === 'object' && (event.data as { cancelled?: unknown }).cancelled === true) turn.cancelled = true
    this.render()
  }

  private rejectPrompt(error: Error): void { const waiter = this.promptWaiter; this.promptWaiter = undefined; waiter?.reject(error) }

  private exit(): void {
    if (!this.running) return
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = undefined; this.renderNow() }
    this.running = false
    if (this.activeTurn) this.activeTurn.active = false
    this.rejectPrompt(new Error('Terminal input closed.'))
    this.finishRun?.()
  }

  private cleanup(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer)
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.options.input.removeListener('data', this.onInput)
    this.options.input.removeListener('end', this.onInputEnd)
    this.options.input.removeListener('close', this.onInputEnd)
    this.options.input.pause?.()
    if (this.options.output.removeListener) this.options.output.removeListener('resize', this.onResize)
    process.removeListener('SIGINT', this.onSignal)
    process.removeListener('SIGTERM', this.onSignal)
    this.options.input.setRawMode?.(false)
    this.write(`${CSI}?2004l${CSI}?25h${CSI}?1049l`)
  }

  private render(): void {
    if (!this.running || this.renderTimer) return
    this.renderTimer = setTimeout(() => { this.renderTimer = undefined; this.renderNow() }, 16)
  }

  private renderNow(): void {
    if (!this.running) return
    const width = Math.max(1, this.options.output.columns ?? 80), rows = Math.max(1, this.options.output.rows ?? 24)
    // Never write the last physical cell: a terminal may wrap there before
    // the next control sequence is processed. The unused final column is
    // cleared by CSI K and keeps cursor/layout calculations deterministic.
    const layoutWidth = Math.max(1, width - 1)
    const cyan = (value: string) => color(this.useColor, '36', value), dim = (value: string) => color(this.useColor, '2', value), green = (value: string) => color(this.useColor, '32', value)
    const branch = this.options.branch ? ` · ${this.options.branch}` : ''
    const cardWidth = Math.min(layoutWidth, 68), card: string[] = []
    if (cardWidth >= 4) {
      const inner = cardWidth - 2
      card.push(`╭${'─'.repeat(inner)}╮`)
      card.push(`│ ${cyan(padCells(`Swico ${this.options.version} · ${this.options.tierLabel}`, inner - 1))}│`)
      card.push(`│ ${dim(padCells(`${abbreviatedDirectory(this.options.directory, inner - 1)}${branch}`, inner - 1))}│`)
      if (this.options.modeLabel) card.push(`│ ${dim(padCells(`Mode: ${this.options.modeLabel()}`, inner - 1))}│`)
      card.push(`╰${'─'.repeat(inner)}╯`)
    } else card.push(padCells('Swico', layoutWidth))

    const transcript: string[] = []
    for (const message of this.messages) {
      const rawLabel = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Swico' : '·'
      const styledLabel = message.role === 'user' ? green(rawLabel) : message.role === 'assistant' ? cyan(rawLabel) : dim(rawLabel)
      const labelWidth = textWidth(rawLabel) + 1, contentWidth = Math.max(1, layoutWidth - labelWidth)
      const wrapped = wrapCells(message.text, contentWidth)
      wrapped.forEach((line, index) => transcript.push(index === 0 ? `${styledLabel} ${padCells(line, contentWidth)}` : `${' '.repeat(labelWidth)}${padCells(line, contentWidth)}`))
    }

    const menu = this.filteredCommands().slice(0, 6).map((item, index) => padCells(`${index === this.menuIndex ? '›' : ' '} /${item.name} ${item.description}`, layoutWidth))
    const composerWidth = Math.max(1, layoutWidth - 2), composerLines: string[] = []
    if (this.draft) {
      for (const [lineIndex, line] of this.draft.split('\n').entries()) {
        const wrapped = wrapCells(line, composerWidth)
        wrapped.forEach((part, index) => composerLines.push(padCells(`${lineIndex === 0 && index === 0 ? '> ' : '· '}${part}`, layoutWidth)))
      }
    } else composerLines.push(padCells(`> ${dim('Ask Swico anything…')}`, layoutWidth))
    const footer = [padCells(dim(this.busy ? 'Working · Ctrl+C cancels' : 'Enter send · Ctrl+J newline · ↑↓ history · Ctrl+D exit'), layoutWidth)]
    const available = Math.max(1, rows - card.length - composerLines.length - menu.length - footer.length - 2)
    const start = Math.max(0, transcript.length - available - this.scrollOffset), visible = transcript.slice(start, start + available)
    const lines = [...card, ...visible, ...menu, '', ...composerLines, ...footer].slice(0, rows).map(line => padCells(line, layoutWidth))
    const draftBefore = this.draft.slice(0, this.cursor), draftParts = draftBefore.split('\n')
    let composerRow = 0, composerColumn = 3
    for (const [lineIndex, part] of draftParts.entries()) {
      const chunks = wrapCells(part, composerWidth)
      composerRow += Math.max(1, chunks.length) - 1
      if (lineIndex < draftParts.length - 1) composerRow += 1
      composerColumn = 3 + textWidth(chunks.at(-1) ?? '')
    }
    const cursorLine = Math.min(Math.max(0, rows - 1), card.length + visible.length + menu.length + 1 + composerRow)
    const cursorColumn = Math.min(layoutWidth, Math.max(1, composerColumn))
    const clear = `${CSI}J`
    const home = this.needsFullClear ? `${CSI}2J${CSI}H` : `${CSI}H`
    const frame = `${home}${lines.map(line => `${line}${CSI}K`).join('\n')}${clear}${CSI}${cursorLine + 1};${cursorColumn}H`
    if (frame !== this.lastFrame) { this.lastFrame = frame; this.write(frame) }
    this.needsFullClear = false
  }
}

export { commandNames }
