from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import Enum
from hashlib import sha256
import os
import re

from .settings import TriagSettings
from .telemetry.metadata import sanitize_metadata


_POLICY_VERSION = re.compile(r"^v[1-9][0-9]{0,3}$")
_FEATURE_KEYS = (
    "triag_hybrid",
    "knowledge_library",
    "repository_chat",
    "answer_guard",
)


class RolloutConfigurationError(RuntimeError):
    """Configuration failure containing variable names, never their values."""

    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__("Invalid web rollout configuration: " + "; ".join(errors))


class TriagReleaseConfigurationError(RuntimeError):
    """Release-state failure containing the variable name, never its value."""

    def __init__(self) -> None:
        super().__init__(
            "Invalid TRIAG release configuration: "
            "WEB_TRIAG_RELEASE_STATE must be controlled or general_availability"
        )


class RolloutMode(str, Enum):
    DISABLED = "disabled"
    INTERNAL_ACCOUNTS = "internal_accounts"
    PERCENTAGE = "percentage"
    ALL_ELIGIBLE = "all_eligible"


class RolloutExecution(str, Enum):
    FALLBACK = "fallback"
    SHADOW = "shadow"
    LIVE = "live"


class TriagReleaseState(str, Enum):
    CONTROLLED = "controlled"
    GENERAL_AVAILABILITY = "general_availability"

    @classmethod
    def from_environ(
        cls, environ: Mapping[str, str] | None = None
    ) -> "TriagReleaseState":
        env = os.environ if environ is None else environ
        raw = str(
            env.get("WEB_TRIAG_RELEASE_STATE", cls.CONTROLLED.value) or ""
        ).strip()
        try:
            return cls(raw)
        except ValueError as exc:
            raise TriagReleaseConfigurationError() from exc


@dataclass(frozen=True)
class FeatureRolloutPolicy:
    feature_key: str
    mode: RolloutMode
    percentage: int = 0

    def __post_init__(self) -> None:
        if self.feature_key not in _FEATURE_KEYS:
            raise ValueError("unsupported rollout feature key")
        if self.percentage < 0 or self.percentage > 100:
            raise ValueError("rollout percentage is outside supported bounds")


@dataclass(frozen=True)
class WebRolloutPolicy:
    policy_version: str
    triag_hybrid: FeatureRolloutPolicy
    knowledge_library: FeatureRolloutPolicy
    repository_chat: FeatureRolloutPolicy
    answer_guard: FeatureRolloutPolicy

    @classmethod
    def from_environ(
        cls, environ: Mapping[str, str] | None = None
    ) -> "WebRolloutPolicy":
        env = os.environ if environ is None else environ
        errors: list[str] = []
        version = str(
            env.get("WEB_ROLLOUT_POLICY_VERSION", "v1") or ""
        ).strip()
        if not _POLICY_VERSION.fullmatch(version):
            errors.append(
                "WEB_ROLLOUT_POLICY_VERSION must be a bounded version id"
            )

        def feature(
            key: str, mode_name: str, percentage_name: str
        ) -> FeatureRolloutPolicy:
            raw_mode = str(env.get(mode_name, "disabled") or "").strip()
            try:
                mode = RolloutMode(raw_mode)
            except ValueError:
                errors.append(
                    f"{mode_name} must be disabled, internal_accounts, "
                    "percentage, or all_eligible"
                )
                mode = RolloutMode.DISABLED
            try:
                percentage = int(
                    str(env.get(percentage_name, "0") or "").strip()
                )
            except (TypeError, ValueError):
                errors.append(f"{percentage_name} must be an integer")
                percentage = 0
            if percentage < 0 or percentage > 100:
                errors.append(
                    f"{percentage_name} is outside supported bounds"
                )
                percentage = 0
            if mode != RolloutMode.PERCENTAGE and percentage != 0:
                errors.append(
                    f"{percentage_name} must be 0 unless {mode_name} is percentage"
                )
            return FeatureRolloutPolicy(key, mode, percentage)

        triag = feature(
            "triag_hybrid",
            "WEB_ROLLOUT_TRIAG_MODE",
            "WEB_ROLLOUT_TRIAG_PERCENT",
        )
        knowledge = feature(
            "knowledge_library",
            "WEB_ROLLOUT_KNOWLEDGE_MODE",
            "WEB_ROLLOUT_KNOWLEDGE_PERCENT",
        )
        repository = feature(
            "repository_chat",
            "WEB_ROLLOUT_REPOSITORY_MODE",
            "WEB_ROLLOUT_REPOSITORY_PERCENT",
        )
        answer = feature(
            "answer_guard",
            "WEB_ROLLOUT_ANSWER_GUARD_MODE",
            "WEB_ROLLOUT_ANSWER_GUARD_PERCENT",
        )
        if errors:
            raise RolloutConfigurationError(errors)
        return cls(version, triag, knowledge, repository, answer)

    @property
    def features(self) -> tuple[FeatureRolloutPolicy, ...]:
        return (
            self.triag_hybrid,
            self.knowledge_library,
            self.repository_chat,
            self.answer_guard,
        )


@dataclass(frozen=True)
class RolloutGlobalFlags:
    triag_hybrid: bool
    knowledge_library: bool
    repository_chat: bool
    answer_guard: bool
    triag_shadow: bool = False

    @classmethod
    def from_settings(cls, settings: TriagSettings) -> "RolloutGlobalFlags":
        return cls(
            triag_hybrid=(
                settings.shadow_planning_enabled
                or settings.hybrid_runtime_enabled
            ),
            knowledge_library=settings.persistent_knowledge_runtime_enabled,
            repository_chat=settings.repository_chat_runtime_enabled,
            answer_guard=(
                settings.answer_guard_runtime_enabled
                and settings.verified_streaming_runtime_enabled
            ),
            triag_shadow=settings.shadow_planning_enabled,
        )

    def enabled(self, feature_key: str) -> bool:
        return bool(getattr(self, feature_key))


@dataclass(frozen=True)
class FeatureRolloutDecision:
    feature_key: str
    cohort: RolloutMode
    policy_version: str
    enabled: bool

    @property
    def safe_metadata(self) -> dict[str, object]:
        return sanitize_metadata({
            "rollout_feature_key": self.feature_key,
            "rollout_cohort": self.cohort.value,
            "rollout_policy_version": self.policy_version,
            "rollout_enabled": self.enabled,
        })


@dataclass(frozen=True)
class WebRolloutDecision:
    policy_version: str
    triag_hybrid: FeatureRolloutDecision
    knowledge_library: FeatureRolloutDecision
    repository_chat: FeatureRolloutDecision
    answer_guard: FeatureRolloutDecision
    execution: RolloutExecution = RolloutExecution.FALLBACK
    release_state: TriagReleaseState = TriagReleaseState.CONTROLLED

    @property
    def features(self) -> tuple[FeatureRolloutDecision, ...]:
        return (
            self.triag_hybrid,
            self.knowledge_library,
            self.repository_chat,
            self.answer_guard,
        )

    @property
    def any_enabled(self) -> bool:
        return any(item.enabled for item in self.features)

    @property
    def safe_metadata(self) -> dict[str, object]:
        return sanitize_metadata({
            "rollout_execution": self.execution.value,
            "rollout_release_state": self.release_state.value,
            "rollout_decisions": [
                item.safe_metadata for item in self.features
            ]
        })


def _percentage_enabled(
    *, owner_user_id: int, feature_key: str, policy_version: str, percentage: int
) -> bool:
    if percentage <= 0:
        return False
    if percentage >= 100:
        return True
    digest = sha256(
        f"{int(owner_user_id)}:{feature_key}:{policy_version}".encode("ascii")
    ).digest()
    bucket = int.from_bytes(digest[:8], "big") % 10_000
    return bucket < percentage * 100


def resolve_rollout_decision(
    policy: WebRolloutPolicy,
    *,
    owner_user_id: int,
    internal_account: bool,
    global_flags: RolloutGlobalFlags,
    release_state: TriagReleaseState = TriagReleaseState.CONTROLLED,
) -> WebRolloutDecision:
    if int(owner_user_id) <= 0:
        raise ValueError("owner_user_id must be positive")

    def resolve(item: FeatureRolloutPolicy) -> FeatureRolloutDecision:
        cohort_enabled = False
        if item.mode == RolloutMode.INTERNAL_ACCOUNTS:
            cohort_enabled = bool(internal_account)
        elif item.mode == RolloutMode.PERCENTAGE:
            cohort_enabled = _percentage_enabled(
                owner_user_id=owner_user_id,
                feature_key=item.feature_key,
                policy_version=policy.policy_version,
                percentage=item.percentage,
            )
        elif item.mode == RolloutMode.ALL_ELIGIBLE:
            cohort_enabled = True
        return FeatureRolloutDecision(
            feature_key=item.feature_key,
            cohort=item.mode,
            policy_version=policy.policy_version,
            enabled=bool(
                global_flags.enabled(item.feature_key) and cohort_enabled
            ),
        )

    decisions = {item.feature_key: resolve(item) for item in policy.features}
    execution = RolloutExecution.FALLBACK
    if any(item.enabled for item in decisions.values()):
        execution = (
            RolloutExecution.SHADOW
            if global_flags.triag_shadow
            and decisions["triag_hybrid"].enabled
            and not any(
                decisions[key].enabled
                for key in (
                    "knowledge_library",
                    "repository_chat",
                    "answer_guard",
                )
            )
            else RolloutExecution.LIVE
        )
    return WebRolloutDecision(
        policy_version=policy.policy_version,
        triag_hybrid=decisions["triag_hybrid"],
        knowledge_library=decisions["knowledge_library"],
        repository_chat=decisions["repository_chat"],
        answer_guard=decisions["answer_guard"],
        execution=execution,
        release_state=release_state,
    )


def effective_triag_settings(
    settings: TriagSettings, decision: WebRolloutDecision
) -> TriagSettings:
    """Apply request-cohort gates without weakening any global kill switch."""

    triag = decision.triag_hybrid.enabled
    knowledge = decision.knowledge_library.enabled
    repository = decision.repository_chat.enabled
    answer = decision.answer_guard.enabled
    any_runtime = triag or knowledge or repository or answer
    return replace(
        settings,
        enabled=settings.enabled and any_runtime,
        rag_hybrid_enabled=settings.rag_hybrid_enabled and triag,
        rag_dense_enabled=settings.rag_dense_enabled and triag,
        retrieval_evaluator_enabled=(
            settings.retrieval_evaluator_enabled and triag
        ),
        persistent_knowledge_enabled=(
            settings.persistent_knowledge_enabled and knowledge
        ),
        rag_triplet_enabled=settings.rag_triplet_enabled and knowledge,
        rag_hierarchy_enabled=settings.rag_hierarchy_enabled and knowledge,
        repository_upload_enabled=(
            settings.repository_upload_enabled and repository
        ),
        repository_index_enabled=(
            settings.repository_index_enabled and repository
        ),
        pro_code_validation_enabled=(
            settings.pro_code_validation_enabled and repository and answer
        ),
        answer_guard_enabled=settings.answer_guard_enabled and answer,
        verified_streaming_enabled=(
            settings.verified_streaming_enabled and answer
        ),
        model_claim_verifier_enabled=(
            settings.model_claim_verifier_enabled and answer
        ),
        answer_repair_enabled=settings.answer_repair_enabled and answer,
    )
