#!/usr/bin/env python3
"""Offline/live operator check for the paid website current-information adapter."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.ai.agents.web_search_agent import (  # noqa: E402
    LiveSearchConfigurationError, WebSearchAgent, live_search_config,
)
from app.ai.freshness import (  # noqa: E402
    _validate_current_evidence_item, resolve_freshness, validate_current_evidence,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="perform one bounded provider request")
    parser.add_argument("--query", default="Who is the CM of Tamil Nadu?")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument(
        "--debug-evidence", action="store_true",
        help="print bounded public claim/source validation diagnostics",
    )
    parser.add_argument(
        "--export-fixture", type=Path,
        help="save the sanitized Responses payload from a live check",
    )
    parser.add_argument(
        "--replay-fixture", type=Path,
        help="replay a sanitized Responses payload without network or billing",
    )
    args = parser.parse_args()
    if args.replay_fixture:
        return _replay_fixture(args)
    report: dict[str, object]
    try:
        config = live_search_config(require_key=args.live)
    except LiveSearchConfigurationError as exc:
        report = {"status": "invalid_configuration", "error": str(exc)}
        _print(report, args.pretty)
        return 2
    report = {
        "status": "disabled" if not config.enabled else "configured",
        "enabled": config.enabled,
        "provider": config.provider,
        "model": config.model,
        "timeout_seconds": config.timeout_seconds,
        "max_calls_per_turn": config.max_calls_per_turn,
        "max_output_tokens": config.max_output_tokens,
        "provider_request": False,
    }
    if not args.live:
        _print(report, args.pretty)
        return 0
    if not config.enabled:
        report.update({"status": "disabled", "error": "WEB_LIVE_SEARCH_ENABLED is false"})
        _print(report, args.pretty)
        return 2
    capture_clock = datetime.now(timezone.utc)
    started = monotonic()
    result = WebSearchAgent(clock=lambda: capture_clock).search(args.query)
    elapsed_ms = int(round((monotonic() - started) * 1000))
    valid, normalized_evidence, reason = validate_current_evidence(
        args.query, result.results, now=capture_clock,
    )
    diagnostics = result.diagnostics or {}
    bundles = [item for item in result.results if isinstance(item, dict)]
    consulted = _source_urls(diagnostics.get("consulted_sources"))
    if not consulted:
        consulted = _source_urls(
            source
            for item in bundles
            for source in (item.get("sources") or [])
        )
    cited = _source_urls(diagnostics.get("citation_annotations"))
    if not cited:
        cited = _source_urls(
            source
            for item in bundles
            for source in (item.get("claim_sources") or [])
        )
    normalized_sources = (
        normalized_evidence.get("claim_sources")
        if isinstance(normalized_evidence, dict) else []
    )
    associated_supporting = _source_urls(normalized_sources)
    independently_verified = _source_urls(
        normalized_sources
        if isinstance(normalized_evidence, dict)
        and normalized_evidence.get("verification_strength") == "independently_source_supported"
        else []
    )
    report.update({
        "status": (
            "verified" if valid and independently_verified else
            "grounded" if valid else "failed"
        ),
        "provider_request": True,
        "latency_ms": elapsed_ms,
        "search_reason": result.reason,
        "result_bundle_count": len(bundles),
        # Keep the historical field for probe compatibility, but make its
        # semantics source-count based.  A bundle can contain several sources.
        "usable_source_count": len(associated_supporting),
        "associated_supporting_source_count": len(associated_supporting),
        "validated_supporting_source_count": len(associated_supporting) if valid else 0,
        "independently_verified_source_count": len(independently_verified),
        "verification_strength": (
            str(normalized_evidence.get("verification_strength") or "")
            if isinstance(normalized_evidence, dict) else "unavailable"
        ),
        "consulted_source_count": len(consulted),
        "cited_source_count": len(cited),
        "evidence_valid": valid,
        "provider_grounding_valid": valid,
        "independent_verification_valid": bool(valid and independently_verified),
        "evidence_reason": reason,
        "capture_clock": capture_clock.isoformat(),
        "requested_as_of": (
            str(normalized_evidence.get("temporal_as_of") or "")
            if isinstance(normalized_evidence, dict)
            else resolve_freshness(args.query, now=capture_clock).as_of
        ),
        "freshness": resolve_freshness(args.query, now=capture_clock).__dict__,
        "usage": result.usage or {},
    })
    if args.export_fixture:
        fixture = {
            "format": "swico-paid-live-search-response-v1",
            "query": args.query[:2000],
            "capture_clock": capture_clock.isoformat(),
            "requested_as_of": resolve_freshness(args.query, now=capture_clock).as_of,
            "response": diagnostics.get("fixture_response"),
        }
        if not fixture["response"]:
            report["fixture_export_error"] = "response_fixture_unavailable"
        else:
            args.export_fixture.write_text(
                json.dumps(fixture, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            report["fixture_exported"] = str(args.export_fixture)
    if args.debug_evidence:
        candidate_diagnostics = []
        for item in bundles[:8]:
            accepted, candidate_normalized, candidate_reason = _validate_current_evidence_item(
                args.query, item, now=capture_clock,
            )
            reported = candidate_normalized if accepted and candidate_normalized else item
            public_sources = []
            for source in (item.get("claim_sources") or item.get("sources") or [])[:8]:
                if isinstance(source, dict) and source.get("url"):
                    public_sources.append({
                        "title": str(source.get("title") or "")[:160],
                        "url": str(source.get("url"))[:500],
                    })
            candidate_diagnostics.append({
                "accepted": accepted,
                "reason": candidate_reason,
                "candidate_claim": str(item.get("claim") or "")[:500],
                "answer_value": str(item.get("answer_value") or item.get("officeholder") or "")[:160],
                "temporal_as_of": str(reported.get("temporal_as_of") or reported.get("as_of") or "")[:32],
                "sources": public_sources,
                "claim_sources": public_sources,
                "supporting_passages": [
                    {
                        "source_url": str(passage.get("source_url") or "")[:500],
                        "block_id": str(passage.get("block_id") or "")[:128],
                        "marker_text": str(passage.get("marker_text") or "")[:160],
                        "start_index": int(passage.get("start_index") or 0),
                        "end_index": int(passage.get("end_index") or 0),
                        "passage": str(passage.get("passage") or "")[:500],
                        "association_method": str(passage.get("association_method") or "")[:80],
                    }
                    for passage in (item.get("supporting_passages") or [])[:8]
                    if isinstance(passage, dict)
                ],
                "claim_support_type": str(item.get("claim_support_type") or "")[:64],
                "verification_strength": str(reported.get("verification_strength") or "")[:64],
            })
        report["debug_evidence"] = {
            "completion_status": (
                str(diagnostics.get("response_status") or "")
                if diagnostics else (
                    "completed" if any(item.get("search_call_completed") is True for item in bundles)
                    else result.reason
                )
            ),
            "incomplete_details": diagnostics.get("incomplete_details"),
            "refusal": diagnostics.get("refusal"),
            "tool_statuses": diagnostics.get("tool_statuses", [])[:8],
            "text_blocks": diagnostics.get("text_blocks", [])[:4],
            "citation_annotations": diagnostics.get("citation_annotations", [])[:16],
            "invalid_annotations": diagnostics.get("invalid_annotations", [])[:16],
            "extraction": diagnostics.get("extraction", {}),
            "citation_association": (
                diagnostics.get("extraction", {}).get("associations", [])[:16]
                if isinstance(diagnostics.get("extraction"), dict) else []
            ),
            "normalized_evidence": (
                {
                    "verification_strength": str(
                        normalized_evidence.get("verification_strength") or ""
                    )[:64],
                    "independent_verification": str(
                        normalized_evidence.get("independent_verification") or ""
                    )[:32],
                    "temporal_as_of": str(
                        normalized_evidence.get("temporal_as_of") or ""
                    )[:32],
                    "claim_sources": [
                        {
                            "title": str(source.get("title") or "")[:160],
                            "url": str(source.get("url") or "")[:500],
                        }
                        for source in normalized_sources[:8]
                        if isinstance(source, dict) and source.get("url")
                    ],
                }
                if isinstance(normalized_evidence, dict) else None
            ),
            "sources": [
                {
                    "title": str(source.get("title") or "")[:160],
                    "url": str(source.get("url") or "")[:500],
                }
                for source in (diagnostics.get("consulted_sources") or [])[:8]
                if isinstance(source, dict) and source.get("url")
            ],
            "candidates": candidate_diagnostics,
        }
    _print(report, args.pretty)
    return 0 if valid else 1


def _source_urls(sources: object) -> set[str]:
    result: set[str] = set()
    if not sources:
        return result
    for source in sources:
        if isinstance(source, dict) and source.get("url"):
            result.add(str(source["url"]))
    return result


def _replay_fixture(args: argparse.Namespace) -> int:
    try:
        fixture = json.loads(args.replay_fixture.read_text(encoding="utf-8"))
        query = str(fixture.get("query") or args.query)[:2000]
        response = fixture["response"]
        requested_as_of = str(fixture.get("requested_as_of") or "").strip() or None
        captured_at = fixture.get("capture_clock")
        if captured_at:
            capture_clock = datetime.fromisoformat(
                str(captured_at).replace("Z", "+00:00")
            )
            if capture_clock.tzinfo is None:
                capture_clock = capture_clock.replace(tzinfo=timezone.utc)
            capture_clock = capture_clock.astimezone(timezone.utc)
        else:
            # Older fixtures remain replayable, but their interpretation is
            # necessarily tied to the replay clock because no capture clock
            # was recorded.
            capture_clock = datetime.now(timezone.utc)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        _print({"status": "invalid_fixture", "error": str(exc)}, args.pretty)
        return 2
    started = monotonic()
    result = WebSearchAgent(
        clock=lambda: capture_clock,
    )._normalize_response(  # noqa: SLF001 - offline production replay.
        response, query, requested_as_of=requested_as_of,
    )
    valid, normalized_evidence, reason = validate_current_evidence(
        query, result.results, now=capture_clock,
    )
    diagnostics = result.diagnostics or {}
    consulted = _source_urls(diagnostics.get("consulted_sources"))
    cited = _source_urls(diagnostics.get("citation_annotations"))
    normalized_sources = (
        normalized_evidence.get("claim_sources")
        if isinstance(normalized_evidence, dict) else []
    )
    associated_supporting = _source_urls(normalized_sources)
    independently_verified = _source_urls(
        normalized_sources
        if isinstance(normalized_evidence, dict)
        and normalized_evidence.get("verification_strength") == "independently_source_supported"
        else []
    )
    report = {
        "status": (
            "verified" if valid and independently_verified else
            "grounded" if valid else "failed"
        ),
        "offline_replay": True,
        "provider_request": False,
        "latency_ms": int(round((monotonic() - started) * 1000)),
        "search_reason": result.reason,
        "result_bundle_count": len(result.results),
        "consulted_source_count": len(consulted),
        "cited_source_count": len(cited),
        "usable_source_count": len(associated_supporting),
        "associated_supporting_source_count": len(associated_supporting),
        "validated_supporting_source_count": len(associated_supporting) if valid else 0,
        "independently_verified_source_count": len(independently_verified),
        "verification_strength": (
            str(normalized_evidence.get("verification_strength") or "")
            if isinstance(normalized_evidence, dict) else "unavailable"
        ),
        "evidence_valid": valid,
        "provider_grounding_valid": valid,
        "independent_verification_valid": bool(valid and independently_verified),
        "evidence_reason": reason,
        "capture_clock": capture_clock.isoformat(),
        "requested_as_of": (
            str(normalized_evidence.get("temporal_as_of") or "")
            if isinstance(normalized_evidence, dict)
            else resolve_freshness(query, now=capture_clock).as_of
        ),
        "freshness": resolve_freshness(query, now=capture_clock).__dict__,
        "usage": result.usage or {},
    }
    if args.debug_evidence:
        report["debug_evidence"] = {
            "response_status": diagnostics.get("response_status"),
            "incomplete_details": diagnostics.get("incomplete_details"),
            "refusal": diagnostics.get("refusal"),
            "tool_statuses": diagnostics.get("tool_statuses", [])[:8],
            "text_blocks": diagnostics.get("text_blocks", [])[:4],
            "citation_annotations": diagnostics.get("citation_annotations", [])[:16],
            "invalid_annotations": diagnostics.get("invalid_annotations", [])[:16],
            "extraction": diagnostics.get("extraction", {}),
            "citation_association": (
                diagnostics.get("extraction", {}).get("associations", [])[:16]
                if isinstance(diagnostics.get("extraction"), dict) else []
            ),
            "normalized_evidence": (
                {
                    "verification_strength": str(
                        normalized_evidence.get("verification_strength") or ""
                    )[:64],
                    "independent_verification": str(
                        normalized_evidence.get("independent_verification") or ""
                    )[:32],
                    "temporal_as_of": str(
                        normalized_evidence.get("temporal_as_of") or ""
                    )[:32],
                    "claim_sources": [
                        {
                            "title": str(source.get("title") or "")[:160],
                            "url": str(source.get("url") or "")[:500],
                        }
                        for source in normalized_sources[:8]
                        if isinstance(source, dict) and source.get("url")
                    ],
                }
                if isinstance(normalized_evidence, dict) else None
            ),
            "sources": [
                {"title": str(source.get("title") or "")[:160], "url": str(source.get("url"))[:500]}
                for source in diagnostics.get("consulted_sources", [])[:8]
                if isinstance(source, dict) and source.get("url")
            ],
        }
    _print(report, args.pretty)
    return 0 if valid else 1


def _print(value: dict[str, object], pretty: bool) -> None:
    print(json.dumps(value, indent=2 if pretty else None, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
