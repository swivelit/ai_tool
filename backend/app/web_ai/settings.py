from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os
import re
from urllib.parse import urlsplit

from .tier_policy import validated_tier_policies


_TRUE = {"1", "true", "yes", "y", "on"}
_FALSE = {"0", "false", "no", "n", "off"}
_POLICY_VERSION = re.compile(r"^v[1-9][0-9]{0,3}$")


class TriagConfigurationError(RuntimeError):
    """Configuration failure containing variable names, never their values."""

    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__("Invalid TRIAG configuration: " + "; ".join(errors))


def _parse_bool(
    environ: Mapping[str, str], name: str, default: bool, errors: list[str]
) -> bool:
    raw = str(
        environ.get(name, "true" if default else "false") or ""
    ).strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    errors.append(f"{name} must be a boolean")
    return default


def _parse_int(
    environ: Mapping[str, str],
    name: str,
    default: int,
    errors: list[str],
    *,
    minimum: int,
    maximum: int,
) -> int:
    try:
        value = int(str(environ.get(name, default)).strip())
    except (TypeError, ValueError):
        errors.append(f"{name} must be an integer")
        return default
    if value < minimum or value > maximum:
        errors.append(f"{name} is outside supported bounds")
        return default
    return value


@dataclass(frozen=True)
class TriagSettings:
    enabled: bool = False
    shadow_mode: bool = True
    policy_version: str = "v1"
    rag_hybrid_enabled: bool = False
    rag_dense_enabled: bool = False
    retrieval_evaluator_enabled: bool = False
    max_corrective_rounds: int = 1
    query_embedding_cache_ttl_seconds: int = 86_400
    embedding_model: str = "text-embedding-3-small"
    embedding_dimensions: int = 1_536
    answer_guard_enabled: bool = False
    verified_streaming_enabled: bool = False
    model_claim_verifier_enabled: bool = False
    answer_repair_enabled: bool = False
    verified_buffer_max_characters: int = 200_000
    repository_upload_enabled: bool = False
    repository_ttl_seconds: int = 3_600
    repository_max_archive_bytes: int = 26_214_400
    repository_max_uncompressed_bytes: int = 104_857_600
    repository_max_files: int = 5_000
    repository_max_compression_ratio: int = 100
    repository_index_enabled: bool = False
    pro_code_validation_enabled: bool = False
    code_validator_url: str = ""
    code_validator_auth_token: str = ""
    code_validator_timeout_seconds: int = 90

    @classmethod
    def from_environ(
        cls, environ: Mapping[str, str] | None = None
    ) -> "TriagSettings":
        env = os.environ if environ is None else environ
        errors: list[str] = []
        enabled = _parse_bool(env, "WEB_TRIAG_ENABLED", False, errors)
        shadow = _parse_bool(env, "WEB_TRIAG_SHADOW_MODE", True, errors)
        hybrid = _parse_bool(env, "WEB_RAG_HYBRID_ENABLED", False, errors)
        dense = _parse_bool(env, "WEB_RAG_DENSE_ENABLED", False, errors)
        evaluator = _parse_bool(
            env, "WEB_RAG_RETRIEVAL_EVALUATOR_ENABLED", False, errors
        )
        answer_guard = _parse_bool(
            env, "WEB_ANSWER_GUARD_ENABLED", False, errors
        )
        verified_streaming = _parse_bool(
            env, "WEB_VERIFIED_STREAMING_ENABLED", False, errors
        )
        model_verifier = _parse_bool(
            env, "WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED", False, errors
        )
        answer_repair = _parse_bool(
            env, "WEB_ANSWER_GUARD_REPAIR_ENABLED", False, errors
        )
        repository_upload = _parse_bool(
            env, "WEB_REPOSITORY_UPLOAD_ENABLED", False, errors
        )
        repository_index = _parse_bool(
            env, "WEB_RAG_REPOSITORY_INDEX_ENABLED", False, errors
        )
        code_validation = _parse_bool(
            env, "WEB_PRO_CODE_VALIDATION_ENABLED", False, errors
        )
        verified_buffer_max = _parse_int(
            env,
            "WEB_ANSWER_GUARD_MAX_BUFFER_CHARACTERS",
            200_000,
            errors,
            minimum=1_000,
            maximum=1_000_000,
        )
        max_corrective_rounds = _parse_int(
            env,
            "WEB_RAG_MAX_CORRECTIVE_ROUNDS",
            1,
            errors,
            minimum=0,
            maximum=1,
        )
        query_cache_ttl = _parse_int(
            env,
            "WEB_RAG_QUERY_EMBEDDING_CACHE_TTL_SECONDS",
            86_400,
            errors,
            minimum=60,
            maximum=604_800,
        )
        embedding_dimensions = _parse_int(
            env,
            "WEB_RAG_EMBEDDING_DIMENSIONS",
            1_536,
            errors,
            minimum=64,
            maximum=8_192,
        )
        repository_ttl = _parse_int(
            env, "WEB_REPOSITORY_TTL_SECONDS", 3_600, errors,
            minimum=300, maximum=86_400,
        )
        repository_archive_bytes = _parse_int(
            env, "WEB_REPOSITORY_MAX_ARCHIVE_BYTES", 26_214_400, errors,
            minimum=1_048_576, maximum=104_857_600,
        )
        repository_uncompressed_bytes = _parse_int(
            env, "WEB_REPOSITORY_MAX_UNCOMPRESSED_BYTES", 104_857_600, errors,
            minimum=1_048_576, maximum=536_870_912,
        )
        repository_max_files = _parse_int(
            env, "WEB_REPOSITORY_MAX_FILES", 5_000, errors,
            minimum=1, maximum=20_000,
        )
        repository_max_ratio = _parse_int(
            env, "WEB_REPOSITORY_MAX_COMPRESSION_RATIO", 100, errors,
            minimum=2, maximum=1_000,
        )
        validator_timeout = _parse_int(
            env, "WEB_CODE_VALIDATOR_TIMEOUT_SECONDS", 90, errors,
            minimum=1, maximum=300,
        )
        validator_url = str(env.get("WEB_CODE_VALIDATOR_URL", "") or "").strip()
        validator_token = str(
            env.get("WEB_CODE_VALIDATOR_AUTH_TOKEN", "") or ""
        ).strip()
        if validator_url and not (
            validator_url.startswith("https://")
            or validator_url.startswith("http://")
        ):
            errors.append("WEB_CODE_VALIDATOR_URL must be an HTTP(S) URL")
        if validator_url:
            parsed_validator_url = urlsplit(validator_url)
            if (
                not parsed_validator_url.hostname
                or parsed_validator_url.username
                or parsed_validator_url.password
                or parsed_validator_url.query
                or parsed_validator_url.fragment
            ):
                errors.append(
                    "WEB_CODE_VALIDATOR_URL must be a host-only service URL"
                )
        if len(validator_url) > 512:
            errors.append("WEB_CODE_VALIDATOR_URL exceeds supported bounds")
        if validator_token and not 32 <= len(validator_token) <= 512:
            errors.append(
                "WEB_CODE_VALIDATOR_AUTH_TOKEN must be a bounded service token"
            )
        if code_validation and (not validator_url or not validator_token):
            errors.append(
                "WEB_PRO_CODE_VALIDATION_ENABLED requires validator URL and token"
            )
        if repository_uncompressed_bytes < repository_archive_bytes:
            errors.append(
                "WEB_REPOSITORY_MAX_UNCOMPRESSED_BYTES must not be smaller than "
                "WEB_REPOSITORY_MAX_ARCHIVE_BYTES"
            )
        embedding_model = str(
            env.get("WEB_RAG_EMBEDDING_MODEL", "text-embedding-3-small") or ""
        ).strip()
        if not embedding_model or len(embedding_model) > 128:
            errors.append("WEB_RAG_EMBEDDING_MODEL must be a bounded model id")
        policy_version = str(
            env.get("WEB_TRIAG_POLICY_VERSION", "v1") or ""
        ).strip()
        if not _POLICY_VERSION.fullmatch(policy_version):
            errors.append("WEB_TRIAG_POLICY_VERSION must be a bounded version id")
        try:
            validated_tier_policies(env)
        except ValueError:
            errors.append("TRIAG tier-policy defaults are invalid")
        if errors:
            raise TriagConfigurationError(errors)
        return cls(
            enabled=enabled,
            shadow_mode=shadow,
            policy_version=policy_version,
            rag_hybrid_enabled=hybrid,
            rag_dense_enabled=dense,
            retrieval_evaluator_enabled=evaluator,
            max_corrective_rounds=max_corrective_rounds,
            query_embedding_cache_ttl_seconds=query_cache_ttl,
            embedding_model=embedding_model,
            embedding_dimensions=embedding_dimensions,
            answer_guard_enabled=answer_guard,
            verified_streaming_enabled=verified_streaming,
            model_claim_verifier_enabled=model_verifier,
            answer_repair_enabled=answer_repair,
            verified_buffer_max_characters=verified_buffer_max,
            repository_upload_enabled=repository_upload,
            repository_ttl_seconds=repository_ttl,
            repository_max_archive_bytes=repository_archive_bytes,
            repository_max_uncompressed_bytes=repository_uncompressed_bytes,
            repository_max_files=repository_max_files,
            repository_max_compression_ratio=repository_max_ratio,
            repository_index_enabled=repository_index,
            pro_code_validation_enabled=code_validation,
            code_validator_url=validator_url,
            code_validator_auth_token=validator_token,
            code_validator_timeout_seconds=validator_timeout,
        )

    @property
    def shadow_planning_enabled(self) -> bool:
        return self.enabled and self.shadow_mode

    @property
    def hybrid_runtime_enabled(self) -> bool:
        return self.enabled and not self.shadow_mode and self.rag_hybrid_enabled

    @property
    def dense_runtime_enabled(self) -> bool:
        return self.hybrid_runtime_enabled and self.rag_dense_enabled

    @property
    def answer_guard_runtime_enabled(self) -> bool:
        return self.enabled and not self.shadow_mode and self.answer_guard_enabled

    @property
    def verified_streaming_runtime_enabled(self) -> bool:
        return (
            self.answer_guard_runtime_enabled
            and self.verified_streaming_enabled
        )

    @property
    def repository_runtime_enabled(self) -> bool:
        return (
            self.enabled
            and not self.shadow_mode
            and self.repository_upload_enabled
            and self.repository_index_enabled
        )

    @property
    def repository_chat_runtime_enabled(self) -> bool:
        return (
            self.repository_runtime_enabled
            and self.answer_guard_runtime_enabled
            and self.verified_streaming_runtime_enabled
        )

    @property
    def code_validation_runtime_enabled(self) -> bool:
        return (
            self.repository_chat_runtime_enabled
            and self.pro_code_validation_enabled
            and bool(self.code_validator_url and self.code_validator_auth_token)
        )

    @property
    def runtime_status(self) -> dict[str, object]:
        if not self.enabled:
            status = "disabled"
        elif self.shadow_mode:
            status = "shadow"
        elif self.rag_hybrid_enabled:
            status = "hybrid"
        else:
            status = "configured_inactive"
        return {
            "status": status,
            "enabled": self.enabled,
            "shadow_mode": self.shadow_mode,
            "policy_version": self.policy_version,
            "hybrid_retrieval": (
                "enabled" if self.hybrid_runtime_enabled else "disabled"
            ),
            "dense_retrieval": (
                "enabled" if self.dense_runtime_enabled else "disabled"
            ),
            "retrieval_evaluator": (
                "enabled"
                if self.hybrid_runtime_enabled
                and self.retrieval_evaluator_enabled
                else "disabled"
            ),
            "answer_guard": (
                "enabled" if self.answer_guard_runtime_enabled else "disabled"
            ),
            "verified_streaming": (
                "enabled"
                if self.verified_streaming_runtime_enabled
                else "disabled"
            ),
            "model_claim_verifier": (
                "enabled"
                if self.answer_guard_runtime_enabled
                and self.model_claim_verifier_enabled
                else "disabled"
            ),
            "answer_repair": (
                "enabled"
                if self.answer_guard_runtime_enabled
                and self.answer_repair_enabled
                else "disabled"
            ),
            "repository_upload": (
                "enabled" if self.repository_upload_enabled else "disabled"
            ),
            "repository_index": (
                "enabled" if self.repository_runtime_enabled else "disabled"
            ),
            "repository_chat": (
                "enabled"
                if self.repository_chat_runtime_enabled else "disabled"
            ),
            "repository_validation": (
                "enabled" if self.code_validation_runtime_enabled else "disabled"
            ),
        }
