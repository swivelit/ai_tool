from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Sequence

from sqlmodel import Session

from ..ai.providers.openai_provider import OpenAIProvider
from ..billing.pricing import estimate_tokens, price_usage
from ..openai_tracked import tracked_embedding
from .knowledge_jobs import PaidEmbeddingProvider, PaidEmbeddingResult
from .settings import TriagSettings


def build_tracked_knowledge_embedding_provider(
    session: Session,
    payload: dict[str, object],
) -> PaidEmbeddingProvider:
    """Inject the existing tracked OpenAI path after billing is reserved."""

    owner_user_id = int(payload["owner_user_id"])
    request_id = str(payload.get("request_id") or "")
    if not request_id or not payload.get("usage_charge_id"):
        raise RuntimeError("knowledge embedding reservation is required")
    settings = TriagSettings.from_environ()
    client = OpenAIProvider()._client_or_create()

    def provide(texts: Sequence[str]) -> PaidEmbeddingResult:
        bounded_texts = [str(text) for text in texts]
        if not bounded_texts:
            raise ValueError("knowledge embedding input is empty")
        response = tracked_embedding(
            client,
            input=bounded_texts,
            route="web_knowledge_embedding_backfill",
            session=session,
            user_id=owner_user_id,
            request_id=request_id,
            model=settings.embedding_model,
            dimensions=settings.embedding_dimensions,
            extra_headers={"Idempotency-Key": request_id},
        )
        vectors = _response_vectors(response)
        input_tokens = _response_input_tokens(response)
        if input_tokens is None:
            input_tokens = sum(estimate_tokens(text) for text in bounded_texts)
        actual = price_usage(
            "openai", settings.embedding_model, input_tokens, 0
        )
        return PaidEmbeddingResult(
            vectors=vectors,
            provider="openai",
            model=settings.embedding_model,
            input_tokens=input_tokens,
            native_cost_amount=actual.amount,
            native_cost_currency=actual.currency,
            micro_inr_cost=actual.micros,
            usd_to_inr_rate=_snapshot_decimal(
                actual.snapshot.get("usd_to_inr_rate")
            ),
        )

    return provide


def _response_vectors(response: Any) -> tuple[tuple[float, ...], ...]:
    data = response.get("data") if isinstance(response, dict) else getattr(
        response, "data", None
    )
    if not isinstance(data, (list, tuple)):
        raise ValueError("embedding response data is malformed")
    vectors: list[tuple[float, ...]] = []
    for item in data:
        value = item.get("embedding") if isinstance(item, dict) else getattr(
            item, "embedding", None
        )
        if not isinstance(value, (list, tuple)):
            raise ValueError("embedding vector is malformed")
        vectors.append(tuple(float(component) for component in value))
    return tuple(vectors)


def _response_input_tokens(response: Any) -> int | None:
    usage = response.get("usage") if isinstance(response, dict) else getattr(
        response, "usage", None
    )
    if usage is None:
        return None
    value = usage.get("prompt_tokens") if isinstance(usage, dict) else getattr(
        usage, "prompt_tokens", None
    )
    if value is None:
        value = usage.get("input_tokens") if isinstance(usage, dict) else getattr(
            usage, "input_tokens", None
        )
    try:
        return max(0, int(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def _snapshot_decimal(value: object) -> Decimal | None:
    try:
        return Decimal(str(value)) if value is not None else None
    except (InvalidOperation, ValueError):
        return None
