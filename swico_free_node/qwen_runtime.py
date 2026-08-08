from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from threading import Event
from typing import Any


class QwenRuntime:
    def __init__(self, path: Path, *, threads: int = 4, batch_size: int = 128) -> None:
        if path.suffix.lower() != ".gguf":
            raise RuntimeError("The configured generation artifact must be GGUF")
        if not path.is_file():
            raise RuntimeError("The configured generation artifact does not exist")
        with path.open("rb") as handle:
            if handle.read(4) != b"GGUF":
                raise RuntimeError("The configured generation artifact is not valid GGUF")
        try:
            from llama_cpp import Llama
        except ImportError as exc:
            raise RuntimeError("llama-cpp-python is required for generation") from exc
        self._llama = Llama(
            model_path=str(path), n_ctx=4096, n_threads=threads, n_batch=batch_size,
            n_gpu_layers=0, verbose=False,
        )

    def generate(self, messages: list[dict[str, str]], max_output_tokens: int) -> tuple[str, dict[str, int]]:
        if hasattr(self._llama, "create_chat_completion"):
            result: Any = self._llama.create_chat_completion(
                messages=messages, max_tokens=max_output_tokens, temperature=0.2,
            )
        else:
            prompt = "\n\n".join(f"{item['role']}: {item['content']}" for item in messages)
            result = self._llama(prompt, max_tokens=max_output_tokens, temperature=0.2)
        text = self._extract_text(result).strip()
        if not text:
            raise RuntimeError("generation returned empty text")
        return text, self._usage(result, messages, text)

    def stream(
        self,
        messages: list[dict[str, str]],
        max_output_tokens: int,
        cancellation: Event | None = None,
    ) -> Iterator[tuple[str, dict[str, int]]]:
        self._install_abort_callback(cancellation)
        if hasattr(self._llama, "create_chat_completion"):
            stream = self._llama.create_chat_completion(
                messages=messages, max_tokens=max_output_tokens,
                temperature=0.2, stream=True,
            )
        else:
            prompt = "\n\n".join(f"{item['role']}: {item['content']}" for item in messages)
            stream = self._llama(prompt, max_tokens=max_output_tokens, temperature=0.2, stream=True)
        parts: list[str] = []
        try:
            for item in stream:
                if cancellation is not None and cancellation.is_set():
                    close = getattr(stream, "close", None)
                    if callable(close):
                        close()
                    return
                delta = self._extract_delta(item)
                if delta:
                    parts.append(delta)
                    yield delta, {}
            if cancellation is None or not cancellation.is_set():
                yield "", self._usage({}, messages, "".join(parts))
        finally:
            self._install_abort_callback(None)

    def _install_abort_callback(self, cancellation: Event | None) -> None:
        setter = getattr(self._llama, "set_abort_callback", None)
        if callable(setter):
            setter((lambda: cancellation.is_set()) if cancellation is not None else None)

    @staticmethod
    def _extract_text(result: Any) -> str:
        choices = result.get("choices", []) if isinstance(result, dict) else []
        choice = choices[0] if choices else {}
        message = choice.get("message", {}) if isinstance(choice, dict) else {}
        return str(message.get("content") or choice.get("text") or "")

    @staticmethod
    def _extract_delta(result: Any) -> str:
        choices = result.get("choices", []) if isinstance(result, dict) else []
        choice = choices[0] if choices else {}
        delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
        return str(delta.get("content") or choice.get("text") or "")

    @staticmethod
    def _usage(result: Any, messages: list[dict[str, str]], text: str) -> dict[str, int]:
        usage = result.get("usage", {}) if isinstance(result, dict) else {}
        usage = {
            "input_tokens": int(usage.get("prompt_tokens") or max(1, sum(len(item["content"]) for item in messages) // 3)),
            "output_tokens": int(usage.get("completion_tokens") or max(1, len(text) // 3)),
        }
        timings = result.get("timings", {}) if isinstance(result, dict) else {}
        if isinstance(timings, dict):
            prompt_ms = timings.get("prompt_ms") or timings.get("prompt_eval_ms")
            if prompt_ms is not None:
                usage["prompt_processing_ms"] = int(float(prompt_ms))
            predicted_ms = timings.get("predicted_ms") or timings.get("generation_ms")
            if predicted_ms is not None:
                usage["generation_ms"] = int(float(predicted_ms))
        return usage
