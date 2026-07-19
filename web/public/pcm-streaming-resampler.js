/* Pure, deterministic streaming resampler shared by the AudioWorklet and tests. */
export const TARGET_SAMPLE_RATE = 16000
export const FRAME_SAMPLES = 512

export class PcmStreamingResampler {
  constructor(sourceRate, targetRate = TARGET_SAMPLE_RATE, frameSamples = FRAME_SAMPLES) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
      throw new RangeError('Sample rates must be positive finite numbers.')
    }
    if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
      throw new RangeError('Frame size must be a positive integer.')
    }
    this.sourceRate = sourceRate
    this.targetRate = targetRate
    this.frameSamples = frameSamples
    this.step = sourceRate / targetRate
    this.residual = new Float32Array(0)
    this.position = 0
    this.frame = new Int16Array(frameSamples)
    this.frameLength = 0
    this.totalInputSamples = 0
    this.totalOutputSamples = 0
  }

  push(input) {
    if (!input || input.length === 0) return []
    this.totalInputSamples += input.length
    const joined = new Float32Array(this.residual.length + input.length)
    joined.set(this.residual)
    joined.set(input, this.residual.length)
    const frames = []

    // Keep the right interpolation sample for the following Web Audio block.
    while (this.position + 1 < joined.length) {
      const left = Math.floor(this.position)
      const fraction = this.position - left
      const sample = joined[left] + (joined[left + 1] - joined[left]) * fraction
      const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0))
      this.frame[this.frameLength++] = clamped < 0
        ? Math.round(clamped * 32768)
        : Math.round(clamped * 32767)
      this.totalOutputSamples += 1
      this.position += this.step
      if (this.frameLength === this.frameSamples) {
        frames.push(this.frame)
        this.frame = new Int16Array(this.frameSamples)
        this.frameLength = 0
      }
    }

    const consumed = Math.min(Math.floor(this.position), Math.max(0, joined.length - 1))
    this.residual = joined.slice(consumed)
    this.position -= consumed
    return frames
  }

  /** Shutdown policy: drop a partial frame by default; optionally zero-pad it. */
  finish({ pad = false } = {}) {
    if (!pad || this.frameLength === 0) {
      this.frame = new Int16Array(this.frameSamples)
      this.frameLength = 0
      this.residual = new Float32Array(0)
      this.position = 0
      return []
    }
    const output = this.frame
    this.frame = new Int16Array(this.frameSamples)
    this.frameLength = 0
    this.residual = new Float32Array(0)
    this.position = 0
    return [output]
  }

  get residualSampleCount() {
    return this.residual.length + this.frameLength
  }
}
