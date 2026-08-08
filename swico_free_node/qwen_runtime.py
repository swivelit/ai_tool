from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any


class QwenRuntime:
    def __init__(self, path: Path) -> None:
        if path.suffix.lower() != ".gguf":
            raise RuntimeError("The configured generation artifact must be GGUF")
        try:
            from llama_cpp import Llama
        except ImportError as exc:
            raise RuntimeError("llama-cpp-python is required for generation") from exc
        self._llama = Llama(
            model_path=str(path), n_ctx=4096, n_threads=8, n_batch=128,
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

    def stream(self, messages: list[dict[str, str]], max_output_tokens: int) -> Iterator[tuple[str, dict[str, int]]]:
        if hasattr(self._llama, "create_chat_completion"):
            stream = self._llama.create_chat_completion(
                messages=messages, max_tokens=max_output_tokens,
                temperature=0.2, stream=True,
            )
        else:
            prompt = "\n\n".join(f"{item['role']}: {item['content']}" for item in messages)
            stream = self._llama(prompt, max_tokens=max_output_tokens, temperature=0.2, stream=True)
        parts: list[str] = []
        for item in stream:
            delta = self._extract_delta(item)
            if delta:
                parts.append(delta)
                yield delta, {}
        yield "", self._usage({}, messages, "".join(parts))

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
        return {
            "input_tokens": int(usage.get("prompt_tokens") or max(1, sum(len(item["content"]) for item in messages) // 3)),
            "output_tokens": int(usage.get("completion_tokens") or max(1, len(text) // 3)),
        }
