// @ts-expect-error The same public ES module is loaded directly by AudioWorklet.addModule.
import { FRAME_SAMPLES, PcmStreamingResampler } from '../public/pcm-streaming-resampler.js'

function feed(rate: number, samples: Float32Array, block = 128) {
  const resampler = new PcmStreamingResampler(rate)
  const frames: Int16Array[] = []
  for (let offset = 0; offset < samples.length; offset += block) {
    frames.push(...resampler.push(samples.subarray(offset, offset + block)))
  }
  return { resampler, frames }
}

function waveform(rate: number, seconds: number, amplitude: number) {
  return Float32Array.from({ length:Math.round(rate * seconds) }, (_, index) =>
    amplitude * Math.sin(2 * Math.PI * 220 * index / rate))
}

it.each([48000, 44100, 96000])('streams %i Hz to exact 512-sample, 32 ms frames', rate => {
  const { frames } = feed(rate, waveform(rate, 1.024, 0.4))
  expect(frames).toHaveLength(32)
  expect(frames.every(frame => frame.length === FRAME_SAMPLES && frame.byteLength === 1024)).toBe(true)
})

it('preserves interpolation phase across arbitrary process blocks', () => {
  const input = waveform(44100, 2, 0.37)
  const one = feed(44100, input, input.length).frames.flatMap(frame => [...frame])
  const blocked = feed(44100, input, 128).frames.flatMap(frame => [...frame])
  expect(blocked).toEqual(one)
})

it.each([
  ['silence', 0], ['quiet speech-like waveform', 0.006], ['normal speech-like waveform', 0.55],
] as const)('handles %s without empty frames or clipping', (_name, amplitude) => {
  const { frames } = feed(48000, waveform(48000, 0.5, amplitude))
  expect(frames.length).toBeGreaterThan(0)
  for (const frame of frames) {
    expect(frame.length).toBe(512)
    expect(Math.min(...frame)).toBeGreaterThanOrEqual(-32768)
    expect(Math.max(...frame)).toBeLessThanOrEqual(32767)
  }
})

it('clips out-of-range input to signed 16-bit PCM', () => {
  const input = Float32Array.from({ length:48000 }, (_, index) => index % 2 ? 4 : -4)
  const { frames } = feed(48000, input)
  expect(frames.some(frame => frame.includes(-32768))).toBe(true)
  expect(frames.some(frame => frame.includes(32767))).toBe(true)
})

it('keeps residual storage bounded and drops an incomplete shutdown frame', () => {
  const resampler = new PcmStreamingResampler(44100)
  expect(resampler.push(new Float32Array(1))).toEqual([])
  for (let index = 0; index < 5000; index += 1) {
    resampler.push(waveform(44100, 128 / 44100, 0.2))
    expect(resampler.residualSampleCount).toBeLessThan(515)
  }
  expect(resampler.finish()).toEqual([])
  expect(resampler.residualSampleCount).toBe(0)
})

it('does not materially drift over a long stream', () => {
  const seconds = 30
  const { resampler, frames } = feed(44100, waveform(44100, seconds, 0.25))
  const framed = frames.length * 512
  expect(Math.abs(resampler.totalOutputSamples - seconds * 16000)).toBeLessThanOrEqual(1)
  expect(resampler.totalOutputSamples - framed).toBeGreaterThanOrEqual(0)
  expect(resampler.totalOutputSamples - framed).toBeLessThan(512)
})
