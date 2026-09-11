from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
import openai
from sqlmodel import select

from app.ai.agents.web_search_agent import (
    LiveSearchConfigurationError, WebSearchAgent, WebSearchResult,
    live_search_config,
)
from app.ai.freshness import validate_current_evidence
from app.ai.types import AIProviderResponse
from app.billing.pricing import calculate_topup
from app.billing.errors import InsufficientCreditError
from app.billing.service import credit_payment_once
from app.database import SessionLocal
from app.models import PaymentOrder, UsageCharge, WebChatMessage, WebUsagePreferences
from app.web_api.chat_service import execute_web_turn, prepare_web_turn

from tests.conftest import auth_headers, create_test_user


def _fund(user_id: int) -> None:
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id, receipt=f"paid-search-{user_id}",
            provider_order_id=f"paid-search-order-{user_id}",
            gross_amount_paise=1000, credited_amount_micros=credit,
            platform_share_paise=platform, status="captured",
        )
        session.add(order)
        session.flush()
        credit_payment_once(session, order)
        session.commit()


class _Responses:
    def __init__(self, response):
        self.response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class _SearchClient:
    def __init__(self, response):
        self.responses = _Responses(response)


def _search_response(
    *, completed: bool = True, with_source: bool = True, with_annotation: bool = True,
):
    source = {
        "url": "https://example.test/tamil-nadu-directory",
        "title": "Tamil Nadu official directory",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
    }
    action = type("Action", (), {
        "type": "search",
        "sources": [source] if with_source else [],
    })()
    call = type("Call", (), {
        "type": "web_search_call",
        "status": "completed" if completed else "in_progress",
        "action": action,
    })()
    usage = type("Usage", (), {"input_tokens": 21, "output_tokens": 17})()
    annotation = type("Annotation", (), {
        "type": "url_citation",
        "url": source["url"],
        "title": source["title"],
        "start_index": 0,
        "end_index": 51,
    })()
    message = type("Message", (), {
        "type": "message",
        "annotations": [annotation] if with_annotation else [],
    })()
    return type("Response", (), {
        "output": [call, message] if with_annotation else [call],
        "output_text": "Example Person is the Chief Minister of Tamil Nadu.",
        "usage": usage,
    })()


def test_paid_adapter_requires_completed_search_and_normalizes_citations(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    client = _SearchClient(_search_response())
    result = WebSearchAgent(client=client, clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )

    assert result.reason == "openai_responses_web_search"
    assert result.usage == {"input_tokens": 21, "output_tokens": 17, "search_calls": 1}
    call = client.responses.calls[0]
    assert call["model"] == "gpt-4.1-mini"
    assert call["tools"] == [{"type": "web_search", "external_web_access": True}]
    assert call["tool_choice"] == "required"
    assert "as of 2026-09-10" in call["input"]
    assert "citation immediately after the sentence" in call["input"]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True
    annotation_result = WebSearchAgent(
        client=_SearchClient(_search_response(with_source=False, with_annotation=True)),
        clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert annotation_result.reason == "openai_responses_web_search"
    assert annotation_result.results[0]["sources"]

    no_search = WebSearchAgent(
        client=_SearchClient(_search_response(completed=False)), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert no_search.reason == "search_tool_not_completed"
    assert no_search.results == []


@pytest.mark.parametrize(
    "answer",
    (
        "Example Person is the Chief Minister of Tamil Nadu.",
        "Example Person is the Chief Minister of Tamil Nadu. The office coordinates the state government.",
        "Example Person is the Chief Minister of Tamil Nadu. [Official directory](https://example.test/office.v1).",
        "A. B. Example is the Chief Minister of Tamil Nadu. See https://example.test/office.v1.",
    ),
)
def test_paid_adapter_extracts_concise_cited_claim_from_realistic_synthesis(monkeypatch, answer):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    source = {
        "url": "https://example.test/office.v1",
        "title": "Tamil Nadu official directory",
        "snippet": (
            "A. B. Example is the Chief Minister of Tamil Nadu."
            if answer.startswith("A. B.")
            else "Example Person is the Chief Minister of Tamil Nadu."
        ),
    }
    annotation = type("Annotation", (), {
        "type": "url_citation", "url": source["url"], "title": source["title"],
        "start_index": 0, "end_index": 12,
    })()
    action = type("Action", (), {"sources": [source]})()
    call = type("Call", (), {"type": "web_search_call", "status": "completed", "action": action})()
    message = type("Message", (), {
        "type": "message", "content": [type("Text", (), {"type": "output_text", "text": answer, "annotations": [annotation]})()],
    })()
    response = type("Response", (), {
        "output": [call, message], "output_text": answer,
        "usage": type("Usage", (), {"input_tokens": 8570, "output_tokens": 235})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results[0]["synthesis"] == " ".join(answer.split())[:4000]
    assert result.results[0]["answer_value"] in {"Example Person", "A. B. Example"}
    assert result.results[0]["claim"]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True


@pytest.mark.parametrize(
    "query,answer",
    (
        ("Who is the CM of Tamil Nadu?", "Example Person is the current Chief Minister of Tamil Nadu."),
        ("Who is the CM of Tamil Nadu?", "**Example Person** is the Chief Minister of Tamil Nadu."),
        ("Who is the CM of Tamil Nadu?", "The Chief Minister of Tamil Nadu is **Example Person**."),
        ("Who is the CM of Tamil Nadu?", "Currently, Example Person serves as Chief Minister of Tamil Nadu."),
        ("Who is the CM of Tamil Nadu?", "Tamil Nadu's Chief Minister is Example Person."),
        (
            "Who is the CM of Tamil Nadu?",
            "As of September 10, 2026, Example Person is the Chief Minister of Tamil Nadu.",
        ),
        (
            "தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் யார்?",
            "உதாரண நபர் தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் ஆவார்.",
        ),
        ("Tamil Nadu la ippo CM yaaru?", "Example Person Tamil Nadu la ippo CM-a irukkaru."),
    ),
)
def test_paid_adapter_extracts_sdk_boundary_wording_and_localized_facts(
    monkeypatch, query, answer,
):
    """Exercise Responses-shaped normalization, not a patched search method."""
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    response = _search_response()
    response.output_text = answer
    response.output[1].annotations[0].end_index = len(answer)
    response.output[0].action.sources[0]["snippet"] = answer
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search(query)
    assert result.reason == "openai_responses_web_search"
    assert len(result.results) == 1
    assert result.results[0]["answer_value"] in {"Example Person", "உதாரண நபர்"}
    assert validate_current_evidence(query, result.results, now=clock)[0] is True


def test_paid_adapter_retains_bounded_diagnostics_when_extraction_fails(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    first = {
        "url": "https://example.test/first", "title": "First source",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
    }
    second = {
        "url": "https://example.test/second", "title": "Second source",
        "snippet": "Another Person is the Chief Minister of Tamil Nadu.",
    }
    answer = "No reliable officeholder was identified in the returned material."
    annotation = type("Annotation", (), {
        "type": "url_citation", "url": second["url"], "title": second["title"],
        "start_index": 0, "end_index": 10,
    })()
    response = type("Response", (), {
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [first, second]})(),
            })(),
            type("Message", (), {
                "type": "message",
                "content": [type("Text", (), {
                    "type": "output_text", "text": answer,
                    "annotations": [annotation],
                })()],
            })(),
        ],
        "output_text": answer,
        "usage": type("Usage", (), {"input_tokens": 8570, "output_tokens": 227})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results == []
    assert result.reason == "search_claim_not_extractable"
    assert result.usage == {"input_tokens": 8570, "output_tokens": 227, "search_calls": 1}
    assert result.diagnostics is not None
    assert len(result.diagnostics["consulted_sources"]) == 2
    assert result.diagnostics["citation_annotations"][0]["url"] == second["url"]
    assert result.diagnostics["text_blocks"][0]["text"] == answer
    assert result.diagnostics["fixture_response"]["output"]
    assert result.diagnostics["extraction"]["reason"] == "no_candidate_fact"


def test_paid_adapter_replays_sanitized_fixture_without_openai_request(monkeypatch, tmp_path):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "false")
    fixture = {
        "format": "swico-paid-live-search-response-v1",
        "query": "Who is the CM of Tamil Nadu?",
        "capture_clock": "2026-09-10T12:00:00+00:00",
        "requested_as_of": "2026-09-10",
        "response": {
            "status": "completed",
            "output_text": "Example Person is the Chief Minister of Tamil Nadu.",
            "usage": {"input_tokens": 21, "output_tokens": 17},
            "output": [{
                "type": "web_search_call", "status": "completed",
                "action": {"type": "search", "sources": [{
                    "url": "https://example.test/office",
                    "title": "Official office directory",
                    "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
                }]},
            }, {
                "type": "message",
                "annotations": [{
                    "type": "url_citation",
                    "url": "https://example.test/office",
                    "title": "Official office directory",
                    "start_index": 0,
                    "end_index": 51,
                }],
            }],
        },
    }
    path = tmp_path / "fixture.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    called = False

    def fail(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("offline replay must not call OpenAI")

    monkeypatch.setattr(openai, "OpenAI", fail)
    completed = subprocess.run(
        [
            sys.executable, "backend/scripts/web_live_search_check.py",
            "--replay-fixture", str(path), "--pretty",
        ],
        cwd=str(Path(__file__).parents[2]),
        env={**dict(os.environ), "PYTHONPATH": "backend"},
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert '"offline_replay": true' in completed.stdout
    assert '"evidence_valid": true' in completed.stdout
    assert '"requested_as_of": "2026-09-10"' in completed.stdout
    assert called is False


def test_probe_debug_replay_reports_empty_result_diagnostics(tmp_path):
    fixture = {
        "format": "swico-paid-live-search-response-v1",
        "query": "Who is the CM of Tamil Nadu?",
        "response": {
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output_text": "No reliable officeholder was identified.",
            "usage": {"input_tokens": 8570, "output_tokens": 227},
            "output": [{
                "type": "web_search_call", "status": "completed",
                "action": {"type": "search", "sources": [
                    {"url": "https://example.test/consulted", "title": "Public source"},
                ]},
            }],
        },
    }
    path = tmp_path / "failed-fixture.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    completed = subprocess.run(
        [
            sys.executable, "backend/scripts/web_live_search_check.py",
            "--replay-fixture", str(path), "--debug-evidence", "--pretty",
        ],
        cwd=str(Path(__file__).parents[2]),
        env={**dict(os.environ), "PYTHONPATH": "backend"},
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 1
    assert '"consulted_source_count": 1' in completed.stdout
    assert '"text_blocks"' in completed.stdout
    assert '"no_candidate_fact"' in completed.stdout
    assert '"reason": "max_output_tokens"' in completed.stdout


@pytest.mark.parametrize(
    "answer",
    (
        "In 2021, Example Person was the Chief Minister of Tamil Nadu.",
        "Example Person is not the current Chief Minister of Tamil Nadu.",
    ),
)
def test_paid_adapter_rejects_historical_or_negated_current_claim(monkeypatch, answer):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    source = {"url": "https://example.test/office", "title": "Official directory"}
    response = type("Response", (), {
        "output": [type("Call", (), {
            "type": "web_search_call", "status": "completed",
            "action": type("Action", (), {"sources": [source]})(),
        })()],
        "output_text": answer,
        "usage": type("Usage", (), {"input_tokens": 10, "output_tokens": 10})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results == []
    assert result.reason == "search_claim_not_extractable"


def test_paid_adapter_binds_claim_to_nested_citation_not_first_consulted_source(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    unrelated = {"url": "https://example.test/weather", "title": "Weather page"}
    supporting = {
        "url": "https://example.test/official-office",
        "title": "Tamil Nadu official directory",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
    }
    nested = type("Annotation", (), {
        "type": "url_citation",
        "url_citation": type("Citation", (), {
            "url": supporting["url"], "title": supporting["title"],
                "start_index": 0, "end_index": 51,
        })(),
    })()
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [unrelated, supporting]})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text",
                    "text": "Example Person is the Chief Minister of Tamil Nadu.",
                    "annotations": [nested],
                })()],
            })(),
        ],
        "output_text": "Example Person is the Chief Minister of Tamil Nadu.",
        "usage": type("Usage", (), {"input_tokens": 12, "output_tokens": 8})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results[0]["url"] == supporting["url"]
    assert [source["url"] for source in result.results[0]["claim_sources"]] == [supporting["url"]]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True


def test_paid_adapter_keeps_multiple_candidates_and_citation_associations(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    text = (
        "Example Person is the Chief Minister of Tamil Nadu. "
        "Another Person is the Chief Minister of Tamil Nadu."
    )
    first = {
        "url": "https://example.test/first", "title": "First office source",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
    }
    second = {
        "url": "https://example.test/second", "title": "Second office source",
        "snippet": "Another Person is the Chief Minister of Tamil Nadu.",
    }
    first_end = text.index(".") + 1
    second_start = text.index("Another")
    annotations = [
        type("Annotation", (), {
            "type": "url_citation", "url": first["url"], "title": first["title"],
            "start_index": 0, "end_index": first_end,
        })(),
        type("Annotation", (), {
            "type": "url_citation", "url": second["url"], "title": second["title"],
            "start_index": second_start, "end_index": len(text),
        })(),
    ]
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [first, second]})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text", "text": text, "annotations": annotations,
                })()],
            })(),
        ],
        "output_text": text,
        "usage": type("Usage", (), {"input_tokens": 21, "output_tokens": 17})(),
    })()
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert len(result.results) == 2
    assert [item["claim_sources"][0]["url"] for item in result.results] == [
        first["url"], second["url"],
    ]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[2] == "evidence_stale_or_conflicting"


def test_paid_adapter_joins_multiple_response_content_blocks_before_citation_mapping(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    claim = "Example Person is the Chief Minister of Tamil Nadu."
    source = {
        "url": "https://example.test/office", "title": "Official office source",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
    }
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [source]})(),
            })(),
            type("Message", (), {
                "content": [
                    type("Text", (), {"type": "output_text", "text": "Context."})(),
                    type("Text", (), {
                        "type": "output_text", "text": claim,
                        "annotations": [type("Annotation", (), {
                            "type": "url_citation", "url": source["url"],
                            "title": source["title"], "start_index": 0,
                            "end_index": len(claim),
                        })()],
                    })(),
                ],
            })(),
        ],
        "usage": type("Usage", (), {"input_tokens": 21, "output_tokens": 17})(),
    })()
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert result.results
    assert result.results[0]["claim_sources"][0]["url"] == source["url"]
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True
    assert len(result.diagnostics["text_blocks"]) == 2
    assert result.diagnostics["aggregate_output_text_used"] is False


def test_paid_adapter_maps_local_annotation_indices_across_output_messages(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    first_claim = "Example Person is the Chief Minister of Tamil Nadu."
    second_claim = "Another Person is the Chief Minister of Tamil Nadu."
    first = {
        "url": "https://example.test/first-message",
        "title": "First message source",
        "snippet": first_claim,
    }
    second = {
        "url": "https://example.test/second-message",
        "title": "Second message source",
        "snippet": second_claim,
    }
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [first, second]})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text", "text": first_claim,
                    "annotations": [type("Annotation", (), {
                        "type": "url_citation", "url": first["url"],
                        "title": first["title"], "start_index": 0,
                        "end_index": len(first_claim),
                    })()],
                })()],
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text", "text": second_claim,
                    "annotations": [type("Annotation", (), {
                        "type": "url_citation", "url": second["url"],
                        "title": second["title"], "start_index": 0,
                        "end_index": len(second_claim),
                    })()],
                })()],
            })(),
        ],
        "usage": type("Usage", (), {"input_tokens": 21, "output_tokens": 17})(),
    })()
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert [item["claim_sources"][0]["url"] for item in result.results] == [
        first["url"], second["url"],
    ]
    assert [item["citation_annotations"][0]["original_start_index"] for item in result.results] == [0, 0]
    assert result.results[1]["citation_annotations"][0]["start_index"] > len(first_claim)


def test_paid_adapter_keeps_invalid_annotation_diagnostics_without_false_support(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    claim = "Example Person is the Chief Minister of Tamil Nadu."
    source = {
        "url": "https://example.test/office", "title": "Office source",
        "snippet": claim,
    }
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [source]})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text", "text": claim,
                    "annotations": [type("Annotation", (), {
                        "type": "url_citation", "url": source["url"],
                        "title": source["title"], "start_index": 0,
                        "end_index": len(claim) + 5,
                    })()],
                })()],
            })(),
        ],
        "output_text": claim,
        "usage": type("Usage", (), {"input_tokens": 21, "output_tokens": 17})(),
    })()
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert result.results == []
    assert result.reason == "claim_has_no_supporting_citation"
    assert result.diagnostics["invalid_annotations"][0]["reason"] == (
        "annotation_range_invalid_or_truncated"
    )
    assert result.diagnostics["extraction"]["stage"] == "citation_association"


def test_paid_adapter_does_not_require_synthetic_source_snippet(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    claim = "Example Person is the Chief Minister of Tamil Nadu."
    source = {"url": "https://example.test/office", "title": "Office source"}
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": [source]})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text", "text": claim,
                    "annotations": [type("Annotation", (), {
                        "type": "url_citation", "url": source["url"],
                        "title": source["title"], "start_index": 0,
                        "end_index": len(claim),
                    })()],
                })()],
            })(),
        ],
        "usage": type("Usage", (), {"input_tokens": 21, "output_tokens": 17})(),
    })()
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )[0] is True


def test_paid_adapter_associates_trailing_marker_with_bounded_supporting_passage(monkeypatch):
    # Labeled reconstruction of the reported production shape; the response
    # indices and fictional URLs were not captured from production.
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 11, 12, tzinfo=timezone.utc)
    prose = (
        "As of September 11, 2026, the Chief Minister of Tamil Nadu is "
        "C. Joseph Vijay, leader of the Tamilaga Vettri Kazhagam (TVK). "
        "He was sworn in on May 10, 2026, following his party's victory. "
        "[Onmanorama](https://example.test/onmanorama) "
        "The administration's political history is discussed separately. "
        "[NDTV](https://example.test/ndtv)"
    )
    onmanorama = {
        "url": "https://example.test/onmanorama",
        "title": "Onmanorama report",
        "snippet": "The report describes the May swearing-in.",
    }
    ndtv = {
        "url": "https://example.test/ndtv",
        "title": "NDTV history",
        "snippet": "The administration's political history.",
    }
    on_start = prose.index("[Onmanorama]")
    ndtv_start = prose.index("[NDTV]")
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {
                    "sources": [onmanorama, ndtv],
                })(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text",
                    "text": prose,
                    "annotations": [
                        type("Annotation", (), {
                            "type": "url_citation", "url": onmanorama["url"],
                            "title": onmanorama["title"],
                            "start_index": on_start,
                            "end_index": on_start + len("[Onmanorama]"),
                        })(),
                        type("Annotation", (), {
                            "type": "url_citation", "url": ndtv["url"],
                            "title": ndtv["title"],
                            "start_index": ndtv_start,
                            "end_index": ndtv_start + len("[NDTV]"),
                        })(),
                    ],
                })()],
            })(),
        ],
        "output_text": prose,
        "usage": type("Usage", (), {"input_tokens": 8570, "output_tokens": 227})(),
    })()
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results
    bundle = result.results[0]
    assert [item["url"] for item in bundle["claim_sources"]] == [onmanorama["url"]]
    assert bundle["supporting_passages"][0]["association_method"] == (
        "trailing_same_subject_passage"
    )
    assert "[Onmanorama]" in bundle["supporting_passages"][0]["marker_text"]
    assert ndtv["url"] not in [item["url"] for item in bundle["claim_sources"]]
    # Association succeeded, but the historical source snippet does not prove
    # that the generated September status is current.
    valid, _evidence, reason = validate_current_evidence(
        "Who is the CM of Tamil Nadu?", result.results, now=clock,
    )
    assert valid is False
    assert reason == "evidence_claim_not_supported"


def test_paid_adapter_rejects_single_consulted_source_without_inline_support(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 11, 12, tzinfo=timezone.utc)
    response = _search_response(with_annotation=False)
    result = WebSearchAgent(
        client=_SearchClient(response), clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert result.results == []
    assert result.reason == "claim_has_no_supporting_citation"
    assert result.diagnostics["extraction"]["stage"] == "citation_association"
    assert result.diagnostics["extraction"]["associations"][0]["rejection_reason"] == (
        "claim_has_no_supporting_citation"
    )


def test_paid_adapter_associates_adjacent_citation_group_without_cross_claim_leakage(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    claim = "Example Person is the Chief Minister of Tamil Nadu."
    text = f"{claim} [Official](https://example.test/official) [Directory](https://example.test/directory)"
    sources = [
        {
            "url": "https://example.test/official", "title": "Official",
            "snippet": claim,
        },
        {
            "url": "https://example.test/directory", "title": "Directory",
            "snippet": claim,
        },
    ]
    annotations = [
        type("Annotation", (), {
            "type": "url_citation", "url": source["url"],
            "title": source["title"],
            "start_index": text.index(f"[{source['title']}]"),
            "end_index": text.index(f"[{source['title']}]") + len(f"[{source['title']}]"),
        })()
        for source in sources
    ]
    response = type("Response", (), {
        "output": [
            type("Call", (), {
                "type": "web_search_call", "status": "completed",
                "action": type("Action", (), {"sources": sources})(),
            })(),
            type("Message", (), {
                "content": [type("Text", (), {
                    "type": "output_text", "text": text,
                    "annotations": annotations,
                })()],
            })(),
        ],
        "output_text": text,
        "usage": type("Usage", (), {"input_tokens": 21, "output_tokens": 17})(),
    })()
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert [source["url"] for source in result.results[0]["claim_sources"]] == [
        source["url"] for source in sources
    ]
    assert {item["association_method"] for item in result.results[0]["supporting_passages"]} == {
        "trailing_same_subject_passage", "trailing_citation_group",
    }


def test_current_date_prefix_is_not_rejected_as_historical(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    response = _search_response()
    response.output_text = (
        "As of 2026-09-10, Example Person is the Chief Minister of Tamil Nadu."
    )
    result = WebSearchAgent(client=_SearchClient(response), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu as of 2026-09-10?"
    )
    assert result.results
    assert validate_current_evidence(
        "Who is the CM of Tamil Nadu as of 2026-09-10?",
        result.results, now=clock,
    )[0] is True


def test_failed_paid_search_with_usage_persists_zero_customer_charge_and_replays(
    monkeypatch, client,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    user = create_test_user("paid-search-fallback", "paid-search-fallback@example.com")
    _fund(int(user.id))
    request_id = str(uuid4())
    response_fixture = _search_response()
    response_fixture.output_text = "No reliable officeholder was identified in the returned material."
    response_fixture.usage = type("Usage", (), {"input_tokens": 8570, "output_tokens": 235})()
    search_calls = 0

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.responses = _Responses(response_fixture)

        @property
        def responses(self):
            return self._responses

        @responses.setter
        def responses(self, value):
            nonlocal search_calls
            search_calls += 1
            self._responses = value

    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    generation_calls = []
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *args, **kwargs: generation_calls.append((args, kwargs))
        or (_ for _ in ()).throw(AssertionError("unavailable search must not generate")),
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("paid-search-fallback", "paid-search-fallback@example.com"),
        json={"request_id": request_id, "message": "Who is the CM of Tamil Nadu?", "reply_language": "en"},
    )
    assert response.status_code == 200
    assert 'event: done' in response.text
    assert 'event: error' not in response.text
    assert "I couldn’t verify the current answer" in response.text
    assert not generation_calls
    with SessionLocal() as session:
        charge = session.exec(
            select(UsageCharge).where(UsageCharge.request_id == request_id)
        ).one()
        assert charge.status == "settled"
        assert charge.usage_kind == "chat"
        assert charge.provider_cost_micros > 0
        assert charge.debited_micros == 0
        assert charge.reserved_micros == 0
        assistant = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.request_id == request_id,
                WebChatMessage.role == "assistant",
            )
        ).one()
    assert assistant.status == "complete"
    assert "couldn’t verify" in assistant.content
    replay = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("paid-search-fallback", "paid-search-fallback@example.com"),
        json={"request_id": request_id, "message": "Who is the CM of Tamil Nadu?", "reply_language": "en"},
    )
    assert replay.status_code == 200
    assert search_calls == 1


def test_endpoint_uses_real_adapter_normalization_and_emits_sources(
    monkeypatch, client,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    user = create_test_user("paid-search-adapter-endpoint", "paid-search-adapter-endpoint@example.com")
    _fund(int(user.id))
    response_fixture = _search_response(with_annotation=True)

    class FakeOpenAI:
        def __init__(self, **_kwargs):
            self.responses = _Responses(response_fixture)

    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    answer = "Example Person is the Chief Minister of Tamil Nadu. [S1]"

    def provider(_self, request, route, on_delta):
        on_delta(answer)
        return AIProviderResponse(
            text=answer, provider="openai", model=route.model, route=route.route,
            reason="mocked_generation", language="en", intent=route.intent,
            input_tokens=20, output_tokens=12,
            raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
        )

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", provider)
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("paid-search-adapter-endpoint", "paid-search-adapter-endpoint@example.com"),
        json={
            "request_id": str(uuid4()),
            "message": "Who is the CM of Tamil Nadu?",
            "reply_language": "en",
        },
    )
    assert response.status_code == 200
    assert "event: sources" in response.text
    assert "https://example.test/tamil-nadu-directory" in response.text


def test_paid_adapter_reports_missing_sources_timeout_and_missing_key(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    clock = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    no_sources = WebSearchAgent(
        client=_SearchClient(_search_response(with_source=False, with_annotation=False)),
        clock=lambda: clock,
    ).search("Who is the CM of Tamil Nadu?")
    assert no_sources.reason == "no_usable_sources"

    class TimeoutClient:
        class responses:
            @staticmethod
            def create(**_kwargs):
                raise TimeoutError("bounded search timeout")

    timeout = WebSearchAgent(client=TimeoutClient(), clock=lambda: clock).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert timeout.reason == "search_timeout"
    monkeypatch.delenv("OPENAI_API_KEY")
    missing_key = WebSearchAgent(client=_SearchClient(_search_response())).search(
        "Who is the CM of Tamil Nadu?"
    )
    assert missing_key.reason == "missing_api_key"


@pytest.mark.parametrize(
    ("name", "value"),
    (("WEB_LIVE_SEARCH_PROVIDER", "not-openai"), ("WEB_LIVE_SEARCH_MAX_CALLS_PER_TURN", "2")),
)
def test_enabled_live_search_rejects_unsafe_configuration(monkeypatch, name, value):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv(name, value)
    with pytest.raises(LiveSearchConfigurationError):
        live_search_config(require_key=True)


def test_paid_prepared_turn_admits_lookup_after_reservation_and_keeps_evidence(
    monkeypatch,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    user = create_test_user("paid-live-search", "paid-live-search@example.com")
    _fund(int(user.id))
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    search = WebSearchResult(
        enabled=True,
        reason="mocked_responses_search",
        usage={"input_tokens": 21, "output_tokens": 17, "search_calls": 1},
        results=[{
            "title": "Tamil Nadu official directory",
            "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
            "claim": "Example Person is the Chief Minister of Tamil Nadu.",
            "officeholder": "Example Person",
            "source": "official-government",
            "provenance": "official-government",
            "url": "https://example.test/tamil-nadu-directory",
            "retrieved_at": fixed.isoformat(),
            "temporal_as_of": "2026-09-10",
            "temporal_support": True,
            "relevant": True,
        }],
    )
    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: search,
    )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Who is the CM of Tamil Nadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en", now=fixed,
    )
    assert prepared.route.provider == "openai"
    assert prepared.precomputed_response is None
    assert prepared.retrieval_context is not None
    assert prepared.ai_request.metadata["freshness_evidence_status"] == "grounded"
    assert "Chief Minister of Tamil Nadu" in str(
        prepared.ai_request.metadata["serialized_provider_prompt"]
    )

    class Provider:
        def complete(self, request, route):
            assert "freshness_evidence_prompt" in request.metadata
            text = "Example Person is the Chief Minister of Tamil Nadu. [S1]"
            return AIProviderResponse(
                text=text, provider="openai", model=route.model,
                route=route.route, reason="mocked", language="en", intent=route.intent,
                input_tokens=20, output_tokens=12,
                raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
            )

        def stream_complete(self, request, route, on_delta):
            assert "freshness_evidence_prompt" in request.metadata
            text = "Example Person is the Chief Minister of Tamil Nadu. [S1]"
            on_delta(text)
            return AIProviderResponse(
                text=text, provider="openai", model=route.model,
                route=route.route, reason="mocked", language="en", intent=route.intent,
                input_tokens=20, output_tokens=12,
                raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
            )

    completed = execute_web_turn(prepared, providers={"openai": Provider()})
    assert completed.message.sources
    assert completed.message.sources[0]["locator"].startswith("https://")
    assert completed.response.raw["cache_eligible"] is False
    assert completed.response.raw["web_search_usage"]["calls"] == 1


@pytest.mark.parametrize(
    ("tier", "message", "reply_language", "expected_provider", "provider_pool"),
    (
        ("lite", "Who is the CM of Tamil Nadu?", "en", "openai", False),
        ("standard", "தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் யார்?", "ta", "sarvam", True),
        ("pro", "Tamil Nadu la ippo CM yaaru?", "tanglish", "sarvam", True),
    ),
)
def test_each_paid_tier_and_answer_language_uses_validated_search_evidence(
    monkeypatch, tier, message, reply_language, expected_provider, provider_pool,
):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("SARVAM_API_KEY", "test-key")
    monkeypatch.setenv("SWICO_PRO_ENABLED", "true")
    monkeypatch.setenv("WEB_MULTI_PROVIDER_ROUTING_ENABLED", str(provider_pool).lower())
    user = create_test_user(
        f"paid-{tier}-search", f"paid-{tier}-search@example.com",
    )
    with SessionLocal() as session:
        session.add(WebUsagePreferences(user_id=int(user.id), assistant_tier=tier))
        session.commit()
    _fund(int(user.id))
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(
            enabled=True,
            reason="mocked_responses_search",
            usage={"input_tokens": 21, "output_tokens": 17, "search_calls": 1},
            results=[{
                "title": "Tamil Nadu official directory",
                "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
                "claim": "Example Person is the Chief Minister of Tamil Nadu.",
                "officeholder": "Example Person",
                "source": "official-government",
                "provenance": "official-government",
                "url": "https://example.test/tamil-nadu-directory",
                "retrieved_at": fixed.isoformat(),
                "temporal_as_of": "2026-09-10",
                "temporal_support": True,
                "relevant": True,
            }],
        ),
    )

    prepared = prepare_web_turn(
        user_id=int(user.id), message=message, request_id=str(uuid4()),
        thread_id=None, reply_language=reply_language, now=fixed,
    )
    assert prepared.swico_tier == tier
    assert prepared.route.provider == expected_provider
    assert prepared.retrieval_context is not None

    class Provider:
        def complete(self, request, route):
            assert "freshness_evidence_prompt" in request.metadata
            answer = "Example Person is the Chief Minister of Tamil Nadu. [S1]"
            return AIProviderResponse(
                text=answer, provider=route.provider, model=route.model,
                route=route.route, reason="mocked", language=reply_language,
                intent=route.intent, input_tokens=20, output_tokens=12,
                raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
            )

    completed = execute_web_turn(
        prepared, providers={expected_provider: Provider()},
    )
    assert completed.message.sources
    assert completed.response.raw["cache_eligible"] is False


def test_free_current_turn_never_calls_paid_adapter(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    user = create_test_user("free-live-search", "free-live-search@example.com")
    called = False

    def fail(_self, _query):
        nonlocal called
        called = True
        raise AssertionError("Free must not call paid search")

    monkeypatch.setattr("app.web_api.chat_service.WebSearchAgent.search", fail)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Who is the CM of Tamil Nadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en",
        forced_swico_tier="free", swico_free_eligible=True,
    )
    assert prepared.precomputed_response is not None
    assert called is False


def test_insufficient_balance_admits_no_paid_search_call(monkeypatch):
    monkeypatch.setenv("WEB_LIVE_SEARCH_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    user = create_test_user("no-paid-balance", "no-paid-balance@example.com")
    called = False

    def fail(_self, _query):
        nonlocal called
        called = True
        raise AssertionError("search must follow the normal balance reservation")

    monkeypatch.setattr("app.web_api.chat_service.WebSearchAgent.search", fail)
    with pytest.raises(InsufficientCreditError):
        prepare_web_turn(
            user_id=int(user.id), message="Who is the CM of Tamil Nadu?",
            request_id=str(uuid4()), thread_id=None, reply_language="en",
        )
    assert called is False


def test_evidence_validation_can_skip_irrelevant_first_result_but_reject_conflicting_supported_claims():
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    query = "Who is the CM of Tamil Nadu?"
    common = {
        "url": "https://example.test/source",
        "source": "official-government",
        "provenance": "official-government",
        "retrieved_at": fixed.isoformat(),
        "temporal_as_of": "2026-09-10",
        "temporal_support": True,
        "relevant": True,
    }
    irrelevant = {
        **common,
        "title": "Tamil Nadu tourism guide",
        "snippet": "Tamil Nadu has beaches and wildlife tourism.",
    }
    supported = {
        **common,
        "title": "Tamil Nadu official directory",
        "snippet": "Example Person is the Chief Minister of Tamil Nadu.",
        "claim": "Example Person is the Chief Minister of Tamil Nadu.",
        "officeholder": "Example Person",
    }
    accepted, _evidence, reason = validate_current_evidence(
        query, [irrelevant, supported], now=fixed,
    )
    assert accepted is True
    assert reason == "grounded_current_evidence"

    conflicting = {
        **supported,
        "url": "https://example.test/other",
        "snippet": "Another Person is the Chief Minister of Tamil Nadu.",
        "claim": "Another Person is the Chief Minister of Tamil Nadu.",
        "officeholder": "Another Person",
    }
    assert validate_current_evidence(
        query, [supported, conflicting], now=fixed,
    )[2] == "evidence_stale_or_conflicting"
