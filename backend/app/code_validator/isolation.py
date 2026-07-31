from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import platform
import stat


@dataclass(frozen=True)
class IsolationCapabilities:
    isolation_level: str
    executable_checks: bool
    reason_code: str


def detect_isolation_capabilities(
    *, network_isolated: bool | None = None,
) -> IsolationCapabilities:
    """Fail closed unless deployment positively attests all executable barriers."""

    proof = os.getenv("CODE_VALIDATOR_ISOLATION_PROOF", "").strip()
    if network_isolated is None:
        from .settings import ValidatorSettings

        network_isolated = ValidatorSettings.from_environ().network_isolated
    non_root = hasattr(os, "geteuid") and os.geteuid() != 0
    proof_file = _verified_proof_file(
        os.getenv("CODE_VALIDATOR_ISOLATION_PROOF_FILE", "")
    )
    kernel = _kernel_isolation()
    if (
        platform.system() == "Linux"
        and proof == "linux-namespace-v1"
        and network_isolated
        and non_root
        and proof_file
        and kernel
    ):
        return IsolationCapabilities("executable", True, "isolation_proven")
    return IsolationCapabilities("static_only", False, "executable_isolation_unproven")


def _kernel_isolation() -> bool:
    try:
        status = Path("/proc/self/status").read_text(encoding="utf-8")
    except OSError:
        return False
    values = {
        line.split(":", 1)[0]: line.split(":", 1)[1].strip()
        for line in status.splitlines() if ":" in line
    }
    return values.get("NoNewPrivs") == "1" and values.get("Seccomp") == "2"


def _verified_proof_file(raw_path: str) -> bool:
    path = Path(str(raw_path or ""))
    if not path.is_absolute():
        return False
    try:
        metadata = path.stat()
        if metadata.st_uid != 0 or metadata.st_mode & (
            stat.S_IWGRP | stat.S_IWOTH
        ):
            return False
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return payload == {
        "version": "linux-namespace-v1",
        "outbound_network_blocked": True,
        "process_namespace": True,
        "disposable_workspace": True,
    }
