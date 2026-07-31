from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import os


_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


class ValidatorConfigurationError(RuntimeError):
    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__(
            "Invalid code-validator configuration: " + "; ".join(errors)
        )


def _boolean(
    environ: Mapping[str, str],
    name: str,
    default: bool,
    errors: list[str],
) -> bool:
    value = str(
        environ.get(name, "true" if default else "false") or ""
    ).strip().casefold()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    errors.append(f"{name} must be a boolean")
    return default


def _integer(
    environ: Mapping[str, str],
    name: str,
    default: int,
    minimum: int,
    maximum: int,
    errors: list[str],
) -> int:
    try:
        value = int(str(environ.get(name, default)).strip())
    except (TypeError, ValueError):
        errors.append(f"{name} must be an integer")
        return default
    if not minimum <= value <= maximum:
        errors.append(f"{name} is outside supported bounds")
        return default
    return value


@dataclass(frozen=True)
class ValidatorSettings:
    network_isolated: bool = False
    timeout_seconds: int = 90
    max_output_bytes: int = 65_536

    @classmethod
    def from_environ(
        cls, environ: Mapping[str, str] | None = None,
    ) -> "ValidatorSettings":
        env = os.environ if environ is None else environ
        errors: list[str] = []
        values = cls(
            network_isolated=_boolean(
                env, "CODE_VALIDATOR_NETWORK_ISOLATED", False, errors,
            ),
            timeout_seconds=_integer(
                env, "CODE_VALIDATOR_TIMEOUT_SECONDS", 90, 1, 300, errors,
            ),
            max_output_bytes=_integer(
                env, "CODE_VALIDATOR_MAX_OUTPUT_BYTES",
                65_536, 1_024, 262_144, errors,
            ),
        )
        if errors:
            raise ValidatorConfigurationError(errors)
        return values
