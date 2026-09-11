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
from app.ai.freshness import resolve_freshness, validate_current_evidence  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="perform one bounded provider request")
    parser.add_argument("--query", default="Who is the CM of Tamil Nadu?")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
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
    started = monotonic()
    result = WebSearchAgent().search(args.query)
    elapsed_ms = int(round((monotonic() - started) * 1000))
    valid, _evidence, reason = validate_current_evidence(
        args.query, result.results, now=datetime.now(timezone.utc),
    )
    report.update({
        "status": "verified" if valid else "failed",
        "provider_request": True,
        "latency_ms": elapsed_ms,
        "search_reason": result.reason,
        "usable_source_count": sum(
            1 for item in result.results if isinstance(item, dict) and item.get("url")
        ),
        "evidence_valid": valid,
        "evidence_reason": reason,
        "freshness": resolve_freshness(args.query).__dict__,
        "usage": result.usage or {},
    })
    _print(report, args.pretty)
    return 0 if valid else 1


def _print(value: dict[str, object], pretty: bool) -> None:
    print(json.dumps(value, indent=2 if pretty else None, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
