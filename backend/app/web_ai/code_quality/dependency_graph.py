from __future__ import annotations

from dataclasses import dataclass

from .repository_contract import RepositoryDependency


@dataclass(frozen=True)
class DependencyGraph:
    edges: tuple[RepositoryDependency, ...]

    def __post_init__(self) -> None:
        if len(self.edges) > 100_000:
            raise ValueError("repository dependency graph exceeds the bound")

    def neighbors(
        self, values: set[str], *, limit: int = 80
    ) -> tuple[RepositoryDependency, ...]:
        bounded = max(1, min(500, int(limit)))
        normalized = {str(value).casefold() for value in values if value}
        ranked = [
            edge
            for edge in self.edges
            if edge.source.casefold() in normalized
            or edge.target.casefold() in normalized
            or any(
                token in edge.source.casefold()
                or token in edge.target.casefold()
                for token in normalized
            )
        ]
        return tuple(sorted(
            ranked,
            key=lambda edge: (edge.kind, edge.source, edge.target),
        )[:bounded])


def deduplicate_edges(
    edges: list[RepositoryDependency],
) -> tuple[RepositoryDependency, ...]:
    unique = {
        (edge.source, edge.target, edge.kind): edge for edge in edges
    }
    return tuple(
        unique[key] for key in sorted(unique)
    )
