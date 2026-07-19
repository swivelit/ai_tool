from __future__ import annotations

from scripts import voice_provider_probe


def test_live_voice_probe_refuses_to_run_without_explicit_opt_in(monkeypatch, capsys):
    monkeypatch.delenv("ALLOW_LIVE_SARVAM_VOICE_PROBE", raising=False)
    monkeypatch.setenv("SARVAM_API_KEY", "must-not-be-used")
    called = False

    def forbidden_run(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("live probe must not run")

    monkeypatch.setattr(voice_provider_probe.asyncio, "run", forbidden_run)
    assert voice_provider_probe.main() == 2
    assert called is False
    assert "ALLOW_LIVE_SARVAM_VOICE_PROBE=true" in capsys.readouterr().err


def test_live_voice_probe_requires_provider_key_after_opt_in(monkeypatch, capsys):
    monkeypatch.setenv("ALLOW_LIVE_SARVAM_VOICE_PROBE", "true")
    monkeypatch.delenv("SARVAM_API_KEY", raising=False)
    assert voice_provider_probe.main() == 2
    assert "SARVAM_API_KEY" in capsys.readouterr().err
