from __future__ import annotations

from collections import Counter, defaultdict
import json
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
_TERMINAL_CHARGE_STATUSES = frozenset({
    "settled", "billing_exempt", "released", "failed",
})


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
        message_statuses: list[str] = []
        for role, status, metadata_json, _created_at in message_rows:
            message_statuses.append(str(status or ""))
            if str(role) != "assistant":
                continue
            metadata = _safe_json(str(metadata_json or "{}"))
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
                candidate_quality = quality.get("status")
                if candidate_quality in _QUALITY_STATUSES:
                    quality_status = str(candidate_quality)

        for _status, metadata_json, _updated_at in sorted(
            trace_rows, key=lambda row: row[2]
        ):
            candidate = _safe_json(str(metadata_json or "{}")).get(
                "retrieval_status"
            )
            if candidate in _RETRIEVAL_STATUSES:
                retrieval_status = str(candidate)
        for _status, metadata_json, _updated_at in sorted(
            check_rows, key=lambda row: row[2]
        ):
            candidate = _safe_json(str(metadata_json or "{}")).get(
                "quality_outcome"
            )
            if candidate in _QUALITY_STATUSES:
                quality_status = str(candidate)

        cancelled_before_usage = any(
            _safe_json(str(row[4] or "{}")).get("release_reason")
            == "cancelled_before_provider_usage"
            for row in charge_rows
        )
        cancelled = (
            "cancelled" in message_statuses or cancelled_before_usage
        )
        failed = bool(
            any(value in {"failed", "retryable"} for value in message_statuses)
            or any(str(row[0]) == "failed" for row in charge_rows)
            or any(str(row[1]) == "failed" for row in stage_rows)
            or any(str(row[0]) == "failed" for row in trace_rows)
        )
        complete = bool(
            any(
                str(role) == "assistant" and str(status) == "complete"
                for role, status, _metadata, _created in message_rows
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
            "answer_check_status_counts": _bounded_counts(
                (row[0] for row in check_rows), _ANSWER_CHECK_STATUSES
            ),
            "cancellation_state": cancellation_state,
            "cancellation_failure_count": cancellation_failure_count,
            "orphaned_active_reservation": active_reservation,
        })
    return results
