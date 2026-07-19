import type { Bootstrap } from './types'

export function voiceAvailability(bootstrap: Bootstrap, frontendRelease: string): {
  enabled: boolean; reason: string; releaseMismatch: boolean;
} {
  const backendRelease = bootstrap.backend_release || 'unavailable'
  const releaseMismatch = frontendRelease !== 'dev' && backendRelease !== 'dev' &&
    backendRelease !== 'unavailable' && frontendRelease !== backendRelease
  const reason = !bootstrap.features.web_realtime_voice
    ? 'Voice Mode is disabled on the server.'
    : !bootstrap.features.separate_voice_credits
      ? 'Voice Mode is unavailable until separate Voice credits are enabled.'
      : bootstrap.voice_protocol_version !== undefined && bootstrap.voice_protocol_version !== 1
        ? 'Voice Mode needs a newer version of Swico. Refresh the page.'
        : releaseMismatch
          ? 'Swico was updated. Refresh the page before starting Voice Mode.'
          : ''
  return { enabled:!reason, reason, releaseMismatch }
}
