from __future__ import annotations

from collections import Counter, defaultdict
import json
import re
from typing import Iterable

from sqlmodel import Session, select

from ..models import (
    UsageCharge,
    WebAnswerCheck,
    WebChatMessage,
    WebEvidenceItem,
    WebRetrievalTrace,
    WebUsageStage,
)


_COUNT_MAX = 1_000_000
_MONEY_MAX = 9_000_000_000_000_000_000
_PROVIDER_STAGES = frozenset({
    "embedding",
    "generation",
    "verifier",
    "repair",
    "knowledge_embedding",
    "knowledge_triplet_extract",
})
_CHARGE_STATUSES = frozenset({
    "reserving",
    "reserved",
    "exempt_pending",
    "settled",
    "billing_exempt",
    "released",
    "failed",
})
_ANSWER_CHECK_STATUSES = frozenset({
    "not_run", "passed", "failed", "skipped", "error",
})
_RETRIEVAL_STATUSES = frozenset({
    "sufficient", "ambiguous", "insufficient", "contradictory",
})
_QUALITY_STATUSES = frozenset({
    "verified",
    "grounded",
    "best_effort",
    "unverified",
    "insufficient_evidence",
})
_SOURCE_KINDS = frozenset({
    "temporary_upload",
    "persistent_knowledge",
    "approved_document",
    "knowledge_triplet",
    "repository",
    "memory",
    "profile",
    "history",
    "global_qa",
})
_ACTIVE_CHARGE_STATUSES = frozenset({
    "reserving", "reserved", "exempt_pending",
})
_ACTIVE_STAGE_STATUSES = frozenset({"reserved", "running"})
_USAGE_STAGE_STATUSES = frozenset({
    "planned", "reserved", "running", "settled", "released", "skipped",
    "failed",
})
_USAGE_STAGE_NAMES = frozenset({
    "embedding", "generation", "verifier", "repository_validation", "repair",
    "knowledge_embedding", "knowledge_triplet_extract",
})
_TERMINAL_CHARGE_STATUSES = frozenset({
    "settled", "billing_exempt", "released", "failed",
})
_TIERS = frozenset({"lite", "standard", "pro"})
_REPOSITORY_VALIDATION_MODES = frozenset({
    "static_only", "executable", "unavailable",
})
_PHASE2_FALLBACK_REASONS = frozenset({
    "dense_unavailable",
    "embedding_budget_unavailable",
    "malformed_vector",
    "upload_expired",
    "retrieval_timeout",
    "retrieval_unavailable",
    "phase2_hybrid_retrieval_failed",
    "phase2_token_allocation_failed",
    "phase2_prompt_rebuild_failed",
    "phase2_persistence_failed",
    "phase2_unknown_failure",
})
_CANCELLATION_FAILURE_ORIGINS = frozenset({
    "message_status", "charge_status", "stage_status", "trace_status", "none",
})
_CACHE_HIT_KINDS = frozenset({"none", "exact", "semantic"})
_FINISH_REASONS = frozenset({
    "unknown", "stop", "length", "content_filter", "tool_calls",
})
_COMPLETION_STATUSES = frozenset({
    "unknown", "complete", "incomplete", "cancelled",
})
_ARCHITECTURE_AREA_IDENTIFIERS = (
    "database_schema",
    "transaction_boundaries",
    "state_transitions",
    "pseudocode",
    "duplicate_handling",
    "out_of_order_handling",
    "failure_recovery",
    "reconciliation",
    "security_checks",
    "test_plan",
)
_ARCHITECTURE_AREA_SET = frozenset(_ARCHITECTURE_AREA_IDENTIFIERS)
_SAFE_REPAIR_CHECK_IDENTIFIERS = frozenset({
    "provider_completion",
    "task_requirement_authoritative_store",
    "task_requirement_forbidden_authority",
    *(
        f"task_architecture_{area}"
        for area in _ARCHITECTURE_AREA_IDENTIFIERS
    ),
})
_SAFE_CHECK_IDENTIFIER = re.compile(
    r"^(?:provider_completion|output_contract_[a-z0-9_]{1,64}|"
    r"task_requirement_[a-z0-9_]{1,64}|task_deliverable_[0-9]{1,3}|"
    r"task_architecture_[a-z0-9_]{1,64})$"
)
_DETERMINISTIC_INTENTS = frozenset({
    "local_time", "arithmetic", "unit_conversion", "json_validation",
    "billing_topup_how", "billing_topup_packages", "billing_topup_bounds",
    "billing_custom_topup", "billing_tier_pricing", "swico_brand",
    "profile", "settings", "web_tool_coming_soon", "memory_write",
})
_DETERMINISTIC_SCOPE_REASONS = frozenset({
    "answer_class_detailed", "answer_class_long_form", "message_too_long",
    "too_many_nonempty_lines", "creation_task", "intent_match_too_late",
})


def _bounded_identifier_list(value: object) -> list[str]:
    return [
        item for item in dict.fromkeys(
            part.strip() for part in str(value or "").split(",")
            if part.strip()
        )
        if (
            item in _ARCHITECTURE_AREA_SET
            or item in _SAFE_REPAIR_CHECK_IDENTIFIERS
            or _SAFE_CHECK_IDENTIFIER.fullmatch(item) is not None
        )
    ][:16]


def _safe_check_identifier(value: object) -> str | None:
    identifier = str(value or "").strip()
    return identifier if _SAFE_CHECK_IDENTIFIER.fullmatch(identifier) else None


def _bounded_count(value: object) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return min(_COUNT_MAX, max(0, parsed))


def _bounded_money(values: Iterable[object]) -> int:
    total = 0
    for value in values:
        try:
            parsed = int(value or 0)
        except (TypeError, ValueError):
            parsed = 0
        total = min(_MONEY_MAX, total + max(0, parsed))
    return min(_MONEY_MAX, total)


def _safe_json(raw: str | None) -> dict[str, object]:
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _bounded_counts(
    values: Iterable[object], allowed: frozenset[str]
) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for value in values:
        normalized = str(value or "")
        counts[normalized if normalized in allowed else "other"] += 1
    return {
        key: min(_COUNT_MAX, counts[key])
        for key in sorted(counts)
        if counts[key] > 0
    }


def build_request_audit(
    session: Session, *, request_ids: list[str]
) -> list[dict[str, object]] | None:
    """Return bounded content-free audit facts, or ``None`` for unknown IDs."""

    charges = list(session.exec(select(
        UsageCharge.request_id,
        UsageCharge.status,
        UsageCharge.reserved_micros,
        UsageCharge.debited_micros,
        UsageCharge.settled_at,
        UsageCharge.pricing_snapshot_json,
        UsageCharge.created_at,
    ).where(UsageCharge.request_id.in_(request_ids))).all())
    stages = list(session.exec(select(
        WebUsageStage.request_id,
        WebUsageStage.stage_name,
        WebUsageStage.status,
        WebUsageStage.reserved_micros,
        WebUsageStage.debited_micros,
        WebUsageStage.input_tokens,
        WebUsageStage.output_tokens,
        WebUsageStage.settled_at,
    ).where(WebUsageStage.request_id.in_(request_ids))).all())
    traces = list(session.exec(select(
        WebRetrievalTrace.request_id,
        WebRetrievalTrace.status,
        WebRetrievalTrace.tier_id,
        WebRetrievalTrace.safe_metadata_json,
        WebRetrievalTrace.updated_at,
    ).where(WebRetrievalTrace.request_id.in_(request_ids))).all())
    evidence = list(session.exec(select(
        WebEvidenceItem.request_id,
        WebEvidenceItem.source_type,
    ).where(WebEvidenceItem.request_id.in_(request_ids))).all())
    checks = list(session.exec(select(
        WebAnswerCheck.request_id,
        WebAnswerCheck.status,
        WebAnswerCheck.safe_metadata_json,
        WebAnswerCheck.updated_at,
    ).where(WebAnswerCheck.request_id.in_(request_ids))).all())
    messages = list(session.exec(select(
        WebChatMessage.request_id,
        WebChatMessage.role,
        WebChatMessage.status,
        WebChatMessage.swico_tier,
        WebChatMessage.metadata_json,
        WebChatMessage.created_at,
    ).where(WebChatMessage.request_id.in_(request_ids))).all())

    known = {
        str(row[0])
        for rows in (charges, stages, traces, evidence, checks, messages)
        for row in rows
        if row[0] is not None
    }
    if any(request_id not in known for request_id in request_ids):
        return None

    by_request: dict[str, dict[str, list[tuple[object, ...]]]] = {
        request_id: defaultdict(list) for request_id in request_ids
    }
    for key, rows in (
        ("charges", charges),
        ("stages", stages),
        ("traces", traces),
        ("evidence", evidence),
        ("checks", checks),
        ("messages", messages),
    ):
        for row in rows:
            request_id = str(row[0])
            if request_id in by_request:
                by_request[request_id][key].append(tuple(row[1:]))

    results: list[dict[str, object]] = []
    for request_id in request_ids:
        facts = by_request[request_id]
        charge_rows = facts["charges"]
        stage_rows = facts["stages"]
        trace_rows = facts["traces"]
        evidence_rows = facts["evidence"]
        check_rows = facts["checks"]
        message_rows = facts["messages"]

        charge_statuses = [row[0] for row in charge_rows]
        settled_charge_count = sum(
            1 for row in charge_rows if row[3] is not None
        )
        settled_stage_names = [
            str(row[0]) for row in stage_rows
            if str(row[1]) == "settled" and row[6] is not None
        ]
        duplicate_stage_settlement = len(settled_stage_names) != len(
            set(settled_stage_names)
        )
        duplicate_settlement = bool(
            len(charge_rows) > 1
            or settled_charge_count > 1
            or duplicate_stage_settlement
        )
        active_reservation = bool(
            any(str(row[0]) in _ACTIVE_CHARGE_STATUSES for row in charge_rows)
            or any(str(row[1]) in _ACTIVE_STAGE_STATUSES for row in stage_rows)
        )
        active_usage_stage_names = sorted({
            str(row[0])
            for row in stage_rows
            if (
                str(row[0]) in _USAGE_STAGE_NAMES
                and str(row[1]) in _ACTIVE_STAGE_STATUSES
            )
        })
        terminal_charges = [
            row for row in charge_rows
            if str(row[0]) in _TERMINAL_CHARGE_STATUSES
        ]
        last_terminal_charge_status = (
            str(max(terminal_charges, key=lambda row: row[5])[0])
            if terminal_charges else None
        )

        provider_calls_from_stages = sum(
            1 for row in stage_rows
            if (
                str(row[0]) in _PROVIDER_STAGES
                and str(row[1]) == "settled"
                and any(_bounded_count(value) > 0 for value in row[3:6])
            )
        )
        provider_calls_from_messages = 0
        retrieval_status = "not_run"
        quality_status = "not_run"
        selected_tier = "not_run"
        repository_validation_mode: str | None = None
        cache_hit = False
        cache_hit_kind = "none"
        finish_reason = "unknown"
        completion_status = "unknown"
        truncated = False
        repair_attempted = False
        output_contract_check_statuses: list[str] = []
        task_requirement_check_statuses: list[str] = []
        failed_check_identifiers: list[str] = []
        architecture_missing_area_identifiers: list[str] = []
        pre_repair_failed_check_identifiers: list[str] = []
        repair_trigger_area_identifiers: list[str] = []
        post_repair_failed_check_identifiers: list[str] = []
        phase2_fallback_reason_code: str | None = None
        deterministic_intent: str | None = None
        deterministic_route: str | None = None
        scope_gate_reason: str | None = None
        message_statuses: list[str] = []
        for role, status, tier, metadata_json, _created_at in message_rows:
            message_statuses.append(str(status or ""))
            if tier in _TIERS:
                selected_tier = str(tier)
            if str(role) != "assistant":
                continue
            metadata = _safe_json(str(metadata_json or "{}"))
            candidate_intent = str(metadata.get("deterministic_intent") or "")
            if candidate_intent in _DETERMINISTIC_INTENTS:
                deterministic_intent = candidate_intent
            if metadata.get("deterministic_route") == "backend_tool":
                deterministic_route = "backend_tool"
            candidate_scope_reason = str(metadata.get("scope_gate_reason") or "")
            if candidate_scope_reason in _DETERMINISTIC_SCOPE_REASONS:
                scope_gate_reason = candidate_scope_reason
            cache_hit = cache_hit or metadata.get("cache_hit") is True
            candidate_cache_kind = str(
                metadata.get("cache_hit_kind") or "none"
            )
            if candidate_cache_kind in _CACHE_HIT_KINDS:
                cache_hit_kind = candidate_cache_kind
            candidate_finish = str(metadata.get("finish_reason") or "unknown")
            finish_reason = (
                candidate_finish
                if candidate_finish in _FINISH_REASONS else "unknown"
            )
            candidate_completion = str(
                metadata.get("completion_status") or "unknown"
            )
            completion_status = (
                candidate_completion
                if candidate_completion in _COMPLETION_STATUSES else "unknown"
            )
            truncated = metadata.get("truncated") is True
            provider_calls_from_messages = max(
                provider_calls_from_messages,
                min(100, _bounded_count(
                    metadata.get("provider_calls_with_usage")
                )),
            )
            candidate_retrieval = metadata.get("retrieval_status")
            if candidate_retrieval in _RETRIEVAL_STATUSES:
                retrieval_status = str(candidate_retrieval)
            quality = metadata.get("quality")
            if isinstance(quality, dict):
                repair_attempted = quality.get("repair_attempted") is True
                for raw_check in (
                    quality.get("checks")
                    if isinstance(quality.get("checks"), list) else []
                ):
                    if not isinstance(raw_check, dict):
                        continue
                    check_type = str(raw_check.get("type") or "")
                    check_status = str(raw_check.get("status") or "")
                    observations = (
                        raw_check.get("observations")
                        if isinstance(raw_check.get("observations"), dict)
                        else {}
                    )
                    if check_type.startswith("output_contract_"):
                        output_contract_check_statuses.append(check_status)
                    if (
                        check_type.startswith("task_requirement_")
                        or check_type.startswith("task_deliverable_")
                        or (
                            check_type.startswith("task_architecture_")
                            and check_type != "task_architecture_repair_trace"
                        )
                    ):
                        task_requirement_check_statuses.append(check_status)
                    if check_status in {"failed", "error"} and (
                        check_type.startswith("output_contract_")
                        or check_type.startswith("task_requirement_")
                        or check_type.startswith("task_deliverable_")
                        or (
                            check_type.startswith("task_architecture_")
                            and check_type != "task_architecture_repair_trace"
                        )
                    ):
                        identifier = _safe_check_identifier(check_type)
                        if (
                            identifier is not None
                            and identifier not in failed_check_identifiers
                        ):
                            failed_check_identifiers.append(identifier)
                    if (
                        check_type.startswith("task_architecture_")
                        and check_type != "task_architecture_repair_trace"
                        and check_status in {"failed", "error"}
                    ):
                        area = str(observations.get("area_identifier") or "")
                        if (
                            area in _ARCHITECTURE_AREA_SET
                            and area not in architecture_missing_area_identifiers
                        ):
                            architecture_missing_area_identifiers.append(area)
                    if check_type == "task_architecture_repair_trace":
                        pre_repair_failed_check_identifiers = (
                            _bounded_identifier_list(observations.get(
                                "pre_repair_failed_check_identifiers"
                            ))
                        )
                        repair_trigger_area_identifiers = (
                            _bounded_identifier_list(observations.get(
                                "repair_trigger_area_identifiers"
                            ))
                        )
                        post_repair_failed_check_identifiers = (
                            _bounded_identifier_list(observations.get(
                                "post_repair_failed_check_identifiers"
                            ))
                        )
                candidate_quality = quality.get("status")
                if candidate_quality in _QUALITY_STATUSES:
                    quality_status = str(candidate_quality)
                candidate_mode = quality.get("repository_validation_mode")
                if candidate_mode in _REPOSITORY_VALIDATION_MODES:
                    repository_validation_mode = str(candidate_mode)

        for _status, tier, metadata_json, _updated_at in sorted(
            trace_rows, key=lambda row: row[3]
        ):
            if tier in _TIERS:
                selected_tier = str(tier)
            trace_metadata = _safe_json(str(metadata_json or "{}"))
            candidate = trace_metadata.get("retrieval_status")
            if candidate in _RETRIEVAL_STATUSES:
                retrieval_status = str(candidate)
            candidate_fallback = trace_metadata.get(
                "phase2_fallback_reason_code"
            )
            if candidate_fallback in _PHASE2_FALLBACK_REASONS:
                phase2_fallback_reason_code = str(candidate_fallback)
        for _status, metadata_json, _updated_at in sorted(
            check_rows, key=lambda row: row[2]
        ):
            check_metadata = _safe_json(str(metadata_json or "{}"))
            candidate = check_metadata.get("quality_outcome")
            # The persisted assistant message is the user-visible source of
            # truth and the SSE quality event is built from the same snapshot.
            # Answer-check rows remain a compatibility fallback for requests
            # created before message quality metadata was persisted.
            if candidate in _QUALITY_STATUSES and quality_status == "not_run":
                quality_status = str(candidate)
            candidate_mode = check_metadata.get("repository_validation_mode")
            if candidate_mode in _REPOSITORY_VALIDATION_MODES:
                repository_validation_mode = str(candidate_mode)
            for raw_check in (
                check_metadata.get("quality_checks")
                if isinstance(check_metadata.get("quality_checks"), list)
                else []
            ):
                if not isinstance(raw_check, dict):
                    continue
                check_type = str(raw_check.get("check_type") or "")
                check_status = str(raw_check.get("check_status") or "")
                if check_status in {"failed", "error"}:
                    identifier = _safe_check_identifier(check_type)
                    if (
                        identifier is not None
                        and identifier not in failed_check_identifiers
                    ):
                        failed_check_identifiers.append(identifier)
                if (
                    check_type.startswith("task_architecture_")
                    and check_type != "task_architecture_repair_trace"
                    and check_status in {"failed", "error"}
                ):
                    area = str(raw_check.get("area_identifier") or "")
                    if (
                        area in _ARCHITECTURE_AREA_SET
                        and area not in architecture_missing_area_identifiers
                    ):
                        architecture_missing_area_identifiers.append(area)
                if check_type == "task_architecture_repair_trace":
                    pre_repair_failed_check_identifiers = (
                        _bounded_identifier_list(raw_check.get(
                            "pre_repair_failed_check_identifiers"
                        ))
                    )
                    repair_trigger_area_identifiers = (
                        _bounded_identifier_list(raw_check.get(
                            "repair_trigger_area_identifiers"
                        ))
                    )
                    post_repair_failed_check_identifiers = (
                        _bounded_identifier_list(raw_check.get(
                            "post_repair_failed_check_identifiers"
                        ))
                    )

        if failed_check_identifiers:
            if not pre_repair_failed_check_identifiers:
                pre_repair_failed_check_identifiers = list(
                    failed_check_identifiers
                )
            if not post_repair_failed_check_identifiers:
                post_repair_failed_check_identifiers = list(
                    failed_check_identifiers
                )

        cancelled_before_usage = any(
            _safe_json(str(row[4] or "{}")).get("release_reason")
            == "cancelled_before_provider_usage"
            for row in charge_rows
        )
        cancelled = (
            "cancelled" in message_statuses or cancelled_before_usage
        )
        message_failed = any(
            value == "failed"
            or (value == "retryable" and not cancelled_before_usage)
            for value in message_statuses
        )
        charge_failed = any(
            str(row[0]) == "failed" for row in charge_rows
        )
        stage_failed = any(
            str(row[1]) == "failed" for row in stage_rows
        )
        trace_failed = any(
            str(row[0]) == "failed" for row in trace_rows
        )
        cancellation_failure_origin = (
            "message_status" if message_failed else
            "charge_status" if charge_failed else
            "stage_status" if stage_failed else
            "trace_status" if trace_failed else
            "none"
        )
        if cancellation_failure_origin not in _CANCELLATION_FAILURE_ORIGINS:
            cancellation_failure_origin = "none"
        failed = cancellation_failure_origin != "none"
        complete = bool(
            any(
                str(role) == "assistant" and str(status) == "complete"
                for role, status, _tier, _metadata, _created in message_rows
            )
            or any(
                str(row[0]) in _TERMINAL_CHARGE_STATUSES
                for row in charge_rows
            )
        )
        cancellation_state = (
            "cancelled" if cancelled else
            "active" if active_reservation else
            "failed" if failed else
            "complete" if complete else
            "not_started"
        )
        cancellation_failure_count = int(
            cancelled and (active_reservation or duplicate_settlement)
        )

        results.append({
            "request_id": request_id,
            "usage_charge_row_count": min(_COUNT_MAX, len(charge_rows)),
            "usage_stage_row_count": min(_COUNT_MAX, len(stage_rows)),
            "provider_call_count": min(
                100,
                max(provider_calls_from_messages, provider_calls_from_stages),
            ),
            "reserved_micro_inr_total": _bounded_money(
                row[1] for row in charge_rows
            ),
            "charged_micro_inr_total": _bounded_money(
                row[2] for row in charge_rows
            ),
            "settled_micro_inr_total": _bounded_money(
                row[2] for row in charge_rows
                if str(row[0]) in {"settled", "billing_exempt"}
            ),
            "charge_status_counts": _bounded_counts(
                charge_statuses, _CHARGE_STATUSES
            ),
            "usage_stage_status_counts": _bounded_counts(
                (row[1] for row in stage_rows), _USAGE_STAGE_STATUSES
            ),
            "active_usage_stage_names": active_usage_stage_names[:16],
            "last_terminal_charge_status": last_terminal_charge_status,
            "paid_usage_stage_count": min(
                _COUNT_MAX,
                sum(
                    1 for row in stage_rows
                    if _bounded_count(row[3]) > 0
                ),
            ),
            "duplicate_settlement_indicator": duplicate_settlement,
            "source_count": min(_COUNT_MAX, len(evidence_rows)),
            "source_kind_counts": _bounded_counts(
                (row[0] for row in evidence_rows), _SOURCE_KINDS
            ),
            "retrieval_status": retrieval_status,
            "quality_status": quality_status,
            "persisted_quality_status": quality_status,
            "cache_hit": cache_hit,
            "cache_hit_kind": cache_hit_kind,
            "finish_reason": finish_reason,
            "completion_status": completion_status,
            "truncated": truncated,
            "output_contract_check_status_counts": _bounded_counts(
                output_contract_check_statuses,
                frozenset({"passed", "failed", "warning", "skipped", "error"}),
            ),
            "task_requirement_check_status_counts": _bounded_counts(
                task_requirement_check_statuses,
                frozenset({"passed", "failed", "warning", "skipped", "error"}),
            ),
            "architecture_missing_area_identifiers": (
                architecture_missing_area_identifiers[:10]
            ),
            "pre_repair_failed_check_identifiers": (
                pre_repair_failed_check_identifiers
            ),
            "repair_trigger_area_identifiers": (
                repair_trigger_area_identifiers
            ),
            "post_repair_failed_check_identifiers": (
                post_repair_failed_check_identifiers
            ),
            "failed_check_identifiers": failed_check_identifiers[:16],
            "deterministic_intent": deterministic_intent,
            "deterministic_route": deterministic_route,
            "scope_gate_reason": (
                None if deterministic_route == "backend_tool"
                else scope_gate_reason
            ),
            "repair_attempted": repair_attempted,
            "generation_stage_count": min(
                _COUNT_MAX,
                sum(1 for row in stage_rows if str(row[0]) == "generation"),
            ),
            "repair_stage_count": min(
                _COUNT_MAX,
                sum(1 for row in stage_rows if str(row[0]) == "repair"),
            ),
            "answer_check_status_counts": _bounded_counts(
                (row[0] for row in check_rows), _ANSWER_CHECK_STATUSES
            ),
            "selected_tier": selected_tier,
            "repository_validation_mode": repository_validation_mode,
            "phase2_fallback_reason_code": phase2_fallback_reason_code,
            "cancellation_state": cancellation_state,
            "cancellation_failure_origin": cancellation_failure_origin,
            "cancellation_failure_count": cancellation_failure_count,
            "orphaned_active_reservation": active_reservation,
        })
    return results
