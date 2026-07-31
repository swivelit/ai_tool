from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Mapping


SafeScalar = str | int | float | bool | None
_FORBIDDEN_KEY_PARTS = (
    "message",
    "prompt",
    "content",
    "text",
    "excerpt",
    "code",
    "secret",
    "token",
    "credential",
    "password",
    "api_key",
    "environment",
    "env_value",
)
_ALLOWED_KEYS = frozenset(
    {
        "policy_version",
        "tier_id",
        "route",
        "intent",
        "answer_class",
        "reason_codes",
        "retrieval_sources",
        "max_output_tokens",
        "expected_provider_calls",
        "cache_eligible",
        "deterministic",
        "streaming_mode",
        "planned_usage_stages",
        "allocation",
        "prompt_ceiling",
        "fixed_tokens",
        "history_tokens",
        "memory_tokens",
        "profile_tokens",
        "document_tokens",
        "unallocated_tokens",
        "attachment_count",
        "attachment_bytes",
        "attachment_media_categories",
        "has_extracted_attachment_chunks",
        "shadow_mode",
        "status",
        "retrieval_status",
        "candidate_count",
        "evidence_item_count",
        "total_token_count",
        "status_codes",
        "source_label",
        "source_locator",
        "source_kind",
        "confidence",
        "content_hash",
        "round_count",
        "dense_enabled",
        "embedding_call_count",
        "quality_outcome",
        "quality_checks",
        "check_type",
        "check_status",
        "repair_attempted",
        "verifier_used",
        "attempt_number",
        "stage_key",
        "provider",
        "model",
        "native_cost_amount",
        "native_cost_currency",
        "micro_inr_cost",
        "input_token_count",
        "output_token_count",
        "rollout_decisions",
        "rollout_feature_key",
        "rollout_cohort",
        "rollout_policy_version",
        "rollout_enabled",
    }
)
_ENUM_VALUES: dict[str, frozenset[str]] = {
    "tier_id": frozenset({"lite", "standard", "pro"}),
    "route": frozenset(
        {"deterministic", "cache_candidate", "provider_backed", "blocked"}
    ),
    "intent": frozenset(
        {
            "general",
            "unsafe_or_sensitive",
            "file_retrieval",
            "creative_tool",
            "document",
            "reminder",
            "note",
            "task",
            "routine",
            "profile",
            "settings",
            "coding",
            "complex_reasoning",
            "translation",
            "tts",
            "stt",
            "weather",
            "live_data",
            "thanks",
            "capabilities",
            "greeting",
            "contextual_reference",
            "contextual_translate",
            "contextual_explain",
            "contextual_rewrite",
        }
    ),
    "answer_class": frozenset({"simple", "normal", "detailed", "long_form"}),
    "streaming_mode": frozenset(
        {"existing_sse", "direct", "verified_buffered", "none"}
    ),
    "status": frozenset(
        {
            "planned",
            "reserved",
            "running",
            "complete",
            "settled",
            "released",
            "disabled",
            "cancelled",
            "skipped",
            "failed",
            "not_run",
            "passed",
            "error",
        }
    ),
    "retrieval_status": frozenset(
        {"sufficient", "ambiguous", "insufficient", "contradictory"}
    ),
    "quality_outcome": frozenset(
        {
            "verified",
            "grounded",
            "best_effort",
            "unverified",
            "insufficient_evidence",
        }
    ),
    "check_status": frozenset(
        {"passed", "failed", "warning", "skipped", "error"}
    ),
    "rollout_feature_key": frozenset(
        {
            "triag_hybrid",
            "knowledge_library",
            "repository_chat",
            "answer_guard",
        }
    ),
    "rollout_cohort": frozenset(
        {"disabled", "internal_accounts", "percentage", "all_eligible"}
    ),
}
_LIST_ENUM_VALUES: dict[str, frozenset[str]] = {
    "retrieval_sources": frozenset(
        {
            "history", "memory", "profile", "documents", "repository",
            "knowledge", "triplets", "hierarchy",
        }
    ),
    "planned_usage_stages": frozenset(
        {
            "embedding",
            "reservation",
            "generation",
            "verifier",
            "repair",
            "repository_validation",
            "settlement",
        }
    ),
    "attachment_media_categories": frozenset(
        {"text", "image", "audio", "video", "application", "other"}
    ),
    "reason_codes": frozenset(
        {
            "deterministic_swico_brand",
            "deterministic_greeting",
            "deterministic_thanks",
            "deterministic_capabilities",
            "safety_block",
            "unsupported_web_capability",
            "provider_contextual",
            "provider_standalone",
            "mode_off",
            "no_complete_history",
            "empty_message",
            "explicit_topic_reset",
            "always_last",
            "explicit_followup",
            "explicit_followup_not_detected",
            "referential_language",
            "elliptical_followup",
            "lexical_topic_overlap",
            "missing_application_subject",
            "clear_standalone_subject",
            "ambiguous_short_fallback",
            "self_contained_no_overlap",
            "continue_response",
            "standalone",
        }
    ),
    "status_codes": frozenset(
        {
            "lexical",
            "dense",
            "dense_unavailable",
            "embedding_budget_unavailable",
            "lexical_fallback",
            "upload_expired",
            "malformed_vector",
            "retrieval_timeout",
            "retrieval_unavailable",
            "owner_mismatch",
            "corrective_round",
            "repository_context_used",
            "knowledge_lexical",
            "knowledge_hybrid",
            "triplet",
            "hierarchy_raw_anchored",
        }
    ),
}


class UnsafeMetadataError(ValueError):
    pass


def _validate_semantic_value(key: str, value: object) -> None:
    if key == "policy_version":
        if not isinstance(value, str) or not re.fullmatch(
            r"v[1-9][0-9]{0,3}", value
        ):
            raise UnsafeMetadataError("policy_version is invalid")
    if key == "rollout_policy_version":
        if not isinstance(value, str) or not re.fullmatch(
            r"v[1-9][0-9]{0,3}", value
        ):
            raise UnsafeMetadataError("rollout_policy_version is invalid")
    allowed = _ENUM_VALUES.get(key)
    if allowed is not None and value not in allowed:
        raise UnsafeMetadataError(f"{key} contains a non-contract value")
    list_allowed = _LIST_ENUM_VALUES.get(key)
    if list_allowed is not None:
        if not isinstance(value, (tuple, list)) or any(
            not isinstance(item, str) or item not in list_allowed
            for item in value
        ):
            raise UnsafeMetadataError(f"{key} contains a non-contract value")


def _safe_value(value: object, *, depth: int) -> object:
    if depth > 3:
        raise UnsafeMetadataError("metadata nesting exceeds the safe bound")
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if len(value) > 256:
            raise UnsafeMetadataError("metadata string exceeds the safe bound")
        return value
    if isinstance(value, (tuple, list)):
        if len(value) > 24:
            raise UnsafeMetadataError("metadata list exceeds the safe bound")
        return [_safe_value(item, depth=depth + 1) for item in value]
    if isinstance(value, Mapping):
        return sanitize_metadata(value, _depth=depth + 1)
    raise UnsafeMetadataError("metadata contains an unsupported value")


def sanitize_metadata(
    metadata: Mapping[str, object], *, _depth: int = 0
) -> dict[str, object]:
    """Return allowlisted, bounded metadata or fail closed."""

    sanitized: dict[str, object] = {}
    for raw_key, raw_value in metadata.items():
        key = str(raw_key or "").strip()
        lowered = key.lower()
        if key not in _ALLOWED_KEYS:
            raise UnsafeMetadataError(f"metadata key is not allowlisted: {key}")
        if (
            key not in _ALLOWED_KEYS
            and any(part in lowered for part in _FORBIDDEN_KEY_PARTS)
        ):
            # Token *counts* are explicitly allowlisted and are safe; no token
            # strings or values can pass this branch.
            if not lowered.endswith("_tokens") and lowered != "max_output_tokens":
                raise UnsafeMetadataError(f"metadata key is unsafe: {key}")
        _validate_semantic_value(key, raw_value)
        sanitized[key] = _safe_value(raw_value, depth=_depth)
    encoded = json.dumps(sanitized, sort_keys=True, separators=(",", ":"))
    if len(encoded) > 8_192:
        raise UnsafeMetadataError("metadata exceeds the safe serialized bound")
    return sanitized


@dataclass(frozen=True)
class SafeMetadata:
    serialized_json: str

    @classmethod
    def from_mapping(cls, metadata: Mapping[str, object]) -> "SafeMetadata":
        safe = sanitize_metadata(metadata)
        return cls(
            json.dumps(safe, sort_keys=True, separators=(",", ":"))
        )

    def as_dict(self) -> dict[str, object]:
        value = json.loads(self.serialized_json)
        return value if isinstance(value, dict) else {}

    def to_json(self) -> str:
        return self.serialized_json
