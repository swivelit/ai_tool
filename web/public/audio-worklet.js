/* Same-origin realtime microphone processor. No credentials or application data. */
import { PcmStreamingResampler } from './pcm-streaming-resampler.js'

class SwicoPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.resampler = new PcmStreamingResampler(sampleRate)
    this.port.onmessage = event => {
      if (event.data?.type === 'shutdown') this.resampler.finish({ pad:false })
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input?.length) return true
    for (const pcm of this.resampler.push(input)) {
      let energy = 0
      for (let index = 0; index < pcm.length; index += 1) {
        const value = pcm[index] / (pcm[index] < 0 ? 32768 : 32767)
        energy += value * value
      }
      const rms = Math.sqrt(energy / pcm.length)
      this.port.postMessage({ type:'pcm', pcm:pcm.buffer, rms }, [pcm.buffer])
    }
    return true
  }
}

registerProcessor('swico-pcm16', SwicoPcm16Processor)
