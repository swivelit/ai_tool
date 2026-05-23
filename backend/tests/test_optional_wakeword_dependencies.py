from __future__ import annotations

import builtins
import importlib


def _block_wakeword_imports(monkeypatch):
    real_import = builtins.__import__

    def blocked_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name in {"av", "onnxruntime", "openwakeword"} or name.startswith(
            ("av.", "onnxruntime.", "openwakeword.")
        ):
            raise ModuleNotFoundError(f"No module named '{name}'")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", blocked_import)


def test_openwakeword_routes_import_without_optional_wake_dependencies(monkeypatch):
    _block_wakeword_imports(monkeypatch)

    support = importlib.reload(importlib.import_module("app.openwakeword_support"))
    api = importlib.reload(importlib.import_module("app.openwakeword_api"))

    assert api.router is not None
    assert support.OpenWakeWordSupport


def test_core_health_stays_available_without_optional_wake_dependencies(
    client, monkeypatch
):
    _block_wakeword_imports(monkeypatch)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "app": "J AI"}


def test_normal_backend_requirements_keep_wakeword_dependencies_optional():
    requirements = open("requirements.txt", encoding="utf-8").read()
    wake_requirements = open("requirements-wakeword.txt", encoding="utf-8").read()

    assert "openwakeword" not in requirements
    assert "onnxruntime" not in requirements
    assert "av>=" not in requirements
    assert "openwakeword" in wake_requirements
    assert "onnxruntime" in wake_requirements
    assert "av>=" in wake_requirements
