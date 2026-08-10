import type { Bootstrap, FeatureFlags } from "./swicoTypes";

export type RealtimeVoiceAvailability = { enabled: boolean; reason: string; releaseMismatch: boolean };

export function crossChatMemoryAvailable(features: FeatureFlags, backendAvailable: boolean) { return features.web_cross_thread_memory === true && backendAvailable; }
export function usageLimitControlsAvailable(billingExempt: boolean) { return !billingExempt; }
export function repositoryValidationVisible(features: FeatureFlags) { return features.web_repository_validation === true; }
export function responseProvenanceVisible(features: FeatureFlags) { return features.web_response_provenance === true; }
export function knowledgeLibraryVisible(features: FeatureFlags) { return features.web_knowledge_library === true; }

export function voiceAvailability(bootstrap: Pick<Bootstrap, "features" | "voice_protocol_version" | "backend_release">, frontendRelease = "unavailable"): RealtimeVoiceAvailability {
  const backendRelease = bootstrap.backend_release || "unavailable";
  const releaseMismatch = frontendRelease !== "unavailable" && frontendRelease !== "dev"
    && backendRelease !== "unavailable" && backendRelease !== "dev" && frontendRelease !== backendRelease;
  const reason = !bootstrap.features.web_realtime_voice
    ? "Voice Mode is disabled on the server."
    : !bootstrap.features.separate_voice_credits
      ? "Voice Mode is unavailable until separate Voice credits are enabled."
      : bootstrap.voice_protocol_version !== undefined && bootstrap.voice_protocol_version !== 1
        ? "Voice Mode needs a newer version of Swico. Refresh the app."
        : releaseMismatch
          ? "Swico was updated. Refresh the app before starting Voice Mode."
          : "";
  return { enabled: !reason, reason, releaseMismatch };
}

export function canUseAttachments(features: FeatureFlags) { return features.web_attachments; }
export function canUploadRepository(features: FeatureFlags) { return features.web_repository_upload === true; }
export function canChatWithRepository(features: FeatureFlags) { return features.web_repository_chat === true; }
export function canDictate(features: FeatureFlags) { return features.web_voice_recording && features.web_voice_billing; }
export function canReplyWithVoice(features: FeatureFlags) { return features.web_voice_reply && features.web_voice_billing; }
