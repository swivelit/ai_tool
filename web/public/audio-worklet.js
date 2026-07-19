/* Same-origin realtime microphone processor. No credentials or application data. */
class SwicoPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pending = []
    this.sourceRate = sampleRate
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input?.length) return true
    const ratio = this.sourceRate / 16000
    const length = Math.floor(input.length / ratio)
    const pcm = new Int16Array(length)
    let energy = 0
    for (let index = 0; index < length; index += 1) {
      const value = Math.max(-1, Math.min(1, input[Math.floor(index * ratio)] || 0))
      energy += value * value
      pcm[index] = value < 0 ? value * 32768 : value * 32767
    }
    this.port.postMessage({ type: 'pcm', pcm: pcm.buffer, rms: Math.sqrt(energy / Math.max(1, length)) }, [pcm.buffer])
    return true
  }
}

registerProcessor('swico-pcm16', SwicoPcm16Processor)

