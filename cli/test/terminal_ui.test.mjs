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
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.1', tierLabel: 'Swico Lite', directory: '/tmp/work', branch: 'main',
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

test('rich UI slash menu selection and malformed commands remain local', async () => {
  const terminal = fakeTerminal(), commands = [], notices = []
  const ui = new RichTerminalUI({
    input: terminal.input, output: terminal.output, version: '0.2.0-rc.1', tierLabel: 'Swico Pro', directory: '/tmp/work', branch: null,
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
