from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

import httpx  # noqa: E402
from alembic.config import Config  # noqa: E402
from alembic.migration import MigrationContext  # noqa: E402
from alembic.script import ScriptDirectory  # noqa: E402
from sqlalchemy import func, inspect, text  # noqa: E402
from sqlmodel import select  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.models import Job  # noqa: E402
from app.production_config import production_configuration_errors  # noqa: E402
from app.ai.provider_pool import (  # noqa: E402
    ALIAS_DEFAULTS, configured_provider_aliases, multi_provider_routing_enabled,
)
from app.web_ai.retrieval.corrective import CorrectiveRetrievalController  # noqa: E402
from app.web_ai.tier_policy import tier_policy_for  # noqa: E402
from app.web_ai.knowledge_jobs import KNOWLEDGE_JOB_TYPES  # noqa: E402
from app.web_ai.rollout import (  # noqa: E402
    RolloutGlobalFlags,
    RolloutMode,
    TriagReleaseConfigurationError,
    TriagReleaseState,
    WebRolloutPolicy,
)
from app.web_ai.rollout_metrics import (  # noqa: E402
    RolloutReportConfigurationError,
    RolloutReportSettings,
)
from app.web_ai.settings import (  # noqa: E402
    TriagConfigurationError,
    TriagSettings,
)


_REQUIRED_TABLES = frozenset({
    "job",
    "usage_charge",
    "web_answer_check",
    "web_code_edge",
    "web_code_file",
    "web_code_repository",
    "web_code_symbol",
    "web_evidence_item",
    "web_knowledge_chunk",
    "web_knowledge_document",
    "web_knowledge_node",
    "web_knowledge_triplet",
    "web_retrieval_trace",
    "web_usage_stage",
})
_JOB_STATUSES = (
    "queued",
    "retrying",
    "running",
    "complete",
    "completed",
    "failed",
    "cancelled",
    "other",
)
_COUNT_MAX = 1_000_000_000
_ROLLOUT_REASON_CODES = frozenset({
    "invalid_configuration",
    "triag_settings_invalid",
    "mode_mismatch",
    "percentage_must_be_zero",
})


def _check(
    name: str,
    passed: bool,
    **metadata: object,
) -> dict[str, object]:
    return {
        "name": name,
        "status": "pass" if passed else "block",
        **metadata,
    }


def _alembic_heads() -> tuple[str, ...]:
    config = Config(str(BACKEND_ROOT / "alembic.ini"))
    script = ScriptDirectory.from_config(config)
    return tuple(sorted(script.get_heads()))


def _validator_capability(settings: TriagSettings) -> str:
    if not settings.code_validator_url or not settings.code_validator_auth_token:
        return "unavailable"
    try:
        with httpx.Client(
            base_url=settings.code_validator_url.rstrip("/"),
            timeout=min(2, settings.code_validator_timeout_seconds),
        ) as client:
            response = client.get(
                "/v1/isolation",
                headers={
                    "Authorization": (
                        f"Bearer {settings.code_validator_auth_token}"
                    )
                },
            )
        if response.status_code != 200:
            return "unavailable"
        payload = response.json()
    except (httpx.HTTPError, TypeError, ValueError):
        return "unavailable"
    isolation = payload.get("isolation_level")
    executable = payload.get("executable_checks")
    if isolation == "executable" and executable is True:
        return "executable"
    if isolation == "static_only" and executable is False:
        return "static_only"
    return "unavailable"


def _provider_pool_check(environ: Mapping[str, str]) -> dict[str, object]:
    enabled = multi_provider_routing_enabled(dict(environ))
    try:
        aliases = configured_provider_aliases(dict(environ))
    except ValueError:
        return _check(
            "multi_provider_routing",
            False,
            enabled=enabled,
            aliases_ready=False,
        )
    ceilings = {
        tier: tier_policy_for(tier, dict(environ)).max_provider_calls
        for tier in ("free", "lite", "standard", "pro")
    }
    ceilings_ready = ceilings == {"free": 1, "lite": 2, "standard": 3, "pro": 3}
    provider_ready = all(item.provider in {"openai", "sarvam"} for item in aliases.values())
    free_cloud_safe = ceilings["free"] == 1
    embedding_alias = aliases.get("embedding_primary")
    embedding_safe = embedding_alias is not None and embedding_alias.provider == "openai"
    try:
        triag_settings = TriagSettings.from_environ(environ)
        corrective_rounds = {
            tier: CorrectiveRetrievalController(
                policy=tier_policy_for(tier, dict(environ)),
                configured_max_rounds=triag_settings.max_corrective_rounds,
            ).maximum_rounds
            for tier in ("standard", "pro")
        }
    except Exception:
        corrective_rounds = {"standard": -1, "pro": -1}
    corrective_ready = corrective_rounds == {"standard": 1, "pro": 2}
    return _check(
        "multi_provider_routing",
        (not enabled) or (
            len(aliases) == len(ALIAS_DEFAULTS)
            and provider_ready
            and embedding_safe
            and ceilings_ready
            and free_cloud_safe
            and corrective_ready
        ),
        enabled=enabled,
        aliases_ready=len(aliases) == len(ALIAS_DEFAULTS),
        tier_provider_call_ceilings=ceilings,
        free_cloud_providers_forbidden=free_cloud_safe,
        corrective_round_limits=corrective_rounds,
        embedding_provider_safe=embedding_safe,
    )


def _database_checks(
    session_factory: Callable[..., object],
    *,
    expected_heads: tuple[str, ...],
) -> tuple[dict[str, object], ...]:
    database = _check("database_access", False)
    current = _check(
        "alembic_current",
        False,
        current_count=0,
        matches_head=False,
    )
    tables = _check(
        "required_triag_tables",
        False,
        required_count=len(_REQUIRED_TABLES),
        present_count=0,
    )
    jobs = _check(
        "knowledge_job_status_counts",
        False,
        counts=[],
    )
    try:
        with session_factory() as session:
            session.exec(text("SELECT 1")).one()
            database = _check("database_access", True)

            current_heads = tuple(sorted(
                MigrationContext.configure(
                    session.connection()
                ).get_current_heads()
            ))
            matches = bool(
                len(expected_heads) == 1 and current_heads == expected_heads
            )
            current = _check(
                "alembic_current",
                matches,
                current_count=len(current_heads),
                matches_head=matches,
            )

            present = set(inspect(session.connection()).get_table_names())
            present_count = len(_REQUIRED_TABLES.intersection(present))
            tables = _check(
                "required_triag_tables",
                present_count == len(_REQUIRED_TABLES),
                required_count=len(_REQUIRED_TABLES),
                present_count=present_count,
            )

            rows = session.exec(
                select(Job.job_type, Job.status, func.count(Job.id))
                .where(Job.job_type.in_(KNOWLEDGE_JOB_TYPES))
                .group_by(Job.job_type, Job.status)
            ).all()
            normalized: dict[tuple[str, str], int] = {}
            unknown = 0
            for job_type, raw_status, raw_count in rows:
                if job_type not in KNOWLEDGE_JOB_TYPES:
                    continue
                status = (
                    str(raw_status)
                    if str(raw_status) in _JOB_STATUSES[:-1]
                    else "other"
                )
                count = min(_COUNT_MAX, max(0, int(raw_count or 0)))
                normalized[(str(job_type), status)] = (
                    normalized.get((str(job_type), status), 0) + count
                )
                if status == "other":
                    unknown += count
            counts = [
                {
                    "job_type": job_type,
                    "status": status,
                    "count": normalized[(job_type, status)],
                }
                for job_type in KNOWLEDGE_JOB_TYPES
                for status in _JOB_STATUSES
                if normalized.get((job_type, status), 0) > 0
            ][: len(KNOWLEDGE_JOB_TYPES) * len(_JOB_STATUSES)]
            failed = sum(
                value
                for (job_type, status), value in normalized.items()
                if job_type in KNOWLEDGE_JOB_TYPES and status == "failed"
            )
            jobs = _check(
                "knowledge_job_status_counts",
                failed == 0 and unknown == 0,
                counts=counts,
                failed_count=min(_COUNT_MAX, failed),
                unknown_status_count=min(_COUNT_MAX, unknown),
            )
    except Exception:
        # No exception detail is safe for a release artifact.
        pass
    return database, current, tables, jobs


def build_release_report(
    environ: Mapping[str, str] | None = None,
    *,
    session_factory: Callable[..., object] = SessionLocal,
) -> dict[str, object]:
    env = os.environ if environ is None else environ
    checks: list[dict[str, object]] = []

    production_errors = production_configuration_errors(env)
    checks.append(_check(
        "production_configuration",
        not production_errors,
        blocker_count=min(128, len(production_errors)),
    ))

    triag_settings: TriagSettings | None = None
    try:
        triag_settings = TriagSettings.from_environ(env)
    except TriagConfigurationError:
        pass
    triag_ready = bool(
        triag_settings
        and triag_settings.enabled
        and not triag_settings.shadow_mode
        and triag_settings.hybrid_runtime_enabled
    )
    checks.append(_check(
        "triag_settings",
        triag_ready,
        runtime=(
            str(triag_settings.runtime_status.get("status"))
            if triag_settings is not None else "invalid"
        ),
    ))
    checks.append(_check(
        "runtime_flags",
        True,
        runtime_status=(
            triag_settings.runtime_status
            if triag_settings is not None else {"status": "invalid"}
        ),
    ))
    checks.append(_provider_pool_check(env))

    release_state: TriagReleaseState | None = None
    try:
        release_state = TriagReleaseState.from_environ(env)
    except TriagReleaseConfigurationError:
        pass
    checks.append(_check(
        "release_state",
        release_state == TriagReleaseState.GENERAL_AVAILABILITY,
        release_state=(release_state.value if release_state else "invalid"),
    ))

    rollout: WebRolloutPolicy | None = None
    try:
        rollout = WebRolloutPolicy.from_environ(env)
    except Exception:
        pass
    mode_counts = {mode.value: 0 for mode in RolloutMode}
    rollout_ready = False
    rollout_reason_code: str | None = None
    if rollout is None:
        rollout_reason_code = "invalid_configuration"
    elif triag_settings is None:
        rollout_reason_code = "triag_settings_invalid"
    if rollout is not None and triag_settings is not None:
        flags = RolloutGlobalFlags.from_settings(triag_settings)
        rollout_ready = True
        for feature in rollout.features:
            mode_counts[feature.mode.value] += 1
            expected = (
                RolloutMode.ALL_ELIGIBLE
                if flags.enabled(feature.feature_key)
                else RolloutMode.DISABLED
            )
            if feature.mode != expected:
                rollout_ready = False
                rollout_reason_code = rollout_reason_code or "mode_mismatch"
            if feature.percentage != 0:
                rollout_ready = False
                rollout_reason_code = (
                    rollout_reason_code or "percentage_must_be_zero"
                )
    if rollout_ready:
        rollout_reason_code = None
    elif rollout_reason_code not in _ROLLOUT_REASON_CODES:
        rollout_reason_code = "invalid_configuration"
    checks.append(_check(
        "rollout_modes",
        rollout_ready,
        mode_counts=mode_counts,
        **(
            {"reason_code": rollout_reason_code}
            if rollout_reason_code is not None else {}
        ),
    ))

    report_settings: RolloutReportSettings | None = None
    try:
        report_settings = RolloutReportSettings.from_environ(env)
    except RolloutReportConfigurationError:
        pass
    checks.append(_check(
        "rollout_report_configuration",
        bool(report_settings and report_settings.enabled),
        enabled=bool(report_settings and report_settings.enabled),
    ))

    try:
        heads = _alembic_heads()
    except Exception:
        heads = ()
    checks.append(_check(
        "alembic_heads",
        len(heads) == 1,
        head_count=len(heads),
    ))
    checks.extend(_database_checks(
        session_factory,
        expected_heads=heads,
    ))

    capability = (
        _validator_capability(triag_settings)
        if triag_settings is not None else "unavailable"
    )
    checks.append(_check(
        "validator_isolation",
        capability in {"static_only", "executable"},
        reachable=capability != "unavailable",
        capability=capability,
    ))

    blocked = sum(1 for item in checks if item["status"] == "block")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if blocked == 0 else "block",
        "blocker_count": blocked,
        "checks": checks,
    }


def render_release_report(report: dict[str, object], *, pretty: bool) -> str:
    return json.dumps(
        report,
        sort_keys=True,
        separators=None if pretty else (",", ":"),
        indent=2 if pretty else None,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run content-free TRIAG production release readiness checks."
    )
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = build_release_report()
    except Exception:
        print("triag_release_check_failed", file=sys.stderr)
        return 1
    print(render_release_report(report, pretty=bool(args.pretty)))
    return 0 if report.get("status") == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
