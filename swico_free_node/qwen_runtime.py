from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from threading import Event
from typing import Any


class VisibleTextFilter:
    """Remove Qwen thinking blocks without emitting buffered hidden tokens."""

    _OPEN = "<think>"
    _CLOSE = "</think>"

    def __init__(self) -> None:
        self._buffer = ""
        self._thinking = False

    def feed(self, value: str) -> str:
        self._buffer += str(value or "")
        visible: list[str] = []
        while self._buffer:
            lowered = self._buffer.lower()
            tag = self._CLOSE if self._thinking else self._OPEN
            index = lowered.find(tag)
            if index >= 0:
                if not self._thinking:
                    visible.append(self._buffer[:index])
                self._buffer = self._buffer[index + len(tag):]
                self._thinking = not self._thinking
                continue
            # Keep only a suffix that could actually be the beginning of a
            # split tag. Ordinary visible text is emitted immediately.
            prefixes = (self._CLOSE,) if self._thinking else (self._OPEN, self._CLOSE)
            keep = max(
                (size for prefix in prefixes for size in range(1, len(prefix))
                 if lowered.endswith(prefix[:size])),
                default=0,
            )
            if not self._thinking:
                if keep:
                    visible.append(self._buffer[:-keep])
                    self._buffer = self._buffer[-keep:]
                else:
                    visible.append(self._buffer)
                    self._buffer = ""
            elif keep:
                self._buffer = self._buffer[-keep:]
            else:
                self._buffer = ""
            break
        return "".join(visible)

    def finish(self) -> str:
        if self._thinking:
            self._buffer = ""
            return ""
        value = self.feed("")
        # ``feed`` can intentionally retain a partial tag at end-of-stream.
        # It is safer to discard that incomplete control marker than expose it
        # as answer text.
        lowered = self._buffer.lower()
        partial_tag = any(
            lowered == tag[:len(lowered)]
            for tag in (self._OPEN, self._CLOSE)
            if lowered
        )
        if not partial_tag:
            value += self._buffer
        self._buffer = ""
        return value


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
        messages = self._non_thinking_messages(messages)
        if hasattr(self._llama, "create_chat_completion"):
            result = self._chat_completion(messages, max_output_tokens, stream=False)
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
        messages = self._non_thinking_messages(messages)
        if hasattr(self._llama, "create_chat_completion"):
            stream = self._chat_completion(messages, max_output_tokens, stream=True)
        else:
            prompt = "\n\n".join(f"{item['role']}: {item['content']}" for item in messages)
            stream = self._llama(prompt, max_tokens=max_output_tokens, temperature=0.2, stream=True)
        parts: list[str] = []
        visible_filter = VisibleTextFilter()
        try:
            for item in stream:
                if cancellation is not None and cancellation.is_set():
                    close = getattr(stream, "close", None)
                    if callable(close):
                        close()
                    return
                delta = visible_filter.feed(self._extract_delta(item))
                if delta:
                    parts.append(delta)
                    yield delta, {}
            tail = visible_filter.finish()
            if tail and (cancellation is None or not cancellation.is_set()):
                parts.append(tail)
                yield tail, {}
            if cancellation is None or not cancellation.is_set():
                yield "", self._usage({}, messages, "".join(parts))
        finally:
            self._install_abort_callback(None)

    def _install_abort_callback(self, cancellation: Event | None) -> None:
        setter = getattr(self._llama, "set_abort_callback", None)
        if callable(setter):
            setter((lambda: cancellation.is_set()) if cancellation is not None else None)

    @staticmethod
    def _non_thinking_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
        copied = [dict(item) for item in messages]
        for item in reversed(copied):
            if item.get("role") == "user":
                item["content"] = f"{item.get('content', '').rstrip()}\n/no_think"
                break
        return copied

    def _chat_completion(
        self, messages: list[dict[str, str]], max_output_tokens: int, *, stream: bool,
    ) -> Any:
        kwargs = {
            "messages": messages, "max_tokens": max_output_tokens,
            "temperature": 0.2, "stream": stream,
        }
        try:
            return self._llama.create_chat_completion(
                **kwargs, chat_template_kwargs={"enable_thinking": False},
            )
        except TypeError as exc:
            # Older llama-cpp-python releases may not expose this keyword; the
            # explicit /no_think control remains in the user message.
            if "chat_template_kwargs" not in str(exc):
                raise
            return self._llama.create_chat_completion(**kwargs)

    @staticmethod
    def _extract_text(result: Any) -> str:
        choices = result.get("choices", []) if isinstance(result, dict) else []
        choice = choices[0] if choices else {}
        message = choice.get("message", {}) if isinstance(choice, dict) else {}
        value = message.get("content") or choice.get("text") or ""
        visible_filter = VisibleTextFilter()
        return visible_filter.feed(str(value)) + visible_filter.finish()

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
