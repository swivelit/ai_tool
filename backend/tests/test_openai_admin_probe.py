import app.main as main_module


class _SecretError(Exception):
    status_code = 400


class _Endpoint:
    def create(self, **kwargs):
        raise _SecretError("bad request sk-test-secret")


class _Client:
    responses = _Endpoint()
    completions = _Endpoint()
    chat = type("Chat", (), {"completions": completions})()


def test_admin_provider_health_requires_flag_and_admin_token(client, monkeypatch):
    monkeypatch.setenv("DEBUG_ADMIN_TOKEN", "debug-token")
    monkeypatch.setenv("ENABLE_ADMIN_AI_PROBE", "false")

    response = client.get("/api/admin/ai/provider-health", headers={"x-admin-token": "debug-token"})

    assert response.status_code == 403
    assert "disabled" in response.json()["detail"].lower()


def test_admin_model_probe_redacts_errors(client, monkeypatch):
    monkeypatch.setenv("DEBUG_ADMIN_TOKEN", "debug-token")
    monkeypatch.setenv("ENABLE_ADMIN_AI_PROBE", "true")
    monkeypatch.setattr(main_module, "_get_openai_client", lambda: _Client())

    response = client.post(
        "/api/admin/ai/model-probe",
        headers={"x-admin-token": "debug-token"},
        json={"models": ["gpt-5-nano"]},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["results"][0]["ok"] is False
    assert "sk-test-secret" not in str(payload)

