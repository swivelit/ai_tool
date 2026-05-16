from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import app.agentic_service as agentic_service_module
from app.agentic_service import AgenticService
from app.database import SessionLocal


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
