from __future__ import annotations

from dataclasses import dataclass
import re

from .models import QualityCheck


REPOSITORY_PATH_VALIDATOR_VERSION = "2026-08-04.2"
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
    index_complete: bool = True
    validator_version: str = REPOSITORY_PATH_VALIDATOR_VERSION

    @property
    def passed(self) -> bool:
        return not self.invalid_paths

    @property
    def indeterminate(self) -> bool:
        return bool(self.invalid_paths and not self.index_complete)


def evaluate_repository_path_grounding(
    answer: str,
    indexed_file_paths: tuple[str, ...],
    *,
    index_complete: bool = True,
) -> RepositoryPathGrounding:
    allowed = {
        normalize_repository_path(path) for path in indexed_file_paths
    }
    cited = cited_repository_paths(answer)
    return RepositoryPathGrounding(
        cited_paths=cited,
        invalid_paths=tuple(path for path in cited if path not in allowed),
        index_complete=bool(index_complete),
    )


def repository_path_grounding_check(
    answer: str,
    indexed_file_paths: tuple[str, ...],
    *,
    index_complete: bool = True,
) -> QualityCheck:
    result = evaluate_repository_path_grounding(
        answer, indexed_file_paths, index_complete=index_complete,
    )
    status = (
        "warning" if result.indeterminate else
        "passed" if not result.invalid_paths else "failed"
    )
    return QualityCheck(
        "repository_path_grounding",
        status,
        (
            "grounding_indeterminate" if result.indeterminate else
            "nonexistent_file" if result.invalid_paths else ""
        ),
        observations=(
            ("cited_path_count", len(result.cited_paths)),
            ("invalid_path_count", len(result.invalid_paths)),
            ("index_complete", int(result.index_complete)),
            ("validator_version", result.validator_version),
        ),
    )


def append_ungrounded_repository_path_warning(
    answer: str,
    indexed_file_paths: tuple[str, ...],
    *,
    index_complete: bool = True,
) -> tuple[str, bool]:
    """Append a warning without rewriting any generated answer bytes."""
    result = evaluate_repository_path_grounding(
        answer, indexed_file_paths, index_complete=index_complete,
    )
    if not result.invalid_paths or result.indeterminate:
        return str(answer or ""), False
    paths = ", ".join(f"`{path}`" for path in result.invalid_paths[:8])
    warning = f"Repository path verification could not verify: {paths}."
    original = str(answer or "")
    return f"{original.rstrip()}\n\n{warning}" if original.strip() else warning, True
