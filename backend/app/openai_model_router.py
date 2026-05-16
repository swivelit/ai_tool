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

try:
    from config import OPENAI_MODEL as CONFIG_OPENAI_MODEL_DEFAULT
except Exception:  # pragma: no cover
    CONFIG_OPENAI_MODEL_DEFAULT = ""

logger = logging.getLogger(__name__)
_USAGE_SCHEMA_COMPAT_LOCK = threading.Lock()
_USAGE_SCHEMA_COMPAT_READY = False
OPENAI_SAFE_DEFAULT_MODEL = "gpt-4o-mini"


class OpenAIConfigurationError(RuntimeError):
    """Raised before provider calls when OpenAI runtime config is invalid."""

    status_code = 503


@dataclass(frozen=True)
class ModelSelection:
    model: str
    tier: str
    reason: str
    max_output_tokens: int
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
    standard_tier = "standard"
    reasoning_tier = "reasoning"
    high_tier = "high"

    def __init__(self) -> None:
        self._explicit_high_model = _env_str("OPENAI_MODEL_HIGH")
        self.models = {
            self.cheap_tier: self._resolve_model("OPENAI_MODEL_CHEAP"),
            self.standard_tier: self._resolve_model("OPENAI_MODEL_STANDARD"),
            self.reasoning_tier: self._resolve_model("OPENAI_MODEL_REASONING"),
            self.high_tier: self._resolve_model("OPENAI_MODEL_HIGH"),
        }
        self.disable_highest = _env_bool("OPENAI_DISABLE_HIGHEST_MODEL", True)
        self.daily_budget_usd = _env_float("OPENAI_DAILY_BUDGET_USD", 0.0)
        self.max_output_default = _env_int("OPENAI_MAX_OUTPUT_TOKENS_DEFAULT", 900, minimum=1)
        self.max_output_hard = _env_int("OPENAI_MAX_OUTPUT_TOKENS_HARD", 1600, minimum=1)
        self.high_allowlist = {
            item.strip().lower()
            for item in _env_str("OPENAI_HIGH_MODEL_ALLOWLIST", "").split(",")
            if item.strip()
        }

    @staticmethod
    def _resolve_model(tier_env_name: str) -> str:
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
        if re.search(r"\b(code|coding|program|debug|refactor|algorithm|architecture|multi[- ]?step|plan|strategy|analyze|tradeoff|design)\b", normalized):
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
        safe_model = str(model or "unknown").upper().replace("-", "_").replace(".", "_")
        input_rate = _env_float(f"OPENAI_PRICE_{safe_model}_INPUT_PER_1M", 0.15)
        output_rate = _env_float(f"OPENAI_PRICE_{safe_model}_OUTPUT_PER_1M", 0.60)
        return (max(0, input_tokens) / 1_000_000.0) * input_rate + (max(0, output_tokens) / 1_000_000.0) * output_rate


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
