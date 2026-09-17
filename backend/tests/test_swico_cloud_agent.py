from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from cloud_runner.swico_cloud_agent import execute


def _task(root: Path, actions: list[dict[str, object]]) -> Path:
    task_file = root.parent / f"{root.name}-task.json"
    task_file.write_text(json.dumps({"version": 2, "job_id": "job-test", "attempt_id": "attempt-test", "task": "repair fixture", "actions": actions}))
    return task_file


def test_cloud_agent_returns_reviewable_patch_and_real_test_observation(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    source = workspace / "main.py"
    source.write_text("value = 1\n")
    result = execute(_task(workspace, [
        {"type": "read", "path": "main.py"},
        {"type": "write", "path": "main.py", "content": "value = 2\n", "expected_sha256": hashlib.sha256(b"value = 1\n").hexdigest()},
        {"type": "command", "argv": [sys.executable, "-c", "from pathlib import Path; assert Path('main.py').read_text() == 'value = 2\\n'"]},
    ]), workspace)
    assert result["status"] == "completed"
    assert result["changed_files"] == ["main.py"]
    assert result["artifacts"][0]["kind"] == "patch"
    assert result["tests"][0]["status"] == "succeeded"


def test_cloud_agent_does_not_turn_a_failed_command_into_success(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    result = execute(_task(workspace, [{"type": "command", "argv": [sys.executable, "-c", "raise SystemExit(3)"]}]), workspace)
    assert result["status"] == "failed"
    assert result["failure_code"] == "test_failed"
    assert result["tests"][0]["exit_code"] == 3
