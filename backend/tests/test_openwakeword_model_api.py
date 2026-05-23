from __future__ import annotations

import io
import json
import wave
import zipfile

import pytest

import app.openwakeword_api as openwakeword_api
from app.openwakeword_support import (
    OpenWakeWordNotInstalledError,
    OpenWakeWordSupport,
    SUPPORTED_BASE_MODELS,
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


def test_default_hey_elli_is_pending_without_real_model_bundle(client, monkeypatch, tmp_path):
    create_test_user()
    _set_service(monkeypatch, OpenWakeWordSupport(tmp_path))

    response = client.get(
        "/api/openwakeword/enrollment/model/status?wake_phrase=Hey%20Elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert "hey elli" not in SUPPORTED_BASE_MODELS
    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is False
    assert payload["status"] == "pending"
    assert payload["model_type"] == "custom"


def test_default_hey_elli_uses_configured_bundle_only_when_complete(
    client, monkeypatch, tmp_path
):
    create_test_user()
    bundle_dir = tmp_path / "hey-elli-bundle"
    bundle_dir.mkdir()
    for filename in ("hey_elli.onnx", "melspectrogram.onnx", "embedding_model.onnx"):
        (bundle_dir / filename).write_bytes(f"fake-{filename}".encode("utf-8"))
    (bundle_dir / "manifest.json").write_text(
        json.dumps(
            {
                "phrase_key": "hey-elli",
                "wake_phrase": "Hey Elli",
                "model_files": [
                    {"role": "melspectrogram", "file": "melspectrogram.onnx"},
                    {"role": "embedding", "file": "embedding_model.onnx"},
                    {"role": "wake", "file": "hey_elli.onnx"},
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("JAI_HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR", str(bundle_dir))
    _set_service(monkeypatch, OpenWakeWordSupport(tmp_path / "service"))

    response = client.get(
        "/api/openwakeword/enrollment/model/status?wake_phrase=Hey%20Elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is True
    assert payload["status"] == "ready"
    assert payload["model_type"] == "configured"
    assert {item["role"] for item in payload["model_files"]} == {
        "melspectrogram",
        "embedding",
        "wake",
    }


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
    (tmp_path / "melspectrogram.onnx").write_bytes(b"fake-mel")
    (tmp_path / "embedding_model.onnx").write_bytes(b"fake-embedding")
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
    assert "melspectrogram.onnx" in archive.namelist()
    assert "embedding_model.onnx" in archive.namelist()
    assert "custom.onnx" in archive.namelist()
    manifest = archive.read("manifest.json").decode("utf-8")
    assert '"model_type": "custom"' in manifest
    assert '"sample_rate": 16000' in manifest


def test_custom_model_bundle_requires_shared_openwakeword_artifacts(client, monkeypatch, tmp_path):
    user = create_test_user()
    service = OpenWakeWordSupport(tmp_path)
    _set_service(monkeypatch, service)
    model_path = tmp_path / "custom.onnx"
    model_path.write_bytes(b"fake-onnx")
    activation = service.activate_custom_phrase(
        user_id=user.id,
        wake_phrase="custom elli",
        custom_model_path=str(model_path),
    )
    assert activation["wake_state"] == "training"
    assert activation["can_run_instantly"] is False
    assert "melspectrogram.onnx" in activation["message"]
    assert "embedding_model.onnx" in activation["message"]

    status_response = client.get(
        "/api/openwakeword/enrollment/model/status?wake_phrase=custom%20elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["ready"] is False
    assert status_payload["status"] == "unsupported"
    assert "melspectrogram.onnx" in status_payload["detail"]
    assert "embedding_model.onnx" in status_payload["detail"]

    download_response = client.get(
        "/api/openwakeword/enrollment/model/download?wake_phrase=custom%20elli",
        headers=auth_headers("test-uid", "test@example.com"),
    )
    assert download_response.status_code == 422
    assert "melspectrogram.onnx" in download_response.json()["detail"]


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
        raise OpenWakeWordNotInstalledError("PyAV and numpy are required to decode Expo audio files.")

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

    assert response.status_code == 503
    assert "PyAV and numpy" in response.json()["detail"]
