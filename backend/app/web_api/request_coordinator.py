from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Literal

from ..billing.pricing import estimate_tokens
from .turn_optimizer import WebTurnOptimization, optimize_web_turn, with_prompt_estimate


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
    ) -> WebRequestDecision:
        optimization = optimize_web_turn(
            message,
            reply_language=reply_language,
            context_turns=context_turns,
            profile_context=profile_context,
            attachment_prompt_context=attachment_context,
            has_attachments=has_attachments,
            previous_topic=previous_topic,
        )
        selected = tuple(
            (str(turn.get("user") or ""), str(turn.get("assistant") or ""))
            for turn in optimization.selected_context_turns
        )
        return WebRequestDecision(
            request_classification=optimization.optimization_route,
            contextual_followup=optimization.is_contextual_followup,
            answer_class=optimization.answer_class,
            needs_same_thread_context=optimization.is_contextual_followup,
            needs_cross_thread_memory=bool(needs_memory),
            needs_document_context=bool(has_attachments),
            same_thread_context=selected,
            memory_context=str(memory_context or ""),
            document_excerpts=optimization.attachment_prompt_context,
            profile_context=optimization.compact_profile_prompt,
            system_prompt=PromptSourceUsage(),
            user_message=_usage(message),
            same_thread=_usage(optimization.formatted_context),
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
            cache_eligible=optimization.cache_eligible and not memory_context,
            expected_provider_call_count=1,
            optimization=optimization,
        )

    def with_exact_prompt(
        self,
        decision: WebRequestDecision,
        *,
        serialized_prompt: str,
        system_prompt: str,
    ) -> WebRequestDecision:
        optimization = with_prompt_estimate(decision.optimization, serialized_prompt)
        return replace(
            decision,
            system_prompt=_usage(system_prompt),
            total_estimated_prompt_tokens=optimization.estimated_prompt_tokens,
            optimization=optimization,
        )
