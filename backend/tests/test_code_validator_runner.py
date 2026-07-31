from __future__ import annotations

from app.code_validator import runner


class _Process:
    pid = 321
    returncode = 0

    def __init__(self, *, running: bool = False):
        self.running = running

    def poll(self):
        return None if self.running else self.returncode

    def wait(self, timeout=None):
        self.running = False
        return self.returncode

    def kill(self):
        self.running = False


def test_runner_clears_inherited_environment_and_never_uses_shell(
    monkeypatch,
):
    captured = {}

    def popen(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        kwargs["stdout"].write(b"ok")
        return _Process()

    monkeypatch.setattr(runner, "_command", lambda _check: ("/usr/bin/true",))
    monkeypatch.setattr(runner.subprocess, "Popen", popen)
    result = runner.run_allowlisted_check(
        "python_compile",
        files={"main.py": "x = 1"},
        limits=runner.RunnerLimits(),
    )
    assert result.status == "passed"
    assert captured["command"] == ("/usr/bin/true",)
    assert "shell" not in captured
    assert set(captured["env"]) == {
        "PATH", "LANG", "LC_ALL", "HOME", "TMPDIR",
        "PYTHONDONTWRITEBYTECODE", "NO_COLOR",
    }
    assert not any(
        name in captured["env"]
        for name in (
            "OPENAI_API_KEY", "DATABASE_URL", "GOOGLE_APPLICATION_CREDENTIALS",
            "RAZORPAY_KEY_SECRET", "CODE_VALIDATOR_AUTH_TOKEN",
        )
    )


def test_runner_enforces_output_limit_without_returning_output(monkeypatch):
    def popen(_command, **kwargs):
        kwargs["stdout"].write(b"secret-output" * 100)
        return _Process()

    monkeypatch.setattr(runner, "_command", lambda _check: ("/usr/bin/true",))
    monkeypatch.setattr(runner.subprocess, "Popen", popen)
    result = runner.run_allowlisted_check(
        "python_compile",
        files={"main.py": "x = 1"},
        limits=runner.RunnerLimits(output_bytes=32),
    )
    assert result.safe_code == "validation_output_limit"
    assert "secret-output" not in repr(result)


def test_runner_propagates_cancellation_to_process_group(monkeypatch):
    killed = []
    process = _Process(running=True)
    monkeypatch.setattr(runner, "_command", lambda _check: ("/usr/bin/true",))
    monkeypatch.setattr(
        runner.subprocess, "Popen", lambda *_args, **_kwargs: process
    )
    monkeypatch.setattr(
        runner.os, "killpg", lambda pid, signal: killed.append((pid, signal))
    )
    result = runner.run_allowlisted_check(
        "python_compile",
        files={"main.py": "x = 1"},
        limits=runner.RunnerLimits(),
        cancelled=lambda: True,
    )
    assert result.safe_code == "validation_cancelled"
    assert killed and killed[0][0] == process.pid
