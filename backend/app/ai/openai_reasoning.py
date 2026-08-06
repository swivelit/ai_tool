from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_FLOOR
from typing import Optional


OPENAI_REASONING_EFFORT_DEFAULTS = {
    "simple": "none",
    "normal": "low",
    "detailed": "low",
    "long_form": "low",
}
VALID_OPENAI_REASONING_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh"}
)
OPENAI_REASONING_MIN_BUDGET_TOKENS_DEFAULT = 2_000
OPENAI_REASONING_MAX_BUDGET_FRACTION_DEFAULT = Decimal("0.4")
_STRICT_EFFORT_DOWNGRADE = {
    "xhigh": "high",
    "high": "medium",
    "medium": "low",
    "low": "minimal",
    "minimal": "minimal",
    "none": "none",
}


class OpenAIReasoningEffortConfigurationError(RuntimeError):
    """Raised when a configured website reasoning effort is unsupported."""


@dataclass(frozen=True)
class OpenAIReasoningBudget:
    """Content-free provider budget diagnostics for a website generation."""

    effective_max_output_tokens: int
    visible_output_reserve_tokens: int
    reasoning_budget_cap_tokens: int
    reasoning_effort: Optional[str]


def openai_visible_output_reserve(
    max_output_tokens: object,
    requested_visible_tokens: object | None = None,
) -> int:
    """Reserve a bounded visible share of the provider's shared output budget."""

    try:
        output_budget = max(0, int(max_output_tokens or 0))
    except (TypeError, ValueError):
        output_budget = 0
    try:
        requested = max(0, int(requested_visible_tokens or 0))
    except (TypeError, ValueError):
        requested = 0
    name = "OPENAI_REASONING_MAX_BUDGET_FRACTION"
    try:
        fraction = Decimal(str(os.getenv(
            name, str(OPENAI_REASONING_MAX_BUDGET_FRACTION_DEFAULT),
        )))
    except (InvalidOperation, ValueError) as exc:
        raise OpenAIReasoningEffortConfigurationError(
            f"{name} must be greater than 0 and less than 1"
        ) from exc
    if not Decimal("0") < fraction < Decimal("1"):
        raise OpenAIReasoningEffortConfigurationError(
            f"{name} must be greater than 0 and less than 1"
        )
    reasoning_cap = int(
        (Decimal(output_budget) * fraction).to_integral_value(
            rounding=ROUND_FLOOR
        )
    )
    fraction_reserve = max(0, output_budget - reasoning_cap)
    return min(output_budget, max(requested, fraction_reserve))


def openai_web_reasoning_effort(
    answer_class: object,
    *,
    max_output_tokens: object | None = None,
    strict_visible_format: bool = False,
    minimum_visible_output_tokens: object | None = None,
    effort_override: object | None = None,
    repair_turn: bool = False,
) -> Optional[str]:
    """Return the configured effort only for an explicitly classified turn."""

    return resolve_openai_reasoning_budget(
        answer_class,
        max_output_tokens=max_output_tokens,
        strict_visible_format=strict_visible_format,
        minimum_visible_output_tokens=minimum_visible_output_tokens,
        effort_override=effort_override,
        repair_turn=repair_turn,
    ).reasoning_effort


def resolve_openai_reasoning_budget(
    answer_class: object,
    *,
    max_output_tokens: object | None = None,
    strict_visible_format: bool = False,
    minimum_visible_output_tokens: object | None = None,
    effort_override: object | None = None,
    repair_turn: bool = False,
) -> OpenAIReasoningBudget:
    """Resolve effort without reducing the provider's visible-output ceiling.

    The Responses API shares ``max_output_tokens`` between reasoning and visible
    output.  A reserve is therefore meaningful only while reasoning is enabled.
    Ordinary non-strict turns keep their historical full ceiling and configured
    effort; bounded automatic reserves are limited to long-form/strict work.
    """

    try:
        output_budget = max(0, int(max_output_tokens or 0))
    except (TypeError, ValueError):
        output_budget = 0
    normalized_class = str(answer_class or "").strip().lower()
    if not normalized_class:
        return OpenAIReasoningBudget(output_budget, 0, 0, None)
    if normalized_class not in OPENAI_REASONING_EFFORT_DEFAULTS:
        raise OpenAIReasoningEffortConfigurationError(
            f"Unsupported OpenAI answer class: {normalized_class}"
        )
    name = f"OPENAI_REASONING_EFFORT_{normalized_class.upper()}"
    effort = str(
        os.getenv(name, OPENAI_REASONING_EFFORT_DEFAULTS[normalized_class])
    ).strip().lower()
    if effort not in VALID_OPENAI_REASONING_EFFORTS:
        raise OpenAIReasoningEffortConfigurationError(
            f"{name} must be one of: "
            + ", ".join(sorted(VALID_OPENAI_REASONING_EFFORTS))
        )
    if effort_override is not None:
        override = str(effort_override).strip().lower()
        if override not in VALID_OPENAI_REASONING_EFFORTS:
            raise OpenAIReasoningEffortConfigurationError(
                "reasoning effort override is unsupported"
            )
        effort = override
    if repair_turn and effort in {"none", "minimal"}:
        effort = "low"
    try:
        requested_reserve = max(0, int(minimum_visible_output_tokens or 0))
    except (TypeError, ValueError):
        requested_reserve = 0
    floor_name = "OPENAI_REASONING_MIN_BUDGET_TOKENS"
    try:
        reasoning_floor = int(os.getenv(
            floor_name, str(OPENAI_REASONING_MIN_BUDGET_TOKENS_DEFAULT)
        ))
    except (TypeError, ValueError) as exc:
        raise OpenAIReasoningEffortConfigurationError(
            f"{floor_name} must be a positive integer"
        ) from exc
    if reasoning_floor <= 0:
        raise OpenAIReasoningEffortConfigurationError(
            f"{floor_name} must be a positive integer"
        )
    # A no-reasoning request cannot consume reasoning tokens, so reserving part
    # of its ceiling would only distort diagnostics and downstream planning.
    if effort == "none":
        return OpenAIReasoningBudget(output_budget, 0, 0, "none")

    reserve_applies = strict_visible_format or normalized_class == "long_form"
    visible_reserve = (
        openai_visible_output_reserve(output_budget, requested_reserve)
        if reserve_applies
        else min(output_budget, requested_reserve)
    )
    reasoning_budget = max(0, output_budget - visible_reserve)
    if (
        reserve_applies
        and output_budget > 0
        and reasoning_budget < reasoning_floor
        and not repair_turn
    ):
        # The Responses API has a shared reasoning/visible-output ceiling but
        # no separate hard reasoning-token parameter. Below the configured
        # safe reasoning budget, `none` is therefore the only enforceable way
        # to guarantee the visible reserve regardless of effort configuration.
        return OpenAIReasoningBudget(output_budget, 0, 0, "none")
    if repair_turn and reasoning_budget <= 0:
        return OpenAIReasoningBudget(output_budget, 0, 0, "none")
    if strict_visible_format and not repair_turn:
        effort = _STRICT_EFFORT_DOWNGRADE[effort]
    return OpenAIReasoningBudget(
        output_budget,
        visible_reserve,
        reasoning_budget,
        effort,
    )
