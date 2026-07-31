from __future__ import annotations

import json

from scripts import triag_release_check
from tests.test_production_config import valid_environment


def _release_environment() -> dict[str, str]:
    return {
        **valid_environment(),
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_TRIAG_RELEASE_STATE": "general_availability",
        "WEB_RAG_HYBRID_ENABLED": "true",
        "WEB_ROLLOUT_POLICY_VERSION": "v1",
        "WEB_ROLLOUT_TRIAG_MODE": "all_eligible",
        "WEB_ROLLOUT_TRIAG_PERCENT": "0",
        "WEB_ROLLOUT_KNOWLEDGE_MODE": "disabled",
        "WEB_ROLLOUT_KNOWLEDGE_PERCENT": "0",
        "WEB_ROLLOUT_REPOSITORY_MODE": "disabled",
        "WEB_ROLLOUT_REPOSITORY_PERCENT": "0",
        "WEB_ROLLOUT_ANSWER_GUARD_MODE": "disabled",
        "WEB_ROLLOUT_ANSWER_GUARD_PERCENT": "0",
        "WEB_TRIAG_ROLLOUT_REPORT_ENABLED": "true",
        "WEB_CODE_VALIDATOR_URL": "http://private-validator:10001",
        "WEB_CODE_VALIDATOR_AUTH_TOKEN": "v" * 32,
    }


def _passing_database_checks(*_args, **_kwargs):
    return (
        triag_release_check._check("database_access", True),
        triag_release_check._check(
            "alembic_current", True, current_count=1, matches_head=True
        ),
        triag_release_check._check(
            "required_triag_tables",
            True,
            required_count=14,
            present_count=14,
        ),
        triag_release_check._check(
            "knowledge_job_status_counts",
            True,
            counts=[],
            failed_count=0,
            unknown_status_count=0,
        ),
    )


def test_release_check_success_report_is_content_free(monkeypatch):
    monkeypatch.setattr(
        triag_release_check, "_alembic_heads", lambda: ("head",)
    )
    monkeypatch.setattr(
        triag_release_check, "_database_checks", _passing_database_checks
    )
    monkeypatch.setattr(
        triag_release_check,
        "_validator_capability",
        lambda _settings: "static_only",
    )
    report = triag_release_check.build_release_report(
        _release_environment()
    )
    assert report["status"] == "pass"
    assert report["blocker_count"] == 0
    validator = next(
        item for item in report["checks"]
        if item["name"] == "validator_isolation"
    )
    assert validator == {
        "name": "validator_isolation",
        "status": "pass",
        "reachable": True,
        "capability": "static_only",
    }
    rendered = triag_release_check.render_release_report(
        report, pretty=True
    )
    for forbidden in (
        "private-validator",
        "configured",
        "rzp_test_configured",
        '"user_id"',
        '"email"',
        '"request_id"',
        '"provider"',
        '"model"',
    ):
        assert forbidden not in rendered


def test_release_check_failure_is_nonzero(monkeypatch, capsys):
    monkeypatch.setattr(
        triag_release_check,
        "build_release_report",
        lambda: {"status": "block", "blocker_count": 1, "checks": []},
    )
    assert triag_release_check.main(["--pretty"]) == 1
    output = json.loads(capsys.readouterr().out)
    assert output["status"] == "block"


def test_release_check_success_exit_code(monkeypatch, capsys):
    monkeypatch.setattr(
        triag_release_check,
        "build_release_report",
        lambda: {"status": "pass", "blocker_count": 0, "checks": []},
    )
    assert triag_release_check.main([]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "pass"


def test_release_check_never_prints_private_failures(monkeypatch):
    secret = "DATABASE-SECRET-private@example.com raw customer source"

    class FailingSessionFactory:
        def __call__(self):
            raise RuntimeError(secret)

    monkeypatch.setattr(
        triag_release_check, "_alembic_heads", lambda: ("head",)
    )
    monkeypatch.setattr(
        triag_release_check,
        "_validator_capability",
        lambda _settings: "unavailable",
    )
    report = triag_release_check.build_release_report(
        {
            **_release_environment(),
            "PRIVATE_SOURCE_TEXT": secret,
            "PRIVATE_USER_EMAIL": "private@example.com",
        },
        session_factory=FailingSessionFactory(),
    )
    rendered = triag_release_check.render_release_report(
        report, pretty=False
    )
    assert report["status"] == "block"
    for forbidden in (
        secret,
        "private@example.com",
        "raw customer source",
        "DATABASE-SECRET",
    ):
        assert forbidden not in rendered


def test_controlled_or_percentage_configuration_blocks_direct_ga(monkeypatch):
    monkeypatch.setattr(
        triag_release_check, "_alembic_heads", lambda: ("head",)
    )
    monkeypatch.setattr(
        triag_release_check, "_database_checks", _passing_database_checks
    )
    monkeypatch.setattr(
        triag_release_check,
        "_validator_capability",
        lambda _settings: "static_only",
    )
    report = triag_release_check.build_release_report({
        **_release_environment(),
        "WEB_TRIAG_RELEASE_STATE": "controlled",
        "WEB_ROLLOUT_TRIAG_MODE": "percentage",
        "WEB_ROLLOUT_TRIAG_PERCENT": "10",
    })
    assert report["status"] == "block"
    blocked = {
        item["name"] for item in report["checks"]
        if item["status"] == "block"
    }
    assert {"release_state", "rollout_modes"}.issubset(blocked)
    rollout = next(
        item for item in report["checks"]
        if item["name"] == "rollout_modes"
    )
    assert rollout["reason_code"] == "mode_mismatch"


def test_release_check_rollout_configuration_reason_is_bounded(monkeypatch):
    monkeypatch.setattr(
        triag_release_check, "_alembic_heads", lambda: ("head",)
    )
    monkeypatch.setattr(
        triag_release_check, "_database_checks", _passing_database_checks
    )
    monkeypatch.setattr(
        triag_release_check,
        "_validator_capability",
        lambda _settings: "static_only",
    )
    report = triag_release_check.build_release_report({
        **_release_environment(),
        "WEB_ROLLOUT_TRIAG_PERCENT": "100",
    })
    rollout = next(
        item for item in report["checks"]
        if item["name"] == "rollout_modes"
    )
    assert rollout["status"] == "block"
    assert rollout["reason_code"] == "invalid_configuration"
    rendered = triag_release_check.render_release_report(
        report, pretty=False
    )
    assert '"100"' not in rendered
