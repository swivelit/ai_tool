from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


CheckStatus = Literal["passed", "failed", "skipped", "unavailable", "error"]


@dataclass(frozen=True)
class ValidationCheckResult:
    check_id: str
    category: str
    status: CheckStatus
    safe_code: str = ""


@dataclass(frozen=True)
class RepositoryValidationResult:
    status: Literal["passed", "failed", "unavailable", "static_only"]
    isolation_level: Literal["executable", "static_only", "unavailable"]
    checks: tuple[ValidationCheckResult, ...]
    required_check_ids: tuple[str, ...] = ()

    @property
    def all_required_passed(self) -> bool:
        by_id = {item.check_id: item.status for item in self.checks}
        return bool(self.required_check_ids) and all(
            by_id.get(check_id) == "passed"
            for check_id in self.required_check_ids
        )

    @property
    def safe_summary(self) -> dict[str, object]:
        return {
            "status": self.status,
            "isolation_level": self.isolation_level,
            "checks": [
                {
                    "type": item.category,
                    "status": item.status,
                    "code": item.safe_code,
                }
                for item in self.checks
            ],
            "required_checks_ran": self.all_required_passed,
        }


class ValidatorCheckPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    check_id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")
    category: str = Field(max_length=32)
    status: CheckStatus
    safe_code: str = Field(default="", max_length=80)


class ValidatorResponsePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["passed", "failed", "unavailable", "static_only"]
    isolation_level: Literal["executable", "static_only", "unavailable"]
    checks: list[ValidatorCheckPayload] = Field(max_length=32)
    required_check_ids: list[str] = Field(max_length=24)

    @field_validator("required_check_ids")
    @classmethod
    def valid_required_ids(cls, values: list[str]) -> list[str]:
        if any(not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value) for value in values):
            raise ValueError("invalid required check id")
        return list(dict.fromkeys(values))


def parse_validator_response(payload: object) -> RepositoryValidationResult:
    parsed = ValidatorResponsePayload.model_validate(payload)
    checks = tuple(
        ValidationCheckResult(
            check_id=item.check_id,
            category=item.category,
            status=item.status,
            safe_code=item.safe_code,
        )
        for item in parsed.checks
    )
    return RepositoryValidationResult(
        status=parsed.status,
        isolation_level=parsed.isolation_level,
        checks=checks,
        required_check_ids=tuple(parsed.required_check_ids),
    )


_FILE_BLOCK = re.compile(
    r"```[A-Za-z0-9_+.-]*[ \t]+path=([^\r\n`]+)\r?\n"
    r"(.*?)\r?\n```",
    re.DOTALL,
)


def extract_proposed_files(
    answer: str,
    *,
    allowed_paths: tuple[str, ...],
    max_files: int = 24,
    max_total_characters: int = 2_000_000,
) -> dict[str, str]:
    """Parse a server-defined full-file envelope; never accepts commands."""

    allowed = set(allowed_paths)
    proposed: dict[str, str] = {}
    total = 0
    for raw_path, content in _FILE_BLOCK.findall(str(answer or "")):
        path = PurePosixPath(raw_path.strip())
        normalized = path.as_posix()
        if (
            path.is_absolute() or ".." in path.parts or "\\" in raw_path
            or normalized not in allowed or normalized in proposed
        ):
            continue
        total += len(content)
        if total > max_total_characters or len(proposed) >= max_files:
            return {}
        proposed[normalized] = content
    return proposed
