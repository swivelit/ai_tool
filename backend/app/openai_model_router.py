from __future__ import annotations

import hashlib
import logging
import os
import re
import threading
from dataclasses import dataclass
from datetime import date, timezone
from typing import Any, Optional

from sqlalchemy import inspect, text
from sqlmodel import Session, select

from .models import OpenAIUsageLog
from .time_utils import utc_now
from .ai.openai_catalog import estimate_model_cost, get_model_spec, get_openai_model_catalog

try:
    from config import OPENAI_MODEL as CONFIG_OPENAI_MODEL_DEFAULT
except Exception:  # pragma: no cover
    CONFIG_OPENAI_MODEL_DEFAULT = ""

logger = logging.getLogger(__name__)
_USAGE_SCHEMA_COMPAT_LOCK = threading.Lock()
_USAGE_SCHEMA_COMPAT_READY = False
OPENAI_SAFE_DEFAULT_MODEL = "gpt-5-nano"


class OpenAIConfigurationError(RuntimeError):
    """Raised before provider calls when OpenAI runtime config is invalid."""

    status_code = 503


@dataclass(frozen=True)
class ModelSelection:
    model: str
    tier: str
    reason: str
    max_output_tokens: int
    endpoint: str = "chat_completions"
    estimated_input_tokens: int = 0
    estimated_output_tokens: int = 0
    estimated_cost_usd: float = 0.0


def _env_str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _first_non_empty(*values: Any) -> str:
    for value in values:
        normalized = str(value or "").strip()
        if normalized:
            return normalized
    return ""


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        parsed = int(str(os.getenv(name, default)).strip())
    except Exception:
        parsed = int(default)
    return max(minimum, parsed)


def _env_float(name: str, default: float, *, minimum: float = 0.0) -> float:
    try:
        parsed = float(str(os.getenv(name, default)).strip())
    except Exception:
        parsed = float(default)
    return max(minimum, parsed)


def stable_user_hash(user_id: Any) -> str:
    raw = str(user_id if user_id is not None else "guest").strip() or "guest"
    secret = (
        _env_str("GLOBAL_QA_USER_HASH_SECRET")
        or _env_str("SECRET_KEY")
        or _env_str("DOWNLOAD_TOKEN_SECRET")
        or "dev-global-qa-user-hash"
    )
    return hashlib.sha256(f"{secret}:{raw}".encode("utf-8")).hexdigest()


def _ensure_usage_schema_compat(session: Optional[Session]) -> None:
    global _USAGE_SCHEMA_COMPAT_READY
    if session is None or _USAGE_SCHEMA_COMPAT_READY:
        return
    with _USAGE_SCHEMA_COMPAT_LOCK:
        if _USAGE_SCHEMA_COMPAT_READY:
            return
        bind = session.get_bind()
        inspector = inspect(bind)
        if inspector.has_table("openai_usage_log"):
            columns = {column["name"] for column in inspector.get_columns("openai_usage_log")}
            if "actual_input_tokens" not in columns:
                session.exec(text("ALTER TABLE openai_usage_log ADD COLUMN actual_input_tokens INTEGER"))
            if "actual_output_tokens" not in columns:
                session.exec(text("ALTER TABLE openai_usage_log ADD COLUMN actual_output_tokens INTEGER"))
            if "actual_cost_usd" not in columns:
                session.exec(text("ALTER TABLE openai_usage_log ADD COLUMN actual_cost_usd FLOAT"))
            session.commit()
        _USAGE_SCHEMA_COMPAT_READY = True


class OpenAIModelRouter:
    """Cost-aware model selector.

    Business logic asks for a task class or supplies enough context for this
    router to classify it. The concrete model IDs are read from environment
    variables so application code does not hard-code model names.
    """

    cheap_tier = "cheap"
    cheap_fallback_tier = "cheap_fallback"
    standard_tier = "standard"
    reasoning_light_tier = "reasoning_light"
    reasoning_tier = "reasoning"
    hard_reasoning_tier = "hard_reasoning"
    high_tier = "high"

    def __init__(self) -> None:
        self._explicit_high_model = _env_str("OPENAI_MODEL_HIGH")
        self.catalog = get_openai_model_catalog()
        self.models = {
            self.cheap_tier: self._resolve_model("OPENAI_MODEL_CHEAP"),
            self.standard_tier: self._resolve_model("OPENAI_MODEL_STANDARD"),
            self.reasoning_tier: self._resolve_model("OPENAI_MODEL_REASONING"),
            self.high_tier: self._resolve_model("OPENAI_MODEL_HIGH"),
        }
        self.disable_highest = _env_bool("OPENAI_DISABLE_HIGHEST_MODEL", True)
        self.daily_budget_usd = _env_float("OPENAI_DAILY_BUDGET_USD", 0.0)
        self.max_output_default = _env_int("OPENAI_MAX_OUTPUT_TOKENS_DEFAULT", 450, minimum=1)
        self.max_output_hard = _env_int("OPENAI_MAX_OUTPUT_TOKENS_HARD", 900, minimum=1)
        self.high_allowlist = {
            item.strip().lower()
            for item in _env_str("OPENAI_HIGH_MODEL_ALLOWLIST", "").split(",")
            if item.strip()
        }
        self.disabled_models = {
            item.strip()
            for item in _env_str("OPENAI_DISABLED_MODELS", "").split(",")
            if item.strip()
        }

    @staticmethod
    def _resolve_model(tier_env_name: str) -> str:
        if tier_env_name == "OPENAI_MODEL_REASONING":
            model = _first_non_empty(
                _env_str(tier_env_name),
                "gpt-5-mini",
                _env_str("OPENAI_JSON_MODEL"),
                _env_str("OPENAI_MODEL"),
                CONFIG_OPENAI_MODEL_DEFAULT,
                OPENAI_SAFE_DEFAULT_MODEL,
            )
            if not model:
                raise OpenAIConfigurationError(
                    "OpenAI model is not configured. Set OPENAI_MODEL or OPENAI_JSON_MODEL."
                )
            return model
        model = _first_non_empty(
            _env_str(tier_env_name),
            _env_str("OPENAI_JSON_MODEL"),
            _env_str("OPENAI_MODEL"),
            CONFIG_OPENAI_MODEL_DEFAULT,
            OPENAI_SAFE_DEFAULT_MODEL,
        )
        if not model:
            raise OpenAIConfigurationError(
                "OpenAI model is not configured. Set OPENAI_MODEL or OPENAI_JSON_MODEL."
            )
        return model

    @staticmethod
    def estimate_tokens(text: Any) -> int:
        normalized = re.sub(r"\s+", " ", str(text or "")).strip()
        if not normalized:
            return 0
        return max(1, int(len(normalized) / 4))

    def classify_task(
        self,
        message: str,
        route: Optional[str] = None,
        risk_level: Optional[str] = None,
        needs_live_data: bool = False,
        token_estimate: Optional[int] = None,
    ) -> str:
        route_key = str(route or "").strip().lower()
        if route_key in {"classification", "routing", "json", "json_extraction", "rewrite", "translation", "review", "simple_fallback"}:
            return route_key
        if route_key in {"highest", "high"}:
            return route_key

        normalized = str(message or "").lower()
        estimated_tokens = token_estimate if token_estimate is not None else self.estimate_tokens(message)

        if needs_live_data or route_key in {"web_search", "weather"}:
            return "live_data"
        if str(risk_level or "").strip().lower() in {"high", "critical"}:
            return "high_risk_review"

        has_code_block = "```" in str(message or "")
        strong_coding = bool(
            has_code_block
            or re.search(
                r"\b(debug|stack trace|traceback|exception|error log|refactor|architecture|system design|"
                r"backend architecture|frontend architecture|react native bug|sql schema|schema migration|"
                r"api implementation|backend implementation|frontend implementation|implement (?:a|the)|"
                r"write (?:a|the)?\s*(?:function|class|component)|fix (?:this|the) bug)\b",
                normalized,
            )
        )
        if strong_coding:
            return "complex_reasoning"
        if re.search(r"\b(multi[- ]?step|trade[- ]?off|deep analysis|reason through|migration plan)\b", normalized):
            return "complex_reasoning"
        if estimated_tokens > 700 or len(normalized) > 2400:
            return "complex_reasoning"
        if re.search(r"\b(classify|route|extract|json|rewrite|translate|summari[sz]e)\b", normalized):
            return "simple_transform"
        return "normal_qa"

    def _tier_for_task(self, task: str) -> tuple[str, str]:
        task_key = str(task or "normal_qa").strip().lower()
        if task_key in {"classification", "routing", "json", "json_extraction", "rewrite", "translation", "review", "simple_fallback", "simple_transform"}:
            return self.cheap_tier, f"{task_key}_uses_cheap"
        if task_key in {"complex_reasoning", "coding", "complex_planning"}:
            return self.reasoning_tier, f"{task_key}_uses_reasoning"
        if task_key in {"highest", "high"}:
            return self.high_tier, "explicit_highest_task"
        if task_key == "high_risk_review":
            return self.reasoning_tier, "high_risk_uses_reasoning"
        if task_key == "live_data":
            return self.standard_tier, "live_data_uses_standard"
        return self.standard_tier if _env_bool("OPENAI_NORMAL_QA_USE_STANDARD", False) else self.cheap_tier, "normal_qa_cost_optimized"

    def select_candidates(
        self,
        task: str,
        message: str,
        route: Optional[Any] = None,
        risk_level: Optional[str] = None,
        needs_live_data: bool = False,
        user_tier: Optional[str] = None,
    ) -> list[ModelSelection]:
        route_key = self._route_key(route)
        task_key = str(task or "normal_qa").strip().lower()
        if task_key not in {"highest", "high", "hard_reasoning"}:
            task_key = self.classify_task(
                message,
                route=route_key or task,
                risk_level=risk_level,
                needs_live_data=needs_live_data,
            )

        if task_key in {"complex_reasoning", "coding", "complex_planning", "high_risk_review"}:
            names = self._reasoning_ladder(message)
            reason = f"{task_key}_uses_reasoning_ladder"
            ladder_kind = "reasoning"
        elif task_key in {"highest", "high", "hard_reasoning"}:
            names = self._hard_reasoning_ladder(user_tier=user_tier, route=route_key or task_key)
            reason = "hard_reasoning_ladder"
            ladder_kind = "hard_reasoning"
        elif task_key == "live_data":
            names = self._cheap_ladder()
            reason = "live_data_cost_guarded_ladder"
            ladder_kind = "cheap"
        else:
            names = self._cheap_ladder()
            reason = f"{task_key}_uses_cheap_ladder"
            ladder_kind = "cheap"

        input_tokens = self.estimate_tokens(message)
        output_tokens = min(self.max_output_default, self.max_output_hard)
        selections: list[ModelSelection] = []
        seen: set[str] = set()
        for index, model in enumerate(names):
            model = str(model or "").strip()
            if not model or model in seen:
                continue
            seen.add(model)
            if not self._model_allowed(model, user_tier=user_tier, task=task_key, route=route_key):
                continue
            spec = get_model_spec(model)
            tier = self._candidate_tier(model, index=index, ladder_kind=ladder_kind, message=message, spec_tier=spec.tier)
            selections.append(
                ModelSelection(
                    model=model,
                    tier=tier,
                    reason=reason if index == 0 else f"{reason}:candidate_{index}",
                    max_output_tokens=output_tokens,
                    endpoint=spec.endpoint,
                    estimated_input_tokens=input_tokens,
                    estimated_output_tokens=output_tokens,
                    estimated_cost_usd=self.estimate_cost(model, input_tokens, output_tokens),
                )
            )
        if selections:
            logger.info(
                "openai_model_ladder_selected",
                extra={
                    "event": "openai_model_ladder_selected",
                    "route": route_key,
                    "task": task_key,
                    "models": [selection.model for selection in selections],
                    "tiers": [selection.tier for selection in selections],
                },
            )
        return selections

    def _daily_budget_available(self) -> bool:
        # This is a conservative selector guard. Precise spend aggregation is
        # recorded in OpenAIUsageLog and can be enforced by a scheduler/report.
        return self.daily_budget_usd > 0.0

    def _highest_allowed(self, task: str, route: Optional[str]) -> bool:
        if self.disable_highest:
            return False
        if not self._explicit_high_model:
            return False
        if not self._daily_budget_available():
            return False
        task_key = str(task or "").strip().lower()
        route_key = str(route or "").strip().lower()
        return task_key in self.high_allowlist or route_key in self.high_allowlist

    def select_model(
        self,
        task: str,
        message: str,
        risk_level: Optional[str] = None,
        needs_live_data: bool = False,
        route: Optional[str] = None,
    ) -> ModelSelection:
        explicit_task = str(task or "").strip().lower()
        if explicit_task in {"highest", "high"}:
            task_key = explicit_task
        else:
            task_key = self.classify_task(
                message,
                route=route or task,
                risk_level=risk_level,
                needs_live_data=needs_live_data,
            )
        candidates = self.select_candidates(
            task_key,
            message,
            risk_level=risk_level,
            needs_live_data=needs_live_data,
            route=route,
        )
        if candidates:
            selected = candidates[0]
            logger.info(
                "openai_model_selected",
                extra={
                    "event": "openai_model_selected",
                    "model_used": selected.model,
                    "model_tier": selected.tier,
                    "reason": selected.reason,
                    "estimated_input_tokens": selected.estimated_input_tokens,
                    "estimated_output_tokens": selected.estimated_output_tokens,
                    "estimated_cost_usd": round(selected.estimated_cost_usd, 8),
                },
            )
            return selected

        tier, reason = self._tier_for_task(task_key)

        if tier == self.high_tier and not self._highest_allowed(task_key, route):
            tier = self.reasoning_tier
            reason = "highest_model_disabled_or_not_allowlisted"
        if tier == self.high_tier and self.disable_highest:
            tier = self.reasoning_tier
            reason = "highest_model_disabled"

        model = self.models.get(tier) or self.models.get(self.standard_tier) or self.models.get(self.cheap_tier)
        if not model:
            model = self._resolve_model("OPENAI_MODEL_STANDARD")
        if not model:
            raise OpenAIConfigurationError(
                "OpenAI model is not configured. Set OPENAI_MODEL or OPENAI_JSON_MODEL."
            )

        input_tokens = self.estimate_tokens(message)
        output_tokens = min(self.max_output_default, self.max_output_hard)
        cost = self.estimate_cost(model, input_tokens, output_tokens)
        selected = ModelSelection(
            model=model,
            tier=tier,
            reason=reason,
            max_output_tokens=output_tokens,
            endpoint=get_model_spec(model).endpoint,
            estimated_input_tokens=input_tokens,
            estimated_output_tokens=output_tokens,
            estimated_cost_usd=cost,
        )
        logger.info(
            "openai_model_selected",
            extra={
                "event": "openai_model_selected",
                "model_used": selected.model,
                "model_tier": selected.tier,
                "reason": selected.reason,
                "estimated_input_tokens": selected.estimated_input_tokens,
                "estimated_output_tokens": selected.estimated_output_tokens,
                "estimated_cost_usd": round(selected.estimated_cost_usd, 8),
            },
        )
        return selected

    def estimate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        return estimate_model_cost(model, input_tokens, output_tokens)

    def _cheap_ladder(self) -> list[str]:
        primary = _env_str("OPENAI_MODEL_CHEAP_PRIMARY", "") or _env_str("OPENAI_MODEL_CHEAP", "") or "gpt-5-nano"
        fallbacks = _env_str("OPENAI_MODEL_CHEAP_FALLBACKS", "gpt-4.1-nano,gpt-4o-mini")
        names = [primary, *self._split_models(fallbacks)]
        if _env_bool("OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK", False):
            names.append("gpt-3.5-turbo-0125")
        return names

    def _reasoning_ladder(self, message: str) -> list[str]:
        hard = self._is_hard_reasoning_message(message)
        if hard:
            primary = _env_str("OPENAI_MODEL_REASONING_PRIMARY", "") or _env_str("OPENAI_MODEL_REASONING", "") or "gpt-5-mini"
            fallbacks = _env_str("OPENAI_MODEL_REASONING_FALLBACKS", "gpt-4.1-mini,gpt-4o-mini")
            return [primary, *self._split_models(fallbacks)]
        primary = _env_str("OPENAI_MODEL_REASONING_LIGHT_PRIMARY", "gpt-4.1-mini")
        reasoning = _env_str("OPENAI_MODEL_REASONING_PRIMARY", "") or _env_str("OPENAI_MODEL_REASONING", "") or "gpt-5-mini"
        fallbacks = self._split_models(_env_str("OPENAI_MODEL_REASONING_FALLBACKS", "gpt-4.1-mini,gpt-4o-mini"))
        return [primary, reasoning, *fallbacks]

    def _hard_reasoning_ladder(self, *, user_tier: Optional[str], route: str = "") -> list[str]:
        names: list[str] = []
        if self._explicit_high_model and self._highest_allowed("highest", route or "highest"):
            names.append(self._explicit_high_model)
        if _env_bool("OPENAI_ENABLE_O_SERIES_FOR_FREE", False) or str(user_tier or "").lower() in {"admin", "internal"}:
            names.append(_env_str("OPENAI_MODEL_HARD_REASONING", "o4-mini"))
        names.extend(self._reasoning_ladder("architecture debug stack trace multi-step"))
        return names

    def _candidate_tier(
        self,
        model: str,
        *,
        index: int,
        ladder_kind: str,
        message: str,
        spec_tier: str,
    ) -> str:
        if model == self._explicit_high_model and self._explicit_high_model:
            return self.high_tier
        if ladder_kind == "cheap":
            return self.cheap_tier if index == 0 else self.cheap_fallback_tier
        if ladder_kind == "hard_reasoning":
            return self.hard_reasoning_tier if model == _env_str("OPENAI_MODEL_HARD_REASONING", "o4-mini") else self.reasoning_tier
        if ladder_kind == "reasoning":
            light_primary = _env_str("OPENAI_MODEL_REASONING_LIGHT_PRIMARY", "gpt-4.1-mini")
            if index == 0 and model == light_primary and not self._is_hard_reasoning_message(message):
                return self.reasoning_light_tier
            if spec_tier in {self.cheap_fallback_tier, self.cheap_tier} and index > 0:
                return spec_tier
            return self.reasoning_tier if spec_tier == "custom" else spec_tier
        return spec_tier

    def _model_allowed(self, model: str, *, user_tier: Optional[str], task: str, route: str) -> bool:
        normalized = str(model or "").strip()
        if not normalized:
            return False
        if normalized in self.disabled_models:
            return False
        lowered = normalized.lower()
        if re.search(r"^(gpt-5\.(?:5|4)|gpt-5-pro|gpt-5\.5-pro|o1-pro|o3-pro)", lowered):
            return False
        if lowered in {"babbage-002", "davinci-002"}:
            return False
        if lowered in {"gpt-5", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"} and self.disable_highest:
            return False
        if normalized == self._explicit_high_model and not self._highest_allowed(task, route):
            return False
        spec = get_model_spec(normalized)
        if not spec.enabled_by_default and normalized != self._explicit_high_model:
            return False
        tier = str(user_tier or "free").strip().lower()
        if tier not in {"admin", "internal"}:
            if spec.admin_only or not spec.free_user_allowed:
                return False
        return True

    @staticmethod
    def _is_hard_reasoning_message(message: str) -> bool:
        normalized = str(message or "").lower()
        return bool(
            "```" in str(message or "")
            or re.search(
                r"\b(debug|stack trace|traceback|architecture|system design|refactor|migration|"
                r"backend|frontend|react native|fastapi|sql|schema|implementation|multi[- ]?step)\b",
                normalized,
            )
        )

    @staticmethod
    def _split_models(raw: str) -> list[str]:
        return [item.strip() for item in str(raw or "").split(",") if item.strip()]

    @staticmethod
    def _route_key(route: Optional[Any]) -> str:
        if route is None:
            return ""
        return str(getattr(route, "route", route) or "").strip().lower()


def record_openai_usage(
    session: Optional[Session],
    *,
    user_id: Any = None,
    request_id: Optional[str] = None,
    route: str,
    selection: Optional[ModelSelection] = None,
    model_used: Optional[str] = None,
    model_tier: Optional[str] = None,
    reason: Optional[str] = None,
    estimated_input_tokens: int = 0,
    estimated_output_tokens: int = 0,
    estimated_cost_usd: float = 0.0,
    actual_input_tokens: Optional[int] = None,
    actual_output_tokens: Optional[int] = None,
    actual_cost_usd: Optional[float] = None,
    cache_hit: bool = False,
) -> Optional[OpenAIUsageLog]:
    model = str(model_used or (selection.model if selection is not None else "") or "").strip()
    tier = str(model_tier or (selection.tier if selection is not None else "") or "").strip()
    if not session or not model or not tier:
        return None
    _ensure_usage_schema_compat(session)
    row = OpenAIUsageLog(
        request_id=request_id,
        user_id_hash=stable_user_hash(user_id) if user_id is not None else None,
        route=str(route or "unknown"),
        model_used=model,
        model_tier=tier,
        reason=str(reason or (selection.reason if selection is not None else "") or ""),
        estimated_input_tokens=int(estimated_input_tokens or (selection.estimated_input_tokens if selection is not None else 0) or 0),
        estimated_output_tokens=int(estimated_output_tokens or (selection.estimated_output_tokens if selection is not None else 0) or 0),
        estimated_cost_usd=float(estimated_cost_usd or (selection.estimated_cost_usd if selection is not None else 0.0) or 0.0),
        actual_input_tokens=int(actual_input_tokens) if actual_input_tokens is not None else None,
        actual_output_tokens=int(actual_output_tokens) if actual_output_tokens is not None else None,
        actual_cost_usd=float(actual_cost_usd) if actual_cost_usd is not None else None,
        cache_hit=bool(cache_hit),
        created_at=utc_now(),
    )
    try:
        session.add(row)
        session.commit()
        session.refresh(row)
    except Exception:
        session.rollback()
        logger.exception("Failed to record OpenAI usage")
        return None
    return row


def get_today_estimated_openai_spend(session: Session) -> float:
    _ensure_usage_schema_compat(session)
    now = utc_now()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    else:
        now = now.astimezone(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = now.replace(hour=23, minute=59, second=59, microsecond=999999)
    rows = session.exec(
        select(OpenAIUsageLog).where(
            OpenAIUsageLog.created_at >= start,
            OpenAIUsageLog.created_at <= end,
        )
    ).all()
    return float(
        sum(
            float(row.actual_cost_usd if row.actual_cost_usd is not None else row.estimated_cost_usd or 0.0)
            for row in rows
        )
    )


def today_budget_key() -> str:
    return date.today().isoformat()
