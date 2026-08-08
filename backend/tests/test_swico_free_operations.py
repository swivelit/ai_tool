from __future__ import annotations

from scripts import swico_free_probe


def test_render_probe_checks_all_endpoints_without_printing_secret(monkeypatch, capsys):
    token = "probe-secret-" + ("x" * 32)
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://desktop-qtf7f78.tailbdb31e.ts.net")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", token)
    captured: dict[str, object] = {}

    class Response:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

    class Client:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def request(self, _method, path, json=None):
            if path == "/health":
                return Response({"ready": True})
            if path == "/v1/embed":
                return Response({"dimensions": 384, "vectors": [[0.0] * 384]})
            return Response({"text": "OK"})

    monkeypatch.setattr(swico_free_probe.httpx, "Client", Client)
    assert swico_free_probe.main(["--pretty"]) == 0
    output = capsys.readouterr().out
    assert "PASS /health" in output
    assert "PASS /v1/embed" in output
    assert "PASS /v1/generate" in output
    assert token not in output
    assert captured["headers"]["Authorization"] == f"Bearer {token}"


def test_render_probe_fails_closed_without_valid_https_configuration(monkeypatch, capsys):
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "http://127.0.0.1:8765")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", "x" * 40)
    assert swico_free_probe.main(["--pretty"]) == 2
    output = capsys.readouterr().out
    assert "FAIL" in output
    assert "127.0.0.1" not in output
