from __future__ import annotations

import pytest

from app.orchestrator_task import run_orchestrator


@pytest.mark.parametrize(
    "message,expected_match",
    [
        ("A dog bit me and I am bleeding", "dog bite"),
        ("I was bitten by a snake", "snake bite"),
        ("I have chest pain and cannot breathe", "chest pain or breathing trouble"),
        ("I want to harm myself", "self harm"),
    ],
)
def test_orchestrator_routes_real_emergencies(message: str, expected_match: str) -> None:
    result = run_orchestrator(None, message)

    assert result["intent"] == "EMERGENCY"
    assert result["next_action"] == "Emergency Agent"
    assert result["priority"] == "high"
    assert result["matched_keyword"] == expected_match
    assert result["fast_path"] is True


@pytest.mark.parametrize(
    "message",
    [
        "Tell me a dog story",
        "Debug my broken code",
        "What is a bit?",
        "Make a snake game",
        "My build is broken",
    ],
)
def test_orchestrator_does_not_route_harmless_mentions_as_emergencies(message: str) -> None:
    result = run_orchestrator(None, message)

    assert result["intent"] != "EMERGENCY"
    assert result["next_action"] != "Emergency Agent"
    assert result["priority"] != "high"


@pytest.mark.parametrize("message", ["Debug my broken code", "My build is broken"])
def test_orchestrator_does_not_route_ok_substrings_as_smalltalk(message: str) -> None:
    result = run_orchestrator(None, message)

    assert result["intent"] != "SMALLTALK"
    assert result["next_action"] != "Greeting Agent"


@pytest.mark.parametrize("message", ["ok", "thanks", "thank you", "cool"])
def test_orchestrator_routes_exact_smalltalk_phrases(message: str) -> None:
    result = run_orchestrator(None, message)

    assert result["intent"] == "SMALLTALK"
    assert result["next_action"] == "Greeting Agent"
    assert result["matched_keyword"] == message
