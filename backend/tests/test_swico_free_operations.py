from __future__ import annotations

from pathlib import Path

import httpx

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

        def iter_lines(self):
            return iter([
                'data: {"delta":"OK"}',
                'data: [DONE]',
            ])

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

        def stream(self, _method, _path, json=None):
            return ResponseContext(Response(None))

    class ResponseContext:
        def __init__(self, response):
            self.response = response

        def __enter__(self):
            return self.response

        def __exit__(self, *_args):
            return False

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


def test_windows_scripts_share_quote_safe_dotenv_loader():
    root = Path(__file__).resolve().parents[2] / "swico_free_node" / "scripts"
    helper = (root / "dotenv.ps1").read_text(encoding="utf-8")
    assert "Substring(1, $value.Length - 2)" in helper
    assert "SetEnvironmentVariable($name, $value, 'Process')" in helper
    for name in ("run.ps1", "health.ps1", "smoke.ps1", "validate_models.ps1", "benchmark.ps1"):
        contents = (root / name).read_text(encoding="utf-8")
        assert "dotenv.ps1" in contents
        assert "Import-SwicoFreeDotEnv" in contents


def test_git_bash_wrappers_use_one_path_safe_powershell_bridge():
    root = Path(__file__).resolve().parents[2] / "swico_free_node" / "scripts"
    bridge = (root / "_powershell.sh").read_text(encoding="utf-8")
    assert "powershell.exe -NoProfile -ExecutionPolicy Bypass" in bridge
    assert "cygpath -w" in bridge
    for name in ("install", "validate_models", "run", "health", "smoke", "benchmark", "doctor", "funnel_smoke", "capacity_test"):
        wrapper = (root / f"{name}.sh").read_text(encoding="utf-8")
        assert "_powershell.sh" in wrapper
        assert f"{name}.ps1" in wrapper
    doctor = (root / "doctor.ps1").read_text(encoding="utf-8")
    assert "Get-NetTCPConnection" in doctor
    assert "QwenRuntime" not in doctor
    funnel = (root / "funnel_smoke.ps1").read_text(encoding="utf-8")
    assert "SWICO_FREE_NODE_TOKEN" in funnel
    assert "https" in funnel


def test_capacity_benchmark_uses_meaningful_workloads_and_bounded_load():
    root = Path(__file__).resolve().parents[2] / "swico_free_node" / "scripts"
    benchmark = (root / "benchmark.py").read_text(encoding="utf-8")
    assert "Reply exactly OK" not in benchmark
    assert "approximately {target_tokens} output tokens" in benchmark
    assert "((\"SHORT\", 64), (\"NORMAL\", 128), (\"LONG\", 256))" in benchmark
    assert "(1, 2, 5, 10, 11, 12)" in benchmark
    assert "normal_requests_per_minute_single_worker" in benchmark
    assert "registered_user_capacity=not_estimated" in benchmark


def test_capacity_soak_is_bounded_and_report_is_safe():
    root = Path(__file__).resolve().parents[2] / "swico_free_node" / "scripts"
    capacity = (root / "capacity_test.py").read_text(encoding="utf-8")
    assert "--soak-minutes" in capacity
    assert "--json-out" in capacity
    assert "STAGES = (1, 2, 5)" in capacity
    assert "BURST_LEVELS = (10, 11, 12)" in capacity
    assert "_workload_prompt(target)" in capacity
    assert '"prompt"' not in capacity
    assert "process_rss_mb" in capacity
    assert "recommended_initial_rollout_percent" in capacity
    for name in ("capacity_test.ps1", "capacity_test.sh"):
        assert (root / name).exists()


def test_render_probe_reports_transport_category_and_skips_expensive_checks(monkeypatch, capsys):
    token = "probe-secret-" + ("x" * 32)
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://desktop-qtf7f78.tailbdb31e.ts.net")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", token)

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def request(self, *_args, **_kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(swico_free_probe.httpx, "Client", Client)
    assert swico_free_probe.main(["--pretty"]) == 1
    output = capsys.readouterr().out
    assert "FAIL /health connection_failed" in output
    assert "SKIP /v1/embed health_prerequisite_failed" in output
    assert "SKIP /v1/generate health_prerequisite_failed" in output
    assert token not in output


def test_render_probe_health_only_does_not_call_generation(monkeypatch, capsys):
    token = "probe-secret-" + ("x" * 32)
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://desktop-qtf7f78.tailbdb31e.ts.net")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", token)

    class Response:
        status_code = 200

        def json(self):
            return {"ready": True}

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def request(self, _method, path, **_kwargs):
            assert path == "/health"
            return Response()

    monkeypatch.setattr(swico_free_probe.httpx, "Client", Client)
    assert swico_free_probe.main(["--pretty", "--health-only"]) == 0
    output = capsys.readouterr().out
    assert output.strip() == "PASS /health"
    assert token not in output


def test_render_probe_reports_thinking_content_without_printing_response(monkeypatch, capsys):
    token = "probe-secret-" + ("x" * 32)
    monkeypatch.setenv("SWICO_FREE_INFERENCE_BASE_URL", "https://desktop-qtf7f78.tailbdb31e.ts.net")
    monkeypatch.setenv("SWICO_FREE_INFERENCE_TOKEN", token)

    class Response:
        status_code = 200

        def __init__(self, body):
            self.body = body

        def json(self):
            return self.body

        def iter_lines(self):
            return iter([
                'data: {"delta":"<think>private"}',
                'data: [DONE]',
            ])

    class Context:
        def __enter__(self):
            return Response(None)

        def __exit__(self, *_args):
            return False

    class Client:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def request(self, _method, path, **_kwargs):
            if path == "/health":
                return Response({"ready": True})
            if path == "/v1/embed":
                return Response({"dimensions": 384, "vectors": [[0.0] * 384]})
            return Response({"text": "OK"})

        def stream(self, *_args, **_kwargs):
            return Context()

    monkeypatch.setattr(swico_free_probe.httpx, "Client", Client)
    assert swico_free_probe.main(["--pretty"]) == 1
    output = capsys.readouterr().out
    assert "FAIL /v1/generate/stream thinking_content_detected" in output
    assert "private" not in output
    assert token not in output
