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


class OpenAIReasoningEffortConfigurationError(RuntimeError):
    """Raised when a configured website reasoning effort is unsupported."""


def openai_web_reasoning_effort(
    answer_class: object,
    *,
    max_output_tokens: object | None = None,
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
    # Responses reasoning tokens share max_output_tokens with visible output.
    # Under Lite/Standard-sized long-form ceilings, reserve that bounded budget
    # for the explicitly requested deliverable even when the general configured
    # long-form effort is low. Larger Pro plans retain the configured effort.
    if (
        normalized_class == "long_form"
        and 0 < output_budget <= 2_400
        and effort not in {"none", "minimal"}
    ):
        return "none"
    return effort
