export const DEFAULT_STAGE_TIMEOUT_MS = 90_000
export const CLEAN_INSTALL_TIMEOUT_MS = 240_000
export const TIMEOUT_TOLERANCE_MS = 1_000
export const DIAGNOSTIC_OUTPUT_LIMIT = 2_000

export function timeoutForStage(label) {
  return label === 'clean-prefix install'
    ? CLEAN_INSTALL_TIMEOUT_MS
    : DEFAULT_STAGE_TIMEOUT_MS
}

export function safeDiagnostic(value, limit = DIAGNOSTIC_OUTPUT_LIMIT) {
  return String(value ?? '')
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(-limit)
}

export function classifyExecFailure({ label, error, startedAt, timeoutMs, now = Date.now() }) {
  const elapsedMs = Math.max(0, now - startedAt)
  const killed = error?.killed === true
  const timedOut = killed && elapsedMs >= timeoutMs - TIMEOUT_TOLERANCE_MS
  return {
    stage: label,
    timeout_ms: timeoutMs,
    elapsed_ms: elapsedMs,
    timed_out: timedOut,
    killed,
    signal: error?.signal ?? null,
    code: error?.code ?? null,
    stdout: safeDiagnostic(error?.stdout),
    stderr: safeDiagnostic(error?.stderr),
  }
}
