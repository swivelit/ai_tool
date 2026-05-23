from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import uuid
import wave
import zipfile
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
CONFIGURED_MODEL_BUNDLE_ENV: Dict[str, List[str]] = {
    "hey elli": [
        "JAI_HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR",
        "HEY_ELLI_OPENWAKEWORD_BUNDLE_DIR",
        "OPENWAKEWORD_HEY_ELLI_BUNDLE_DIR",
    ],
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
MODEL_FRAME_MS = 80
MODEL_THRESHOLD_DEFAULT = 0.5
MODEL_BUNDLE_VERSION = 1
MODEL_FILE_ROLES = {"wake", "melspectrogram", "embedding"}



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
        resolved_custom_model_path = custom_model_path or manifest.get("custom_model_path")
        custom_model_ready = False
        custom_model_error: Optional[str] = None
        validated_custom_model_path: Optional[Path] = None

        if resolved_custom_model_path:
            try:
                validated_custom_model_path = self._validate_custom_model_path(
                    Path(str(resolved_custom_model_path)).expanduser()
                )
                custom_model_ready = True
            except EnrollmentValidationError:
                if custom_model_path:
                    raise
                custom_model_error = (
                    "Custom wake phrase model is pending because the configured model file is not allowed or does not exist."
                )
            except TrainingNotSupportedError as exc:
                if custom_model_path:
                    candidate = Path(str(resolved_custom_model_path)).expanduser().resolve()
                    allowed_root = self.root_dir.resolve()
                    if (
                        candidate.suffix.lower() == ".onnx"
                        and candidate.exists()
                        and candidate.is_file()
                        and (candidate == allowed_root or allowed_root in candidate.parents)
                    ):
                        validated_custom_model_path = candidate
                    custom_model_error = str(exc)
                else:
                    custom_model_error = str(exc)
        bundle_ready = custom_model_ready and not custom_model_error

        next_manifest = {
            **manifest,
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": normalized_phrase,
            "phrase_key": paths.phrase_key,
            "created_at": _utc_now(),
            "supported_base_model": SUPPORTED_BASE_MODELS.get(normalized_phrase),
            "activation_mode": "custom_model" if bundle_ready else "custom_model_pending",
            "wake_state": "active" if bundle_ready else "training",
            "custom_model_path": str(validated_custom_model_path) if validated_custom_model_path else None,
            "notes": notes,
            "message": (
                f"'{normalized_phrase}' is now Active."
                if bundle_ready
                else custom_model_error
                if custom_model_error
                else (
                    f"'{normalized_phrase}' samples are saved, but the custom phrase still needs "
                    "a real OpenWakeWord model file before it can become Active."
                )
            ),
        }

        manifest_path = paths.manifests_dir / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
        manifest_path.write_text(json.dumps(next_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

        status = self.status(user_id, normalized_phrase)
        status["message"] = next_manifest["message"]
        status["manifest_path"] = str(manifest_path)
        return status

    def model_bundle_status(self, user_id: int, wake_phrase: str) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id, wake_phrase)
        normalized_phrase = paths.wake_phrase
        base_model_key = SUPPORTED_BASE_MODELS.get(normalized_phrase)
        manifest = self._load_latest_manifest(paths)

        configured_bundle = self.locate_configured_model_bundle(normalized_phrase)
        if configured_bundle["configured"]:
            if configured_bundle["error"]:
                return self._model_status_payload(
                    user_id=user_id,
                    paths=paths,
                    status="unsupported",
                    ready=False,
                    model_type="configured",
                    detail=str(configured_bundle["error"]),
                    manifest=manifest,
                )
            return self._model_status_payload(
                user_id=user_id,
                paths=paths,
                status="ready",
                ready=True,
                model_type="configured",
                detail="Wake model bundle is ready.",
                manifest=manifest,
                model_files=configured_bundle["model_files"],
            )

        if base_model_key:
            try:
                located = self.locate_supported_base_model_bundle(base_model_key)
            except OpenWakeWordNotInstalledError as exc:
                return self._model_status_payload(
                    user_id=user_id,
                    paths=paths,
                    status="missing_dependency",
                    ready=False,
                    model_type="supported_base",
                    supported_base_model=base_model_key,
                    detail=str(exc),
                    manifest=manifest,
                )
            except TrainingNotSupportedError as exc:
                return self._model_status_payload(
                    user_id=user_id,
                    paths=paths,
                    status="unsupported",
                    ready=False,
                    model_type="supported_base",
                    supported_base_model=base_model_key,
                    detail=str(exc),
                    manifest=manifest,
                )

            return self._model_status_payload(
                user_id=user_id,
                paths=paths,
                status="ready",
                ready=True,
                model_type="supported_base",
                supported_base_model=base_model_key,
                detail="OpenWakeWord ONNX model bundle is ready.",
                manifest=manifest,
                model_files=located["model_files"],
            )

        try:
            located = self.locate_custom_model_bundle(user_id, normalized_phrase)
        except EnrollmentValidationError as exc:
            return self._model_status_payload(
                user_id=user_id,
                paths=paths,
                status="pending",
                ready=False,
                model_type="custom",
                detail=str(exc),
                manifest=manifest,
            )
        except TrainingNotSupportedError as exc:
            return self._model_status_payload(
                user_id=user_id,
                paths=paths,
                status="unsupported",
                ready=False,
                model_type="custom",
                detail=str(exc),
                manifest=manifest,
            )

        return self._model_status_payload(
            user_id=user_id,
            paths=paths,
            status="ready",
            ready=True,
            model_type="custom",
            detail="Custom OpenWakeWord model bundle is ready.",
            manifest=manifest,
            model_files=located["model_files"],
        )

    def build_model_bundle(self, user_id: int, wake_phrase: str) -> Path:
        paths = self.enrollment_paths(user_id, wake_phrase)
        normalized_phrase = paths.wake_phrase
        base_model_key = SUPPORTED_BASE_MODELS.get(normalized_phrase)
        configured_bundle = self.locate_configured_model_bundle(normalized_phrase)
        if configured_bundle["configured"]:
            if configured_bundle["error"]:
                raise TrainingNotSupportedError(str(configured_bundle["error"]))
            located = configured_bundle
        else:
            located = (
                self.locate_supported_base_model_bundle(base_model_key)
                if base_model_key
                else self.locate_custom_model_bundle(user_id, normalized_phrase)
            )
        bundle_dir = paths.root / "bundles"
        bundle_dir.mkdir(parents=True, exist_ok=True)
        bundle_path = bundle_dir / f"{paths.phrase_key}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.zip"
        manifest = {
            "version": MODEL_BUNDLE_VERSION,
            "phrase_key": paths.phrase_key,
            "wake_phrase": normalized_phrase,
            "model_type": located["model_type"],
            "model_files": [
                {
                    "role": entry["role"],
                    "file": entry["file"],
                    "sha256": entry["sha256"],
                    "bytes": entry["bytes"],
                }
                for entry in located["model_files"]
            ],
            "threshold": MODEL_THRESHOLD_DEFAULT,
            "frame_ms": MODEL_FRAME_MS,
            "sample_rate": TARGET_SAMPLE_RATE,
            "created_at": _utc_now(),
        }

        with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for entry in located["model_files"]:
                archive.write(entry["path"], entry["file"])

        return bundle_path

    def locate_configured_model_bundle(self, wake_phrase: str) -> Dict[str, Any]:
        normalized_phrase = normalize_phrase(wake_phrase)
        phrase_key = phrase_key_for(normalized_phrase)
        slug = re.sub(r"[^a-z0-9]+", "-", normalized_phrase).strip("-")
        env_keys = CONFIGURED_MODEL_BUNDLE_ENV.get(normalized_phrase, [])
        candidate_dirs: List[Path] = []

        for env_key in env_keys:
            configured_path = os.getenv(env_key)
            if configured_path:
                candidate_dirs.append(Path(configured_path).expanduser())

        candidate_dirs.extend(
            [
                self.root_dir / "models" / phrase_key,
                self.root_dir / "models" / slug,
                Path(__file__).resolve().parent.parent.parent
                / "models"
                / "openwakeword"
                / slug,
            ]
        )

        existing_bundle_dirs = [
            candidate for candidate in candidate_dirs if candidate.exists() and candidate.is_dir()
        ]
        if not existing_bundle_dirs:
            return {
                "configured": False,
                "model_type": "configured",
                "model_files": [],
                "error": None,
            }

        bundle_dir = existing_bundle_dirs[0]
        try:
            model_files = self._model_files_from_bundle_dir(bundle_dir)
        except TrainingNotSupportedError as exc:
            return {
                "configured": True,
                "model_type": "configured",
                "model_files": [],
                "error": exc,
            }

        return {
            "configured": True,
            "model_type": "configured",
            "model_key": slug,
            "model_files": model_files,
            "error": None,
        }

    def locate_supported_base_model_bundle(self, model_key: str) -> Dict[str, Any]:
        try:
            import openwakeword  # type: ignore
            from openwakeword.utils import download_models  # type: ignore
        except ImportError as exc:
            raise OpenWakeWordNotInstalledError(
                "openwakeword is not installed. Install optional wakeword dependencies before downloading wake model bundles."
            ) from exc

        try:
            download_models([model_key])
        except TypeError:
            download_models()
        except Exception as exc:
            raise OpenWakeWordNotInstalledError(
                f"Could not download OpenWakeWord artifacts for '{model_key}': {exc}"
            ) from exc

        package_root = Path(openwakeword.__file__).resolve().parent
        search_roots = [
            package_root,
            package_root / "resources",
            package_root / "models",
            Path.home() / ".cache" / "openwakeword",
            self.root_dir / "models",
        ]

        mel = self._find_model_file(search_roots, ["melspectrogram.onnx", "mel*.onnx"])
        embedding = self._find_model_file(search_roots, ["embedding_model.onnx", "*embedding*.onnx"])
        wake = self._find_model_file(
            search_roots,
            [
                f"{model_key}.onnx",
                f"{model_key}_*.onnx",
                f"*{model_key}*.onnx",
            ],
            exclude_patterns=["*embedding*", "*melspectrogram*"],
        )

        if not wake:
            tflite = self._find_model_file(
                search_roots,
                [f"{model_key}.tflite", f"{model_key}_*.tflite", f"*{model_key}*.tflite"],
            )
            if tflite:
                raise TrainingNotSupportedError(
                    f"OpenWakeWord model '{model_key}' is available only as TFLite here. "
                    "The mobile wake engine requires ONNX artifacts."
                )

        missing = [
            name
            for name, value in (
                ("melspectrogram.onnx", mel),
                ("embedding_model.onnx", embedding),
                (f"{model_key}.onnx", wake),
            )
            if not value
        ]
        if missing:
            raise TrainingNotSupportedError(
                f"OpenWakeWord ONNX bundle for '{model_key}' is incomplete. Missing: {', '.join(missing)}."
            )

        return {
            "model_type": "supported_base",
            "model_key": model_key,
            "model_files": [
                self._model_file_entry(mel, "melspectrogram"),
                self._model_file_entry(embedding, "embedding"),
                self._model_file_entry(wake, "wake"),
            ],
        }

    def locate_custom_model_bundle(self, user_id: int, wake_phrase: str) -> Dict[str, Any]:
        paths = self.enrollment_paths(user_id, wake_phrase)
        manifest = self._load_latest_manifest(paths)
        custom_model_path = manifest.get("custom_model_path")
        if not custom_model_path:
            raise EnrollmentValidationError(
                "Custom wake phrase model is pending. Upload or attach a trained OpenWakeWord model before downloading a bundle."
            )

        model_path = self._validate_custom_model_path(Path(str(custom_model_path)).expanduser())

        model_files = [self._model_file_entry(model_path, "wake")]
        missing_shared_artifacts: List[str] = []
        for role, filename in (
            ("melspectrogram", "melspectrogram.onnx"),
            ("embedding", "embedding_model.onnx"),
        ):
            candidate = model_path.parent / filename
            if candidate.exists() and candidate.is_file():
                model_files.insert(0 if role == "melspectrogram" else 1, self._model_file_entry(candidate, role))
            else:
                missing_shared_artifacts.append(filename)

        if missing_shared_artifacts:
            raise TrainingNotSupportedError(
                "Custom wake phrase model bundle is incomplete. Missing: "
                + ", ".join(missing_shared_artifacts)
                + "."
            )

        return {
            "model_type": "custom",
            "model_files": model_files,
        }

    def _model_files_from_bundle_dir(self, bundle_dir: Path) -> List[Dict[str, Any]]:
        manifest_path = bundle_dir / "manifest.json"
        if not manifest_path.is_file():
            raise TrainingNotSupportedError(
                "Configured wake model bundle is incomplete. Missing: manifest.json."
            )

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise TrainingNotSupportedError(
                f"Configured wake model manifest is invalid: {exc}"
            ) from exc

        manifest_files = manifest.get("model_files")
        files_by_role: Dict[str, Path] = {}
        if isinstance(manifest_files, list):
            for item in manifest_files:
                if not isinstance(item, dict):
                    continue
                role = str(item.get("role") or "").strip()
                if role not in MODEL_FILE_ROLES:
                    raise TrainingNotSupportedError(
                        "Configured wake model manifest roles must be wake, melspectrogram, or embedding."
                    )
                files_by_role[role] = self._safe_bundle_model_file(
                    bundle_dir,
                    item.get("file"),
                    role,
                )

        fallback_names = {
            "melspectrogram": bundle_dir / "melspectrogram.onnx",
            "embedding": bundle_dir / "embedding_model.onnx",
        }
        for role, path in fallback_names.items():
            files_by_role.setdefault(role, path)

        wake_path = files_by_role.get("wake")
        if wake_path is None:
            wake_candidates = sorted(
                path
                for path in bundle_dir.glob("*.onnx")
                if path.name not in {"melspectrogram.onnx", "embedding_model.onnx"}
            )
            if wake_candidates:
                files_by_role["wake"] = wake_candidates[0]

        required_roles = ("melspectrogram", "embedding", "wake")
        missing = [
            role
            for role in required_roles
            if not files_by_role.get(role) or not files_by_role[role].is_file()
        ]
        if missing:
            role_names = {
                "melspectrogram": "melspectrogram.onnx",
                "embedding": "embedding_model.onnx",
                "wake": "wake model ONNX",
            }
            raise TrainingNotSupportedError(
                "Configured wake model bundle is incomplete. Missing: "
                + ", ".join(role_names[role] for role in missing)
                + "."
            )

        return [
            self._model_file_entry(files_by_role["melspectrogram"], "melspectrogram"),
            self._model_file_entry(files_by_role["embedding"], "embedding"),
            self._model_file_entry(files_by_role["wake"], "wake"),
        ]

    def _derive_wake_state(self, supported_base_model: Optional[str], manifest: Dict[str, Any]) -> WAKE_STATE:
        manifest_state = str(manifest.get("wake_state") or "").strip().lower()
        if manifest_state == "active":
            custom_model_path = manifest.get("custom_model_path")
            if supported_base_model:
                return "active"
            if custom_model_path:
                model_path = Path(str(custom_model_path)).expanduser()
                if model_path.exists() and model_path.is_file() and not self._custom_model_artifact_error(model_path):
                    return "active"
            return "training"
        if manifest_state == "training":
            custom_model_path = manifest.get("custom_model_path")
            if custom_model_path:
                model_path = Path(str(custom_model_path)).expanduser()
                if model_path.exists() and model_path.is_file() and not self._custom_model_artifact_error(model_path):
                    return "active"
            return "training"
        if supported_base_model:
            return "ready_now"
        return "needs_training"

    def _custom_model_artifact_error(self, model_path: Path) -> Optional[str]:
        try:
            self._validate_custom_model_path(model_path)
        except (EnrollmentValidationError, TrainingNotSupportedError) as exc:
            return str(exc)
        return None

    def _safe_bundle_model_file(self, bundle_dir: Path, value: Any, role: str) -> Path:
        file_name = str(value or "").strip()
        if (
            not file_name
            or file_name.startswith("/")
            or "\\" in file_name
            or "/" in file_name
            or file_name in {".", ".."}
            or Path(file_name).is_absolute()
            or ".." in Path(file_name).parts
        ):
            raise TrainingNotSupportedError(
                f"Configured wake model manifest has an unsafe file path for {role or 'model'}."
            )
        if Path(file_name).suffix.lower() != ".onnx":
            raise TrainingNotSupportedError(
                f"Configured wake model manifest role {role or 'model'} must point to an ONNX file."
            )
        root = bundle_dir.resolve()
        candidate = (bundle_dir / file_name).resolve()
        if candidate.parent != root:
            raise TrainingNotSupportedError(
                f"Configured wake model manifest path for {role or 'model'} escapes the bundle directory."
            )
        return candidate

    def _validate_custom_model_path(self, model_path: Path) -> Path:
        try:
            resolved = model_path.expanduser().resolve()
        except OSError as exc:
            raise EnrollmentValidationError(
                "Custom wake phrase activation requires a readable backend-owned OpenWakeWord model file."
            ) from exc

        allowed_root = self.root_dir.resolve()
        if resolved != allowed_root and allowed_root not in resolved.parents:
            raise EnrollmentValidationError(
                "Custom wake phrase activation requires a backend-owned OpenWakeWord model file."
            )
        if not resolved.exists() or not resolved.is_file():
            raise EnrollmentValidationError(
                "Custom wake phrase activation requires an existing OpenWakeWord model file."
            )
        if resolved.suffix.lower() == ".tflite":
            raise TrainingNotSupportedError(
                "The mobile wake engine requires an ONNX custom wake model; TFLite custom models are not supported."
            )
        if resolved.suffix.lower() != ".onnx":
            raise TrainingNotSupportedError(
                "The custom wake model must be an ONNX file for the on-device wake engine."
            )

        missing_shared_artifacts = [
            filename
            for filename in ("melspectrogram.onnx", "embedding_model.onnx")
            if not (resolved.parent / filename).is_file()
        ]
        if missing_shared_artifacts:
            raise TrainingNotSupportedError(
                "Custom wake phrase model bundle is incomplete. Missing: "
                + ", ".join(missing_shared_artifacts)
                + "."
            )
        return resolved

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

    def _model_status_payload(
        self,
        *,
        user_id: int,
        paths: EnrollmentPaths,
        status: str,
        ready: bool,
        model_type: str,
        detail: str,
        manifest: Dict[str, Any],
        supported_base_model: Optional[str] = None,
        model_files: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        return {
            "ok": True,
            "user_id": int(user_id),
            "wake_phrase": paths.wake_phrase,
            "phrase_key": paths.phrase_key,
            "status": status,
            "ready": ready,
            "model_type": model_type,
            "supported_base_model": supported_base_model,
            "detail": detail,
            "threshold": MODEL_THRESHOLD_DEFAULT,
            "frame_ms": MODEL_FRAME_MS,
            "sample_rate": TARGET_SAMPLE_RATE,
            "model_files": [
                {
                    "role": entry["role"],
                    "file": entry["file"],
                    "sha256": entry["sha256"],
                    "bytes": entry["bytes"],
                }
                for entry in (model_files or [])
            ],
            "manifest": manifest,
        }

    def _find_model_file(
        self,
        search_roots: List[Path],
        patterns: List[str],
        *,
        exclude_patterns: Optional[List[str]] = None,
    ) -> Optional[Path]:
        exclude_patterns = exclude_patterns or []
        for root in search_roots:
            if not root.exists():
                continue
            for pattern in patterns:
                for candidate in sorted(root.rglob(pattern)):
                    if not candidate.is_file():
                        continue
                    if any(candidate.match(exclude) for exclude in exclude_patterns):
                        continue
                    return candidate
        return None

    def _model_file_entry(self, path: Path, role: str) -> Dict[str, Any]:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        return {
            "role": role,
            "file": path.name,
            "path": path,
            "sha256": digest,
            "bytes": path.stat().st_size,
        }

    def _decode_to_wav(self, source_path: Path, destination_path: Path) -> Dict[str, Any]:
        try:
            import av  # type: ignore
            import numpy as np  # type: ignore
        except ImportError as exc:
            raise OpenWakeWordNotInstalledError(
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
