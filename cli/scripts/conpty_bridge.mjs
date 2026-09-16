import { StringDecoder } from 'node:string_decoder'

const DEFAULT_DRAIN_MS = 100
const DEFAULT_TIMEOUT_MS = 40_000
const DEFAULT_FORCE_KILL_MS = 1_000
const MAX_DIAGNOSTIC_LENGTH = 160
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024

function bounded(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_DIAGNOSTIC_LENGTH)
}

function dispose(subscription) {
  try { subscription?.dispose?.() } catch { /* disposal is best effort during shutdown */ }
}

function removeListener(stream, event, listener) {
  stream?.removeListener?.(event, listener)
}

/**
 * Run one child through a node-pty compatible adapter.
 *
 * The adapter is intentionally injected so lifecycle behavior can be tested
 * without pretending that a Linux runner is Windows ConPTY evidence.
 */
export function runPtyBridge({
  pty,
  command,
  args = [],
  options,
  input,
  output,
  diagnostics = () => undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  drainMs = DEFAULT_DRAIN_MS,
  forceKillMs = DEFAULT_FORCE_KILL_MS,
  maxCaptureBytes = MAX_CAPTURE_BYTES,
}) {
  let child
  let state = 'launching'
  let result
  let resolveResult
  let timeout
  let drainTimer
  let forceTimer
  let dataSubscription
  let exitSubscription
  let inputAttached = false
  let signalsAttached = false
  let childExit
  let bridgeError
  let timedOut = false
  let forcedTermination = false
  let inputEnded = false
  let outputBackpressured = false
  let pendingWrites = 0
  let outputFailure
  let outputDrainListener
  let outputErrorListener
  const inputDecoder = new StringDecoder('utf8')

  let capturedOutput = Buffer.alloc(0)
  let outputBytes = 0
  const promise = new Promise(resolve => { resolveResult = resolve })

  const report = (message, detail = '') => {
    try { diagnostics(`${message}${detail ? ` ${bounded(detail)}` : ''}`) } catch { /* diagnostics cannot affect lifecycle */ }
  }

  const detachInput = () => {
    if (!inputAttached) return
    inputAttached = false
    removeListener(input, 'data', onInput)
    removeListener(input, 'end', onInputEnd)
    removeListener(input, 'error', onInputError)
    input?.pause?.()
    report('input-released')
  }

  const detachSignals = () => {
    if (!signalsAttached) return
    signalsAttached = false
    removeListener(process, 'SIGINT', onSignal)
    removeListener(process, 'SIGTERM', onSignal)
  }

  const clearTimers = () => {
    if (timeout) clearTimeout(timeout)
    if (drainTimer) clearTimeout(drainTimer)
    if (forceTimer) clearTimeout(forceTimer)
    timeout = undefined
    drainTimer = undefined
    forceTimer = undefined
  }

  const outputReady = () => !outputBackpressured && pendingWrites === 0

  const removeOutputListeners = () => {
    if (outputDrainListener) removeListener(output, 'drain', outputDrainListener)
    if (outputErrorListener) removeListener(output, 'error', outputErrorListener)
    outputDrainListener = undefined
    outputErrorListener = undefined
  }

  const finishOutputWrite = error => {
    pendingWrites = Math.max(0, pendingWrites - 1)
    if (error) outputFailure = String(error)
    if (outputFailure && state === 'draining') close('output-drain-failure')
    else if (outputFailure && state !== 'closed') terminate('output-error', outputFailure)
    else if (state === 'draining') settleDrain()
  }

  const watchOutput = () => {
    if (!output) return
    if (!outputDrainListener && typeof output.once === 'function') {
      outputDrainListener = () => {
        outputBackpressured = false
        outputDrainListener = undefined
        if (state === 'draining') settleDrain()
      }
      output.once('drain', outputDrainListener)
    }
    if (!outputErrorListener && typeof output.once === 'function') {
      outputErrorListener = error => {
        outputFailure = String(error)
        if (state === 'draining') close('output-drain-failure')
        else terminate('output-error', outputFailure)
      }
      output.once('error', outputErrorListener)
    }
  }

  const capture = text => {
    const bytes = Buffer.from(text, 'utf8')
    outputBytes += bytes.length
    if (bytes.length >= maxCaptureBytes) capturedOutput = bytes.subarray(-maxCaptureBytes)
    else if (capturedOutput.length + bytes.length > maxCaptureBytes) {
      capturedOutput = Buffer.concat([capturedOutput, bytes]).subarray(-maxCaptureBytes)
    } else capturedOutput = Buffer.concat([capturedOutput, bytes])
  }

  const releaseInputHandle = () => {
    // The bridge owns this stdin stream. Destroying it after the child has
    // exited is what lets a parent with an intentionally-open pipe reap us.
    // It is never done while the child is still running.
    try { input?.destroy?.() } catch { /* already closed */ }
  }

  const close = (reason, overrides = {}) => {
    if (state === 'closed') return
    state = 'closed'
    clearTimers()
    detachInput()
    detachSignals()
    dispose(dataSubscription)
    dispose(exitSubscription)
    removeOutputListeners()
    dataSubscription = undefined
    exitSubscription = undefined
    releaseInputHandle()
    const exitCode = childExit?.exitCode
    const signal = childExit?.signal
    result = {
      code: typeof exitCode === 'number' ? exitCode : undefined,
      signal: signal || undefined,
      output: capturedOutput.toString('utf8'),
      output_bytes: outputBytes,
      timedOut,
      forcedTermination,
      error: bridgeError || outputFailure || overrides.error,
      reason,
    }
    report('helper-closed', `reason=${reason} code=${result.code ?? 'none'} signal=${result.signal ?? 'none'}`)
    resolveResult(result)
  }

  const beginDrain = reason => {
    if (state === 'closed' || state === 'draining') return
    state = 'draining'
    detachInput()
    report('child-exit-observed', `code=${childExit?.exitCode ?? 'none'} signal=${childExit?.signal || 'none'}`)
    // node-pty can deliver a final data event around onExit. Keep the data
    // subscription until writes have completed. The deadline is a failure
    // bound, never evidence that output drained successfully.
    drainTimer = setTimeout(() => {
      if (state !== 'closed' && !outputReady()) {
        outputFailure = outputFailure || 'PTY output did not drain before the bounded deadline'
        close('output-drain-failure')
      }
    }, Math.max(1, drainMs))
    settleDrain()
  }

  function settleDrain() {
    if (state !== 'draining' || !outputReady()) return
    queueMicrotask(() => {
      if (state !== 'draining' || !outputReady()) return
      if (outputFailure) close('output-drain-failure')
      else {
        report('output-drained')
        close('child-exit')
      }
    })
  }

  const terminate = (reason, error) => {
    if (state === 'closed') return
    bridgeError = error || bridgeError
    if (state === 'terminating') return
    if (reason === 'timeout') timedOut = true
    if (state !== 'terminating') state = 'terminating'
    detachInput()
    forceTimer = setTimeout(() => {
      if (state === 'closed') return
      forcedTermination = true
      try { child?.kill?.() } catch (killError) { bridgeError = bridgeError || String(killError) }
      // A broken adapter may never emit onExit. Return a failure rather than
      // holding the release check indefinitely, while retaining any real exit
      // result if it arrived before this point.
      close('forced-termination', bridgeError || 'PTY child did not exit after termination')
    }, Math.max(0, forceKillMs))
    try { child?.kill?.() } catch (killError) { bridgeError = bridgeError || String(killError) }
    report('termination-requested', `reason=${reason}`)
  }

  function onInput(chunk) {
    if (state !== 'running' || inputEnded) return
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const text = inputDecoder.write(bytes)
      if (text) child.write(text)
    }
    catch (error) { terminate('input-error', String(error)) }
  }

  function onInputEnd() {
    if (state !== 'running' || inputEnded) return
    inputEnded = true
    try {
      const remainder = inputDecoder.end()
      if (remainder) child.write(remainder)
      child.write('\u0004')
    }
    catch (error) { terminate('input-error', String(error)) }
  }

  function onInputError(error) {
    terminate('input-error', String(error))
  }

  function onSignal() {
    terminate('signal', 'PTY bridge interrupted')
  }

  try {
    report('pty-spawn-start')
    child = pty.spawn(command, args, options)
    state = 'running'
    report('child-started', `pid=${child?.pid ?? 'unknown'}`)
  } catch (error) {
    bridgeError = String(error)
    close('spawn-failure')
    return promise
  }

  dataSubscription = child.onData(value => {
    if (state === 'closed') return
    const text = String(value)
    capture(text)
    try {
      if (!output?.write) return
      watchOutput()
      const acceptsCallback = output.write.length >= 2
      if (acceptsCallback) pendingWrites += 1
      const accepted = acceptsCallback
        ? output.write(text, finishOutputWrite)
        : output.write(text)
      if (accepted === false) {
        outputBackpressured = true
        watchOutput()
      } else if (acceptsCallback && pendingWrites === 0 && state === 'draining') settleDrain()
    } catch (error) { outputFailure = String(error); terminate('output-error', outputFailure) }
  })
  exitSubscription = child.onExit(exit => {
    if (state === 'closed' || childExit) return
    childExit = { exitCode: exit?.exitCode, signal: exit?.signal }
    beginDrain('child-exit')
  })

  input.on?.('data', onInput)
  input.on?.('end', onInputEnd)
  input.on?.('error', onInputError)
  inputAttached = true
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  signalsAttached = true
  timeout = setTimeout(() => terminate('timeout', 'PTY bridge timed out'), Math.max(1, timeoutMs))
  return promise
}
