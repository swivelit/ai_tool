from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
from pathlib import PurePosixPath
import re

from ..code_quality.dependency_graph import DependencyGraph
from ..code_quality.repository_contract import (
    RepositoryContract,
    RepositoryFileRange,
)
from ..code_quality.repository_index import RepositoryIndex
from ..evidence.models import EvidenceItem, EvidencePack


_QUERY_TOKEN = re.compile(r"[A-Za-z_$][A-Za-z0-9_$.-]{1,127}")


@dataclass(frozen=True)
class RepositoryRetrievalResult:
    contract: RepositoryContract
    evidence_pack: EvidencePack


def _query_terms(query: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys(
        value.casefold()
        for value in _QUERY_TOKEN.findall(str(query or ""))[:64]
    ))


def retrieve_repository_contract(
    *,
    owner_user_id: int,
    request_id: str,
    repository_id: str,
    source_version: str,
    index: RepositoryIndex,
    query: str,
    token_cap: int,
    evidence_item_limit: int,
    required_validation_categories: tuple[str, ...] = (),
) -> RepositoryRetrievalResult:
    terms = _query_terms(query)

    def file_score(path: str) -> tuple[int, str]:
        folded = path.casefold()
        name = PurePosixPath(path).name.casefold()
        score = sum(
            12 if term == folded or term == name else
            8 if term in name else
            3 if term in folded else 0
            for term in terms
        )
        if "test" in folded:
            score += 2
        if name in {
            "package.json", "pyproject.toml", "requirements.txt",
            "tsconfig.json",
        }:
            score += 2
        return (-score, path)

    ranked_files = sorted(index.files, key=lambda item: file_score(item.path))
    selected_files = ranked_files[: min(24, max(2, evidence_item_limit * 2))]
    selected_paths = {item.path for item in selected_files}

    def symbol_score(item) -> tuple[int, str, int]:
        name = item.name.casefold()
        signature = item.signature.casefold()
        score = sum(
            20 if term == name else
            10 if term in name else
            5 if term in signature else
            0
            for term in terms
        )
        if item.path in selected_paths:
            score += 3
        return (-score, item.path, item.start_line)

    symbols = tuple(sorted(index.symbols, key=symbol_score)[:96])
    graph_terms = {
        item.path for item in selected_files
    } | {item.name for item in symbols[:24]}
    edges = DependencyGraph(index.edges).neighbors(graph_terms, limit=160)
    target_candidates = {
        item.path for item in selected_files
        if any(
            term == item.path.casefold()
            or term == PurePosixPath(item.path).name.casefold()
            or ("." in term and term in PurePosixPath(item.path).name.casefold())
            for term in terms
        )
    }
    target_candidates.update(
        item.path for item in symbols
        if any(
            term == item.name.casefold()
            or (
                len(term) >= 4
                and term not in {"code", "file", "test", "tests"}
                and term in item.name.casefold()
            )
            for term in terms
        )
    )
    query_folded = str(query or "").casefold()
    unchanged_files = tuple(sorted(
        item.path for item in index.files
        if (
            re.search(
                rf"\b(?:do not|don't|must not)\s+change\s+"
                rf"{re.escape(item.path.casefold())}\b",
                query_folded,
            )
            or re.search(
                rf"\b{re.escape(item.path.casefold())}\b"
                rf".{{0,30}}\b(?:unchanged|untouched)\b",
                query_folded,
            )
        )
    ))[:48]
    target_candidates.difference_update(unchanged_files)
    target_files = tuple(sorted(target_candidates))[:24]
    relevant = tuple(
        RepositoryFileRange(
            path=item.path,
            language=item.language,
            start_line=1,
            end_line=min(item.line_count, 2_000),
            content_hash=item.content_hash,
        )
        for item in selected_files
    )
    contract = RepositoryContract(
        repository_id=repository_id,
        source_version=source_version,
        detected_languages=index.languages,
        frameworks=index.frameworks,
        dependency_versions=index.dependency_versions,
        tool_versions=index.tool_versions,
        relevant_files=relevant,
        public_symbols=symbols,
        dependencies=edges,
        validation_capabilities=tuple(
            replace(
                item,
                required=(
                    item.category in required_validation_categories
                ),
            )
            for item in index.validation_capabilities
        ),
        target_files=target_files,
        unchanged_files=unchanged_files,
    )

    # Evidence text remains request-local. Source summaries use only safe path
    # and line locators.
    items: list[EvidenceItem] = []
    total_tokens = 0
    for position, item in enumerate(selected_files[:evidence_item_limit], 1):
        remaining = max(0, token_cap - total_tokens)
        if remaining < 32:
            break
        text = item.text[: remaining * 4]
        token_count = max(1, min(remaining, len(text) // 4 + 1))
        excerpt_end_line = min(
            item.line_count, 2_000, max(1, text.count("\n") + 1)
        )
        locator = f"{item.path}:1-{excerpt_end_line}"
        items.append(EvidenceItem(
            evidence_id=hashlib.sha256(
                f"{request_id}:{position}:{item.path}".encode()
            ).hexdigest()[:32],
            owner_user_id=owner_user_id,
            source_type="repository",
            source_id=item.path,
            ordinal=position - 1,
            estimated_tokens=token_count,
            relevance_score=(
                1.0 if file_score(item.path)[0] < 0 else 0.55
            ),
            citation_label=f"S{position}",
            source_label=PurePosixPath(item.path).name[:128],
            source_locator=locator[:256],
            confidence=1.0 if file_score(item.path)[0] < 0 else 0.55,
            runtime_text=text,
            content_hash=hashlib.sha256(
                f"{source_version}:{item.path}".encode()
            ).hexdigest(),
            safe_attributes=(("language", item.language),),
        ))
        total_tokens += token_count
    pack = EvidencePack(
        owner_user_id=owner_user_id,
        request_id=request_id,
        items=tuple(items),
        total_estimated_tokens=total_tokens,
        retrieval_status="sufficient" if items else "insufficient",
        contradictions=(),
        source_map=tuple(
            (item.citation_label, item.source_locator) for item in items
        ),
        total_token_count=total_tokens,
        status_codes=("repository_context_used",),
    )
    return RepositoryRetrievalResult(contract=contract, evidence_pack=pack)
