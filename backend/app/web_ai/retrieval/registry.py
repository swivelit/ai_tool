from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError
from dataclasses import dataclass
from typing import Protocol

from ...web_api.upload_store import EphemeralUpload
from ..execution_plan import ExecutionPlan
from .dense import DenseRetrievalUnavailable
from .models import RetrievalCandidate


class Retriever(Protocol):
    source_name: str
    status_code: str

    def retrieve(
        self,
        *,
        query: str,
        uploads: list[EphemeralUpload],
        owner_user_id: int,
        limit: int,
        cancellation_signal: object | None = None,
    ) -> tuple[RetrievalCandidate, ...]: ...


@dataclass(frozen=True)
class RetrievalRun:
    result_sets: tuple[tuple[RetrievalCandidate, ...], ...]
    status_codes: tuple[str, ...]


class RetrievalRegistry:
    def __init__(
        self,
        retrievers: tuple[Retriever, ...],
        *,
        max_concurrency: int = 2,
        timeout_seconds: float = 3.0,
    ) -> None:
        self.retrievers = retrievers
        self.max_concurrency = min(4, max(1, int(max_concurrency)))
        self.timeout_seconds = min(15.0, max(0.05, float(timeout_seconds)))

    def execute(
        self,
        *,
        plan: ExecutionPlan,
        query: str,
        uploads: list[EphemeralUpload],
        owner_user_id: int,
        candidate_limit: int,
        cancellation_signal: object | None = None,
    ) -> RetrievalRun:
        allowed = set(plan.retrieval_sources)
        selected = tuple(
            retriever for retriever in self.retrievers
            if retriever.source_name in allowed
        )
        if not selected or _cancelled(cancellation_signal):
            return RetrievalRun((), ())
        result_sets: list[tuple[RetrievalCandidate, ...]] = []
        statuses: list[str] = []
        executor = ThreadPoolExecutor(
            max_workers=min(self.max_concurrency, len(selected)),
            thread_name_prefix="web-rag",
        )
        try:
            futures = [
                (
                    retriever,
                    executor.submit(
                        retriever.retrieve,
                        query=query,
                        uploads=uploads,
                        owner_user_id=owner_user_id,
                        limit=candidate_limit,
                        cancellation_signal=cancellation_signal,
                    ),
                )
                for retriever in selected
            ]
            for retriever, future in futures:
                try:
                    results = future.result(timeout=self.timeout_seconds)
                    if any(
                        not item.belongs_to(owner_user_id) for item in results
                    ):
                        raise PermissionError("retriever returned a foreign owner")
                    result_sets.append(results)
                    statuses.append(retriever.status_code)
                except TimeoutError:
                    future.cancel()
                    statuses.append(
                        "dense_unavailable"
                        if retriever.status_code == "dense"
                        else "retrieval_timeout"
                    )
                except DenseRetrievalUnavailable as exc:
                    code = str(exc)
                    statuses.append(
                        code
                        if code in {
                            "dense_unavailable",
                            "upload_expired",
                            "malformed_vector",
                        }
                        else "dense_unavailable"
                    )
                except PermissionError:
                    statuses.append("owner_mismatch")
                except Exception:
                    statuses.append(
                        "dense_unavailable"
                        if retriever.status_code == "dense"
                        else "retrieval_unavailable"
                    )
        finally:
            executor.shutdown(wait=False, cancel_futures=True)
        if "lexical" in statuses and (
            "dense_unavailable" in statuses
            or "upload_expired" in statuses
            or "malformed_vector" in statuses
        ):
            statuses.append("lexical_fallback")
        return RetrievalRun(tuple(result_sets), tuple(dict.fromkeys(statuses)))


def _cancelled(signal: object | None) -> bool:
    if signal is None:
        return False
    value = getattr(signal, "cancelled", False)
    return bool(value() if callable(value) else value)
