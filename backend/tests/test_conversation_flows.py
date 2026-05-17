from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.database import SessionLocal
import app.main as main_module
from app.main import _get_job_queue
from app.models import Item, QACache
from conftest import auth_headers, create_test_user


@pytest.fixture(autouse=True)
def legacy_pipeline_default(monkeypatch):
    monkeypatch.setenv("AI_ROUTER_ENABLED", "false")
    monkeypatch.setenv("AI_LEGACY_PIPELINE_ENABLED", "true")


@pytest.fixture()
def pipeline_stub(monkeypatch):
    # Keep chat-flow tests deterministic and offline. Without this, greetings can
    # be answered by the local fast path or the orchestrator can call live OpenAI.
    monkeypatch.setattr(
        "app.main.run_orchestrator",
        lambda client, text: {
            "intent": "GENERAL",
            "priority": "low",
            "confidence": 1.0,
            "matched_keyword": "",
        },
    )
    monkeypatch.setattr("app.main.upsert_qa_cache", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        "app.main._metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "assistant",
            "category": "Other",
            "datetime": None,
            "title": "Assistant",
            "details": fallback_details,
        },
    )


def test_text_chat_flow(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": f"Reply for: {message}",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )

    response = client.post(
        "/api/chat",
        headers={**headers, "x-request-id": "req-text-001"},
        json={"user_id": user_id, "message": "hello there", "reply_language": "en"},
    )
    assert response.status_code == 200
    assert response.headers["x-request-id"] == "req-text-001"

    payload = response.json()
    assert payload["ok"] is True
    assert payload["assistant"]["text"] == "Reply for: hello there"
    assert payload["item"]["intent"] == "assistant"


def test_streaming_chat_flow(client, monkeypatch):
    monkeypatch.setenv("STREAM_CHUNK_SIZE", "5")
    monkeypatch.setattr(
        "app.main._run_chat_payload",
        lambda payload: {
            "ok": True,
            "assistant": {"text": "hello streaming world"},
            "item": {"id": 1, "intent": "assistant", "category": "Other", "raw_text": "hi"},
            "pipeline": {"pipeline_version": "test"},
            "meta": {},
        },
    )

    user = create_test_user()
    headers = auth_headers("test-uid", "test@example.com")

    with client.stream("POST", "/api/chat/stream", headers=headers, json={"message": "hi", "reply_language": "en"}) as response:
        assert response.status_code == 200
        raw = "".join(response.iter_text())

    assert "event: status" in raw
    assert "event: token" in raw
    assert "event: done" in raw
    assert "hello" in raw
    assert "streaming" in raw


@pytest.mark.parametrize("path", ["/transcribe-and-analyze", "/api/transcribe-and-analyze"])
def test_voice_flow_uses_chat_response_shape(client, monkeypatch, pipeline_stub, path):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr("app.main._transcribe_audio_file", lambda path, speech_language=None: "voice hello")
    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "Voice reply",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )

    files = {"file": ("audio.m4a", b"fake-audio", "audio/m4a")}
    response = client.post(f"{path}?user_id={user_id}&reply_language=en", headers=headers, files=files)
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["assistant"]["text"] == "Voice reply"
    assert payload["item"]["transcript"] == "voice hello"
    assert payload["item"]["raw_text"] == "voice hello"


def test_legacy_voice_reminder_preserves_item_fields(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr("app.main._transcribe_audio_file", lambda path, speech_language=None: "remind me about standup")
    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "I will remind you about Standup.",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )
    monkeypatch.setattr(
        "app.main._metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "reminder",
            "category": "Work",
            "datetime": "2026-05-01T09:00:00",
            "title": "Standup",
            "details": fallback_details,
        },
    )

    files = {"file": ("audio.m4a", b"fake-audio", "audio/m4a")}
    response = client.post(f"/transcribe-and-analyze?user_id={user_id}&reply_language=en", headers=headers, files=files)
    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["datetime"] == "2026-05-01T09:00:00"
    assert payload["item"]["title"] == "Standup"


def test_reminder_creation_flow(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "I will remind you tomorrow at 8 AM",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )
    monkeypatch.setattr(
        "app.main._metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "reminder",
            "category": "Work",
            "datetime": "2026-03-28T08:00:00",
            "title": "Standup",
            "details": fallback_details,
        },
    )

    response = client.post(
        "/api/chat",
        headers=headers,
        json={"user_id": user_id, "message": "remind me for standup", "reply_language": "en"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["item"]["intent"] == "reminder"
    assert payload["item"]["datetime"] == "2026-03-28T08:00:00"
    assert payload["item"]["title"] == "Standup"


@pytest.mark.parametrize(
    ("message", "expected_terms"),
    [
        ("What is photosynthesis?", ["sunlight", "carbon dioxide", "oxygen"]),
        ("Explain quantum computing in simple words", ["qubit", "computing"]),
        ("What is a compiler?", ["compiler", "source code", "machine"]),
        ("What is fistula?", ["fistula", "abnormal", "clinician"]),
        ("Write a short email asking for a meeting", ["Subject:", "meeting", "Best regards"]),
    ],
)
def test_static_general_smoke_answers_do_not_require_openai(client, message, expected_terms):
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": message, "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    answer = payload["assistant"]["text"]
    assert payload["pipeline"]["route_taken"] == "static_general_answer"
    for term in expected_terms:
        assert term.lower() in answer.lower()


def test_weather_without_location_asks_for_location_instead_of_500(client):
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "What is the weather tomorrow?", "reply_language": "en"},
    )

    assert response.status_code == 200
    answer = response.json()["assistant"]["text"]
    assert "location" in answer.lower() or "city" in answer.lower() or "place" in answer.lower()
    assert "could not fetch the weather" not in answer.lower()


def test_reminder_create_missing_content_asks_clarifying_question(client):
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "Create a reminder for tomorrow morning", "reply_language": "en"},
    )

    assert response.status_code == 200
    answer = response.json()["assistant"]["text"]
    assert "What should I remind you about tomorrow morning?" in answer
    assert "do not have any reminders" not in answer.lower()


def test_bad_cached_reminder_list_answer_is_skipped_for_create_intent(client):
    user = create_test_user()
    cached_payload = {
        "pipeline": {
            "raw_english": "You do not have any tomorrow reminders, Smoke Test User.",
            "remodeled_english": "You do not have any tomorrow reminders, Smoke Test User.",
            "route_taken": "local_schedule_rag",
            "direct_answer_source": "local_schedule_memory",
            "direct_answer_confidence": "1.0000",
            "predicted_label": "schedule",
            "risk_level": "low",
        },
        "meta": {},
    }
    with SessionLocal() as session:
        session.add(
            QACache(
                user_id=int(user.id),
                question="Create a reminder for tomorrow morning",
                answer=json.dumps(cached_payload),
            )
        )
        session.commit()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "Create a reminder for tomorrow morning", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["pipeline"]["route_taken"] == "agentic_calendar"
    assert "What should I remind you about tomorrow morning?" in payload["assistant"]["text"]


def test_ipl_general_question_gets_general_answer_not_clarification(client):
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "Do you know about IPL?", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    answer = payload["assistant"]["text"].lower()
    assert payload["pipeline"]["route_taken"] == "static_general_answer"
    assert "indian premier league" in answer
    assert "cricket" in answer
    assert "are you asking" not in answer


def test_latest_ipl_score_reports_missing_live_provider_instead_of_generic_failure(client):
    create_test_user()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "What is the latest IPL score today?", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    answer = payload["assistant"]["text"]
    assert payload["pipeline"]["route_taken"] == "agentic_web_search"
    assert "Live IPL score lookup needs a configured live sports data provider" in answer
    assert "I could not fetch a reliable web result" not in answer


def test_live_ipl_score_ignores_local_cache_and_uses_web_route(client):
    user = create_test_user()
    cached_payload = {
        "pipeline": {
            "raw_english": "I can't check the live IPL score right now because the backend doesn't have a reliable sports data provider set up.",
            "remodeled_english": "I can't check the live IPL score right now because the backend doesn't have a reliable sports data provider set up.",
            "route_taken": "agentic_web_search",
            "direct_answer_source": "agentic_web_search",
            "direct_answer_confidence": "0.9900",
            "predicted_label": "web_search",
            "risk_level": "low",
        },
        "meta": {},
    }
    with SessionLocal() as session:
        session.add(
            QACache(
                user_id=int(user.id),
                question="What is the latest IPL score today?",
                answer=json.dumps(cached_payload),
            )
        )
        session.commit()

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "What is the latest IPL score today?", "reply_language": "en"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["pipeline"]["route_taken"] == "agentic_web_search"
    assert payload["pipeline"]["cache_hit"] == "false"
    assert "Live IPL score lookup needs a configured live sports data provider" in payload["assistant"]["text"]


def test_cache_side_effect_failure_does_not_fail_chat(client, monkeypatch):
    create_test_user()

    monkeypatch.setattr(
        "app.main.run_orchestrator",
        lambda client, text: {
            "intent": "GENERAL",
            "priority": "low",
            "confidence": 1.0,
            "matched_keyword": "",
        },
    )
    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": "Useful answer despite cache failure",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )
    monkeypatch.setattr(
        "app.main._metadata_for_item",
        lambda session, user_id, text, fallback_details: {
            "intent": "assistant",
            "category": "Other",
            "datetime": None,
            "title": "Assistant",
            "details": fallback_details,
        },
    )
    monkeypatch.setattr(
        "app.main.upsert_qa_cache",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("synthetic cache failure")),
    )

    response = client.post(
        "/api/chat",
        headers=auth_headers("test-uid", "test@example.com"),
        json={"message": "Tell me something useful", "reply_language": "en"},
    )

    assert response.status_code == 200
    assert response.json()["assistant"]["text"] == "Useful answer despite cache failure"


def test_async_export_job_flow(client, monkeypatch, tmp_path: Path):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")
    with SessionLocal() as session:
        item = Item(
            user_id=user_id,
            intent="assistant",
            category="Other",
            raw_text="export me",
            title="Export",
            details="Export body",
            source="text",
        )
        session.add(item)
        session.commit()
        session.refresh(item)
        item_id = int(item.id)

    # _build_download_payload only accepts files under DOCS_BASE_DIR.
    # Keep the test's fake export isolated while matching production's path contract.
    docs_dir = tmp_path / "generated_docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr("app.main.DOCS_BASE_DIR", docs_dir.resolve())

    export_file = docs_dir / "item_1.pdf"
    export_file.write_text("fake pdf")
    monkeypatch.setattr("app.main.generate_pdf", lambda item: export_file)

    response = client.post(f"/items/{item_id}/generate-pdf?background=true", headers=headers)
    assert response.status_code == 200
    job_id = response.json()["job"]["id"]

    processed = _get_job_queue()._process_one()
    assert processed is True

    status_response = client.get(f"/api/jobs/{job_id}", headers=headers)
    assert status_response.status_code == 200
    job = status_response.json()["job"]
    assert job["status"] == "completed"
    assert job["result"]["download_url"].startswith("/download/")


def test_async_chat_job_flow(client, monkeypatch, pipeline_stub):
    user = create_test_user()
    user_id = int(user.id)
    headers = auth_headers("test-uid", "test@example.com")

    monkeypatch.setattr(
        "app.main._run_agentic_or_pipeline",
        lambda session, user_id, message, reply_language=None: {
            "remodeled_english": f"Background reply for: {message}",
            "tamil_text": "",
            "theni_tamil_text": "",
            "pipeline_version": "test",
            "stage_notes": "[]",
            "core_meta": "{}",
            "remodel_meta": "{}",
            "review_meta": "{}",
            "translation_meta": "{}",
            "timings_ms": "{}",
        },
    )

    enqueue = client.post(
        "/api/chat/jobs",
        headers=headers,
        json={"user_id": user_id, "message": "do a long task", "reply_language": "en"},
    )
    assert enqueue.status_code == 200
    job_id = enqueue.json()["job"]["id"]

    processed = _get_job_queue()._process_one()
    assert processed is True

    status_response = client.get(f"/api/jobs/{job_id}", headers=headers)
    assert status_response.status_code == 200
    payload = status_response.json()["job"]
    assert payload["status"] == "completed"
    assert payload["result"]["assistant"]["text"] == "Background reply for: do a long task"




def test_tts_retry_timeout_returns_client_readable_error(client, monkeypatch):
    create_test_user()
    headers = auth_headers("test-uid", "test@example.com")
    monkeypatch.setattr(main_module, "SARVAM_API_KEY", "test-key")

    class DummyResponse:
        status_code = 400
        text = "bad payload"

        def json(self):
            return {}

    calls = []

    def fake_post(*args, **kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return DummyResponse()
        raise main_module.requests.Timeout("retry too slow")

    monkeypatch.setattr(main_module.requests, "post", fake_post)

    response = client.post("/api/tts", headers=headers, json={"text": "hello"})

    assert response.status_code == 504
    assert response.json()["detail"] == "TTS retry timed out."
    assert calls[0]["timeout"] == (5, 30)
    assert calls[1]["timeout"] == (5, 30)


def test_feature_flags(client, monkeypatch):
    monkeypatch.setenv("VOICE_ROUTING_MODE", "local")
    response = client.get("/api/flags")
    assert response.status_code == 200
    flags = response.json()["flags"]
    assert flags["voiceRoutingMode"] == "local"
    assert flags["streamingChatEnabled"] is True
    assert flags["asyncExportJobsEnabled"] is True
    assert isinstance(flags["vectorStoreBackend"], str)
