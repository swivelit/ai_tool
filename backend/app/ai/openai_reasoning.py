from __future__ import annotations

import os
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


def openai_web_reasoning_effort(
    answer_class: object,
    *,
    max_output_tokens: object | None = None,
    strict_visible_format: bool = False,
    minimum_visible_output_tokens: object | None = None,
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
    try:
        output_budget = max(0, int(max_output_tokens or 0))
    except (TypeError, ValueError):
        output_budget = 0
    try:
        visible_reserve = max(0, int(minimum_visible_output_tokens or 0))
    except (TypeError, ValueError):
        visible_reserve = 0
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
        strict_visible_format
        and output_budget > 0
        and reasoning_budget < reasoning_floor
    ):
        if (
            normalized_class == "long_form"
            and reasoning_budget > 0
            and downgraded != "none"
        ):
            # A bounded long-form contract still benefits from a small amount
            # of reasoning when its visible reserve fits. Collapse to minimal
            # rather than disabling reasoning outright merely because the
            # remaining shared budget is below the configured comfort floor.
            return "minimal"
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
