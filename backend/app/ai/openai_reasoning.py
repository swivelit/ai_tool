from __future__ import annotations

import os
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
) -> Optional[str]:
    """Return the configured effort only for an explicitly classified turn."""

    normalized_class = str(answer_class or "").strip().lower()
    if not normalized_class:
        return None
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
        return override
    try:
        output_budget = max(0, int(max_output_tokens or 0))
    except (TypeError, ValueError):
        output_budget = 0
    reserve_is_explicit = minimum_visible_output_tokens is not None
    visible_reserve = (
        openai_visible_output_reserve(
            output_budget, minimum_visible_output_tokens,
        )
        if minimum_visible_output_tokens is not None else 0
    )
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
    reasoning_budget = max(0, output_budget - visible_reserve)
    downgraded = _STRICT_EFFORT_DOWNGRADE[effort]
    if (
        reserve_is_explicit
        and output_budget > 0
        and reasoning_budget < reasoning_floor
    ):
        # The Responses API has a shared reasoning/visible-output ceiling but
        # no separate hard reasoning-token parameter. Below the configured
        # safe reasoning budget, `none` is therefore the only enforceable way
        # to guarantee the visible reserve regardless of effort configuration.
        return "none"
    if strict_visible_format:
        return downgraded
    # Responses reasoning tokens share max_output_tokens with visible output.
    # Below the configured floor, reserve the bounded response budget for the
    # explicitly requested visible deliverable. Larger plans retain their
    # configured effort.
    if (
        normalized_class == "long_form"
        and 0 < output_budget < reasoning_floor
        and effort not in {"none", "minimal"}
    ):
        return "minimal"
    return effort
