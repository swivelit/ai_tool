from __future__ import annotations

from scripts import swico_free_release_check as release


def test_release_configuration_requires_enabled_free_without_exposing_values():
    checks = release.configuration_checks({
        "SWICO_FREE_ENABLED": "false",
        "SWICO_FREE_ROLLOUT_PERCENT": "100",
    })
    by_name = {check.name: check for check in checks}
    assert by_name["swico_free_enabled"].status == "fail"
    assert by_name["rollout_percent"].detail == "100"
    rendered = release.render_report({
        "status": "fail", "blocker_count": 1, "warning_count": 0,
        "checks": [check.__dict__ for check in checks],
    }, pretty=True)
    assert "secret" not in rendered.lower()


def test_release_queue_backlog_is_warning_only_and_content_free():
    checks = release.queue_warning_checks({
        "queued_count": 4,
        "oldest_queue_wait_seconds": 75,
        "transient_laptop_unavailable_count": 1,
        "transient_laptop_busy_count": 0,
    })
    assert checks
    assert all(check.status == "warn" for check in checks)
    rendered = release.render_report({
        "status": "warn", "blocker_count": 0,
        "warning_count": len(checks),
        "checks": [check.__dict__ for check in checks],
        "queue": {"queued_count": 4},
    }, pretty=True)
    assert "queued_count" in rendered
    assert "prompt" not in rendered.lower()
    assert "answer" not in rendered.lower()


def test_release_check_reports_head_and_endpoint_checks_without_printing_content(monkeypatch):
    monkeypatch.setenv("SWICO_FREE_DURABLE_QUEUE_ENABLED", "true")
    monkeypatch.setenv("SWICO_FREE_QUEUE_WORKER_ENABLED", "true")
    monkeypatch.setattr(release, "configuration_checks", lambda: [])
    monkeypatch.setattr(release, "live_runtime_status", lambda: {"worker_running": True})
    monkeypatch.setattr(release, "_database_checks", lambda: (
        [release.Check("alembic_current", "pass", "current")],
        {"repository_head": "7b4c9e1a2d6f", "database_heads": ["7b4c9e1a2d6f"]},
    ))
    monkeypatch.setattr(release, "queue_metrics", lambda session: {
        "queued_count": 0, "running_count": 0, "completed_count": 7,
        "failed_count": 0, "oldest_queue_wait_seconds": 0,
        "transient_laptop_unavailable_count": 0,
        "transient_laptop_busy_count": 0,
    })
    monkeypatch.setattr(release, "_inference_checks", lambda: [
        release.Check("/health", "pass", "ok"),
        release.Check("/v1/embed", "pass", "ok"),
        release.Check("/v1/generate", "pass", "ok"),
        release.Check("/v1/generate/stream", "pass", "ok"),
        release.Check("embedding_dimensions", "pass", "384"),
    ])
    report = release.build_report()
    assert report["status"] == "pass"
    assert report["blocker_count"] == 0
    assert report["repository_head"] == "7b4c9e1a2d6f"
