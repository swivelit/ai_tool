"""Source-controlled bounded action executor for the isolated Cloud sandbox.

The trusted controller supplies already-authorized structured actions in the
task envelope. This process never receives model credentials or Swico tokens.
An empty action plan fails explicitly instead of turning a task-only echo into
a successful coding result.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from typing import Any

MAX_OUTPUT = 64 * 1024
MAX_ACTIONS = 32


def _safe_path(workspace: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value or len(value) > 512 or "\x00" in value:
        raise ValueError("invalid workspace path")
    candidate = (workspace / value.replace("\\", "/")).resolve()
    if candidate != workspace and workspace not in candidate.parents:
        raise ValueError("path is outside workspace")
    relative = candidate.relative_to(workspace).as_posix()
    if relative in {".swico-task.json", ".swico-result.json", ".swico-cloud-agent.py"} or any(part == ".git" or part.startswith(".env") or part in {".swico", ".npmrc", ".pypirc"} for part in candidate.relative_to(workspace).parts):
        raise ValueError("protected workspace path")
    return candidate


def _run(argv: Any, workspace: Path, timeout: float = 30.0) -> dict[str, Any]:
    if not isinstance(argv, list) or not argv or len(argv) > 32 or not all(isinstance(item, str) and item and len(item) <= 256 for item in argv):
        raise ValueError("invalid command")
    environment = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/swico-home", "LANG": "C.UTF-8"}
    kwargs: dict[str, Any] = {"cwd": workspace, "env": environment, "stdin": subprocess.DEVNULL, "stdout": subprocess.PIPE, "stderr": subprocess.PIPE, "text": True}
    if os.name != "nt": kwargs["start_new_session"] = True
    try:
        process = subprocess.Popen(argv, **kwargs)
        try:
            stdout, stderr = process.communicate(timeout=max(1.0, min(180.0, float(timeout))))
        except subprocess.TimeoutExpired:
            if os.name != "nt": os.killpg(process.pid, signal.SIGTERM)
            else: process.terminate()
            stdout, stderr = process.communicate(timeout=3)
            return {"status": "timeout", "exit_code": None, "stdout": stdout[-MAX_OUTPUT:], "stderr": stderr[-MAX_OUTPUT:]}
    except OSError as exc:
        return {"status": "tool_error", "exit_code": None, "stdout": "", "stderr": str(exc)[:MAX_OUTPUT]}
    return {"status": "succeeded" if process.returncode == 0 else "failed", "exit_code": process.returncode, "stdout": stdout[-MAX_OUTPUT:], "stderr": stderr[-MAX_OUTPUT:]}


def _git_output(workspace: Path, args: list[str], limit: int = 2 * 1024 * 1024) -> str:
    result = subprocess.run(["git", *args], cwd=workspace, env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/swico-home"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15, check=False)
    if result.returncode != 0: return ""
    return result.stdout[:limit]


def execute(task_file: Path, workspace: Path) -> dict[str, Any]:
    envelope = json.loads(task_file.read_text(encoding="utf-8"))
    if envelope.get("version") != 2 or not isinstance(envelope.get("actions"), list) or len(envelope["actions"]) > MAX_ACTIONS:
        raise ValueError("unsupported or oversized cloud action envelope")
    actions = envelope["actions"]
    if not actions:
        return {"protocol": "swico-cloud-result-v1", "status": "failed", "failure_code": "planning_actions_unavailable", "summary": "The trusted controller supplied no executable plan; no repository action was run.", "job_id": envelope.get("job_id"), "attempt_id": envelope.get("attempt_id"), "tests": [], "changed_files": [], "patch": "", "patch_sha256": hashlib.sha256(b"").hexdigest(), "logs": []}
    logs: list[dict[str, Any]] = []
    tests: list[dict[str, Any]] = []
    command_failed = False
    # A fresh E2B workspace is not assumed to contain the user's .git
    # administration. Create a private review base so the result is a real
    # patch, while never importing host Git configuration or hooks.
    _run(["git", "init", "-q"], workspace)
    _run(["git", "config", "user.email", "swico-cloud@invalid"], workspace)
    _run(["git", "config", "user.name", "Swico Cloud"], workspace)
    _run(["git", "add", "-A"], workspace)
    _run(["git", "commit", "--allow-empty", "-qm", "snapshot base"], workspace)
    for index, action in enumerate(actions):
        if not isinstance(action, dict) or not isinstance(action.get("type"), str): raise ValueError("malformed cloud action")
        kind = action["type"]
        if kind == "read":
            path = _safe_path(workspace, action.get("path")); data = path.read_bytes()
            if len(data) > 256 * 1024: raise ValueError("read result exceeds bound")
            logs.append({"step": index, "action": kind, "path": path.relative_to(workspace).as_posix(), "bytes": len(data)})
        elif kind in {"write", "create"}:
            path = _safe_path(workspace, action.get("path")); content = action.get("content")
            if not isinstance(content, str) or len(content.encode()) > 2 * 1024 * 1024: raise ValueError("write content exceeds bound")
            expected = action.get("expected_sha256")
            if path.exists() and expected and hashlib.sha256(path.read_bytes()).hexdigest() != expected: raise ValueError("stale write hash")
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content, encoding="utf-8")
            logs.append({"step": index, "action": kind, "path": path.relative_to(workspace).as_posix()})
        elif kind == "command":
            result = _run(action.get("argv"), workspace, action.get("timeout", 30)); command_failed = command_failed or result["status"] != "succeeded"; logs.append({"step": index, "action": kind, **result})
            tests.append({"argv": action.get("argv"), **result})
        else: raise ValueError("unsupported cloud action")
    patch = _git_output(workspace, ["diff", "--binary", "--find-renames", "HEAD"])
    status = _git_output(workspace, ["status", "--porcelain=v1"])
    changed = [line[3:] for line in status.splitlines() if len(line) > 3]
    patch_bytes = patch.encode("utf-8", errors="replace")
    return {"protocol": "swico-cloud-result-v1", "status": "failed" if command_failed else "completed", "failure_code": "test_failed" if command_failed else None, "summary": str(envelope.get("task", ""))[:1_000], "job_id": envelope.get("job_id"), "attempt_id": envelope.get("attempt_id"), "tests": tests[-MAX_ACTIONS:], "changed_files": changed[:500], "patch_sha256": hashlib.sha256(patch_bytes).hexdigest(), "artifacts": [{"kind": "patch", "content_type": "text/x-diff", "content_base64": __import__("base64").b64encode(patch_bytes).decode("ascii"), "sha256": hashlib.sha256(patch_bytes).hexdigest()}] if patch_bytes else [], "logs": logs[-MAX_ACTIONS:]}


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--task-file", required=True); parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    try: result = execute(Path(args.task_file), Path(args.workspace).resolve())
    except Exception as exc: result = {"protocol": "swico-cloud-result-v1", "status": "failed", "failure_code": "agent_protocol_error", "summary": str(exc)[:240], "logs": []}
    encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=False)
    try: (Path(args.workspace) / ".swico-result.json").write_text(encoded, encoding="utf-8")
    except OSError: pass
    print(encoded)
    return 0 if result.get("status") == "completed" else 1


if __name__ == "__main__": sys.exit(main())
