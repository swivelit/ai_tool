from __future__ import annotations

from types import SimpleNamespace

from scripts import subscription_release_check as release
from app import alembic_utils


def test_subscription_revision_is_current_head_or_ancestor_of_current_head():
    required = release.REQUIRED_SUBSCRIPTION_REVISION
    assert alembic_utils.repository_alembic_revision_is_ancestor(
        required, required,
    ) is True
    assert alembic_utils.repository_alembic_revision_is_ancestor(
        required, "c7e4a1b9d2f6",
    ) is True


def test_subscription_revision_ancestry_uses_graph_for_future_descendants(monkeypatch):
    class FutureScript:
        @staticmethod
        def iterate_revisions(upper, lower):
            assert upper == "future-revision"
            assert lower == release.REQUIRED_SUBSCRIPTION_REVISION
            return iter([
                SimpleNamespace(
                    revision="future-revision",
                    down_revision=release.REQUIRED_SUBSCRIPTION_REVISION,
                ),
                SimpleNamespace(
                    revision=release.REQUIRED_SUBSCRIPTION_REVISION,
                    down_revision="older-revision",
                ),
            ])

    monkeypatch.setattr(alembic_utils, "repository_alembic_script", lambda: FutureScript())
    assert alembic_utils.repository_alembic_revision_is_ancestor(
        release.REQUIRED_SUBSCRIPTION_REVISION, "future-revision",
    ) is True


def test_subscription_revision_absent_from_ancestry_is_not_ready():
    assert alembic_utils.repository_alembic_revision_is_ancestor(
        release.REQUIRED_SUBSCRIPTION_REVISION, "7b4c9e1a2d6f",
    ) is False


def test_migration_readiness_accepts_required_revision_as_current_head(monkeypatch):
    monkeypatch.setattr(release, "repository_alembic_revision_is_ancestor", lambda *_: True)
    readiness, blockers = release._migration_readiness(
        repository_head=release.REQUIRED_SUBSCRIPTION_REVISION,
        database_head=release.REQUIRED_SUBSCRIPTION_REVISION,
        missing_tables=[],
        constraints_ready=True,
    )
    assert blockers == 0
    assert readiness["repository_database_heads_match"] is True
    assert readiness["subscription_revision_present"] is True
    assert readiness["subscription_revision_ready"] is True


def test_migration_readiness_accepts_guest_session_descendant(monkeypatch):
    monkeypatch.setattr(release, "repository_alembic_revision_is_ancestor", lambda *_: True)
    readiness, blockers = release._migration_readiness(
        repository_head="c7e4a1b9d2f6",
        database_head="c7e4a1b9d2f6",
        missing_tables=[],
        constraints_ready=True,
    )
    assert blockers == 0
    assert readiness["repository_database_heads_match"] is True
    assert readiness["required_subscription_revision"] == "b8f2c7d1e4a9"
    assert readiness["subscription_revision_ready"] is True


def test_migration_head_mismatch_is_one_blocker_and_not_two(monkeypatch):
    monkeypatch.setattr(release, "repository_alembic_revision_is_ancestor", lambda *_: True)
    readiness, blockers = release._migration_readiness(
        repository_head="c7e4a1b9d2f6",
        database_head="b8f2c7d1e4a9",
        missing_tables=[],
        constraints_ready=True,
    )
    assert blockers == 1
    assert readiness["repository_database_heads_match"] is False
    assert readiness["subscription_revision_ready"] is True


def test_migration_readiness_blocks_missing_revision_tables_and_constraints(monkeypatch):
    monkeypatch.setattr(release, "repository_alembic_revision_is_ancestor", lambda *_: False)
    readiness, blockers = release._migration_readiness(
        repository_head="future-revision",
        database_head="future-revision",
        missing_tables=["subscription_entitlement"],
        constraints_ready=False,
    )
    assert blockers == 2
    assert readiness["subscription_revision_ready"] is False
    assert readiness["missing_tables"] == ["subscription_entitlement"]
    # Missing tables already explain why their constraints cannot be inspected.
    readiness, blockers = release._migration_readiness(
        repository_head="future-revision",
        database_head="future-revision",
        missing_tables=[],
        constraints_ready=False,
    )
    assert blockers == 2


def test_abandoned_checkout_findings_are_informational_when_not_actionable():
    summary = release.financial_integrity_summary({
        "findings": [{
            "category": "abandoned_checkout_order",
            "severity": "info",
            "actionable": False,
            "count": 203,
        }],
        "actionable_finding_count": 0,
    })
    assert summary["counts_by_category"]["abandoned_checkout_order"] == 203
    assert summary["actionable_finding_count"] == 0
    assert summary["ready"] is True


def test_release_gate_blocks_actionable_financial_audit(monkeypatch):
    monkeypatch.setattr(
        release,
        "financial_audit",
        lambda _session: {
            "findings": [
                {
                    "category": "captured_payment_uncredited",
                    "severity": "high",
                    "actionable": True,
                    "count": 1,
                }
            ],
            "actionable_finding_count": 1,
        },
    )
    report = release.build_report()
    assert report["financial_integrity"]["captured_payment_uncredited"] == 1
    assert report["financial_integrity"]["ready"] is False
    assert report["blocker_count"] > 0


def test_release_gate_fails_closed_when_financial_audit_cannot_run(monkeypatch):
    def fail(_session):
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(release, "financial_audit", fail)
    report = release.build_report()
    assert report["financial_integrity"]["status"] == "unavailable"
    assert report["financial_integrity"]["actionable_finding_count"] is None
    assert report["financial_integrity"]["ready"] is False
    assert report["blocker_count"] > 0
