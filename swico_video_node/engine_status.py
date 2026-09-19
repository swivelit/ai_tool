"""Read-only FaceFusion checkout identity and conservative recovery helpers.

The pinned engine is a separate private Git checkout.  This module deliberately
does not reset or clean it, and its status output never includes an absolute
operator path.
"""
from __future__ import annotations

from datetime import datetime, timezone
import os
import platform
from pathlib import Path
import subprocess
import tempfile
import uuid

from .storage import ENGINE_COMMIT, exclusive, root

ENGINE_RELATIVE = Path("engine") / "facefusion"
ENGINE_REMOTE = "https://github.com/facefusion/facefusion.git"
MAX_STATUS_LINES = 20
MAX_STATUS_LINE = 160


def _safe_lines(value: str) -> list[str]:
    lines = []
    for line in value.splitlines()[:MAX_STATUS_LINES]:
        # Git paths are useful to an operator, but never expose the private
        # absolute checkout root or uncontrolled command output.
        clean = " ".join(line.strip().split())
        if clean:
            lines.append(clean[:MAX_STATUS_LINE])
    return lines


def status() -> dict:
    """Return bounded, read-only status for the separate engine checkout."""
    directory = root() / ENGINE_RELATIVE
    report = {
        "expected_commit": ENGINE_COMMIT,
        "path": str(ENGINE_RELATIVE),
        "actual_commit": None,
        "state": "missing",
        "issues": [],
        "tracked_changes": [],
        "untracked_changes": [],
    }
    try:
        if directory.is_symlink():
            report["state"] = "unsafe_path"
            report["issues"] = ["engine_path_symlink"]
            return report
        if not directory.exists():
            return report
        if not directory.is_dir() or (directory / ".git").is_symlink() or not (directory / ".git").is_dir():
            report["state"] = "not_repository"
            report["issues"] = ["engine_not_repository"]
            return report
        commit = subprocess.run(
            ["git", "-C", str(directory), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=15,
        )
        if commit.returncode == 0:
            value = commit.stdout.strip()
            if len(value) == 40 and all(character in "0123456789abcdef" for character in value):
                report["actual_commit"] = value
            else:
                report["issues"].append("engine_commit_unreadable")
        else:
            report["issues"].append("engine_commit_unreadable")
        changes = subprocess.run(
            ["git", "-C", str(directory), "status", "--porcelain", "--untracked-files=all"],
            capture_output=True, text=True, timeout=15,
        )
        if changes.returncode != 0:
            report["issues"].append("engine_status_unavailable")
        else:
            for line in _safe_lines(changes.stdout):
                code = line[:2]
                if code == "??" or (len(code) > 1 and code[1] == "?"):
                    report["untracked_changes"].append(line)
                else:
                    report["tracked_changes"].append(line)
        if report["actual_commit"] != ENGINE_COMMIT:
            report["issues"].append("engine_wrong_revision")
        if report["tracked_changes"]:
            report["issues"].append("engine_tracked_changes")
        if report["untracked_changes"]:
            report["issues"].append("engine_untracked_changes")
        report["issues"] = list(dict.fromkeys(report["issues"]))
        if report["issues"]:
            report["state"] = report["issues"][0]
        else:
            report["state"] = "ready"
        return report
    except (OSError, subprocess.SubprocessError, ValueError):
        report["state"] = "engine_status_unavailable"
        report["issues"] = ["engine_status_unavailable"]
        return report


def _assert_recovery_target(directory: Path) -> None:
    if directory.is_symlink():
        raise ValueError("Engine path is a symlink; inspect it before recovery")
    if directory.exists() and not directory.is_dir():
        raise ValueError("Engine path is not a directory; inspect it before recovery")
    parent = directory.parent
    if parent.is_symlink() or not parent.is_dir():
        raise ValueError("Engine storage parent is unsafe; inspect it before recovery")


def _git(args: list[str], *, timeout: int = 120) -> None:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise ValueError("Pinned engine recovery command failed; preserved state and temporary recovery for inspection")


def recover(*, recreate: bool = False) -> dict:
    """Archive an invalid checkout and recreate only the pinned revision.

    The clone is completed in a private temporary directory before the old
    checkout is moved.  A fetch failure therefore leaves the original intact.
    """
    if not recreate:
        return status()
    directory = root() / ENGINE_RELATIVE
    _assert_recovery_target(directory)
    # Holding this lock proves that the foreground worker is not rendering.
    # A loaded LaunchAgent is checked separately when macOS service commands
    # are available; a waiting/restarting service must be explicitly stopped.
    with exclusive():
        if platform.system() == "Darwin":
            launchctl = Path("/bin/launchctl")
            if launchctl.exists():
                domain = f"gui/{os.getuid()}/in.swico.video-worker"
                probe = subprocess.run([str(launchctl), "print", domain], capture_output=True, text=True, timeout=10)
                if probe.returncode == 0:
                    raise ValueError("LaunchAgent is still loaded; run service stop before engine recovery")
        current = status()
        if current["state"] == "ready":
            return {**current, "recovered": False, "reason": "pinned_engine_already_clean"}

        parent = directory.parent
        temporary = Path(tempfile.mkdtemp(prefix=".facefusion-recovery-", dir=parent))
        os.chmod(temporary, 0o700)
        try:
            _git(["git", "init", temporary])
            _git(["git", "-C", str(temporary), "fetch", "--depth", "1", ENGINE_REMOTE, ENGINE_COMMIT])
            _git(["git", "-C", str(temporary), "checkout", "--detach", ENGINE_COMMIT])
            archive = None
            if directory.exists():
                archive_root = parent / "archives"
                archive_root.mkdir(mode=0o700, exist_ok=True)
                os.chmod(archive_root, 0o700)
                archive = archive_root / f"facefusion-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:12]}"
                directory.rename(archive)
            temporary.rename(directory)
            return {"recovered": True, "state": "ready", "expected_commit": ENGINE_COMMIT,
                    "archived": bool(archive), "archive": "engine/archives/" + archive.name if archive else None}
        except Exception:
            # Keep a failed fetch/recreate tree for diagnosis; never delete an
            # operator checkout or silently fall back to the old revision.
            raise
