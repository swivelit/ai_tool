from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable
import os
from pathlib import Path
import resource
import shutil
import signal
import subprocess
import sys
import tempfile


@dataclass(frozen=True)
class RunnerLimits:
    timeout_seconds: int = 90
    memory_bytes: int = 536_870_912
    cpu_seconds: int = 60
    process_count: int = 64
    file_size_bytes: int = 10_485_760
    output_bytes: int = 65_536


@dataclass(frozen=True)
class RunnerResult:
    status: str
    safe_code: str


def _limits(value: RunnerLimits):
    def apply() -> None:
        os.setsid()
        resource.setrlimit(resource.RLIMIT_CPU, (value.cpu_seconds, value.cpu_seconds))
        resource.setrlimit(resource.RLIMIT_AS, (value.memory_bytes, value.memory_bytes))
        resource.setrlimit(resource.RLIMIT_NPROC, (value.process_count, value.process_count))
        resource.setrlimit(
            resource.RLIMIT_FSIZE,
            (value.file_size_bytes, value.file_size_bytes),
        )
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


def _tool(name: str) -> str | None:
    trusted_path = "/usr/local/bin:/usr/bin:/bin"
    return shutil.which(name, path=trusted_path)


def _command(check_id: str) -> tuple[str, ...] | None:
    # These templates are server owned. No request field can alter argv.
    python = sys.executable
    commands: dict[str, tuple[str, ...] | None] = {
        "python_compile": (python, "-m", "compileall", "-q", "."),
        "python_lint": (
            (_tool("ruff"), "check", ".") if _tool("ruff") else None
        ),
        "python_typecheck": (
            (_tool("mypy"), ".") if _tool("mypy") else None
        ),
        "python_pytest": (
            python, "-m", "pytest", "-q", "--disable-warnings", "--maxfail=1",
        ),
        "typescript_typecheck": (
            (_tool("tsc"), "--noEmit", "--pretty", "false")
            if _tool("tsc") else None
        ),
        "typescript_lint": (
            (_tool("eslint"), ".") if _tool("eslint") else None
        ),
        "typescript_tests": None,
        "typescript_build": None,
        "migration_upgrade": (
            python, "-m", "alembic", "-c", "alembic.ini", "upgrade", "head",
        ),
        "authorization_tests": (
            python, "-m", "pytest", "-q", "--disable-warnings",
            "--maxfail=1", "-k", "authorization or owner or permission",
        ),
    }
    return commands.get(check_id)


def run_allowlisted_check(
    check_id: str,
    *,
    files: dict[str, str],
    limits: RunnerLimits,
    cancelled: Callable[[], bool] | None = None,
) -> RunnerResult:
    command = _command(check_id)
    if command is None:
        return RunnerResult("skipped", "allowlisted_tool_unavailable")
    with tempfile.TemporaryDirectory(prefix="swico-validator-") as directory:
        root = Path(directory).resolve()
        for relative, content in files.items():
            target = (root / relative).resolve()
            if root not in target.parents:
                return RunnerResult("failed", "unsafe_workspace_path")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        environment = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "HOME": str(root / ".home"),
            "TMPDIR": str(root / ".tmp"),
            "PYTHONDONTWRITEBYTECODE": "1",
            "NO_COLOR": "1",
        }
        if check_id == "migration_upgrade":
            environment["DATABASE_URL"] = (
                f"sqlite:///{(root / '.validator.sqlite').as_posix()}"
            )
        Path(environment["HOME"]).mkdir()
        Path(environment["TMPDIR"]).mkdir()
        process: subprocess.Popen[bytes] | None = None
        try:
            output_file = tempfile.TemporaryFile(dir=root)
            process = subprocess.Popen(
                command,
                cwd=root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=output_file,
                stderr=subprocess.STDOUT,
                start_new_session=False,
                preexec_fn=_limits(limits) if os.name == "posix" else None,
            )
            deadline = __import__("time").monotonic() + limits.timeout_seconds
            while process.poll() is None:
                if cancelled and cancelled():
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    return RunnerResult("failed", "validation_cancelled")
                remaining = deadline - __import__("time").monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(command, limits.timeout_seconds)
                try:
                    process.wait(timeout=min(0.1, remaining))
                except subprocess.TimeoutExpired:
                    continue
            return_code = process.returncode
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
        except subprocess.TimeoutExpired:
            if process is not None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except OSError:
                    process.kill()
                process.communicate()
            return RunnerResult("failed", "validation_timeout")
        except (OSError, ValueError):
            return RunnerResult("failed", "validation_process_error")
        output_file.seek(0)
        output = output_file.read(limits.output_bytes + 1)
        output_file.close()
        if len(output) > limits.output_bytes:
            return RunnerResult("failed", "validation_output_limit")
        return RunnerResult(
            "passed" if return_code == 0 else "failed",
            "" if return_code == 0 else "validation_check_failed",
        )
