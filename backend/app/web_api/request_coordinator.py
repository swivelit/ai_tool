from __future__ import annotations

from dataclasses import dataclass, replace
import os
from typing import Any, Literal

from sqlmodel import Session

from ..ai.context_compressor import ContextCompressor
from ..ai.prompts import STATIC_SYSTEM_PREFIX
from ..billing.pricing import estimate_tokens
from .conversation_continuity import SameThreadContinuityDecision
from .turn_optimizer import (
    WebTurnOptimization, optimize_web_turn, select_context_turns,
    with_prompt_estimate,
)


AnswerClass = Literal["simple", "normal", "detailed", "long_form"]


@dataclass(frozen=True)
class PromptSourceUsage:
    characters: int = 0
    estimated_tokens: int = 0


@dataclass(frozen=True)
class WebRequestDecision:
    """Immutable, deterministic website orchestration decision.

    Text values are retained only for the in-process provider request.  Callers
    must use ``sanitized_metadata`` for logs and persisted telemetry.
    """

    request_classification: str
    contextual_followup: bool
    answer_class: AnswerClass
    needs_same_thread_context: bool
    needs_cross_thread_memory: bool
    needs_document_context: bool
    same_thread_context: tuple[tuple[str, str], ...]
    memory_context: str
    document_excerpts: str
    profile_context: str
    system_prompt: PromptSourceUsage
    user_message: PromptSourceUsage
    same_thread: PromptSourceUsage
    memory: PromptSourceUsage
    profile: PromptSourceUsage
    attachment: PromptSourceUsage
    total_estimated_prompt_tokens: int
    max_output_tokens: int
    model_candidate_strategy: str
    cache_eligible: bool
    expected_provider_call_count: int
    continuity: SameThreadContinuityDecision
    optimization: WebTurnOptimization

    @property
    def sanitized_metadata(self) -> dict[str, Any]:
        return {
            "request_classification": self.request_classification,
            "contextual_followup": self.contextual_followup,
            "answer_class": self.answer_class,
            "needs_same_thread_context": self.needs_same_thread_context,
            "needs_cross_thread_memory": self.needs_cross_thread_memory,
            "needs_document_context": self.needs_document_context,
            "system_prompt_chars": self.system_prompt.characters,
            "system_prompt_estimated_tokens": self.system_prompt.estimated_tokens,
            "user_message_chars": self.user_message.characters,
            "user_message_estimated_tokens": self.user_message.estimated_tokens,
            "same_thread_chars": self.same_thread.characters,
            "same_thread_estimated_tokens": self.same_thread.estimated_tokens,
            "memory_chars": self.memory.characters,
            "memory_estimated_tokens": self.memory.estimated_tokens,
            "profile_chars": self.profile.characters,
            "profile_estimated_tokens": self.profile.estimated_tokens,
            "attachment_chars": self.attachment.characters,
            "attachment_estimated_tokens": self.attachment.estimated_tokens,
            "total_estimated_prompt_tokens": self.total_estimated_prompt_tokens,
            "max_output_tokens": self.max_output_tokens,
            "model_candidate_strategy": self.model_candidate_strategy,
            "cache_eligible": self.cache_eligible,
            "expected_provider_call_count": self.expected_provider_call_count,
            "same_thread_context_mode": self.continuity.mode,
            "same_thread_context_reason": self.continuity.reason,
            "same_thread_context_confidence": self.continuity.confidence,
            "same_thread_context_turns_sent": len(self.same_thread_context),
            "same_thread_context_chars_sent": self.same_thread.characters,
            "same_thread_estimated_tokens": self.same_thread.estimated_tokens,
        }


def _usage(value: str) -> PromptSourceUsage:
    text = str(value or "")
    return PromptSourceUsage(
        characters=len(text), estimated_tokens=estimate_tokens(text) if text else 0
    )


class WebRequestCoordinator:
    """Provider-free website request planner.

    Classification, selection, budgeting and routing hints are deliberately
    lexical/rule based.  This class never owns a provider client.
    """

    def preliminary(
        self,
        message: str,
        *,
        reply_language: str | None,
        has_attachments: bool,
        previous_topic: str | None = None,
    ) -> WebTurnOptimization:
        return optimize_web_turn(
            message,
            reply_language=reply_language,
            has_attachments=has_attachments,
            previous_topic=previous_topic,
        )

    def decide(
        self,
        message: str,
        *,
        reply_language: str | None,
        context_turns: list[dict[str, str]] | None,
        profile_context: dict[str, Any] | None,
        attachment_context: str,
        memory_context: str = "",
        needs_memory: bool = False,
        has_attachments: bool = False,
        previous_topic: str | None = None,
        continuity: SameThreadContinuityDecision,
        session: Session | None = None,
    ) -> WebRequestDecision:
        optimization = optimize_web_turn(
            message,
            reply_language=reply_language,
            context_turns=context_turns,
            profile_context=profile_context,
            attachment_prompt_context=attachment_context,
            has_attachments=has_attachments,
            previous_topic=previous_topic,
            continuity=continuity,
        )
        selected_turns, formatted = select_context_turns(
            context_turns or [],
            contextual=continuity.use_context,
            preferred_turn_count=continuity.preferred_turn_count,
            current_message=message,
            session=session,
        )
        optimization = replace(
            optimization,
            selected_context_turns=selected_turns,
            formatted_context=formatted,
            context_chars_sent=len(formatted),
            metrics={
                **optimization.metrics,
                "context_turns_sent": len(selected_turns),
                "context_chars_sent": len(formatted),
            },
        )
        optimization, memory_context = _apply_prompt_budget(
            optimization,
            message=message,
            memory_context=memory_context,
        )
        selected = tuple(
            (str(turn.get("user") or ""), str(turn.get("assistant") or ""))
            for turn in optimization.selected_context_turns
        )
        same_thread_text = "\n".join(
            value for pair in selected for value in pair if value
        )
        same_thread_used = bool(selected)
        return WebRequestDecision(
            request_classification=optimization.optimization_route,
            contextual_followup=continuity.use_context,
            answer_class=optimization.answer_class,
            needs_same_thread_context=same_thread_used,
            needs_cross_thread_memory=bool(needs_memory),
            needs_document_context=bool(has_attachments),
            same_thread_context=selected,
            memory_context=str(memory_context or ""),
            document_excerpts=optimization.attachment_prompt_context,
            profile_context=optimization.compact_profile_prompt,
            system_prompt=PromptSourceUsage(),
            user_message=_usage(message),
            same_thread=_usage(same_thread_text),
            memory=_usage(memory_context),
            profile=_usage(optimization.compact_profile_prompt),
            attachment=_usage(optimization.attachment_prompt_context),
            total_estimated_prompt_tokens=0,
            max_output_tokens=optimization.max_output_tokens,
            model_candidate_strategy=(
                "tier_primary_then_zero_usage_fallback"
                if optimization.answer_class in {"detailed", "long_form"}
                else "economical_tier_candidate"
            ),
            cache_eligible=(
                optimization.cache_eligible and not memory_context and not same_thread_used
            ),
            expected_provider_call_count=1,
            continuity=continuity,
            optimization=optimization,
        )

    def with_exact_prompt(
        self,
        decision: WebRequestDecision,
        *,
        serialized_prompt: str,
        system_prompt: str,
        context_turns: list[dict[str, str]] | None = None,
        memory_context: str | None = None,
        profile_context: str | None = None,
        attachment_context: str | None = None,
    ) -> WebRequestDecision:
        turns = (
            context_turns
            if context_turns is not None
            else decision.optimization.selected_context_turns
        )
        memory_value = (
            decision.memory_context if memory_context is None else memory_context
        )
        profile_value = (
            decision.profile_context if profile_context is None else profile_context
        )
        attachment_value = (
            decision.document_excerpts
            if attachment_context is None else attachment_context
        )
        formatted = "\n".join(
            value
            for turn in turns
            for value in (
                str(turn.get("user") or ""),
                str(turn.get("assistant") or ""),
            )
            if value
        )
        exact_metrics = {
            **decision.optimization.metrics,
            "context_turns_sent": len(turns),
            "context_chars_sent": len(formatted),
            "memory_estimated_tokens": (
                estimate_tokens(memory_value) if memory_value else 0
            ),
            "profile_estimated_tokens": (
                estimate_tokens(profile_value) if profile_value else 0
            ),
            "attachment_estimated_tokens": (
                estimate_tokens(attachment_value) if attachment_value else 0
            ),
        }
        exact_optimization = replace(
            decision.optimization,
            selected_context_turns=list(turns),
            formatted_context=formatted,
            context_chars_sent=len(formatted),
            compact_profile_prompt=profile_value,
            profile_chars_sent=len(profile_value),
            attachment_prompt_context=attachment_value,
            attachment_chars_sent=len(attachment_value),
            metrics=exact_metrics,
        )
        optimization = with_prompt_estimate(
            exact_optimization, serialized_prompt
        )
        selected = tuple(
            (str(turn.get("user") or ""), str(turn.get("assistant") or ""))
            for turn in turns
        )
        return replace(
            decision,
            system_prompt=_usage(system_prompt),
            same_thread_context=selected,
            memory_context=memory_value,
            document_excerpts=attachment_value,
            profile_context=profile_value,
            same_thread=_usage(formatted),
            memory=_usage(memory_value),
            profile=_usage(profile_value),
            attachment=_usage(attachment_value),
            total_estimated_prompt_tokens=optimization.estimated_prompt_tokens,
            optimization=optimization,
        )


def _max_prompt_tokens() -> int:
    try:
        return max(1, int(str(os.getenv("WEB_MAX_PROMPT_TOKENS", "6000")).strip()))
    except (TypeError, ValueError):
        return 6000


def _truncate_tokens(value: str, token_limit: int) -> str:
    text = str(value or "").strip()
    if token_limit <= 0:
        return ""
    if estimate_tokens(text) <= token_limit:
        return text
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if estimate_tokens(text[:middle]) <= token_limit:
            low = middle
        else:
            high = middle - 1
    return text[:low].rstrip()


def _history_within_budget(
    turns: list[dict[str, str]], token_budget: int
) -> tuple[list[dict[str, str]], str]:
    kept: list[dict[str, str]] = []
    used = 0
    for turn in reversed(turns):
        block = "\n".join(
            value
            for value in (
                str(turn.get("user") or ""),
                str(turn.get("assistant") or ""),
            )
            if value
        )
        tokens = estimate_tokens(block)
        if used + tokens > token_budget:
            continue
        kept.insert(0, turn)
        used += tokens
    formatted = "\n".join(
        value
        for turn in kept
        for value in (
            str(turn.get("user") or ""),
            str(turn.get("assistant") or ""),
        )
        if value
    )
    return kept, formatted


def _apply_prompt_budget(
    optimization: WebTurnOptimization,
    *,
    message: str,
    memory_context: str,
) -> tuple[WebTurnOptimization, str]:
    maximum = _max_prompt_tokens()
    fixed = estimate_tokens(message) + estimate_tokens(STATIC_SYSTEM_PREFIX) + 320
    remaining = max(0, maximum - fixed)
    memory_cap = int(remaining * 0.15)
    profile_cap = int(remaining * 0.10)
    document_cap = int(remaining * 0.25)

    memory = _truncate_tokens(memory_context, memory_cap)
    profile = _truncate_tokens(optimization.compact_profile_prompt, profile_cap)
    compressor = ContextCompressor(
        max_chunks=8,
        max_chunk_chars=max(64, document_cap * 4),
        max_total_chars=max(64, document_cap * 4),
    )
    document_chunks = [
        chunk for chunk in str(optimization.attachment_prompt_context or "").split("\n\n")
        if chunk.strip()
    ]
    document = "\n\n".join(compressor.compress(document_chunks))
    document = _truncate_tokens(document, document_cap)

    # Memory replaces history token-for-token. Empty or unused section shares
    # naturally flow back to history.
    section_tokens = (
        estimate_tokens(memory) + estimate_tokens(profile) + estimate_tokens(document)
    )
    history_budget = max(0, remaining - section_tokens)
    history, formatted = _history_within_budget(
        optimization.selected_context_turns, history_budget
    )
    metrics = {
        **optimization.metrics,
        "context_turns_sent": len(history),
        "context_chars_sent": len(formatted),
        "memory_estimated_tokens": estimate_tokens(memory) if memory else 0,
        "profile_estimated_tokens": estimate_tokens(profile) if profile else 0,
        "attachment_estimated_tokens": estimate_tokens(document) if document else 0,
        "history_token_allocation": history_budget,
        "prompt_token_budget": maximum,
    }
    return (
        replace(
            optimization,
            selected_context_turns=history,
            formatted_context=formatted,
            context_chars_sent=len(formatted),
            compact_profile_prompt=profile,
            profile_chars_sent=len(profile),
            attachment_prompt_context=document,
            attachment_chars_sent=len(document),
            metrics=metrics,
        ),
        memory,
    )
