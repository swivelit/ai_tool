from __future__ import annotations

import gc
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

from config import (
    DIALECT_MODEL_MAX_LENGTH,
    DIALECT_MODEL_NUM_BEAMS,
    ENABLE_LOCAL_DIALECT_MODEL,
    ENABLE_SPACE_HEALTHCHECK,
    ENABLE_SPACE_WARMUP_ON_BOOT,
    ENABLE_TAMIL_VALIDATION,
    ENABLE_THENI_TAMIL_CONVERSION,
    ENABLE_TRANSLATION_REFINEMENT,
    MIN_TAMIL_CHAR_RATIO,
    SPACE_HEALTHCHECK_TIMEOUT,
    SPACE_MAX_RETRIES,
    SPACE_REQUEST_CONNECT_TIMEOUT,
    SPACE_REQUEST_READ_TIMEOUT,
    SPACE_RETRY_BACKOFF_SECONDS,
    SPACE_WARM_STATE_TTL_SECONDS,
    SPACE_WARMUP_TIMEOUT,
    TAMIL_TO_THENI_API_URL,
    TAMIL_TO_THENI_MODEL_ROOT,
    THENI_TO_TAMIL_API_URL,
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
    Flow:
    English -> standard Tamil         : OpenAI stage
    standard Tamil -> Theni Tamil     : Hugging Face Space first, local model fallback
    Theni Tamil -> standard Tamil     : Hugging Face Space
    """

    def __init__(self, core: Any) -> None:
        self.core = core
        self._tokenizer = None
        self._model = None
        self._loaded_model_dir: Optional[Path] = None
        self._warm_state: Dict[str, float] = {}
        self._conversion_cache: Dict[Tuple[str, str], str] = {}
        self._cache_lock = threading.Lock()

        self._tamil_to_theni_url = (TAMIL_TO_THENI_API_URL or THENI_TAMIL_API_URL or "").strip()
        self._theni_to_tamil_url = (THENI_TO_TAMIL_API_URL or "").strip()

        if ENABLE_SPACE_WARMUP_ON_BOOT:
            self._start_background_warmup()

    def _start_background_warmup(self) -> None:
        urls = [url for url in [self._tamil_to_theni_url, self._theni_to_tamil_url] if url]
        if not urls:
            return

        def _runner() -> None:
            for url in urls:
                try:
                    self._warm_remote_space(url)
                except Exception:
                    pass

        threading.Thread(target=_runner, name="hf-space-warmup", daemon=True).start()

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

    def _ensure_tamil_to_theni_model(self) -> bool:
        return self._load_local_model(TAMIL_TO_THENI_MODEL_ROOT)

    def _space_base_url(self, convert_url: str) -> str:
        return str(convert_url or "").rstrip("/").removesuffix("/convert").removesuffix("/health").removesuffix("/warmup")

    def _space_health_url(self, convert_url: str) -> str:
        return f"{self._space_base_url(convert_url)}/health"

    def _space_warmup_url(self, convert_url: str) -> str:
        return f"{self._space_base_url(convert_url)}/warmup"

    def _is_recently_warm(self, convert_url: str) -> bool:
        last = self._warm_state.get(convert_url)
        if last is None:
            return False
        return (time.time() - last) <= SPACE_WARM_STATE_TTL_SECONDS

    def _mark_warm(self, convert_url: str) -> None:
        self._warm_state[convert_url] = time.time()

    def _healthcheck_space(self, convert_url: str) -> bool:
        if not ENABLE_SPACE_HEALTHCHECK:
            return False
        try:
            response = requests.get(
                self._space_health_url(convert_url),
                timeout=(SPACE_REQUEST_CONNECT_TIMEOUT, SPACE_HEALTHCHECK_TIMEOUT),
            )
            if response.status_code == 200:
                self._mark_warm(convert_url)
                return True
        except Exception:
            pass
        return False

    def _warm_remote_space(self, convert_url: str) -> bool:
        if not convert_url:
            return False

        if self._is_recently_warm(convert_url):
            return True

        if self._healthcheck_space(convert_url):
            return True

        try:
            response = requests.post(
                self._space_warmup_url(convert_url),
                timeout=(SPACE_REQUEST_CONNECT_TIMEOUT, SPACE_WARMUP_TIMEOUT),
            )
            if response.status_code == 200:
                self._mark_warm(convert_url)
                return True
        except Exception:
            pass

        return False

    def _extract_remote_output(self, payload: Dict[str, Any]) -> str:
        text = (
            payload.get("output_text")
            or payload.get("theni_tamil_text")
            or payload.get("tamil_text")
            or payload.get("text")
            or payload.get("output")
            or ""
        )
        return self._cleanup_tamil(text)

    def _convert_via_space_api(self, convert_url: str, text: str) -> str:
        if not convert_url:
            return ""

        cache_key = (convert_url, text)
        with self._cache_lock:
            cached = self._conversion_cache.get(cache_key)
        if cached:
            return cached

        attempts = max(1, SPACE_MAX_RETRIES + 1)
        for attempt in range(attempts):
            try:
                if attempt == 0:
                    if not self._is_recently_warm(convert_url):
                        self._warm_remote_space(convert_url)
                else:
                    self._warm_remote_space(convert_url)
                    time.sleep(SPACE_RETRY_BACKOFF_SECONDS * attempt)

                response = requests.post(
                    convert_url,
                    json={"text": text},
                    timeout=(SPACE_REQUEST_CONNECT_TIMEOUT, SPACE_REQUEST_READ_TIMEOUT),
                )
                response.raise_for_status()
                payload = response.json() if response.content else {}
                output = self._extract_remote_output(payload)
                if output and self._looks_like_valid_tamil_output(output):
                    self._mark_warm(convert_url)
                    with self._cache_lock:
                        if len(self._conversion_cache) >= 256:
                            self._conversion_cache.pop(next(iter(self._conversion_cache)))
                        self._conversion_cache[cache_key] = output
                    return output
            except Exception:
                continue

        return ""

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
        tamil_text = self._cleanup_tamil(tamil_text)
        if not tamil_text:
            return ""

        if not ENABLE_THENI_TAMIL_CONVERSION:
            return tamil_text

        if not self._looks_like_valid_tamil_output(tamil_text):
            return tamil_text

        remote_output = self._convert_via_space_api(self._tamil_to_theni_url, tamil_text)
        if remote_output:
            return remote_output

        if self._ensure_tamil_to_theni_model():
            try:
                generated = self._cleanup_tamil(self._generate(tamil_text, self._model))
                if self._looks_like_valid_tamil_output(generated):
                    return generated
            except Exception:
                self._clear_memory()

        return tamil_text

    def thenitamil_to_tamil(self, theni_tamil_text: str) -> str:
        theni_tamil_text = self._cleanup_tamil(theni_tamil_text)
        if not theni_tamil_text:
            return ""

        if not self._looks_like_valid_tamil_output(theni_tamil_text):
            return theni_tamil_text

        remote_output = self._convert_via_space_api(self._theni_to_tamil_url, theni_tamil_text)
        if remote_output:
            return remote_output

        return theni_tamil_text