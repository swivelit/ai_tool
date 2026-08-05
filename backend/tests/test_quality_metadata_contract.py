from __future__ import annotations

import ast
from pathlib import Path

from app.web_ai.generation.repository_grounding import (
    repository_path_grounding_check,
)
from app.web_ai.telemetry.metadata import (
    allowed_metadata_keys,
    sanitize_metadata,
)


GENERATION_ROOT = (
    Path(__file__).resolve().parents[1] / "app" / "web_ai" / "generation"
)


def _quality_check_observation_keys(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    assignments: dict[str, ast.AST] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            targets = node.targets
            value = node.value
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
            value = node.value
        else:
            continue
        for target in targets:
            if isinstance(target, ast.Name) and value is not None:
                assignments[target.id] = value

    def collect(node: ast.AST, seen: frozenset[str] = frozenset()) -> set[str]:
        if isinstance(node, ast.Name) and node.id in assignments:
            if node.id in seen:
                return set()
            return collect(assignments[node.id], seen | {node.id})
        found: set[str] = set()
        if (
            isinstance(node, (ast.Tuple, ast.List))
            and len(node.elts) == 2
            and isinstance(node.elts[0], ast.Constant)
            and isinstance(node.elts[0].value, str)
        ):
            found.add(node.elts[0].value)
        for child in ast.iter_child_nodes(node):
            found.update(collect(child, seen))
        return found

    keys: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function_name = (
            node.func.id if isinstance(node.func, ast.Name)
            else node.func.attr if isinstance(node.func, ast.Attribute)
            else ""
        )
        if function_name != "QualityCheck":
            continue
        for keyword in node.keywords:
            if keyword.arg == "observations":
                keys.update(collect(keyword.value))
    return keys


def test_repository_grounding_observations_sanitize_cleanly():
    check = repository_path_grounding_check(
        "See `src/real.py` and `src/missing.py`.",
        ("src/real.py",),
        index_complete=True,
    )
    observations = dict(check.observations)
    assert observations == {
        "cited_path_count": 2,
        "invalid_path_count": 1,
        "index_complete": 1,
        "validator_version": "2026-08-04.2",
    }
    assert sanitize_metadata(observations) == observations


def test_every_generation_quality_observation_key_is_allowlisted():
    emitted = set().union(*(
        _quality_check_observation_keys(path)
        for path in GENERATION_ROOT.glob("*.py")
    ))
    assert emitted
    assert emitted <= allowed_metadata_keys()
