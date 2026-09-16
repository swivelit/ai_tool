import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { RichTerminalUI } from '../dist/terminal_ui.js'

function fakeTerminal() {
  const input = new EventEmitter()
  input.isTTY = true
  input.setRawMode = value => { input.raw = value }
  const output = new EventEmitter()
  output.isTTY = true; output.columns = 80; output.rows = 24
  let text = ''
  output.write = value => { text += String(value); return true }
  return { input, output, text: () => text }
}

test('rich UI keeps bracketed multiline paste as one draft and preserves slash text', async () => {
  const terminal = fakeTerminal(), messages = [], commands = []
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.3', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: 'main',
    onMessage: async (message, emit) => { messages.push(message); emit({ event: 'delta', data: { text: 'Tamil தமிழ் 😀\n```ts\nconst ok = true\n```' } }); emit({ event: 'done', data: { cancelled: false } }); return { text: 'fallback', threadId: 'thread-1' } },
    onCommand: async command => { commands.push(command.name) },
  })
  const running = ui.run()
  terminal.input.emit('data', '\u001b[200~/ask /literal text\n/bogus\u001b[201~')
  terminal.input.emit('data', '\r')
  await new Promise(resolve => setTimeout(resolve, 10))
  terminal.input.emit('data', '/exit\r')
  await running
  assert.deepEqual(messages, ['/literal text\n/bogus'])
  assert.deepEqual(commands, [])
  assert.match(terminal.text(), /Tamil/)
  assert.match(terminal.text(), /const ok = true/)
})

test('rich UI keeps the active assistant identity across status, quality, and usage notices', async () => {
  const terminal = fakeTerminal(), answers = []
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.3', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: 'main',
    onMessage: async (message, emit) => {
      answers.push(message)
      emit({ event: 'status', data: { phase: 'routing' } })
      emit({ event: 'delta', data: { text: 'ANSWER_' } })
      emit({ event: 'usage', data: { input_tokens: 1, output_tokens: 2 } })
      emit({ event: 'delta', data: { text: 'MARKER' } })
      emit({ event: 'quality', data: { status: 'best_effort' } })
      emit({ event: 'done', data: { cancelled: false } })
      return { text: 'ANSWER_MARKER', threadId: 'thread-1' }
    },
    onCommand: async (command, context) => { commands.push(command.name); context.notice('usage shown') },
  })
  const running = ui.run()
  terminal.input.emit('data', Buffer.from('first\r', 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', Buffer.from('second\r', 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', Buffer.from('/exit\r', 'utf8'))
  await running
  assert.deepEqual(answers, ['first', 'second'])
  const output = terminal.text()
  assert.match(output, /ANSWER_MARKER/)
  assert.equal((output.match(/ANSWER_MARKER/g) ?? []).length >= 2, true)
})

test('rich UI queues bounded follow-ups with Tab and runs them in order after the active turn', async () => {
  const terminal = fakeTerminal(), answers = []
  let releaseFirst
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.1', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: null,
    onMessage: async (message, emit) => {
      answers.push(message)
      if (message === 'first') await new Promise(resolve => { releaseFirst = resolve })
      emit({ event: 'delta', data: { text: message } }); emit({ event: 'done', data: { cancelled: false } })
      return { text: message, threadId: null }
    },
    onCommand: async () => undefined,
  })
  const running = ui.run()
  terminal.input.emit('data', 'first\r')
  await new Promise(resolve => setTimeout(resolve, 20))
  terminal.input.emit('data', 'second\t')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(answers, ['first'])
  assert.match(terminal.text(), /Queued follow-up 1\/8/)
  releaseFirst?.()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(answers, ['first', 'second'])
  terminal.input.emit('data', '/exit\r')
  await running
})

test('rich UI slash menu selection and malformed commands remain local', async () => {
  const terminal = fakeTerminal(), commands = [], notices = []
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.3', tierLabel: 'Swico Pro', directory: '/tmp/work', branch: null,
    onMessage: async () => { throw new Error('Chat must not run') },
    onCommand: async (command, context) => { commands.push(command.name); context.notice('usage shown') },
  })
  const running = ui.run()
  terminal.input.emit('data', '/us\t\r')
  await new Promise(resolve => setTimeout(resolve, 10))
  terminal.input.emit('data', '/bogus\r')
  await new Promise(resolve => setTimeout(resolve, 10))
  terminal.input.emit('data', '/exit\r')
  await running
  notices.push(terminal.text())
  assert.deepEqual(commands, ['usage'])
  assert.match(notices[0], /Unknown interactive command \"\/bogus\"/)
  assert.match(notices[0], /usage shown/)
})

test('rich UI supports local prompt history search and copying the latest answer', async () => {
  const terminal = fakeTerminal(), copied = [], messages = []
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.1', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: null,
    onMessage: async (message, emit) => { messages.push(message); emit({ event: 'delta', data: { text: 'copy me' } }); emit({ event: 'done', data: { cancelled: false } }); return { text: 'copy me', threadId: null } },
    onCommand: async (command, context) => { if (command.name === 'copy') await context.copyLatest() },
    onCopy: async text => { copied.push(text) },
  })
  const running = ui.run()
  terminal.input.emit('data', 'first\r')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', 'second\r')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', '\u0012\u0003')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', '\u000f')
  terminal.input.emit('data', '/copy\r')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', '/exit\r'); await running
  assert.deepEqual(messages, ['first', 'second'])
  assert.deepEqual(copied, ['copy me', 'copy me'])
})

test('rich UI decodes fragmented UTF-8, escape input, CRLF, and split paste markers', async () => {
  const terminal = fakeTerminal(), messages = []
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.3', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: null,
    onMessage: async (message, emit) => { messages.push(message); emit({ event: 'delta', data: { text: 'ok' } }); emit({ event: 'done', data: { cancelled: false } }); return { text: 'ok', threadId: null } },
    onCommand: async () => undefined,
  })
  const running = ui.run()
  const unicode = Buffer.from('தமிழ் 😀\r\n', 'utf8')
  for (const byte of unicode) terminal.input.emit('data', Buffer.from([byte]))
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', 'ab'); terminal.input.emit('data', '\u001b'); terminal.input.emit('data', 'Z\r')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', '\u001b[20'); terminal.input.emit('data', '0~pasted\n/bogus'); terminal.input.emit('data', '\u001b[201'); terminal.input.emit('data', '~\r')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', '/exit\r')
  await running
  assert.deepEqual(messages, ['தமிழ் 😀', 'abZ', 'pasted\n/bogus'])
  assert.equal((terminal.text().match(/\u001b\[2J/g) ?? []).length <= 6, true)
  assert.equal(terminal.input.raw, false)
})

test('rich UI closes on EOF and does not accept late callbacks after cancellation', async () => {
  const terminal = fakeTerminal(), messages = [], emits = []
  let release
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.3', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: null,
    onMessage: async message => { messages.push(message); await new Promise(resolve => { release = resolve }); return { text: 'late', threadId: null } },
    onCommand: async () => undefined,
  })
  const running = ui.run()
  terminal.input.emit('data', 'hold\r')
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.input.emit('data', '\u0003')
  terminal.input.emit('data', '\u001b[200~late\u001b[201~')
  terminal.input.emit('end')
  await running
  release?.()
  await new Promise(resolve => setTimeout(resolve, 25))
  emits.push(terminal.text())
  assert.deepEqual(messages, ['hold'])
  assert.match(emits[0], /\u001b\[\?1049l$/)
  assert.doesNotMatch(emits[0], /Swico late/)
})

test('rich UI keeps the header at the top, shows tier/mode, and uses a visible cell cursor without row padding', async () => {
  const terminal = fakeTerminal(); terminal.output.columns = 157; terminal.output.rows = 93
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.3', tierLabel: 'Swico Lite', modeLabel: () => 'Chat', directory: '/Users/example/projects/swico', branch: 'main',
    onMessage: async (_message, emit) => { emit({ event: 'delta', data: { text: 'layout answer' } }); emit({ event: 'done', data: { cancelled: false } }); return { text: 'layout answer', threadId: null } },
    onCommand: async () => undefined,
  })
  const running = ui.run()
  await new Promise(resolve => setTimeout(resolve, 25))
  const initial = terminal.text()
  assert.match(initial, /Swico 0\.2\.0-rc\.3 · Swico Lite/)
  assert.match(initial, /Chat/)
  assert.match(initial, /\u001b\[\d+;\d+H/)
  assert.equal((initial.match(/\u001b\[2J/g) ?? []).length, 1)
  assert.ok(initial.split('\n').length < 30, 'initial frame must not write one blank line per terminal row')
  terminal.input.emit('data', Buffer.from('layout\r', 'utf8'))
  await new Promise(resolve => setTimeout(resolve, 25))
  terminal.output.columns = 24; terminal.output.rows = 8; terminal.output.emit('resize')
  terminal.input.emit('data', Buffer.from('/exit\r', 'utf8'))
  await running
  assert.match(terminal.text(), /layout answer/)
  assert.equal(terminal.input.raw, false)
})
