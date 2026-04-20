from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
import uuid
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import numpy as np

logger = logging.getLogger(__name__)

SAMPLE_KIND = Literal["positive", "negative"]
SUPPORTED_BASE_MODELS: Dict[str, str] = {
    "alexa": "alexa",
    "hey alexa": "alexa",
    "hey mycroft": "hey_mycroft",
    "mycroft": "hey_mycroft",
    "hey jarvis": "hey_jarvis",
    "jarvis": "hey_jarvis",
    "hey rhasspy": "hey_rhasspy",
    "rhasspy": "hey_rhasspy",
    "what's the weather": "weather",
    "whats the weather": "weather",
    "weather": "weather",
    "set a 10 minute timer": "timer",
    "set ten minute timer": "timer",
    "timer": "timer",
}

MINIMUM_POSITIVE_SAMPLES = 3
MINIMUM_NEGATIVE_SAMPLES = 2
TARGET_SAMPLE_RATE = 16_000


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_phrase(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().lower().split())


@dataclass
class EnrollmentPaths:
    root: Path
    positive_dir: Path
    negative_dir: Path
    manifests_dir: Path
    verifier_dir: Path


class OpenWakeWordNotInstalledError(RuntimeError):
    pass


class AudioDecodeError(RuntimeError):
    pass


class EnrollmentValidationError(RuntimeError):
    pass


class TrainingNotSupportedError(RuntimeError):
    pass


class OpenWakeWordSupport:
    def __init__(self, root_dir: Optional[Path] = None) -> None:
        default_root = Path(__file__).resolve().parent.parent / "generated" / "openwakeword"
        self.root_dir = Path(root_dir or default_root)
        self.root_dir.mkdir(parents=True, exist_ok=True)

    def enrollment_paths(self, user_id: int) -> EnrollmentPaths:
        root = self.root_dir / f"user_{int(user_id)}"
        positive_dir = root / "positive"
        negative_dir = root / "negative"
        manifests_dir = root / "manifests"
        verifier_dir = root / "verifier"
        for path in (positive_dir, negative_dir, manifests_dir, verifier_dir):
            path.mkdir(parents=True, exist_ok=True)
        return EnrollmentPaths(
            root=root,
            positive_dir=positive_dir,
            negative_dir=negative_dir,
            manifests_dir=manifests_dir,
            verifier_dir=verifier_dir,
        )

    def reset(self, user_id: int) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id)
        if paths.root.exists():
            shutil.rmtree(paths.root, ignore_errors=True)
        self.enrollment_paths(user_id)
        return {
            "ok": True,
            "user_id": int(user_id),
            "reset_at": _utc_now(),
        }

    def status(self, user_id: int, wake_phrase: Optional[str] = None) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id)
        positive = sorted(paths.positive_dir.glob("*.wav"))
        negative = sorted(paths.negative_dir.glob("*.wav"))
        manifest = self._load_latest_manifest(paths)
        normalized_phrase = normalize_phrase(wake_phrase) or manifest.get("wake_phrase", "")
        base_model_key = SUPPORTED_BASE_MODELS.get(normalized_phrase)
        verifier_path = None
        if manifest.get("verifier_path"):
            verifier_path = str(manifest["verifier_path"])
        return {
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "positive_count": len(positive),
            "negative_count": len(negative),
            "minimum_positive": MINIMUM_POSITIVE_SAMPLES,
            "minimum_negative": MINIMUM_NEGATIVE_SAMPLES,
            "supported_base_model": base_model_key,
            "custom_phrase_requires_colab": not bool(base_model_key) if normalized_phrase else False,
            "verifier_ready": bool(verifier_path and Path(verifier_path).exists()),
            "manifest": manifest,
        }

    def save_sample(
        self,
        *,
        user_id: int,
        wake_phrase: str,
        sample_kind: SAMPLE_KIND,
        source_path: Path,
        source_filename: str,
    ) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id)
        target_dir = paths.positive_dir if sample_kind == "positive" else paths.negative_dir
        sample_id = uuid.uuid4().hex
        raw_extension = source_path.suffix or Path(source_filename).suffix or ".bin"
        raw_path = target_dir / f"{sample_id}{raw_extension}"
        wav_path = target_dir / f"{sample_id}.wav"
        metadata_path = target_dir / f"{sample_id}.json"

        shutil.copyfile(source_path, raw_path)
        audio_meta = self._decode_to_wav(raw_path, wav_path)

        metadata = {
            "id": sample_id,
            "user_id": int(user_id),
            "wake_phrase": normalize_phrase(wake_phrase),
            "sample_kind": sample_kind,
            "created_at": _utc_now(),
            "raw_path": str(raw_path),
            "wav_path": str(wav_path),
            "source_filename": source_filename,
            **audio_meta,
        }
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

        return {
            "ok": True,
            "sample": metadata,
            **self.status(user_id, wake_phrase),
        }

    def finalize(self, *, user_id: int, wake_phrase: str) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id)
        normalized_phrase = normalize_phrase(wake_phrase)
        positive = sorted(paths.positive_dir.glob("*.wav"))
        negative = sorted(paths.negative_dir.glob("*.wav"))

        if len(positive) < MINIMUM_POSITIVE_SAMPLES:
            raise EnrollmentValidationError(
                f"Record at least {MINIMUM_POSITIVE_SAMPLES} positive wake phrase samples before training."
            )
        if len(negative) < MINIMUM_NEGATIVE_SAMPLES:
            raise EnrollmentValidationError(
                f"Record at least {MINIMUM_NEGATIVE_SAMPLES} negative speech samples before training."
            )

        manifest = {
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "created_at": _utc_now(),
            "positive_samples": [str(path) for path in positive],
            "negative_samples": [str(path) for path in negative],
            "minimum_positive": MINIMUM_POSITIVE_SAMPLES,
            "minimum_negative": MINIMUM_NEGATIVE_SAMPLES,
            "mode": "bundle_only",
            "supported_base_model": SUPPORTED_BASE_MODELS.get(normalized_phrase),
            "custom_phrase_requires_colab": False,
            "verifier_path": None,
            "message": "Enrollment bundle saved.",
        }

        model_key = SUPPORTED_BASE_MODELS.get(normalized_phrase)
        if model_key:
            verifier_path = paths.verifier_dir / f"{model_key}_verifier.pkl"
            self._train_custom_verifier(
                positive_reference_clips=positive,
                negative_reference_clips=negative,
                output_path=verifier_path,
                model_name=model_key,
            )
            manifest.update(
                {
                    "mode": "verifier",
                    "custom_phrase_requires_colab": False,
                    "verifier_path": str(verifier_path),
                    "message": f"openWakeWord verifier trained for base model '{model_key}'.",
                }
            )
        else:
            manifest.update(
                {
                    "custom_phrase_requires_colab": True,
                    "message": (
                        "Enrollment samples were saved, but this custom phrase still needs the openWakeWord "
                        "custom phrase training notebook/Colab to build a base wake-word model."
                    ),
                }
            )

        manifest_path = paths.manifests_dir / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest["manifest_path"] = str(manifest_path)
        return manifest

    def _load_latest_manifest(self, paths: EnrollmentPaths) -> Dict[str, Any]:
        manifests = sorted(paths.manifests_dir.glob("*.json"))
        if not manifests:
            return {}
        try:
            return json.loads(manifests[-1].read_text(encoding="utf-8"))
        except Exception:
            return {}

    def _decode_to_wav(self, source_path: Path, destination_path: Path) -> Dict[str, Any]:
        try:
            import av  # type: ignore
        except ImportError as exc:
            raise AudioDecodeError(
                "PyAV is required to decode Expo audio files. Install backend dependencies again after adding 'av'."
            ) from exc

        try:
            container = av.open(str(source_path))
        except Exception as exc:
            raise AudioDecodeError(f"Could not open audio file '{source_path.name}': {exc}") from exc

        audio_stream = next((stream for stream in container.streams if stream.type == "audio"), None)
        if audio_stream is None:
            raise AudioDecodeError("The uploaded file does not contain an audio stream.")

        resampler = av.audio.resampler.AudioResampler(
            format="s16",
            layout="mono",
            rate=TARGET_SAMPLE_RATE,
        )

        frames: List[np.ndarray] = []

        def consume_resampled(value: Any) -> None:
            if value is None:
                return
            if isinstance(value, list):
                for item in value:
                    consume_resampled(item)
                return
            array = value.to_ndarray()
            if array.ndim == 2:
                array = array[0]
            frames.append(np.asarray(array, dtype=np.int16).reshape(-1))

        try:
            for frame in container.decode(audio_stream):
                consume_resampled(resampler.resample(frame))
            consume_resampled(resampler.resample(None))
        except Exception as exc:
            raise AudioDecodeError(f"Could not decode audio frames: {exc}") from exc
        finally:
            container.close()

        if not frames:
            raise AudioDecodeError("The uploaded audio was empty after decoding.")

        pcm = np.concatenate(frames)
        with wave.open(str(destination_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(TARGET_SAMPLE_RATE)
            handle.writeframes(pcm.tobytes())

        return {
            "sample_rate": TARGET_SAMPLE_RATE,
            "num_samples": int(pcm.shape[0]),
            "duration_seconds": round(float(pcm.shape[0]) / float(TARGET_SAMPLE_RATE), 3),
        }

    def _train_custom_verifier(
        self,
        *,
        positive_reference_clips: List[Path],
        negative_reference_clips: List[Path],
        output_path: Path,
        model_name: str,
    ) -> None:
        try:
            import openwakeword
            from openwakeword import train_custom_verifier
            from openwakeword.utils import download_models
        except ImportError as exc:
            raise OpenWakeWordNotInstalledError(
                "openwakeword is not installed in the backend environment."
            ) from exc

        output_path.parent.mkdir(parents=True, exist_ok=True)
        download_models([model_name])
        train_custom_verifier(
            positive_reference_clips=[str(path) for path in positive_reference_clips],
            negative_reference_clips=[str(path) for path in negative_reference_clips],
            output_path=str(output_path),
            model_name=model_name,
        )


def write_upload_to_tempfile(upload_bytes: bytes, suffix: str) -> Path:
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix or ".bin") as tmp:
        tmp.write(upload_bytes)
        return Path(tmp.name)
