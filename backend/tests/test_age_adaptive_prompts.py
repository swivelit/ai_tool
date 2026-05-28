"""
Tests for age-adaptive AI response style and life context insight prompts.
Run: cd backend && python -m pytest tests/test_age_adaptive_prompts.py -v
"""

from app.ai.prompts import (
    _age_adaptive_style,
    _life_context_insight_prompt,
    build_system_instructions,
)
from app.ai.types import AIRequest, AIRoute


def make_request(message="how many steps did I walk?", age_group="26_35", life_ctx=None):
    metadata = {"age_group": age_group}
    if life_ctx:
        metadata["client_context"] = {"life_context": life_ctx}
    return AIRequest(
        user_id=1,
        message=message,
        reply_language="en",
        channel="text",
        request_id="age-adaptive-test",
        metadata=metadata,
    )


def make_route(intent="life_context_qa"):
    return AIRoute(
        intent=intent,
        language="en",
        provider="openai",
        model="gpt-4o-mini",
        route="openai_general",
        reason="test",
        max_output_tokens=240,
    )


def test_age_style_under_13_uses_simple_language():
    style = _age_adaptive_style({"age_group": "under_13"})
    assert "child" in style.lower() or "under 13" in style.lower()
    assert "simple" in style.lower()
    assert "1 hour" in style


def test_age_style_teenager():
    style = _age_adaptive_style({"age_group": "13_17"})
    assert "teen" in style.lower() or "13" in style
    assert "2 hours" in style


def test_age_style_senior():
    style = _age_adaptive_style({"age_group": "60_plus"})
    assert "senior" in style.lower() or "60" in style
    assert "6,000" in style or "7,000" in style


def test_age_style_prefer_not_to_say_returns_empty():
    assert _age_adaptive_style({"age_group": "prefer_not_to_say"}) == ""


def test_age_style_missing_returns_empty():
    assert _age_adaptive_style({}) == ""
    assert _age_adaptive_style(None) == ""


def test_age_style_all_groups_return_nonempty():
    groups = ["under_13", "13_17", "18_25", "26_35", "36_45", "46_60", "60_plus"]
    for group in groups:
        result = _age_adaptive_style({"age_group": group})
        assert len(result) > 20, f"Expected non-trivial style for {group}, got: {result!r}"


SAMPLE_LIFE_CTX = {
    "movementSummary": "7420 steps, about 5.7 km",
    "screenSummary": "3.5 hours screen time",
    "topAppsSummary": "YouTube 1.0 hour, WhatsApp 40 minutes",
    "ageGroup": "26_35",
}


def test_life_context_insight_includes_step_goal():
    prompt = _life_context_insight_prompt(
        {
            "age_group": "26_35",
            "client_context": {"life_context": SAMPLE_LIFE_CTX},
        }
    )
    assert "10,000" in prompt


def test_life_context_insight_includes_screen_threshold():
    prompt = _life_context_insight_prompt(
        {
            "age_group": "13_17",
            "client_context": {"life_context": SAMPLE_LIFE_CTX},
        }
    )
    assert "2 hours" in prompt


def test_life_context_insight_empty_when_no_life_ctx():
    prompt = _life_context_insight_prompt({"age_group": "26_35"})
    assert prompt == ""


def test_life_context_insight_child_has_lower_step_goal():
    prompt = _life_context_insight_prompt(
        {
            "age_group": "under_13",
            "client_context": {"life_context": SAMPLE_LIFE_CTX},
        }
    )
    assert "12,000" in prompt


def test_build_instructions_includes_age_style():
    req = make_request(age_group="under_13")
    route = make_route()
    instructions = build_system_instructions(req, route, provider="openai")
    assert "child" in instructions.lower() or "under 13" in instructions.lower()


def test_build_instructions_includes_life_insight_when_context_present():
    req = make_request(age_group="26_35", life_ctx=SAMPLE_LIFE_CTX)
    route = make_route()
    instructions = build_system_instructions(req, route, provider="openai")
    assert "step goal" in instructions.lower() or "10,000" in instructions


def test_build_instructions_no_age_no_life_no_crash():
    req = AIRequest(
        user_id=1,
        message="hello",
        reply_language="en",
        channel="text",
        request_id="age-adaptive-test",
        metadata={},
    )
    route = make_route(intent="general_qa")
    instructions = build_system_instructions(req, route, provider="openai")
    assert isinstance(instructions, str)
    assert len(instructions) > 10
