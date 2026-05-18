from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import app.agentic_service as agentic_service_module
from app.ai.orchestrator import run_text_turn
from app.ai.types import AIProviderResponse, AIRequest
from app.agentic_service import AgenticService
from app.database import SessionLocal
from app.models import AgentRun, AgentStep, Item, User
from sqlmodel import select


class DummyLocalRag:
    def try_answer(self, *_args: Any, **_kwargs: Any) -> None:
        return None


@pytest.fixture()
def agentic_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AgenticService:
    data_dir = tmp_path / "data"
    config_dir = tmp_path / "config"

    monkeypatch.setattr(agentic_service_module, "DATA_DIR", data_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_CONFIG_DIR", config_dir)
    monkeypatch.setattr(agentic_service_module, "AGENT_STATE_DIR", data_dir / "state")
    monkeypatch.setattr(agentic_service_module, "AGENT_MEMORY_DIR", data_dir / "memory")
    monkeypatch.setattr(agentic_service_module, "AGENT_LOGS_DIR", data_dir / "logs")
    monkeypatch.setattr(agentic_service_module, "AGENT_PROFILER_SCHEMA_PATH", config_dir / "profiler_slots.json")
    monkeypatch.setattr(agentic_service_module, "AGENT_ORCHESTRATOR_CONFIG_PATH", config_dir / "orchestrator_routes.json")
    monkeypatch.setattr(agentic_service_module, "AGENT_ALIGNMENT_CONFIG_PATH", config_dir / "alignment_rules.json")
    monkeypatch.setattr(agentic_service_module, "AGENT_MEMORY_CONFIG_PATH", config_dir / "memory_rules.json")

    service = AgenticService(openai_client=None, local_rag_service=DummyLocalRag())
    service.enabled = True
    return service


def test_orchestrate_chat_accepts_onboarding_profile_without_crashing(
    agentic_service: AgenticService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    onboarding_profile = {"answers": {"main_goal": "career_or_business"}}
    captured_tool_meta: dict[str, Any] = {}

    monkeypatch.setattr(
        agentic_service,
        "_classify_route",
        lambda *_args, **_kwargs: {
            "route": "clarify",
            "reason": "test",
            "clarifying_question": "What career result do you want first?",
            "confidence": 0.98,
        },
    )

    def fake_align_answer(**kwargs: Any) -> dict[str, Any]:
        captured_tool_meta.update(kwargs["tool_meta"])
        return {
            "english_answer": kwargs["draft_answer"],
            "final_answer": kwargs["draft_answer"],
            "style_applied": [],
            "code_switch": False,
        }

    monkeypatch.setattr(agentic_service, "_align_answer", fake_align_answer)

    with SessionLocal() as session:
        result = agentic_service.orchestrate_chat(
            session,
            None,
            "I need career help",
            "en",
            pipeline_runner=lambda *_args, **_kwargs: {"pipeline_version": "fallback"},
            onboarding_profile=onboarding_profile,
        )

    core_meta = json.loads(result["core_meta"])
    assert captured_tool_meta["onboarding_profile"] == onboarding_profile
    assert core_meta["tool_meta"]["onboarding_profile"] == onboarding_profile
    assert result["route_taken"] == "agentic_clarify"


def test_quick_route_supports_mobile_orchestrator_config_shape(agentic_service: AgenticService) -> None:
    mobile_config_path = (
        Path(__file__).resolve().parents[2] / "mobile" / "data" / "config" / "orchestrator_routes.json"
    )
    temp_config_path = Path(agentic_service_module.AGENT_ORCHESTRATOR_CONFIG_PATH)
    temp_config_path.write_text(mobile_config_path.read_text(encoding="utf-8"), encoding="utf-8")

    assert agentic_service._quick_route("What is the weather tomorrow?") == "weather"
    assert agentic_service._quick_route("Create a reminder for tomorrow morning") == "calendar"
    assert agentic_service._quick_route("What is the latest IPL score today?") == "web_search"
    assert agentic_service._quick_route("Hi elli") == "fast_greeting"


def test_quick_route_keeps_stable_knowledge_off_web_search(agentic_service: AgenticService) -> None:
    assert agentic_service._quick_route("What is photosynthesis?") is None
    assert agentic_service._quick_route("What is a compiler?") is None
    assert agentic_service._quick_route("Do you know about IPL?") is None
    assert agentic_service._quick_route("Tell me about Indian Premier League") is None
    assert agentic_service._quick_route("What is the latest IPL score today?") == "web_search"


def test_calendar_create_reminder_missing_content_asks_clarifying_question(agentic_service: AgenticService) -> None:
    with SessionLocal() as session:
        user = User(
            firebase_uid="calendar-uid",
            email="calendar@example.com",
            name="Calendar User",
            timezone="Asia/Kolkata",
            assistant_name="Elli",
            reply_language="en",
        )
        session.add(user)
        session.commit()
        session.refresh(user)

        answer = agentic_service._tool_calendar(
            session,
            int(user.id),
            "Create a reminder for tomorrow morning",
            user,
        )

    assert "What should I remind you about tomorrow morning?" == answer
    assert "do not have any reminders" not in answer.lower()


def test_web_search_ambiguous_election_and_live_ipl_are_clear_non_500(agentic_service: AgenticService) -> None:
    election_answer = agentic_service._tool_web_search("Do you know about the new election details?")
    assert "Which election and location" in election_answer

    ipl_answer = agentic_service._tool_web_search("What is the latest IPL score today?")
    assert "Live IPL score lookup needs a configured live sports data provider" in ipl_answer
    assert "I could not fetch a reliable web result" not in ipl_answer


class _ExplodingProvider:
    def complete(self, *_args: Any, **_kwargs: Any):
        raise AssertionError("agent local route must not call providers")


def _agent_request(message: str, user_id: int, *, reply_language: str = "en", context_turns=None) -> AIRequest:
    return AIRequest(
        user_id=user_id,
        message=message,
        reply_language=reply_language,
        channel="text",
        request_id=f"agent-{abs(hash(message))}",
        metadata={},
        context_turns=context_turns or [],
    )


def test_agent_runtime_local_greeting_records_trace_without_provider_call() -> None:
    with SessionLocal() as session:
        user = User(firebase_uid="agent-uid", email="agent@example.com", name="Agent User")
        session.add(user)
        session.commit()
        session.refresh(user)

        response = run_text_turn(
            session,
            _agent_request("hello", int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )

        run = session.exec(select(AgentRun).where(AgentRun.user_id == int(user.id))).one()
        steps = session.exec(select(AgentStep).where(AgentStep.run_id == int(run.id))).all()

    assert response.route == "agent_local_greeting"
    assert response.provider == "backend_tool"
    assert run.final_route == "agent_local_greeting"
    assert run.final_intent == "greeting"
    assert run.provider_calls == 0
    assert {step.step_name for step in steps} >= {
        "tamil_intent_agent",
        "planner_agent",
        "cost_optimizer_agent",
        "verifier_agent",
        "tool_execution_agent",
    }


def test_agent_runtime_dhoom_query_uses_provider_plan_not_reminder(monkeypatch: pytest.MonkeyPatch) -> None:
    class StaticProvider:
        def complete(self, request, route):
            return AIProviderResponse(
                text="Dhoom is an Indian action film franchise.",
                provider="openai",
                model=route.model,
                route=route.route,
                reason=route.reason,
                language=route.language,
                intent=route.intent,
            )

    with SessionLocal() as session:
        user = User(firebase_uid="dhoom-agent-uid", email="dhoom-agent@example.com", name="Dhoom User")
        session.add(user)
        session.commit()
        session.refresh(user)

        first = run_text_turn(
            session,
            _agent_request("Remind me tomorrow morning", int(user.id)),
            existing_context={"openai_provider": _ExplodingProvider(), "sarvam_provider": _ExplodingProvider()},
        )
        response = run_text_turn(
            session,
            _agent_request(
                "Tell me about dhoom movie",
                int(user.id),
                context_turns=[{"user": "Remind me tomorrow morning", "assistant": first.text}],
            ),
            existing_context={"openai_provider": StaticProvider(), "sarvam_provider": _ExplodingProvider()},
        )
        reminders = session.exec(select(Item).where(Item.user_id == int(user.id), Item.intent == "reminder")).all()
        run = session.exec(select(AgentRun).where(AgentRun.user_id == int(user.id)).order_by(AgentRun.id.desc())).first()

    assert response.route == "agent_provider_qa"
    assert response.intent == "general"
    assert "Dhoom" in response.text
    assert reminders == []
    assert run is not None
    assert run.final_route == "agent_provider_qa"
    assert run.provider_calls == 1
