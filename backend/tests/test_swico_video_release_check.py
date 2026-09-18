from types import SimpleNamespace

from scripts import swico_video_release_check as release_check


class FakeSession:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def get(self, *_args): return object()


def test_enabled_video_with_missing_prerequisite_reports_unsafe_rollout(monkeypatch):
    monkeypatch.setattr(release_check, "settings", lambda: SimpleNamespace(enabled=True, paid=True, worker_digest=""))
    monkeypatch.setattr(release_check, "video_policy_ready", lambda: True)
    monkeypatch.setattr(release_check, "inspect", lambda *_: SimpleNamespace(has_table=lambda _name: True))
    monkeypatch.setattr(release_check, "SessionLocal", lambda: FakeSession())
    monkeypatch.setattr(release_check, "healthy", lambda _row: True)
    monkeypatch.setattr(release_check, "templates_current", lambda *_: True)
    monkeypatch.setattr(release_check, "cache", lambda: SimpleNamespace(health=lambda: {"available": True}))
    monkeypatch.setattr(release_check, "email_delivery_runtime_status", lambda **_: {"configured": True})
    monkeypatch.setenv("RAZORPAY_KEY_ID", "test")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "test")
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", "test")
    result = release_check.check()
    assert result["ready"] is False
    assert result["prerequisites_ready"] is False
    assert result["rollout_safe"] is False
    assert result["release_state"] == "unsafe_enabled_missing_prerequisites"
    assert "worker_token_digest_configured" in result["blocking_checks"]


def test_disabled_video_is_explicitly_pending_not_effectively_paid(monkeypatch):
    monkeypatch.setattr(release_check, "settings", lambda: SimpleNamespace(enabled=False, paid=False, worker_digest=""))
    monkeypatch.setattr(release_check, "video_policy_ready", lambda: False)
    monkeypatch.setattr(release_check, "inspect", lambda *_: SimpleNamespace(has_table=lambda _name: False))
    monkeypatch.setattr(release_check, "SessionLocal", lambda: FakeSession())
    monkeypatch.setattr(release_check, "cache", lambda: SimpleNamespace(health=lambda: {"available": False}))
    monkeypatch.setattr(release_check, "email_delivery_runtime_status", lambda **_: {"configured": False})
    result = release_check.check()
    assert result["ready"] is False
    assert result["rollout_safe"] is True
    assert result["release_state"] == "disabled_pending_prerequisites"
    assert result["paid_configured_enabled"] is False
