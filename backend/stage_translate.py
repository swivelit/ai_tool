from __future__ import annotations

import gc
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

from config import (
    DIALECT_MODEL_MAX_LENGTH,
    DIALECT_MODEL_NUM_BEAMS,
    ENABLE_LOCAL_DIALECT_MODEL,
    ENABLE_TAMIL_VALIDATION,
    ENABLE_TRANSLATION_REFINEMENT,
    MIN_TAMIL_CHAR_RATIO,
    TAMIL_TO_THENI_MODEL_ROOT,
    THENI_TAMIL_API_TIMEOUT,
    THENI_TAMIL_API_URL,
    TRANSLATION_MAX_CHUNK_CHARS,
    TRANSLATION_MAX_RETRIES,
    TRANSLATION_REFINEMENT_MAX_CHARS,
    TRANSLATION_RETRY_ON_NON_TAMIL,
    TRANSLATION_TEMPERATURE,
)

try:
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
except Exception:
    AutoModelForSeq2SeqLM = None
    AutoTokenizer = None


TAMIL_RE = re.compile(r"[\u0B80-\u0BFF]")


def _is_hf_weight_file(filename: str) -> bool:
    return filename.endswith((".bin", ".safetensors"))


def _looks_like_full_hf_model_dir(model_dir: Path) -> bool:
    if not model_dir.is_dir():
        return False
    has_config = (model_dir / "config.json").exists()
    has_weights = any(_is_hf_weight_file(path.name) for path in model_dir.iterdir() if path.is_file())
    return has_config and has_weights


def _pick_best_model_dir(root: Path) -> Optional[Path]:
    if _looks_like_full_hf_model_dir(root):
        return root
    candidates = [path for path in root.glob("**/*") if _looks_like_full_hf_model_dir(path)]
    return sorted(candidates, key=lambda p: len(str(p)))[0] if candidates else None


class StageTranslator:
    """
    English -> standard Tamil uses the existing OpenAI stage.
    Standard Tamil -> Theni Tamil stays local-first to avoid extra token cost.
    """

    def __init__(self, core: Any) -> None:
        self.core = core
        self._tokenizer = None
        self._model = None
        self._loaded_model_dir: Optional[Path] = None

    def _contains_tamil(self, text: str) -> bool:
        return bool(TAMIL_RE.search(str(text or "")))

    def _cleanup_tamil(self, text: str) -> str:
        text = str(text or "").strip()
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"\s+([.,!?])", r"\1", text)
        return text.strip()

    def _split_into_chunks(self, text: str, chunk_size: int = TRANSLATION_MAX_CHUNK_CHARS) -> List[str]:
        text = str(text or "").strip()
        if len(text) <= chunk_size:
            return [text] if text else []

        sentences = re.split(r"(?<=[.!?])\s+", text)
        chunks: List[str] = []
        current = ""

        for sentence in sentences:
            if len(current) + len(sentence) + 1 <= chunk_size:
                current = f"{current} {sentence}".strip()
            else:
                if current:
                    chunks.append(current)
                current = sentence.strip()

        if current:
            chunks.append(current)

        return chunks

    def _tamil_char_ratio(self, text: str) -> float:
        text = str(text or "")
        if not text:
            return 0.0
        tamil_count = len(TAMIL_RE.findall(text))
        alpha_count = len(re.findall(r"[\w\u0B80-\u0BFF]", text))
        return tamil_count / max(alpha_count, 1)

    def _looks_like_valid_tamil_output(self, text: str) -> bool:
        if not text.strip():
            return False
        if not self._contains_tamil(text):
            return False
        if ENABLE_TAMIL_VALIDATION and self._tamil_char_ratio(text) < MIN_TAMIL_CHAR_RATIO:
            return False
        return True

    def _clear_memory(self) -> None:
        gc.collect()

    def _load_local_model(self, model_dir: Path) -> bool:
        if not ENABLE_LOCAL_DIALECT_MODEL or AutoTokenizer is None or AutoModelForSeq2SeqLM is None:
            return False

        resolved = _pick_best_model_dir(model_dir)
        if resolved is None:
            return False

        if self._loaded_model_dir == resolved and self._model is not None and self._tokenizer is not None:
            return True

        self._tokenizer = AutoTokenizer.from_pretrained(str(resolved))
        self._model = AutoModelForSeq2SeqLM.from_pretrained(str(resolved))
        self._loaded_model_dir = resolved
        return True

    def _convert_via_external_api(self, tamil_text: str) -> str:
        if not THENI_TAMIL_API_URL:
            return ""

        try:
            response = requests.post(
                THENI_TAMIL_API_URL,
                json={"text": tamil_text},
                timeout=THENI_TAMIL_API_TIMEOUT,
            )
            response.raise_for_status()
            payload = response.json()
            output = self._cleanup_tamil(payload.get("theni_tamil_text") or payload.get("text") or "")
            return output if self._looks_like_valid_tamil_output(output) else ""
        except Exception:
            return ""

    def _ensure_tamil_to_theni_model(self) -> bool:
        return self._load_local_model(TAMIL_TO_THENI_MODEL_ROOT)

    def _translate_chunk(self, english_text: str, tone: str, answer_length: str) -> str:
        system_prompt = (
            "You are a high-quality English to Tamil translator. Produce natural standard Tamil, not dialect Tamil. "
            "Preserve meaning, keep it fluent, and do not explain the translation."
        )
        user_prompt = f"""
English text:
{english_text}

Requested tone: {tone}
Requested answer length: {answer_length}

Task:
- Translate to clear, natural Tamil.
- Keep names and technical terms readable.
- Output only Tamil text.
""".strip()

        return self._cleanup_tamil(
            self.core.generate_text(
                system_prompt,
                user_prompt,
                temperature=TRANSLATION_TEMPERATURE,
                max_output_tokens=900,
            )
        )

    def _retry_translate_chunk(self, english_text: str) -> str:
        system_prompt = (
            "Translate the given English text into Tamil only. "
            "Do not keep it in English. Do not explain anything."
        )
        return self._cleanup_tamil(
            self.core.generate_text(
                system_prompt,
                english_text,
                temperature=0.0,
                max_output_tokens=900,
            )
        )

    def _refine_combined_tamil(self, tamil_text: str, tone: str, answer_length: str) -> str:
        if not ENABLE_TRANSLATION_REFINEMENT or len(tamil_text) > TRANSLATION_REFINEMENT_MAX_CHARS:
            return tamil_text

        system_prompt = (
            "You are a Tamil editor. Improve fluency and consistency while preserving meaning. "
            "Keep the output in standard Tamil only."
        )
        user_prompt = f"""
Tamil draft:
{tamil_text}

Requested tone: {tone}
Requested answer length: {answer_length}

Task:
- Improve fluency and readability.
- Preserve meaning exactly.
- Output only the refined Tamil.
""".strip()

        refined = self._cleanup_tamil(
            self.core.generate_text(
                system_prompt,
                user_prompt,
                temperature=0.08,
                max_output_tokens=900,
            )
        )
        return refined if self._looks_like_valid_tamil_output(refined) else tamil_text

    def english_to_tamil_with_meta(self, english_text: str, profile: Dict[str, Any]) -> Dict[str, Any]:
        english_text = str(english_text or "").strip()
        if not english_text:
            return {
                "tamil_text": "",
                "chunks": 0,
                "tone": "neutral",
                "answer_length": "short",
                "retry_count": 0,
                "valid_tamil": False,
            }

        profile_card = profile.get("profile_card", {}) if isinstance(profile, dict) else {}
        tone = str(profile_card.get("tone", "warm")).strip() or "warm"
        answer_length = str(profile_card.get("answer_length", "balanced")).strip() or "balanced"

        chunks = self._split_into_chunks(english_text)
        tamil_chunks: List[str] = []
        retry_count = 0

        for chunk in chunks:
            translated = self._translate_chunk(chunk, tone, answer_length)

            if TRANSLATION_RETRY_ON_NON_TAMIL and not self._looks_like_valid_tamil_output(translated):
                for _ in range(TRANSLATION_MAX_RETRIES):
                    retry_count += 1
                    translated = self._retry_translate_chunk(chunk)
                    if self._looks_like_valid_tamil_output(translated):
                        break

            tamil_chunks.append(translated)

        combined = self._cleanup_tamil(" ".join(tamil_chunks))
        refined = self._refine_combined_tamil(combined, tone, answer_length)

        return {
            "tamil_text": refined,
            "chunks": len(chunks),
            "tone": tone,
            "answer_length": answer_length,
            "retry_count": retry_count,
            "valid_tamil": self._looks_like_valid_tamil_output(refined),
        }

    def english_to_tamil(self, english_text: str, profile: Dict[str, Any]) -> str:
        return str(self.english_to_tamil_with_meta(english_text, profile).get("tamil_text", "")).strip()

    def tamil_to_thenitamil(self, tamil_text: str) -> str:
        """
        Cost-free dialect conversion path:
        1) separate local API
        2) local HF model
        3) graceful fallback to standard Tamil (no extra OpenAI call)
        """
        tamil_text = self._cleanup_tamil(tamil_text)
        if not tamil_text:
            return ""

        if not self._looks_like_valid_tamil_output(tamil_text):
            return tamil_text

        api_result = self._convert_via_external_api(tamil_text)
        if api_result:
            return api_result

        if self._ensure_tamil_to_theni_model():
            try:
                generated = self._cleanup_tamil(self._generate(tamil_text, self._model))
                if self._looks_like_valid_tamil_output(generated):
                    return generated
            except Exception:
                self._clear_memory()

        return tamil_text

    def _generate(self, text: str, model: Any) -> str:
        if self._tokenizer is None or model is None:
            raise RuntimeError("Local tokenizer/model not loaded.")

        encoded = self._tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=DIALECT_MODEL_MAX_LENGTH,
        )
        output_ids = model.generate(
            **encoded,
            max_length=DIALECT_MODEL_MAX_LENGTH,
            num_beams=DIALECT_MODEL_NUM_BEAMS,
        )
        return str(self._tokenizer.batch_decode(output_ids, skip_special_tokens=True)[0]).strip()