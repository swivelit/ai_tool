from __future__ import annotations

import io
import wave
import zipfile

import pytest

import app.openwakeword_api as openwakeword_api
from app.openwakeword_support import (
    OpenWakeWordNotInstalledError,
    OpenWakeWordSupport,
    TrainingNotSupportedError,
)
from conftest import auth_headers, create_test_user


def _set_service(monkeypatch, service: OpenWakeWordSupport):
    monkeypatch.setattr(openwakeword_api, "service", service)


def test_model_status_pending_for_custom_phrase(client, monkeypatch, tmp_path):
    create_test_user()
    _set_service(monkeypatch, OpenWakeWordSupport(tmp_path))

    response = client.get(
        "/api/openwakeword/enrollment/model/status?wake_phrase=custom%20elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is False
    assert payload["status"] == "pending"
    assert payload["model_type"] == "custom"


def test_model_download_custom_without_model_returns_clear_error(client, monkeypatch, tmp_path):
    create_test_user()
    _set_service(monkeypatch, OpenWakeWordSupport(tmp_path))

    response = client.get(
        "/api/openwakeword/enrollment/model/download?wake_phrase=custom%20elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 404
    assert "Custom wake phrase model is pending" in response.json()["detail"]


def test_supported_base_status_handles_missing_openwakeword_dependency(client, monkeypatch, tmp_path):
    create_test_user()
    service = OpenWakeWordSupport(tmp_path)
    _set_service(monkeypatch, service)

    def missing(_model_key: str):
        raise OpenWakeWordNotInstalledError("openwakeword missing for tests")

    monkeypatch.setattr(service, "locate_supported_base_model_bundle", missing)

    response = client.get(
        "/api/openwakeword/enrollment/model/status?wake_phrase=hey%20alexa",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is False
    assert payload["status"] == "missing_dependency"
    assert "openwakeword missing" in payload["detail"]


def test_supported_base_download_returns_503_for_missing_dependency(client, monkeypatch, tmp_path):
    create_test_user()
    service = OpenWakeWordSupport(tmp_path)
    _set_service(monkeypatch, service)
    monkeypatch.setattr(
        service,
        "locate_supported_base_model_bundle",
        lambda _model_key: (_ for _ in ()).throw(OpenWakeWordNotInstalledError("openwakeword missing")),
    )

    response = client.get(
        "/api/openwakeword/enrollment/model/download?wake_phrase=hey%20alexa",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 503
    assert "openwakeword missing" in response.json()["detail"]


def test_custom_model_bundle_download_contains_manifest_and_model(client, monkeypatch, tmp_path):
    user = create_test_user()
    service = OpenWakeWordSupport(tmp_path)
    _set_service(monkeypatch, service)
    model_path = tmp_path / "custom.onnx"
    model_path.write_bytes(b"fake-onnx")
    service.activate_custom_phrase(
        user_id=user.id,
        wake_phrase="custom elli",
        custom_model_path=str(model_path),
    )

    response = client.get(
        "/api/openwakeword/enrollment/model/download?wake_phrase=custom%20elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    assert "manifest.json" in archive.namelist()
    assert "custom.onnx" in archive.namelist()
    manifest = archive.read("manifest.json").decode("utf-8")
    assert '"model_type": "custom"' in manifest
    assert '"sample_rate": 16000' in manifest


def test_activate_custom_phrase_does_not_mark_active_without_model(tmp_path):
    service = OpenWakeWordSupport(tmp_path)
    status = service.activate_custom_phrase(user_id=7, wake_phrase="custom elli")

    assert status["wake_state"] == "training"
    assert status["can_run_instantly"] is False
    assert "needs a real OpenWakeWord model" in status["message"]


def test_sample_upload_fails_clearly_when_audio_dependency_missing(client, monkeypatch, tmp_path):
    create_test_user()
    service = OpenWakeWordSupport(tmp_path)
    _set_service(monkeypatch, service)

    def missing_decode(_source_path, _destination_path):
        from app.openwakeword_support import AudioDecodeError

        raise AudioDecodeError("PyAV and numpy are required to decode Expo audio files.")

    monkeypatch.setattr(service, "_decode_to_wav", missing_decode)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\x00\x00" * 160)
    buffer.seek(0)

    response = client.post(
        "/api/openwakeword/enrollment/sample?wake_phrase=custom%20elli&sample_kind=positive",
        headers=auth_headers("test-uid", "test@example.com"),
        files={"file": ("sample.wav", buffer, "audio/wav")},
    )

    assert response.status_code == 400
    assert "PyAV and numpy" in response.json()["detail"]
