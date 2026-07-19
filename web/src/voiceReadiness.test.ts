import { describe, expect, it } from 'vitest'
import type { Bootstrap } from './types'
import { voiceAvailability } from './voiceReadiness'

const bootstrap = (release?: string): Bootstrap => ({
  backend_release:release, voice_protocol_version:1,
  features:{ web_realtime_voice:true, separate_voice_credits:true } as Bootstrap['features'],
} as Bootstrap)

describe('Voice release parity', () => {
  it('allows equal non-dev releases', () => {
    expect(voiceAvailability(bootstrap('208e3024abcd'), '208e3024abcd').enabled).toBe(true)
  })

  it('blocks unequal non-dev releases with refresh guidance', () => {
    const result = voiceAvailability(bootstrap('208e3024abcd'), '999999999999')
    expect(result.enabled).toBe(false)
    expect(result.reason).toBe('Swico was updated. Refresh the page before starting Voice Mode.')
  })

  it('does not block text-era or local clients when release metadata is unavailable', () => {
    expect(voiceAvailability(bootstrap(), 'dev').enabled).toBe(true)
    expect(voiceAvailability(bootstrap(), '208e3024abcd').enabled).toBe(true)
  })

  it('uses authenticated feature flags as authority', () => {
    const value = bootstrap('208e3024abcd')
    value.features.web_realtime_voice = false
    expect(voiceAvailability(value, '208e3024abcd')).toMatchObject({ enabled:false, reason:'Voice Mode is disabled on the server.' })
  })
})
