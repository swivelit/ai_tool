from __future__ import annotations

from dataclasses import dataclass
import re

from .models import QualityCheck


REPOSITORY_PATH_VALIDATOR_VERSION = "2026-08-04.1"
_PATH_WITH_DIRECTORY = re.compile(
    r"(?<![A-Za-z0-9:/])((?:(?:\.{1,2}/)?[A-Za-z0-9_.-]+/)+"
    r"[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16})(?=$|[\s`'\"),.:;\]])"
)
_BACKTICK_FILE = re.compile(
    r"`((?:\.{0,2}/)?[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,16})`"
)


def normalize_repository_path(value: str) -> str:
    path = str(value or "").strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if path.startswith(("a/", "b/")):
        path = path[2:]
    return path


def cited_repository_paths(answer: str) -> tuple[str, ...]:
    value = str(answer or "")
    candidates = [match.group(1) for match in _PATH_WITH_DIRECTORY.finditer(value)]
    candidates.extend(match.group(1) for match in _BACKTICK_FILE.finditer(value))
    return tuple(dict.fromkeys(
        normalized for item in candidates
        if (normalized := normalize_repository_path(item))
    ))


@dataclass(frozen=True)
class RepositoryPathGrounding:
    cited_paths: tuple[str, ...]
    invalid_paths: tuple[str, ...]
    validator_version: str = REPOSITORY_PATH_VALIDATOR_VERSION

    @property
    def passed(self) -> bool:
        return not self.invalid_paths


def evaluate_repository_path_grounding(
    answer: str,
    indexed_file_paths: tuple[str, ...],
) -> RepositoryPathGrounding:
    allowed = {
        normalize_repository_path(path) for path in indexed_file_paths
    }
    cited = cited_repository_paths(answer)
    return RepositoryPathGrounding(
        cited_paths=cited,
        invalid_paths=tuple(path for path in cited if path not in allowed),
    )


def repository_path_grounding_check(
    answer: str,
    indexed_file_paths: tuple[str, ...],
) -> QualityCheck:
    result = evaluate_repository_path_grounding(answer, indexed_file_paths)
    return QualityCheck(
        "repository_path_grounding",
        "passed" if result.passed else "failed",
        "repository_path_not_indexed" if result.invalid_paths else "",
        observations=(
            ("cited_path_count", len(result.cited_paths)),
            ("invalid_path_count", len(result.invalid_paths)),
            ("validator_version", result.validator_version),
        ),
    )


def strip_ungrounded_repository_path_claims(
    answer: str,
    indexed_file_paths: tuple[str, ...],
) -> tuple[str, bool]:
    result = evaluate_repository_path_grounding(answer, indexed_file_paths)
    if result.passed:
        return str(answer or ""), False
    invalid = set(result.invalid_paths)
    retained: list[str] = []
    for line in str(answer or "").splitlines():
        cited = set(cited_repository_paths(line))
        if cited & invalid:
            continue
        retained.append(line)
    cleaned = "\n".join(retained).strip()
    if not cleaned:
        cleaned = (
            "The requested file was not found in the indexed repository, so "
            "Swico cannot describe it or identify functions that import it."
        )
    return cleaned, True
