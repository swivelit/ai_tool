from app.ai.openai_catalog import get_model_spec, get_openai_model_catalog


def test_openai_catalog_defaults_to_responses_for_gpt5(monkeypatch):
    monkeypatch.delenv("OPENAI_API_MODE", raising=False)
    catalog = get_openai_model_catalog()

    assert catalog["gpt-5-nano"].endpoint == "responses"
    assert catalog["gpt-5-mini"].endpoint == "responses"
    assert catalog["gpt-5-nano"].free_user_allowed is True
    assert catalog["gpt-5-mini"].free_user_allowed is True


def test_openai_catalog_includes_cheap_fallbacks_and_admin_o_series(monkeypatch):
    monkeypatch.delenv("OPENAI_ENABLE_O_SERIES_FOR_FREE", raising=False)
    catalog = get_openai_model_catalog()

    assert catalog["gpt-4.1-nano"].endpoint == "chat_completions"
    assert catalog["gpt-4o-mini"].endpoint == "chat_completions"
    assert catalog["o4-mini"].admin_only is True
    assert catalog["o4-mini"].free_user_allowed is False


def test_openai_catalog_reads_pricing_env(monkeypatch):
    monkeypatch.setenv("OPENAI_PRICE_GPT_4_1_NANO_INPUT_PER_1M", "0.123")
    monkeypatch.setenv("OPENAI_PRICE_GPT_4_1_NANO_CACHED_INPUT_PER_1M", "0.012")
    monkeypatch.setenv("OPENAI_PRICE_GPT_4_1_NANO_OUTPUT_PER_1M", "0.456")

    spec = get_model_spec("gpt-4.1-nano")

    assert spec.input_price_per_1m == 0.123
    assert spec.cached_input_price_per_1m == 0.012
    assert spec.output_price_per_1m == 0.456

