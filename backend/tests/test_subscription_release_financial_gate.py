from __future__ import annotations

from scripts import subscription_release_check as release


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
