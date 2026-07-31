from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import ceil
import json
import os
import re
from typing import Literal

from sqlmodel import Session, select

from ..models import (
    UsageCharge,
    WebAnswerCheck,
    WebChatMessage,
    WebMessageFeedback,
    WebRetrievalTrace,
    WebUsageStage,
)
from ..time_utils import utc_now


_FEATURE_KEYS = frozenset({
    "triag_hybrid",
    "knowledge_library",
    "repository_chat",
    "answer_guard",
})
_COHORTS = frozenset({
    "disabled",
    "internal_accounts",
    "percentage",
    "all_eligible",
})
_EXECUTIONS = frozenset({"fallback", "shadow", "live"})
_TIERS = frozenset({"lite", "standard", "pro"})
_RETRIEVAL_STATUSES = frozenset({
    "sufficient",
    "ambiguous",
    "insufficient",
    "contradictory",
})
_QUALITY_STATUSES = frozenset({
    "verified",
    "grounded",
    "best_effort",
    "unverified",
    "insufficient_evidence",
})
_ROLLOUT_KEYS = frozenset({
    "rollout_feature_key",
    "rollout_cohort",
    "rollout_policy_version",
    "rollout_enabled",
})
_VERSION = re.compile(r"^v[1-9][0-9]{0,3}$")
_PROVIDER_STAGES = frozenset({
    "embedding",
    "generation",
    "verifier",
    "repair",
    "knowledge_embedding",
    "knowledge_triplet_extract",
})

GateStatus = Literal["pass", "warning", "fail", "insufficient_sample"]


class RolloutReportConfigurationError(RuntimeError):
    """Configuration failure that reports variable names, never their values."""

    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__(
            "Invalid rollout report configuration: " + "; ".join(errors)
        )


@dataclass(frozen=True)
class RolloutReportSettings:
    enabled: bool = False
    default_window_hours: int = 24
    max_window_hours: int = 168
    acceptance_min_sample: int = 20

    @classmethod
    def from_environ(
        cls, environ: Mapping[str, str] | None = None
    ) -> "RolloutReportSettings":
        env = os.environ if environ is None else environ
        errors: list[str] = []
        raw_enabled = str(
            env.get("WEB_TRIAG_ROLLOUT_REPORT_ENABLED", "false") or ""
        ).strip().lower()
        if raw_enabled in {"1", "true", "yes", "y", "on"}:
            enabled = True
        elif raw_enabled in {"0", "false", "no", "n", "off"}:
            enabled = False
        else:
            enabled = False
            errors.append(
                "WEB_TRIAG_ROLLOUT_REPORT_ENABLED must be a boolean"
            )

        def bounded(
            name: str, default: int, minimum: int, maximum: int
        ) -> int:
            try:
                value = int(str(env.get(name, default)).strip())
            except (TypeError, ValueError):
                errors.append(f"{name} must be an integer")
                return default
            if value < minimum or value > maximum:
                errors.append(f"{name} is outside supported bounds")
                return default
            return value

        default_window = bounded(
            "WEB_TRIAG_ROLLOUT_REPORT_DEFAULT_WINDOW_HOURS",
            24,
            1,
            168,
        )
        max_window = bounded(
            "WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS",
            168,
            1,
            720,
        )
        min_sample = bounded(
            "WEB_TRIAG_ROLLOUT_ACCEPTANCE_MIN_SAMPLE",
            20,
            1,
            10_000,
        )
        if default_window > max_window:
            errors.append(
                "WEB_TRIAG_ROLLOUT_REPORT_DEFAULT_WINDOW_HOURS must not "
                "exceed WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS"
            )
        if errors:
            raise RolloutReportConfigurationError(errors)
        return cls(enabled, default_window, max_window, min_sample)


@dataclass(frozen=True, order=True)
class RolloutGroupKey:
    policy_version: str
    feature_key: str
    cohort: str
    execution: str
    swico_tier: str


@dataclass(frozen=True)
class AcceptanceGateResult:
    gate: str
    status: GateStatus
    observed: int | float
    threshold: str

    def as_dict(self) -> dict[str, object]:
        return {
            "gate": self.gate,
            "status": self.status,
            "observed": self.observed,
            "threshold": self.threshold,
        }


def _safe_json(raw: str | None) -> dict[str, object]:
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _bounded_nonnegative(value: object, maximum: int = 2_147_483_647) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return min(maximum, max(0, parsed))


def _rate(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator > 0 else 0.0


def _percentile(values: Sequence[int], percentile: float) -> int:
    if not values:
        return 0
    ordered = sorted(max(0, int(value)) for value in values)
    index = max(0, ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def _rollout_records(
    raw_metadata: str | None,
) -> tuple[list[tuple[str, str, str, bool]], str, int]:
    metadata = _safe_json(raw_metadata)
    raw_records = metadata.get("rollout_decisions")
    if not isinstance(raw_records, list):
        return [], "fallback", 0
    records: list[tuple[str, str, str, bool]] = []
    violations = 0
    for value in raw_records[:8]:
        if not isinstance(value, dict):
            violations += 1
            continue
        feature = value.get("rollout_feature_key")
        cohort = value.get("rollout_cohort")
        version = value.get("rollout_policy_version")
        enabled = value.get("rollout_enabled")
        valid = (
            isinstance(feature, str)
            and feature in _FEATURE_KEYS
            and isinstance(cohort, str)
            and cohort in _COHORTS
            and isinstance(version, str)
            and bool(_VERSION.fullmatch(version))
            and isinstance(enabled, bool)
        )
        if not valid:
            violations += 1
            continue
        if set(value) != _ROLLOUT_KEYS:
            violations += 1
        records.append((version, feature, cohort, enabled))
    if len(raw_records) > 8:
        violations += 1
    raw_execution = metadata.get("rollout_execution")
    if isinstance(raw_execution, str) and raw_execution in _EXECUTIONS:
        execution = str(raw_execution)
    else:
        # Telemetry predating this field could not reach shadow through the
        # rollout resolver, so its bounded classification is deterministic.
        execution = (
            "live" if any(record[3] for record in records) else "fallback"
        )
        if raw_execution is not None:
            violations += 1
    return records, execution, violations


def _gate(
    name: str,
    *,
    observed: int | float,
    threshold: str,
    status: GateStatus,
) -> AcceptanceGateResult:
    return AcceptanceGateResult(name, status, observed, threshold)


def evaluate_acceptance_gates(
    metrics: Mapping[str, object], *, min_sample: int
) -> tuple[AcceptanceGateResult, ...]:
    total = _bounded_nonnegative(metrics.get("total_eligible_requests"))
    failures = _bounded_nonnegative(metrics.get("failure_count"))
    cancellations = _bounded_nonnegative(metrics.get("cancellation_count"))
    cancellation_failures = _bounded_nonnegative(
        metrics.get("cancellation_failure_count")
    )
    privacy_violations = _bounded_nonnegative(
        metrics.get("privacy_violation_count")
    )
    owner_mismatches = _bounded_nonnegative(
        metrics.get("owner_isolation_mismatch_count")
    )
    billing_mismatches = _bounded_nonnegative(
        metrics.get("reservation_settlement_mismatch_count")
    )
    p95 = _bounded_nonnegative(metrics.get("latency_p95_ms"))
    retrieval_counts = metrics.get("retrieval_status_counts")
    retrieval_counts = (
        retrieval_counts if isinstance(retrieval_counts, Mapping) else {}
    )
    retrieval_total = sum(
        _bounded_nonnegative(retrieval_counts.get(key))
        for key in _RETRIEVAL_STATUSES
    )
    retrieval_poor = (
        _bounded_nonnegative(retrieval_counts.get("insufficient"))
        + _bounded_nonnegative(retrieval_counts.get("contradictory"))
    )
    quality_counts = metrics.get("answer_quality_status_counts")
    quality_counts = (
        quality_counts if isinstance(quality_counts, Mapping) else {}
    )
    quality_total = sum(
        _bounded_nonnegative(quality_counts.get(key))
        for key in _QUALITY_STATUSES
    )
    quality_poor = (
        _bounded_nonnegative(quality_counts.get("unverified"))
        + _bounded_nonnegative(quality_counts.get("insufficient_evidence"))
    )

    sample_status: GateStatus = (
        "insufficient_sample" if total < max(1, min_sample) else "pass"
    )
    error_rate = _rate(failures, total)
    cancellation_failure_rate = _rate(
        cancellation_failures, cancellations
    )
    retrieval_poor_rate = _rate(retrieval_poor, retrieval_total)
    quality_poor_rate = _rate(quality_poor, quality_total)

    privacy_status: GateStatus = (
        "fail" if privacy_violations else
        "insufficient_sample" if total == 0 else "pass"
    )
    owner_status: GateStatus = (
        "fail" if owner_mismatches else
        "insufficient_sample" if total == 0 else "pass"
    )
    billing_status: GateStatus = (
        "fail" if billing_mismatches else
        "insufficient_sample" if total == 0 else "pass"
    )
    cancellation_status: GateStatus = (
        "fail" if cancellation_failure_rate > 0.05 else
        "warning" if cancellation_failures > 0 else
        "insufficient_sample" if cancellations == 0 else "pass"
    )
    error_status: GateStatus = (
        sample_status if sample_status == "insufficient_sample" else
        "fail" if error_rate > 0.05 else
        "warning" if error_rate > 0.02 else "pass"
    )
    latency_status: GateStatus = (
        sample_status if sample_status == "insufficient_sample" else
        "fail" if p95 > 15_000 else
        "warning" if p95 > 8_000 else "pass"
    )
    retrieval_status: GateStatus = (
        "insufficient_sample"
        if retrieval_total < max(1, min_sample)
        else "fail" if retrieval_poor_rate > 0.25
        else "warning" if retrieval_poor_rate > 0.10
        else "pass"
    )
    quality_status: GateStatus = (
        "insufficient_sample"
        if quality_total < max(1, min_sample)
        else "fail" if quality_poor_rate > 0.15
        else "warning" if quality_poor_rate > 0.05
        else "pass"
    )
    return (
        _gate(
            "privacy",
            observed=privacy_violations,
            threshold="0 violations",
            status=privacy_status,
        ),
        _gate(
            "owner_isolation",
            observed=owner_mismatches,
            threshold="0 mismatches",
            status=owner_status,
        ),
        _gate(
            "billing_settlement",
            observed=billing_mismatches,
            threshold="0 mismatches",
            status=billing_status,
        ),
        _gate(
            "cancellation",
            observed=cancellation_failure_rate,
            threshold="0 cancellation settlement failures",
            status=cancellation_status,
        ),
        _gate(
            "error_rate",
            observed=error_rate,
            threshold="warning >2%; fail >5%",
            status=error_status,
        ),
        _gate(
            "latency",
            observed=p95,
            threshold="warning >8000ms; fail >15000ms",
            status=latency_status,
        ),
        _gate(
            "retrieval_quality",
            observed=retrieval_poor_rate,
            threshold="warning >10%; fail >25%",
            status=retrieval_status,
        ),
        _gate(
            "answer_quality",
            observed=quality_poor_rate,
            threshold="warning >5%; fail >15%",
            status=quality_status,
        ),
    )


def _overall_gate_status(
    gates: Sequence[AcceptanceGateResult],
) -> GateStatus:
    statuses = {gate.status for gate in gates}
    if "fail" in statuses:
        return "fail"
    if "warning" in statuses:
        return "warning"
    if "insufficient_sample" in statuses:
        return "insufficient_sample"
    return "pass"


def build_rollout_report(
    session: Session,
    *,
    window_hours: int,
    settings: RolloutReportSettings | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    config = settings or RolloutReportSettings.from_environ()
    if window_hours < 1 or window_hours > config.max_window_hours:
        raise ValueError("window_hours is outside configured bounds")
    end = now or utc_now()
    start = end - timedelta(hours=window_hours)

    user_rows = list(session.exec(
        select(
            WebChatMessage.user_id,
            WebChatMessage.request_id,
            WebChatMessage.metadata_json,
            WebChatMessage.status,
            WebChatMessage.created_at,
        ).where(
            WebChatMessage.role == "user",
            WebChatMessage.request_id.is_not(None),
            WebChatMessage.created_at >= start,
            WebChatMessage.created_at <= end,
        )
    ).all())
    request_facts: dict[tuple[int, str], dict[str, object]] = {}
    request_ids: set[str] = set()
    for user_id, request_id, metadata_json, status, created_at in user_rows:
        request_key = (int(user_id), str(request_id))
        records, execution, privacy_violations = _rollout_records(metadata_json)
        if not records:
            continue
        request_ids.add(str(request_id))
        request_facts[request_key] = {
            "records": records,
            "execution": execution,
            "privacy_violations": privacy_violations,
            "user_status": str(status or ""),
            "user_created_at": created_at,
            "tier": "unknown",
            "assistant_status": "",
            "assistant_created_at": None,
            "assistant_id": "",
            "input_tokens": 0,
            "output_tokens": 0,
            "provider_calls": 0,
            "runtime_fallback": False,
            "cache_suppressed": False,
            "retrieval_status": "not_run",
            "retrieval_failed": False,
            "quality_status": "not_run",
            "stages": [],
            "charge": None,
            "feedback": False,
            "owner_mismatches": 0,
        }
    if not request_facts:
        return {
            "generated_at": end.isoformat(),
            "window": {
                "hours": window_hours,
                "started_at": start.isoformat(),
                "ended_at": end.isoformat(),
            },
            "groups": [],
        }

    def mark_owner_mismatch(user_id: int, request_id: str) -> None:
        if (int(user_id), str(request_id)) in request_facts:
            return
        for key, fact in request_facts.items():
            if key[1] == str(request_id):
                fact["owner_mismatches"] = _bounded_nonnegative(
                    fact.get("owner_mismatches")
                ) + 1

    assistant_ids: set[str] = set()
    assistant_owner_by_id: dict[str, int] = {}
    assistant_rows = list(session.exec(
        select(
            WebChatMessage.user_id,
            WebChatMessage.request_id,
            WebChatMessage.id,
            WebChatMessage.swico_tier,
            WebChatMessage.input_tokens,
            WebChatMessage.output_tokens,
            WebChatMessage.status,
            WebChatMessage.metadata_json,
            WebChatMessage.created_at,
        ).where(
            WebChatMessage.role == "assistant",
            WebChatMessage.request_id.in_(request_ids),
        )
    ).all())
    for (
        user_id,
        request_id,
        assistant_id,
        tier,
        input_tokens,
        output_tokens,
        status,
        metadata_json,
        created_at,
    ) in assistant_rows:
        key = (int(user_id), str(request_id))
        fact = request_facts.get(key)
        if fact is None:
            mark_owner_mismatch(int(user_id), str(request_id))
            continue
        metadata = _safe_json(metadata_json)
        fact["tier"] = tier if tier in _TIERS else "unknown"
        fact["assistant_status"] = str(status or "")
        fact["assistant_created_at"] = created_at
        fact["assistant_id"] = str(assistant_id)
        fact["input_tokens"] = _bounded_nonnegative(input_tokens)
        fact["output_tokens"] = _bounded_nonnegative(output_tokens)
        fact["provider_calls"] = _bounded_nonnegative(
            metadata.get("provider_calls_with_usage"), maximum=100
        )
        fact["runtime_fallback"] = bool(
            metadata.get("fallback_attempted")
        )
        fact["cache_suppressed"] = (
            metadata.get("cache_scope") == "disabled"
            and metadata.get("cache_scope_reason")
            == "rollout_controlled_path"
        )
        retrieval_status = metadata.get("retrieval_status")
        if retrieval_status in _RETRIEVAL_STATUSES:
            fact["retrieval_status"] = retrieval_status
        quality = metadata.get("quality")
        if isinstance(quality, dict):
            quality_status = quality.get("status")
            if quality_status in _QUALITY_STATUSES:
                fact["quality_status"] = quality_status
        assistant_ids.add(str(assistant_id))
        assistant_owner_by_id[str(assistant_id)] = int(user_id)

    trace_rows = list(session.exec(
        select(
            WebRetrievalTrace.user_id,
            WebRetrievalTrace.request_id,
            WebRetrievalTrace.status,
            WebRetrievalTrace.safe_metadata_json,
        ).where(WebRetrievalTrace.request_id.in_(request_ids))
    ).all())
    for user_id, request_id, trace_status, metadata_json in trace_rows:
        key = (int(user_id), str(request_id))
        fact = request_facts.get(key)
        if fact is None:
            mark_owner_mismatch(int(user_id), str(request_id))
            continue
        trace_metadata = _safe_json(metadata_json)
        status = trace_metadata.get("retrieval_status")
        if (
            fact["retrieval_status"] == "not_run"
            and status in _RETRIEVAL_STATUSES
        ):
            fact["retrieval_status"] = status
        fact["retrieval_failed"] = (
            fact["retrieval_failed"] or trace_status == "failed"
        )
        status_codes = trace_metadata.get("status_codes")
        if isinstance(status_codes, list) and any(
            value in {
                "lexical_fallback",
                "dense_unavailable",
                "embedding_budget_unavailable",
                "upload_expired",
            }
            for value in status_codes
        ):
            fact["runtime_fallback"] = True

    check_rows = list(session.exec(
        select(
            WebAnswerCheck.user_id,
            WebAnswerCheck.request_id,
            WebAnswerCheck.safe_metadata_json,
        ).where(WebAnswerCheck.request_id.in_(request_ids))
    ).all())
    for user_id, request_id, metadata_json in check_rows:
        key = (int(user_id), str(request_id))
        fact = request_facts.get(key)
        if fact is None:
            mark_owner_mismatch(int(user_id), str(request_id))
            continue
        status = _safe_json(metadata_json).get("quality_outcome")
        if status in _QUALITY_STATUSES:
            fact["quality_status"] = status

    stage_rows = list(session.exec(
        select(
            WebUsageStage.user_id,
            WebUsageStage.request_id,
            WebUsageStage.stage_name,
            WebUsageStage.status,
            WebUsageStage.debited_micros,
            WebUsageStage.input_tokens,
            WebUsageStage.output_tokens,
        ).where(WebUsageStage.request_id.in_(request_ids))
    ).all())
    for row in stage_rows:
        user_id, request_id = int(row[0]), str(row[1])
        fact = request_facts.get((user_id, request_id))
        if fact is None:
            mark_owner_mismatch(user_id, request_id)
            continue
        stages = fact["stages"]
        if isinstance(stages, list):
            stages.append(tuple(row[2:]))

    charge_rows = list(session.exec(
        select(
            UsageCharge.user_id,
            UsageCharge.request_id,
            UsageCharge.status,
            UsageCharge.swico_tier,
            UsageCharge.reserved_micros,
            UsageCharge.debited_micros,
            UsageCharge.provider_cost_micros,
            UsageCharge.input_tokens,
            UsageCharge.output_tokens,
            UsageCharge.billing_exemption_reason,
        ).where(
            UsageCharge.usage_kind == "chat",
            UsageCharge.request_id.in_(request_ids),
        )
    ).all())
    for row in charge_rows:
        user_id, request_id = int(row[0]), str(row[1])
        fact = request_facts.get((user_id, request_id))
        if fact is None:
            mark_owner_mismatch(user_id, request_id)
            continue
        fact["charge"] = tuple(row[2:])
        if fact["tier"] == "unknown" and row[3] in _TIERS:
            fact["tier"] = row[3]

    if assistant_ids:
        feedback_rows = list(session.exec(
            select(
                WebMessageFeedback.user_id,
                WebMessageFeedback.message_id,
            ).where(WebMessageFeedback.message_id.in_(assistant_ids))
        ).all())
        for user_id, message_id in feedback_rows:
            owner = assistant_owner_by_id.get(str(message_id))
            for key, fact in request_facts.items():
                if fact["assistant_id"] == str(message_id):
                    if owner == int(user_id) == key[0]:
                        fact["feedback"] = True
                    else:
                        fact["owner_mismatches"] = _bounded_nonnegative(
                            fact.get("owner_mismatches")
                        ) + 1
                    break

    groups: dict[RolloutGroupKey, list[dict[str, object]]] = defaultdict(list)
    for fact in request_facts.values():
        for version, feature, cohort, enabled in fact["records"]:
            group_fact = {**fact, "rollout_enabled": enabled}
            groups[
                RolloutGroupKey(
                    version,
                    feature,
                    cohort,
                    str(fact["execution"]),
                    str(fact["tier"]),
                )
            ].append(group_fact)

    rendered_groups: list[dict[str, object]] = []
    for key in sorted(groups):
        facts = groups[key]
        retrieval_counts = {
            status: sum(
                1 for fact in facts
                if fact["retrieval_status"] == status
            )
            for status in (*sorted(_RETRIEVAL_STATUSES), "not_run")
        }
        quality_counts = {
            status: sum(
                1 for fact in facts if fact["quality_status"] == status
            )
            for status in (*sorted(_QUALITY_STATUSES), "not_run")
        }
        latencies: list[int] = []
        provider_calls = 0
        verifier_tokens = 0
        repair_tokens = 0
        input_tokens = 0
        output_tokens = 0
        settled_micros = 0
        mismatch_count = 0
        cancellation_failures = 0
        for fact in facts:
            started = fact.get("user_created_at")
            completed = fact.get("assistant_created_at")
            if isinstance(started, datetime) and isinstance(completed, datetime):
                latencies.append(
                    max(0, int((completed - started).total_seconds() * 1000))
                )
            stages = fact.get("stages")
            stages = stages if isinstance(stages, list) else []
            inferred_calls = sum(
                1
                for stage in stages
                if (
                    str(stage[0]) in _PROVIDER_STAGES
                    and str(stage[1]) == "settled"
                    and (
                        _bounded_nonnegative(stage[2]) > 0
                        or _bounded_nonnegative(stage[3]) > 0
                        or _bounded_nonnegative(stage[4]) > 0
                    )
                )
            )
            provider_calls += max(
                _bounded_nonnegative(fact.get("provider_calls"), 100),
                inferred_calls,
            )
            verifier_tokens += sum(
                _bounded_nonnegative(stage[3])
                + _bounded_nonnegative(stage[4])
                for stage in stages
                if str(stage[0]) == "verifier"
            )
            repair_tokens += sum(
                _bounded_nonnegative(stage[3])
                + _bounded_nonnegative(stage[4])
                for stage in stages
                if str(stage[0]) == "repair"
            )
            charge = fact.get("charge")
            if isinstance(charge, tuple):
                (
                    charge_status,
                    _tier,
                    reserved,
                    debited,
                    provider_cost,
                    charge_input,
                    charge_output,
                    exemption,
                ) = charge
                input_tokens += _bounded_nonnegative(charge_input)
                output_tokens += _bounded_nonnegative(charge_output)
                if charge_status == "settled":
                    settled_micros += _bounded_nonnegative(debited)
                stage_cost = sum(
                    _bounded_nonnegative(stage[2])
                    for stage in stages
                    if (
                        str(stage[0]) in _PROVIDER_STAGES
                        and str(stage[1]) == "settled"
                    )
                )
                mismatch = (
                    charge_status not in {"settled", "released"}
                    or (
                        charge_status == "settled"
                        and not exemption
                        and _bounded_nonnegative(debited)
                        != _bounded_nonnegative(provider_cost)
                    )
                    or (
                        charge_status == "settled"
                        and not exemption
                        and _bounded_nonnegative(provider_cost)
                        > _bounded_nonnegative(reserved)
                    )
                    or (
                        charge_status == "settled"
                        and stage_cost > 0
                        and stage_cost != _bounded_nonnegative(provider_cost)
                    )
                )
                mismatch_count += int(mismatch)
                if (
                    fact["assistant_status"] == "cancelled"
                    and mismatch
                ):
                    cancellation_failures += 1
            else:
                input_tokens += _bounded_nonnegative(fact.get("input_tokens"))
                output_tokens += _bounded_nonnegative(
                    fact.get("output_tokens")
                )
        total = len(facts)
        cancellations = sum(
            1
            for fact in facts
            if (
                fact["user_status"] == "cancelled"
                or fact["assistant_status"] == "cancelled"
            )
        )
        failures = sum(
            1
            for fact in facts
            if (
                fact["user_status"] in {"failed", "retryable"}
                or fact["assistant_status"] in {"failed", "retryable"}
                or fact["retrieval_failed"]
                or any(
                    str(stage[1]) == "failed"
                    for stage in (
                        fact["stages"]
                        if isinstance(fact["stages"], list) else []
                    )
                )
            )
        )
        metrics: dict[str, object] = {
            "total_eligible_requests": total,
            "rollout_enabled_requests": sum(
                1 for fact in facts if fact["rollout_enabled"]
            ),
            "fallback_requests": sum(
                1
                for fact in facts
                if (
                    not fact["rollout_enabled"]
                    or fact["runtime_fallback"]
                )
            ),
            "deterministic_provider_free_requests": sum(
                1
                for fact in facts
                if (
                    _bounded_nonnegative(fact.get("provider_calls"), 100) == 0
                    and not any(
                        str(stage[0]) in _PROVIDER_STAGES
                        and str(stage[1]) == "settled"
                        for stage in (
                            fact["stages"]
                            if isinstance(fact["stages"], list) else []
                        )
                    )
                )
            ),
            "provider_call_count": provider_calls,
            "retrieval_status_counts": retrieval_counts,
            "answer_quality_status_counts": quality_counts,
            "cancellation_count": cancellations,
            "cancellation_failure_count": cancellation_failures,
            "failure_count": failures,
            "cache_suppression_count": sum(
                1 for fact in facts if fact["cache_suppressed"]
            ),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "verifier_tokens": verifier_tokens,
            "repair_tokens": repair_tokens,
            "total_settled_micro_inr": settled_micros,
            "reservation_settlement_mismatch_count": mismatch_count,
            "latency_p50_ms": _percentile(latencies, 0.50),
            "latency_p95_ms": _percentile(latencies, 0.95),
            "feedback_count": sum(
                1 for fact in facts if fact["feedback"]
            ),
            "feedback_rate": _rate(
                sum(1 for fact in facts if fact["feedback"]), total
            ),
            "privacy_violation_count": sum(
                _bounded_nonnegative(fact.get("privacy_violations"))
                for fact in facts
            ),
            "owner_isolation_mismatch_count": sum(
                _bounded_nonnegative(fact.get("owner_mismatches"))
                for fact in facts
            ),
        }
        gates = evaluate_acceptance_gates(
            metrics, min_sample=config.acceptance_min_sample
        )
        rendered_groups.append({
            "policy_version": key.policy_version,
            "feature_key": key.feature_key,
            "rollout_cohort": key.cohort,
            "rollout_execution": key.execution,
            "swico_tier": key.swico_tier,
            "metrics": metrics,
            "acceptance": {
                "status": _overall_gate_status(gates),
                "gates": [gate.as_dict() for gate in gates],
            },
        })

    return {
        "generated_at": end.isoformat(),
        "window": {
            "hours": window_hours,
            "started_at": start.isoformat(),
            "ended_at": end.isoformat(),
        },
        "groups": rendered_groups,
    }
