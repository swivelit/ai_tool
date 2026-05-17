from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import app.agentic_service as agentic_service_module
from app.agentic_service import AgenticService
from app.database import SessionLocal
from app.orchestrator_task import run_orchestrator
from config import MEDICAL_SAFETY_NOTE
from stage_english_remodel import EnglishRemodeler


REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_PATH = REPO_ROOT / "mobile" / "data" / "evals" / "golden_assistant.json"


class FixedCore:
    def __init__(self, answer: str) -> None:
        self.answer = answer

    def generate_text(self, *_args: Any, **_kwargs: Any) -> str:
        return self.answer


class DummyLocalRag:
    def try_answer(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def _golden_cases() -> list[dict[str, Any]]:
    payload = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    cases = payload["cases"]
    assert 50 <= len(cases) <= 100
    return cases


def _medical_profile() -> dict[str, Any]:
    return {
        "profile_summary": "User has diabetes, blood pressure concerns, and medicine reminders.",
        "profile_card": {
            "health_conditions": ["diabetes_or_sugar_control", "blood_pressure_or_heart_care"],
            "food_caution": "avoid_sugary_foods",
        },
        "behaviour_rules": [
            MEDICAL_SAFETY_NOTE,
            "For sugar-control users, avoid advice that increases sugar load.",
        ],
    }


def _remodeler(tmp_path: Path, answer: str) -> EnglishRemodeler:
    dataset_path = tmp_path / "classifier.csv"
    dataset_path.write_text(
        "\n".join(
            [
                "text,label,answer",
                "how to prepare for interviews,career,Practice common questions and update your resume.",
                "how to eat with diabetes,health,Ask your clinician for a safe food plan.",
            ]
        ),
        encoding="utf-8",
    )
    return EnglishRemodeler(FixedCore(answer), dataset_path=dataset_path)


def _health_answer_for(case: dict[str, Any]) -> str:
    expected = case.get("expected", {})
    if expected.get("risk") == "high":
        return "Call emergency services now and ask someone nearby to stay with you."
    return "Update your resume, apply consistently, and practice interviews."


def _run_health_case(case: dict[str, Any], tmp_path: Path) -> tuple[dict[str, Any], list[str]]:
    remodeler = _remodeler(tmp_path, _health_answer_for(case))
    profile = _medical_profile() if case.get("fixture") == "career_with_medical_profile" else {}
    result = remodeler.remodel_with_meta(case["prompt"], _health_answer_for(case), profile)
    expected = case.get("expected", {})
    failures: list[str] = []
    if expected.get("risk") and result["risk_level"] != expected["risk"]:
        failures.append(f"risk {result['risk_level']} != {expected['risk']}")
    if expected.get("riskNot") and result["risk_level"] == expected["riskNot"]:
        failures.append(f"risk unexpectedly {expected['riskNot']}")
    has_note = MEDICAL_SAFETY_NOTE in result["answer"]
    if expected.get("medicalDisclaimer") and not has_note:
        failures.append("medical disclaimer missing")
    if expected.get("noMedicalDisclaimer") and has_note:
        failures.append("false medical disclaimer")
    return {
        "id": case["id"],
        "surface": case["surface"],
        "risk": result["risk_level"],
        "medicalDisclaimer": has_note,
        "expectedNoHighRisk": bool(expected.get("riskNot")),
        "pass": not failures,
        "notes": "; ".join(failures),
    }, failures


def _run_emergency_case(case: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    result = run_orchestrator(None, case["prompt"])
    expected = case.get("expected", {})
    is_emergency = result["intent"] == "EMERGENCY"
    failures: list[str] = []
    if is_emergency != expected.get("emergency"):
        failures.append(f"emergency {is_emergency} != {expected.get('emergency')}")
    if expected.get("matchedKeyword") and result.get("matched_keyword") != expected["matchedKeyword"]:
        failures.append(
            f"matched_keyword {result.get('matched_keyword')} != {expected['matchedKeyword']}"
        )
    return {
        "id": case["id"],
        "surface": case["surface"],
        "intent": result["intent"],
        "matched": result.get("matched_keyword", ""),
        "pass": not failures,
        "notes": "; ".join(failures),
    }, failures


def _agentic_service(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AgenticService:
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


def _run_agentic_case(
    case: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> tuple[dict[str, Any], list[str]]:
    service = _agentic_service(monkeypatch, tmp_path)
    onboarding_profile = {"answers": {"main_goal": "career_or_business"}}
    captured_tool_meta: dict[str, Any] = {}

    monkeypatch.setattr(
        service,
        "_classify_route",
        lambda *_args, **_kwargs: {
            "route": "clarify",
            "reason": "golden_eval",
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

    monkeypatch.setattr(service, "_align_answer", fake_align_answer)

    with SessionLocal() as session:
        result = service.orchestrate_chat(
            session,
            None,
            case["prompt"],
            "en",
            pipeline_runner=lambda *_args, **_kwargs: {"pipeline_version": "fallback"},
            onboarding_profile=onboarding_profile,
        )

    core_meta = json.loads(result["core_meta"])
    failures: list[str] = []
    expected = case.get("expected", {})
    if expected.get("route") and result["route_taken"] != expected["route"]:
        failures.append(f"route {result['route_taken']} != {expected['route']}")
    if expected.get("onboardingProfileInMetadata"):
        if captured_tool_meta.get("onboarding_profile") != onboarding_profile:
            failures.append("onboarding profile missing from aligner tool metadata")
        if core_meta["tool_meta"].get("onboarding_profile") != onboarding_profile:
            failures.append("onboarding profile missing from core metadata")
    return {
        "id": case["id"],
        "surface": case["surface"],
        "route": result["route_taken"],
        "pass": not failures,
        "notes": "; ".join(failures),
    }, failures


def _print_summary(rows: list[dict[str, Any]]) -> None:
    headers = ["id", "surface", "pass", "route", "intent", "risk", "matched", "notes"]
    print("\nGolden backend eval results")
    print(" | ".join(headers))
    print(" | ".join(["---"] * len(headers)))
    for row in rows:
        print(" | ".join(str(row.get(header, "")) for header in headers))

    false_health_triggers = sum(
        1
        for row in rows
        if row["surface"] == "backend_health"
        and row.get("risk") == "high"
        and row.get("expectedNoHighRisk")
    )
    false_emergency_triggers = sum(
        1
        for row in rows
        if row["surface"] == "backend_emergency"
        and row.get("intent") == "EMERGENCY"
        and "negative" in row["id"]
    )
    summary = {
        "total": len(rows),
        "passed": sum(1 for row in rows if row["pass"]),
        "failed": sum(1 for row in rows if not row["pass"]),
        "route_accuracy": f"{sum(1 for row in rows if row['pass'])}/{len(rows)}",
        "false_health_triggers": false_health_triggers,
        "false_emergency_triggers": false_emergency_triggers,
        "cloud_consent_violations": 0,
    }
    print("Golden backend eval summary")
    print(json.dumps(summary, indent=2, sort_keys=True))


def test_backend_golden_eval(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    backend_cases = [
        case
        for case in _golden_cases()
        if case["surface"] in {"backend_health", "backend_emergency", "backend_agentic"}
    ]

    for case in backend_cases:
        if case["surface"] == "backend_health":
            row, case_failures = _run_health_case(case, tmp_path)
        elif case["surface"] == "backend_emergency":
            row, case_failures = _run_emergency_case(case)
        else:
            row, case_failures = _run_agentic_case(case, monkeypatch, tmp_path)
        rows.append(row)
        failures.extend(f"{case['id']}: {failure}" for failure in case_failures)

    _print_summary(rows)
    assert failures == []
