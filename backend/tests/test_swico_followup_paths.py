from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from app.ai.freshness import resolve_freshness, validate_current_evidence
from app.ai.language import (
    WEB_REPLY_LANGUAGE_NAMES,
    WEB_REPLY_LANGUAGE_CODES,
    explicit_web_reply_language,
    resolve_web_reply_language,
)
from app.ai.types import AIProviderResponse
from app.ai.router import AIProviderRouter
from app.ai.types import AIRequest
from app.billing.pricing import calculate_topup
from app.billing.service import credit_payment_once
from app.database import SessionLocal
from app.models import PaymentOrder
from app.web_ai.telemetry.metadata import sanitize_metadata
from app.web_ai.generation.models import AnswerQualityResult, QualityCheck
from app.web_ai.persistence import persist_answer_quality
from app.web_api.chat_service import execute_web_turn, prepare_web_turn
from app.ai.agents.web_search_agent import WebSearchResult
from app.web_ai.generation.output_contract import (
    OutputContract,
    apply_reply_language_contract,
    extract_output_contract,
    validate_output_contract,
)
from tests.conftest import auth_headers, create_test_user


def _fund(user_id: int) -> None:
    credit, platform = calculate_topup(1000)
    with SessionLocal() as session:
        order = PaymentOrder(
            user_id=user_id,
            receipt=f"follow-up-{user_id}",
            provider_order_id=f"follow-up-order-{user_id}",
            gross_amount_paise=1000,
            credited_amount_micros=credit,
            platform_share_paise=platform,
            status="captured",
        )
        session.add(order)
        session.flush()
        credit_payment_once(session, order)
        session.commit()


def _sse_text(response) -> str:
    return "\n".join(
        json.loads(line.removeprefix("data: ")).get("text", "")
        for line in response.text.splitlines()
        if line.startswith("data: ") and '"text"' in line
    )


def test_temporal_decision_handles_roles_dates_and_timedless_now():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert resolve_freshness("CM of Tamil Nadu", now=clock).requires_fresh_evidence
    assert resolve_freshness("Who is the CM of Tamilnadu?", now=clock).scope == "current"
    assert resolve_freshness("Who was appointed Chief Minister today?", now=clock).scope == "current"
    timeless = resolve_freshness("Explain how the word now is used in grammar.", now=clock)
    assert timeless.scope == "unspecified" and not timeless.requires_fresh_evidence
    historical = resolve_freshness("Who was CM as of 2020-01-02?", now=clock)
    assert historical.scope == "historical" and historical.as_of == "2020-01-02"


def test_temporal_decision_normalizes_abbreviated_and_named_officeholder_dates():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert resolve_freshness("CM of Tamil Nadu as of 2026-09-10", now=clock).scope == "current"
    assert resolve_freshness("CM of Tamilnadu as of September 11, 2026", now=clock).scope == "future"
    assert resolve_freshness("Who is the CM on 2020-01-02?", now=clock).scope == "historical"


def test_temporal_mixed_scope_preserves_current_evidence_requirement():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    decision = resolve_freshness(
        "Who was the CM on 2020-01-02, and who is the CM now?", now=clock,
    )
    assert decision.scope == "mixed"
    assert decision.requires_fresh_evidence is True


def test_general_role_explanation_is_not_current_officeholder_data():
    decision = resolve_freshness(
        "Explain the role of a chief minister in the Indian Constitution.",
        now=datetime(2026, 9, 10, tzinfo=timezone.utc),
    )
    assert decision.scope == "unspecified"
    assert decision.requires_fresh_evidence is False


def test_tamil_and_tanglish_current_officeholder_questions_are_freshness_gated():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    for message in (
        "தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் யார்?",
        "Tamil Nadu la ippo CM yaaru?",
    ):
        decision = resolve_freshness(message, now=clock)
        assert decision.scope == "current"
        assert decision.requires_fresh_evidence is True


def test_tamil_and_tanglish_historical_and_future_years_keep_their_scope():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    historical = (
        "2020-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?",
        "2020 la Tamil Nadu CM yaaru?",
    )
    future = (
        "2027-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?",
        "2027 la Tamil Nadu CM yaaru?",
    )
    for message in historical:
        decision = resolve_freshness(message, now=clock)
        assert decision.scope == "historical"
        assert decision.as_of == "2020"
        assert decision.requires_fresh_evidence is False
    for message in future:
        decision = resolve_freshness(message, now=clock)
        assert decision.scope == "future"
        assert decision.as_of == "2027"
        assert decision.requires_fresh_evidence is True


@pytest.mark.parametrize(
    ("message", "scope", "required", "as_of", "historical_as_of"),
    (
        ("2020 la Tamil Nadu CM yaaru?", "historical", False, "2020", None),
        ("2027 la Tamil Nadu CM yaaru?", "future", True, "2027", None),
        ("2026 la Tamil Nadu CM yaaru?", "current", True, "2026-09-10", None),
        (
            "2020 la Tamil Nadu CM yaaru, and who is the CM now?",
            "mixed", True, "2026-09-10", "2020",
        ),
        (
            "2020 la Tamil Nadu CM yaaru, ippo CM yaaru?",
            "mixed", True, "2026-09-10", "2020",
        ),
        ("2020-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?", "historical", False, "2020", None),
        ("2027-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?", "future", True, "2027", None),
        ("2026-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?", "current", True, "2026-09-10", None),
        (
            "2020-ல் தமிழ்நாட்டின் முதலமைச்சர் யார், இப்போது முதலமைச்சர் யார்?",
            "mixed", True, "2026-09-10", "2020",
        ),
    ),
)
def test_localized_years_preserve_mixed_current_scope_and_validation_date(
    message, scope, required, as_of, historical_as_of,
):
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    decision = resolve_freshness(message, now=clock)
    assert (decision.scope, decision.requires_fresh_evidence, decision.as_of) == (
        scope, required, as_of,
    )
    assert decision.historical_as_of == historical_as_of


def test_localized_mixed_scope_reaches_preparation_and_cache_admission():
    user = create_test_user("freshness-localized-mixed", "freshness-localized-mixed@example.com")
    _fund(int(user.id))
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    for message in (
        "2020 la Tamil Nadu CM yaaru, and who is the CM now?",
        "2020 la Tamil Nadu CM yaaru, ippo CM yaaru?",
    ):
        prepared = prepare_web_turn(
            user_id=int(user.id), message=message, request_id=str(uuid4()),
            thread_id=None, reply_language="en", now=clock,
        )
        assert prepared.ai_request.metadata["freshness_scope"] == "mixed"
        assert prepared.ai_request.metadata["freshness_required"] is True
        assert prepared.ai_request.metadata["freshness_as_of"] == "2026-09-10"
        assert prepared.ai_request.metadata["freshness_historical_as_of"] == "2020"
        assert prepared.route.provider == "blocked"
        assert prepared.optimization is not None
        assert prepared.optimization.cache_eligible is False


def test_prepared_tamil_and_tanglish_current_questions_are_blocked_without_search():
    user = create_test_user("freshness-localized", "freshness-localized@example.com")
    _fund(int(user.id))
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    for message, language in (
        ("தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் யார்?", "ta"),
        ("Tamil Nadu la ippo CM yaaru?", "tanglish"),
        ("2026 la Tamil Nadu CM yaaru?", "en"),
        ("2026-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?", "ta"),
    ):
        prepared = prepare_web_turn(
            user_id=int(user.id), message=message, request_id=str(uuid4()),
            thread_id=None, reply_language=language, now=clock,
        )
        assert prepared.ai_request.metadata["freshness_required"] is True
        assert prepared.route.provider == "blocked"
        assert prepared.optimization is not None
        assert prepared.optimization.cache_eligible is False


def test_prepared_localized_historical_questions_are_not_live_blocked():
    user = create_test_user("freshness-localized-history", "freshness-localized-history@example.com")
    _fund(int(user.id))
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    for message in (
        "2020-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?",
        "2020 la Tamil Nadu CM yaaru?",
    ):
        prepared = prepare_web_turn(
            user_id=int(user.id), message=message, request_id=str(uuid4()),
            thread_id=None, reply_language="en", now=clock,
        )
        assert prepared.ai_request.metadata["freshness_scope"] == "historical"
        assert prepared.ai_request.metadata["freshness_required"] is False
        assert prepared.route.provider != "blocked"
        assert prepared.optimization is not None
        assert prepared.optimization.cache_scope_reason != "freshness_requires_retrieval"


@pytest.mark.parametrize(
    ("message", "language"),
    (
        ("தமிழ்நாட்டின் தற்போதைய முதலமைச்சர் யார்?", "ta"),
        ("Tamil Nadu la ippo CM yaaru?", "tanglish"),
        ("2026 la Tamil Nadu CM yaaru?", "en"),
        ("2026-ல் தமிழ்நாட்டின் முதலமைச்சர் யார்?", "ta"),
    ),
)
def test_current_tamil_questions_use_localized_unavailable_endpoint_response(monkeypatch, client, message, language):
    user = create_test_user(f"freshness-endpoint-{language}", f"freshness-endpoint-{language}@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers(f"freshness-endpoint-{language}", f"freshness-endpoint-{language}@example.com"),
        json={"request_id": str(uuid4()), "message": message, "reply_language": language},
    )
    assert response.status_code == 200
    text = _sse_text(response)
    assert text.strip()
    assert "Example" not in text


def test_prepared_mixed_scope_and_timeless_role_share_freshness_cache_policy():
    user = create_test_user("freshness-mixed-prepared", "freshness-mixed-prepared@example.com")
    _fund(int(user.id))
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    mixed = prepare_web_turn(
        user_id=int(user.id),
        message="Who was the CM on 2020-01-02, and who is the CM now?",
        request_id=str(uuid4()), thread_id=None, reply_language="en", now=clock,
    )
    assert mixed.ai_request.metadata["freshness_scope"] == "mixed"
    assert mixed.ai_request.metadata["freshness_required"] is True
    assert mixed.route.provider == "blocked"
    assert mixed.optimization is not None and mixed.optimization.cache_eligible is False

    general = prepare_web_turn(
        user_id=int(user.id),
        message="Explain the role of a chief minister in the Indian Constitution.",
        request_id=str(uuid4()), thread_id=None, reply_language="en", now=clock,
    )
    assert general.ai_request.metadata["freshness_scope"] == "unspecified"
    assert general.ai_request.metadata["freshness_required"] is False
    assert general.route.provider != "blocked"
    assert general.optimization is not None
    assert general.optimization.cache_scope_reason != "freshness_requires_retrieval"


def test_current_evidence_matches_role_and_ignores_polite_instruction_words():
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    base = {
        "url": "https://example.test/current", "source": "official-government",
        "provenance": "official-government", "temporal_support": True,
        "temporal_as_of": "2026-09-10", "relevant": True,
        "retrieved_at": fixed.isoformat(),
    }
    governor = {**base, "title": "Tamil Nadu Governor", "snippet": "The Governor of Tamil Nadu is Example Governor."}
    prime_minister = {**base, "title": "Prime Minister of India", "snippet": "Example PM is the current Prime Minister of India.", "officeholder": "Example PM"}
    assert validate_current_evidence("Please identify the CM of Tamil Nadu", governor, now=fixed)[0] is False
    assert validate_current_evidence("Please identify the PM of India", prime_minister, now=fixed)[0] is True
    wrong_state = {**base, "title": "Kerala Chief Minister", "snippet": "The Chief Minister of Kerala is Example Person."}
    assert validate_current_evidence("Who is the Chief Minister of Tamil Nadu?", wrong_state, now=fixed)[0] is False
    matching_title_wrong_body = {**base, "title": "Tamil Nadu Chief Minister", "snippet": "Example Person is the Chief Minister of Kerala.", "officeholder": "Example Person"}
    assert validate_current_evidence("Who is the Chief Minister of Tamil Nadu?", matching_title_wrong_body, now=fixed)[0] is False
    role_definition = {**base, "title": "Tamil Nadu Chief Minister", "snippet": "The Chief Minister of Tamil Nadu leads the elected state government."}
    assert validate_current_evidence("Who is the Chief Minister of Tamil Nadu?", role_definition, now=fixed)[0] is False


def test_language_resolution_ignores_quotes_negation_and_subject_names():
    assert explicit_web_reply_language("Translate it to English") == "en"
    assert explicit_web_reply_language("Do not reply in Tamil; reply in English") == "en"
    assert explicit_web_reply_language('Discuss "reply in English" and English grammar') is None
    assert resolve_web_reply_language("ta", "Answer in English about Tamil Nadu") == "en"
    assert resolve_web_reply_language("ta", "Translate it to English") == "en"


def test_resolved_english_clears_subject_language_script_requirement():
    message = "Reply in English and explain the Tamil language"
    contract = apply_reply_language_contract(
        extract_output_contract(message), "en",
    )
    assert contract.required_script is None
    checks = validate_output_contract(
        "Tamil is a language spoken by many people. English can describe its history clearly.",
        contract,
    )
    assert all(check.status == "passed" for check in checks)


def test_superseded_or_discussed_tamil_does_not_conflict_with_english_contract():
    for message, profile in (
        ("Reply in English and explain how Tamil sentences are structured", "ta"),
        ("Reply in Tamil. Actually, reply in English.", "ta"),
        ("Write about education in Tamil Nadu", "en"),
        ("Give me information about schools in Tamil Nadu", "en"),
        ("Reply in Tamil. Translate it to English.", "ta"),
        ("Reply in Tamil. Explain it in English.", "ta"),
    ):
        contract = apply_reply_language_contract(extract_output_contract(message), "en")
        assert contract.required_script is None
        checks = validate_output_contract(
            "English can explain how Tamil sentences are structured without requiring Tamil script.",
            contract,
        )
        assert all(check.status == "passed" for check in checks)


def test_resolved_non_english_targets_replace_superseded_tamil_script_contracts():
    cases = (
        ("Reply in Tamil. Translate it to Tanglish.", "tanglish", "Tamil Nadu pathi oru short explanation."),
        ("Reply in Tamil. Explain it in Hindi.", "hi", "तमिलनाडु के बारे में यह एक संक्षिप्त विवरण है।"),
        ("Reply in Tamil. Translate it to English.", "en", "This is an English explanation."),
        ("Reply in Tamil.", "ta", "இது தமிழ் பதில்."),
    )
    for message, expected_language, answer in cases:
        resolved = resolve_web_reply_language("ta", message)
        assert resolved == expected_language
        contract = apply_reply_language_contract(extract_output_contract(message), resolved)
        checks = validate_output_contract(answer, contract)
        assert all(check.status == "passed" for check in checks)


def test_prepared_non_english_language_contract_reaches_provider_and_validation():
    user = create_test_user("language-non-english", "language-non-english@example.com")
    _fund(int(user.id))
    cases = (
        ("Reply in Tamil. Translate it to Tanglish.", "tanglish", "Tamil Nadu pathi oru short explanation."),
        ("Reply in Tamil. Explain it in Hindi.", "hi", "तमिलनाडु के बारे में यह एक संक्षिप्त विवरण है।"),
    )
    for message, expected_language, answer in cases:
        prepared = prepare_web_turn(
            user_id=int(user.id), message=message, request_id=str(uuid4()),
            thread_id=None, reply_language="ta",
        )
        assert prepared.reply_language == expected_language
        contract = OutputContract.from_metadata(prepared.ai_request.metadata["output_contract"])
        assert all(check.status == "passed" for check in validate_output_contract(answer, contract))
        assert any(expected_language.title() in str(item.get("content") or "")
                   for item in prepared.ai_request.metadata["provider_messages"]
                   if isinstance(item, dict))


@pytest.mark.parametrize("target", WEB_REPLY_LANGUAGE_CODES)
@pytest.mark.parametrize("directive", ("Reply", "Translate", "Explain"))
def test_full_language_matrix_reaches_contract_prompt_and_validation(target, directive):
    user = create_test_user(
        f"language-matrix-{directive.lower()}-{target}",
        f"language-matrix-{directive.lower()}-{target}@example.com",
    )
    _fund(int(user.id))
    target_name = WEB_REPLY_LANGUAGE_NAMES[target]
    if directive == "Reply":
        message = f"Reply in Tamil. Actually, reply in {target_name}."
    elif directive == "Translate":
        message = f"Reply in Tamil. Translate it to {target_name}."
    else:
        message = f"Reply in Tamil. Explain it in {target_name}."
    resolved = resolve_web_reply_language("ta", message)
    assert resolved == target
    prepared = prepare_web_turn(
        user_id=int(user.id), message=message, request_id=str(uuid4()),
        thread_id=None, reply_language="ta",
    )
    assert prepared.reply_language == resolved == target
    contract = OutputContract.from_metadata(
        prepared.ai_request.metadata["output_contract"]
    )
    if target == "ta":
        answer = "தமிழ் மொழியில் இது ஒரு சுருக்கமான பதில்."
        assert contract.required_script == "tamil"
    elif target == "tanglish":
        answer = "Idhu oru short Tanglish badhil."
        assert contract.forbid_tamil_script is True
        assert contract.required_script is None
    else:
        answer = f"This is a concise answer in {target_name}."
        assert contract.required_script is None
        assert contract.forbid_tamil_script is False
    checks = validate_output_contract(answer, contract)
    assert all(check.status == "passed" for check in checks)
    provider_messages = prepared.ai_request.metadata["provider_messages"]
    assert target_name in " ".join(str(item.get("content") or "") for item in provider_messages)


def test_prepared_language_contract_uses_the_final_english_instruction():
    user = create_test_user("language-final-instruction", "language-final-instruction@example.com")
    _fund(int(user.id))
    for message, profile in (
        ("Reply in English and explain how Tamil sentences are structured", "ta"),
        ("Reply in Tamil. Actually, reply in English.", "ta"),
        ("Write about education in Tamil Nadu", "en"),
        ("Give me information about schools in Tamil Nadu", "en"),
        ("Reply in Tamil. Translate it to English.", "ta"),
        ("Reply in Tamil. Explain it in English.", "ta"),
    ):
        prepared = prepare_web_turn(
            user_id=int(user.id), message=message, request_id=str(uuid4()),
            thread_id=None, reply_language=profile,
        )
        assert prepared.reply_language == "en"
        assert prepared.ai_request.metadata["output_contract"]["required_script"] is None
        assert any(
            "English" in str(item.get("content") or "")
            for item in prepared.ai_request.metadata["provider_messages"]
            if isinstance(item, dict)
        )


def test_explicit_english_translation_does_not_require_tamil_script():
    contract = apply_reply_language_contract(
        extract_output_contract("Translate this Tamil sentence to English"), "en",
    )
    assert contract == OutputContract()


def test_prepared_language_contract_accepts_an_english_answer_about_tamil_nadu():
    user = create_test_user("language-contract", "language-contract@example.com")
    _fund(int(user.id))
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Explain Tamil Nadu in three simple sentences in English",
        request_id=str(uuid4()),
        thread_id=None,
        reply_language="ta",
    )
    assert prepared.reply_language == "en"
    contract = prepared.ai_request.metadata["output_contract"]
    assert contract["required_script"] is None
    checks = __import__(
        "app.web_ai.generation.output_contract",
        fromlist=["validate_output_contract", "OutputContract"],
    ).validate_output_contract(
        "Tamil Nadu is a state in southern India. It has a rich history. Its capital is Chennai.",
        __import__(
            "app.web_ai.generation.output_contract",
            fromlist=["OutputContract"],
        ).OutputContract.from_metadata(contract),
    )
    assert all(check.status == "passed" for check in checks)


def test_prepared_turn_sends_the_resolved_language_to_provider_and_validation():
    user = create_test_user("language-provider-path", "language-provider-path@example.com")
    _fund(int(user.id))
    captured = {}

    class Provider:
        def complete(self, request, route):
            captured.update({
                "reply_language": request.reply_language,
                "messages": request.metadata.get("provider_messages"),
                "contract": request.metadata.get("output_contract"),
            })
            return AIProviderResponse(
                text=(
                    "Tamil Nadu is a state in southern India. "
                    "It has a rich history. Its capital is Chennai."
                ),
                provider=route.provider, model=route.model, route=route.route,
                reason=route.reason, language="en", intent=route.intent,
                input_tokens=10, output_tokens=20,
                raw={
                    "usage_actual": True, "finish_reason": "stop",
                    "completion_status": "complete",
                    "quality": {"status": "checked", "retrieval_status": "insufficient", "checks": []},
                },
            )

    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Reply in English and explain how Tamil sentences are structured",
        request_id=str(uuid4()), thread_id=None, reply_language="ta",
    )
    completed = execute_web_turn(
        prepared, providers={prepared.route.provider: Provider()},
    )
    assert captured["reply_language"] == "en"
    assert any(
        "English" in str(item.get("content") or "")
        for item in captured["messages"]
        if isinstance(item, dict)
    )
    assert captured["contract"]["required_script"] is None
    assert completed.message.content.startswith("Tamil Nadu is a state")


def test_punctuation_scoped_negation_and_translation_rebuild_the_final_contract():
    assert resolve_web_reply_language(
        "ta", "Do not reply in Tamil. Reply in English.",
    ) == "en"
    user = create_test_user("language-punctuation", "language-punctuation@example.com")
    _fund(int(user.id))
    prepared = prepare_web_turn(
        user_id=int(user.id),
        message="Translate this Tamil sentence to English",
        request_id=str(uuid4()),
        thread_id=None,
        reply_language="ta",
    )
    assert prepared.reply_language == "en"
    assert prepared.ai_request.metadata["output_contract"]["required_script"] is None


def test_checked_quality_survives_strict_metadata_sanitization():
    assert sanitize_metadata({"quality_outcome": "checked"})["quality_outcome"] == "checked"


def test_checked_quality_persists_as_passed_for_history_and_audit_consumers():
    user = create_test_user("checked-quality", "checked-quality@example.com")
    result = AnswerQualityResult(
        status="checked", checks=(QualityCheck("format", "passed"),),
    )
    with SessionLocal() as session:
        row = persist_answer_quality(
            session, user_id=int(user.id), thread_id=None,
            request_id="checked-quality-request", assistant_message_id=None,
            result=result,
        )
        session.commit()
        assert row.status == "passed"
        assert json.loads(row.safe_metadata_json)["quality_outcome"] == "checked"


def test_current_request_is_gated_in_real_web_stream_before_provider(monkeypatch, client):
    user = create_test_user("freshness-disabled", "freshness-disabled@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "false")
    calls = {"provider": 0}

    def provider(*_args, **_kwargs):
        calls["provider"] += 1
        raise AssertionError("current factual request must not guess without retrieval")

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", provider)
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("freshness-disabled", "freshness-disabled@example.com"),
        json={"request_id": str(uuid4()), "message": "Who is the CM of Tamilnadu?"},
    )
    assert response.status_code == 200
    assert calls["provider"] == 0
    assert "will not guess" in _sse_text(response)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Who is the CM of Tamilnadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en",
    )
    assert prepared.optimization is not None and prepared.optimization.cache_eligible is False


def test_explicit_today_and_future_officeholder_requests_are_gated_in_prepared_path():
    user = create_test_user("freshness-explicit-date", "freshness-explicit-date@example.com")
    _fund(int(user.id))
    for message, scope in (
        ("Who is the CM as of 2026-09-10?", "current"),
        ("Who is the CM as of 2026-09-11?", "future"),
        ("CM of Tamil Nadu as of 2026-09-10?", "current"),
        ("CM of Tamilnadu as of September 11, 2026?", "future"),
    ):
        prepared = prepare_web_turn(
            user_id=int(user.id), message=message, request_id=str(uuid4()),
            thread_id=None, reply_language="en",
            now=datetime(2026, 9, 10, tzinfo=timezone.utc),
        )
        assert prepared.ai_request.metadata["freshness_scope"] == scope
        assert prepared.ai_request.metadata["freshness_required"] is True
        assert prepared.route.provider == "blocked"
        assert prepared.optimization is not None and prepared.optimization.cache_eligible is False
    assert resolve_freshness(
        "CM of Tamil Nadu as of 2026-09-10?",
        now=datetime(2026, 9, 11, tzinfo=timezone.utc),
    ).scope == "historical"


def test_freshness_resolves_explicit_dates_against_the_injected_clock():
    clock = datetime(2026, 9, 10, tzinfo=timezone.utc)
    as_of_today = resolve_freshness(
        "Who is the CM as of 2026-09-10?", now=clock,
    )
    assert as_of_today.scope == "current"
    assert as_of_today.requires_fresh_evidence is True
    assert as_of_today.as_of == "2026-09-10"
    future = resolve_freshness(
        "Who is the CM as of 2026-09-11?", now=clock,
    )
    assert future.scope == "future"
    assert future.requires_fresh_evidence is True
    past = resolve_freshness(
        "Who was CM as of 2020-01-02?", now=clock,
    )
    assert past.scope == "historical"
    assert past.requires_fresh_evidence is False
    mixed = resolve_freshness(
        "Who is the current CM and who was the previous CM?", now=clock,
    )
    assert mixed.requires_fresh_evidence is True
    assert mixed.scope == "mixed"


def test_contextual_officeholder_followup_inherits_temporal_subject():
    decision = resolve_freshness(
        "Who holds it now?",
        context="User: Who is the Chief Minister of Tamil Nadu?\nAssistant: The current officeholder is...",
        now=datetime(2026, 9, 10, tzinfo=timezone.utc),
    )
    assert decision.requires_fresh_evidence is True


def test_weather_route_is_retrieval_gated_when_search_is_enabled(monkeypatch):
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    route = AIProviderRouter().select_route(AIRequest(
        user_id=1, message="What is the weather today in Chennai?", reply_language="en",
        channel="text", request_id="weather-route", metadata={
            "client_surface": "web", "swico_tier": "lite",
        },
    ))
    assert route.intent == "weather"
    assert route.metadata["freshness_required"] is True


def test_current_endpoint_requires_temporally_supported_evidence(monkeypatch, client):
    user = create_test_user("freshness-stale", "freshness-stale@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    provider_calls = {"count": 0}

    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(
            enabled=True,
            results=[{
                "title": "Tamil Nadu Chief Minister",
                "snippet": "An old summary without present-day confirmation.",
                "source": "wikipedia_summary",
                "url": "https://example.test/old-summary",
                "retrieved_at": "2026-09-10T10:00:00+00:00",
                "temporal_support": False,
            }],
            reason="mock_stale_retrieval",
        ),
    )
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *_args, **_kwargs: provider_calls.__setitem__("count", provider_calls["count"] + 1),
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("freshness-stale", "freshness-stale@example.com"),
        json={"request_id": str(uuid4()), "message": "Who is the CM of Tamil Nadu?"},
    )
    assert response.status_code == 200
    assert provider_calls["count"] == 0
    assert "will not guess" in _sse_text(response)
    assert validate_current_evidence("Who is the CM of Tamil Nadu?", {
        "title": "old", "snippet": "old", "url": "https://example.test/old",
        "retrieved_at": "2020-01-01T00:00:00Z", "source": "old", "temporal_support": False,
    })[0] is False


def test_weather_endpoint_cannot_bypass_freshness_gate(monkeypatch, client):
    user = create_test_user("freshness-weather", "freshness-weather@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(enabled=True, results=[], reason="not_configured"),
    )
    provider_calls = {"count": 0}
    monkeypatch.setattr(
        "app.ai.providers.openai_provider.OpenAIProvider.stream_complete",
        lambda *_args, **_kwargs: provider_calls.__setitem__("count", provider_calls["count"] + 1),
    )
    response = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("freshness-weather", "freshness-weather@example.com"),
        json={"request_id": str(uuid4()), "message": "What is the weather today in Chennai?"},
    )
    assert response.status_code == 200
    assert provider_calls["count"] == 0
    assert "will not guess" in _sse_text(response)


def test_current_evidence_rejects_malformed_old_future_unrelated_and_conflicting_results():
    query = "Who is the CM of Tamil Nadu?"
    base = {
        "title": "Tamil Nadu Chief Minister",
        "snippet": "Tamil Nadu Chief Minister current officeholder",
        "url": "https://example.test/current",
        "source": "official-government",
        "provenance": "official-government",
        "temporal_support": True,
        "temporal_as_of": "2026-09-10",
        "relevant": True,
    }
    fixed = datetime(2026, 9, 10, 12, tzinfo=timezone.utc)
    assert validate_current_evidence(query, {**base, "retrieved_at": "not-a-date"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {**base, "retrieved_at": "2020-01-01T00:00:00Z"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {**base, "retrieved_at": "2026-09-11T00:00:00Z"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {**base, "retrieved_at": fixed.isoformat(), "relevant": False, "snippet": "weather in London"}, now=fixed)[0] is False
    assert validate_current_evidence(query, {
        **base,
        "title": "Tamil Nadu tourism guide",
        "snippet": "Tamil Nadu has beaches, temples, and wildlife tourism.",
        "retrieved_at": fixed.isoformat(),
    }, now=fixed)[0] is False
    assert validate_current_evidence(query, [
        {**base, "retrieved_at": fixed.isoformat(), "claim": "A"},
        {**base, "retrieved_at": fixed.isoformat(), "claim": "B"},
    ], now=fixed)[0] is False
    assert validate_current_evidence(
        "Who is the CM as of 2026-09-11?",
        {**base, "temporal_as_of": "2026-09-11", "retrieved_at": fixed.isoformat()},
        now=fixed,
    )[0] is False


def test_current_request_uses_validated_retrieval_in_prepared_turn(monkeypatch):
    user = create_test_user("freshness-enabled", "freshness-enabled@example.com")
    _fund(int(user.id))
    monkeypatch.setenv("ENABLE_WEB_SEARCH_FOR_FREE", "true")
    captured = {}

    monkeypatch.setattr(
        "app.web_api.chat_service.WebSearchAgent.search",
        lambda _self, _query: WebSearchResult(
            enabled=True,
            results=[{
                "title": "Tamil Nadu Chief Minister",
                "snippet": "Example Person is the current Chief Minister of Tamil Nadu.",
                "officeholder": "Example Person",
                "source": "official-government",
                "provenance": "official-government",
                "url": "https://example.test/tamil-nadu-chief-minister",
                "retrieved_at": "2026-09-10T10:00:00+00:00",
                "temporal_as_of": "2026-09-10",
                "temporal_support": True,
                "relevant": True,
            }],
            reason="mock_retrieval",
        ),
    )

    def provider(_self, request, route, on_delta):
        captured.update(request.metadata)
        answer = "The current officeholder is stated by the retrieved source."
        on_delta(answer)
        return AIProviderResponse(
            text=answer, provider="openai", model=route.model, route=route.route,
            reason=route.reason, language="en", intent=route.intent,
            input_tokens=10, output_tokens=10,
            raw={"usage_actual": True, "finish_reason": "stop", "completion_status": "complete"},
        )

    def complete(_self, request, route):
        return provider(_self, request, route, lambda _text: None)

    monkeypatch.setattr("app.ai.providers.openai_provider.OpenAIProvider.stream_complete", provider)
    prepared = prepare_web_turn(
        user_id=int(user.id), message="Who is the CM of Tamilnadu?",
        request_id=str(uuid4()), thread_id=None, reply_language="en",
    )
    assert prepared.retrieval_context is not None
    assert prepared.retrieval_context.retrieval_status == "sufficient"
    completed = execute_web_turn(
        prepared, providers={"openai": type("Provider", (), {"complete": complete})()},
    )
    assert "freshness_evidence_prompt" in captured
    assert prepared.ai_request.metadata["freshness_source_url"].startswith("https://")
    assert completed.response.raw["cache_eligible"] is False
