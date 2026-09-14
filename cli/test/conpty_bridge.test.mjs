import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { runPtyBridge } from '../scripts/conpty_bridge.mjs'

class FakeInput extends EventEmitter {
  constructor() {
    super()
    this.destroyed = false
    this.paused = false
  }

  pause() { this.paused = true }
  destroy() { this.destroyed = true; this.emit('close') }
}

class FakeChild {
  constructor() {
    this.dataListeners = new Set()
    this.exitListeners = new Set()
    this.writes = []
    this.kills = 0
  }

  onData(listener) {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener) {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(value) { this.writes.push(value) }
  kill() { this.kills += 1 }

  data(value) { for (const listener of this.dataListeners) listener(value) }
  exit(code = 0, signal = 0) { for (const listener of [...this.exitListeners]) listener({ exitCode: code, signal }) }
}

function bridgeFixture(overrides = {}) {
  const input = overrides.input ?? new FakeInput()
  const output = overrides.output ?? { text: '', write(value) { this.text += value } }
  const child = overrides.child ?? new FakeChild()
  const diagnostics = []
  const promise = runPtyBridge({
    pty: { spawn: () => child },
    command: 'controlled-child',
    input,
    output,
    drainMs: overrides.drainMs ?? 5,
    timeoutMs: overrides.timeoutMs ?? 100,
    forceKillMs: overrides.forceKillMs ?? 10,
    maxCaptureBytes: overrides.maxCaptureBytes,
    diagnostics: value => diagnostics.push(value),
  })
  return { input, output, child, diagnostics, promise }
}

async function within(promise, ms = 250) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('bridge did not settle')), ms)),
  ])
}

test('child exit closes a held-open stdin pipe and preserves exit 0 plus final output', async () => {
  const fixture = bridgeFixture()
  fixture.child.data('PTY_READY')
  fixture.child.exit(0, 0)
  fixture.child.data('FINAL_OUTPUT')
  const result = await within(fixture.promise)
  assert.equal(result.code, 0)
  assert.equal(result.signal, undefined)
  assert.equal(result.output, 'PTY_READYFINAL_OUTPUT')
  assert.equal(fixture.input.destroyed, true)
  assert.equal(fixture.child.kills, 0)
  assert.ok(fixture.diagnostics.includes('child-exit-observed code=0 signal=none'))
  assert.ok(fixture.diagnostics.includes('input-released'))
  assert.ok(fixture.diagnostics.includes('output-drained'))
  assert.match(fixture.diagnostics.at(-1), /^helper-closed reason=child-exit code=0/)
  assert.equal(fixture.input.listenerCount('data'), 0)
})

test('nonzero child exit remains a real nonzero result and duplicate exit is ignored', async () => {
  const fixture = bridgeFixture()
  fixture.child.exit(7, 0)
  fixture.child.exit(0, 0)
  const result = await within(fixture.promise)
  assert.equal(result.code, 7)
  assert.equal(result.timedOut, false)
  assert.equal(result.forcedTermination, false)
  assert.equal(fixture.input.destroyed, true)
})

test('parent EOF forwards one EOT while the child is running and then cleans up', async () => {
  const fixture = bridgeFixture()
  fixture.input.emit('end')
  assert.deepEqual(fixture.child.writes, ['\u0004'])
  fixture.child.exit(0, 0)
  const result = await within(fixture.promise)
  assert.equal(result.code, 0)
  assert.equal(fixture.input.destroyed, true)
  assert.deepEqual(fixture.child.writes, ['\u0004'])
})

test('split UTF-8 input is forwarded as one intact string', async () => {
  const fixture = bridgeFixture()
  const bytes = Buffer.from('தமிழ் 😀', 'utf8')
  fixture.input.emit('data', bytes.subarray(0, 3))
  fixture.input.emit('data', bytes.subarray(3))
  assert.equal(fixture.child.writes.join(''), 'தமிழ் 😀')
  assert.equal(fixture.child.writes.join('').includes('�'), false)
  fixture.child.exit(0, 0)
  await within(fixture.promise)
})

test('timeout force-terminates a child that never reports exit and remains a failure', async () => {
  const fixture = bridgeFixture()
  const result = await within(fixture.promise, 300)
  assert.equal(result.timedOut, true)
  assert.equal(result.forcedTermination, true)
  assert.equal(result.code, undefined)
  assert.ok(fixture.child.kills >= 2)
  assert.equal(fixture.input.destroyed, true)
  assert.match(fixture.diagnostics.at(-1), /^helper-closed reason=forced-termination/)
})

test('output failure terminates the child without leaving bridge listeners behind', async () => {
  const input = new FakeInput()
  const child = new FakeChild()
  const output = { write() { throw new Error('controlled output failure') } }
  const fixture = bridgeFixture({ input, child, output })
  child.data('output')
  child.exit(70, 0)
  const result = await within(fixture.promise)
  assert.match(result.error, /controlled output failure/)
  assert.equal(result.code, 70)
  assert.equal(input.listenerCount('data'), 0)
  assert.equal(input.listenerCount('end'), 0)
})

test('backpressured output must report drain before successful helper closure', async () => {
  const output = new EventEmitter()
  let callback
  output.write = (_value, done) => { callback = done; return false }
  const fixture = bridgeFixture({ output, drainMs: 50 })
  fixture.child.data('final')
  fixture.child.exit(0, 0)
  await new Promise(resolve => setTimeout(resolve, 5))
  callback()
  output.emit('drain')
  const result = await within(fixture.promise)
  assert.equal(result.code, 0)
  assert.equal(result.error, undefined)
})

test('asynchronous output errors fail the drain rather than becoming a success', async () => {
  const output = new EventEmitter()
  output.write = () => true
  const fixture = bridgeFixture({ output })
  fixture.child.data('final')
  fixture.child.exit(0, 0)
  output.emit('error', new Error('controlled asynchronous output failure'))
  const result = await within(fixture.promise)
  assert.match(result.error, /controlled asynchronous output failure/)
  assert.equal(result.reason, 'output-drain-failure')
})

test('repeated termination requests are idempotent and retain the first failure', async () => {
  const fixture = bridgeFixture()
  fixture.input.emit('error', new Error('first input failure'))
  fixture.input.on('error', () => undefined)
  fixture.input.emit('error', new Error('second input failure'))
  fixture.child.exit(1, 0)
  const result = await within(fixture.promise)
  assert.equal(fixture.child.kills, 1)
  assert.match(result.error, /first input failure/)
  assert.equal(result.code, 1)
})

test('capture is bounded by bytes and preserves a real signal outcome', async () => {
  const fixture = bridgeFixture()
  fixture.child.data('123456789')
  fixture.child.exit(0, 9)
  const result = await within(fixture.promise)
  assert.equal(result.signal, 9)
  assert.equal(result.code, 0)
  assert.equal(result.output_bytes, 9)

  const bounded = bridgeFixture({ maxCaptureBytes: 4 })
  bounded.child.data('abcdefghij')
  bounded.child.exit(0, 0)
  const boundedResult = await within(bounded.promise)
  assert.equal(Buffer.byteLength(boundedResult.output), 4)
})
