from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os
import re

from .tier_policy import validated_tier_policies


_TRUE = {"1", "true", "yes", "y", "on"}
_FALSE = {"0", "false", "no", "n", "off"}
_POLICY_VERSION = re.compile(r"^v[1-9][0-9]{0,3}$")


class TriagConfigurationError(RuntimeError):
    """Configuration failure containing variable names, never their values."""

    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__("Invalid TRIAG configuration: " + "; ".join(errors))


def _parse_bool(
    environ: Mapping[str, str], name: str, default: bool, errors: list[str]
) -> bool:
    raw = str(
        environ.get(name, "true" if default else "false") or ""
    ).strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    errors.append(f"{name} must be a boolean")
    return default


@dataclass(frozen=True)
class TriagSettings:
    enabled: bool = False
    shadow_mode: bool = True
    policy_version: str = "v1"

    @classmethod
    def from_environ(
        cls, environ: Mapping[str, str] | None = None
    ) -> "TriagSettings":
        env = os.environ if environ is None else environ
        errors: list[str] = []
        enabled = _parse_bool(env, "WEB_TRIAG_ENABLED", False, errors)
        shadow = _parse_bool(env, "WEB_TRIAG_SHADOW_MODE", True, errors)
        policy_version = str(
            env.get("WEB_TRIAG_POLICY_VERSION", "v1") or ""
        ).strip()
        if not _POLICY_VERSION.fullmatch(policy_version):
            errors.append("WEB_TRIAG_POLICY_VERSION must be a bounded version id")
        try:
            validated_tier_policies()
        except ValueError:
            errors.append("TRIAG tier-policy defaults are invalid")
        if errors:
            raise TriagConfigurationError(errors)
        return cls(
            enabled=enabled,
            shadow_mode=shadow,
            policy_version=policy_version,
        )

    @property
    def shadow_planning_enabled(self) -> bool:
        return self.enabled and self.shadow_mode

    @property
    def runtime_status(self) -> dict[str, object]:
        if not self.enabled:
            status = "disabled"
        elif self.shadow_mode:
            status = "shadow"
        else:
            # Phase 1 intentionally has no live activation path.
            status = "configured_inactive"
        return {
            "status": status,
            "enabled": self.enabled,
            "shadow_mode": self.shadow_mode,
            "policy_version": self.policy_version,
        }
