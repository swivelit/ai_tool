from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import tempfile
import uuid
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional


logger = logging.getLogger(__name__)

SAMPLE_KIND = Literal["positive", "negative"]
WAKE_STATE = Literal["ready_now", "needs_training", "training", "active"]
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
WAKE_STATE_LABELS: Dict[str, str] = {
    "ready_now": "Ready now",
    "needs_training": "Needs training",
    "training": "Training",
    "active": "Active",
}
MINIMUM_POSITIVE_SAMPLES = 3
MINIMUM_NEGATIVE_SAMPLES = 2
TARGET_SAMPLE_RATE = 16_000



def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()



def normalize_phrase(value: Optional[str]) -> str:
    return " ".join(str(value or "").strip().lower().split())



def phrase_key_for(value: str) -> str:
    normalized = normalize_phrase(value)
    if not normalized:
        raise EnrollmentValidationError("Wake phrase is required.")

    slug = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")[:40] or "phrase"
    digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:10]
    return f"{slug}-{digest}"


@dataclass
class EnrollmentPaths:
    root: Path
    positive_dir: Path
    negative_dir: Path
    manifests_dir: Path
    verifier_dir: Path
    phrase_meta_path: Path
    phrase_key: str
    wake_phrase: str


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

    def enrollment_paths(self, user_id: int, wake_phrase: str) -> EnrollmentPaths:
        normalized_phrase = normalize_phrase(wake_phrase)
        phrase_key = phrase_key_for(normalized_phrase)
        root = self.root_dir / f"user_{int(user_id)}" / "phrases" / phrase_key
        positive_dir = root / "positive"
        negative_dir = root / "negative"
        manifests_dir = root / "manifests"
        verifier_dir = root / "verifier"
        for path in (positive_dir, negative_dir, manifests_dir, verifier_dir):
            path.mkdir(parents=True, exist_ok=True)

        phrase_meta_path = root / "phrase.json"
        phrase_meta = {
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "phrase_key": phrase_key,
            "updated_at": _utc_now(),
        }
        phrase_meta_path.write_text(json.dumps(phrase_meta, ensure_ascii=False, indent=2), encoding="utf-8")

        return EnrollmentPaths(
            root=root,
            positive_dir=positive_dir,
            negative_dir=negative_dir,
            manifests_dir=manifests_dir,
            verifier_dir=verifier_dir,
            phrase_meta_path=phrase_meta_path,
            phrase_key=phrase_key,
            wake_phrase=normalized_phrase,
        )

    def reset(self, user_id: int, wake_phrase: str) -> Dict[str, Any]:
        normalized_phrase = normalize_phrase(wake_phrase)
        phrase_key = phrase_key_for(normalized_phrase)
        root = self.root_dir / f"user_{int(user_id)}" / "phrases" / phrase_key
        if root.exists():
            shutil.rmtree(root, ignore_errors=True)
        status = self.status(user_id, normalized_phrase)
        status["reset_at"] = _utc_now()
        status["message"] = f"Reset wake phrase setup for '{normalized_phrase}'."
        return status

    def status(self, user_id: int, wake_phrase: Optional[str] = None) -> Dict[str, Any]:
        normalized_phrase = normalize_phrase(wake_phrase)
        if not normalized_phrase:
            raise EnrollmentValidationError("Wake phrase is required.")

        paths = self.enrollment_paths(user_id, normalized_phrase)
        positive = sorted(paths.positive_dir.glob("*.wav"))
        negative = sorted(paths.negative_dir.glob("*.wav"))
        manifest = self._load_latest_manifest(paths)
        base_model_key = SUPPORTED_BASE_MODELS.get(normalized_phrase)
        wake_state = self._derive_wake_state(base_model_key, manifest)
        verifier_path = manifest.get("verifier_path")
        custom_model_path = manifest.get("custom_model_path")

        return {
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "phrase_key": paths.phrase_key,
            "positive_count": len(positive),
            "negative_count": len(negative),
            "minimum_positive": MINIMUM_POSITIVE_SAMPLES,
            "minimum_negative": MINIMUM_NEGATIVE_SAMPLES,
            "supported_base_model": base_model_key,
            "custom_phrase_requires_colab": wake_state in {"needs_training", "training"} and not bool(base_model_key),
            "verifier_ready": bool(verifier_path and Path(verifier_path).exists()),
            "custom_model_ready": bool(custom_model_path and Path(custom_model_path).exists()) if custom_model_path else False,
            "wake_state": wake_state,
            "wake_state_label": WAKE_STATE_LABELS[wake_state],
            "can_run_instantly": wake_state in {"ready_now", "active"},
            "state_message": self._state_message(
                wake_state=wake_state,
                wake_phrase=normalized_phrase,
                supported_base_model=base_model_key,
            ),
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
        paths = self.enrollment_paths(user_id, wake_phrase)
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

        status = self.status(user_id, wake_phrase)
        status["sample"] = metadata
        status["message"] = (
            f"Saved {sample_kind} sample for '{status['wake_phrase']}'."
        )
        return status

    def finalize(self, *, user_id: int, wake_phrase: str) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id, wake_phrase)
        normalized_phrase = paths.wake_phrase
        positive = sorted(paths.positive_dir.glob("*.wav"))
        negative = sorted(paths.negative_dir.glob("*.wav"))

        if len(positive) < MINIMUM_POSITIVE_SAMPLES:
            raise EnrollmentValidationError(
                f"Record at least {MINIMUM_POSITIVE_SAMPLES} positive wake phrase samples before continuing."
            )
        if len(negative) < MINIMUM_NEGATIVE_SAMPLES:
            raise EnrollmentValidationError(
                f"Record at least {MINIMUM_NEGATIVE_SAMPLES} negative speech samples before continuing."
            )

        model_key = SUPPORTED_BASE_MODELS.get(normalized_phrase)
        manifest = {
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "phrase_key": paths.phrase_key,
            "created_at": _utc_now(),
            "positive_samples": [str(path) for path in positive],
            "negative_samples": [str(path) for path in negative],
            "minimum_positive": MINIMUM_POSITIVE_SAMPLES,
            "minimum_negative": MINIMUM_NEGATIVE_SAMPLES,
            "supported_base_model": model_key,
            "verifier_path": None,
            "custom_model_path": None,
            "activation_mode": None,
            "wake_state": "training",
            "message": "Training bundle saved.",
        }

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
                    "activation_mode": "verifier",
                    "verifier_path": str(verifier_path),
                    "wake_state": "active",
                    "message": (
                        f"'{normalized_phrase}' is now Active. The base phrase is supported and the verifier was trained for this user's voice."
                    ),
                }
            )
        else:
            manifest.update(
                {
                    "activation_mode": "custom_model_pending",
                    "wake_state": "training",
                    "message": (
                        f"'{normalized_phrase}' is now in Training. The setup clips were saved, but an arbitrary phrase still needs a custom openWakeWord model before it can become Active."
                    ),
                }
            )

        manifest_path = paths.manifests_dir / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        status = self.status(user_id, normalized_phrase)
        status["message"] = manifest["message"]
        status["manifest_path"] = str(manifest_path)
        return status

    def activate_custom_phrase(
        self,
        *,
        user_id: int,
        wake_phrase: str,
        custom_model_path: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id, wake_phrase)
        normalized_phrase = paths.wake_phrase
        manifest = self._load_latest_manifest(paths)

        next_manifest = {
            **manifest,
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "phrase_key": paths.phrase_key,
            "created_at": _utc_now(),
            "supported_base_model": SUPPORTED_BASE_MODELS.get(normalized_phrase),
            "activation_mode": "custom_model",
            "wake_state": "active",
            "custom_model_path": custom_model_path,
            "notes": notes,
            "message": f"'{normalized_phrase}' is now Active.",
        }

        manifest_path = paths.manifests_dir / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        manifest_path.write_text(json.dumps(next_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        status = self.status(user_id, normalized_phrase)
        status["message"] = next_manifest["message"]
        status["manifest_path"] = str(manifest_path)
        return status

    def _derive_wake_state(self, supported_base_model: Optional[str], manifest: Dict[str, Any]) -> WAKE_STATE:
        manifest_state = str(manifest.get("wake_state") or "").strip().lower()
        if manifest_state == "active":
            return "active"
        if manifest_state == "training":
            return "training"
        if supported_base_model:
            return "ready_now"
        return "needs_training"

    def _state_message(
        self,
        *,
        wake_state: WAKE_STATE,
        wake_phrase: str,
        supported_base_model: Optional[str],
    ) -> str:
        if wake_state == "active":
            return f"'{wake_phrase}' is Active and can be used as the wake phrase."
        if wake_state == "training":
            return (
                f"'{wake_phrase}' is in Training. The setup clips were saved, but a custom model still needs to be produced before this phrase becomes Active."
            )
        if wake_state == "ready_now":
            return (
                f"'{wake_phrase}' matches the supported base model '{supported_base_model}'. It can work immediately, and setup voice samples will personalize it for this user."
            )
        return (
            f"'{wake_phrase}' is an arbitrary phrase. It is accepted, but it needs a custom training job before it can wake the app."
        )

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
            import numpy as np  # type: ignore
        except ImportError as exc:
            raise AudioDecodeError(
                "PyAV and numpy are required to decode Expo audio files. Install optional wakeword dependencies before using this route."
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

        frames: List[Any] = []

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
