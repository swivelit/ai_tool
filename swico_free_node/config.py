from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} is outside supported bounds")
    return value


@dataclass(frozen=True)
class NodeConfig:
    token: str
    qwen_gguf_path: Path
    e5_model_path: Path
    host: str
    port: int
    qwen_threads: int
    qwen_batch_size: int
    e5_threads: int
    max_concurrent_generations: int
    max_queue_size: int
    max_output_tokens: int
    max_concurrent_embeddings: int
    max_embedding_queue_size: int

    @classmethod
    def from_environment(cls) -> "NodeConfig":
        token = os.getenv("SWICO_FREE_NODE_TOKEN", "").strip()
        if len(token) < 32 or any(char.isspace() for char in token):
            raise RuntimeError("SWICO_FREE_NODE_TOKEN must be a strong token")
        qwen = Path(os.getenv("SWICO_FREE_QWEN_GGUF_PATH", "").strip()).expanduser()
        e5 = Path(os.getenv("SWICO_FREE_E5_MODEL_PATH", "").strip()).expanduser()
        if qwen.suffix.lower() != ".gguf" or not qwen.is_file():
            raise RuntimeError("SWICO_FREE_QWEN_GGUF_PATH must point to an existing GGUF file")
        if not e5.is_dir():
            raise RuntimeError("SWICO_FREE_E5_MODEL_PATH must point to a model directory")
        host = os.getenv("SWICO_FREE_NODE_HOST", "127.0.0.1").strip() or "127.0.0.1"
        if host != "127.0.0.1":
            raise RuntimeError("SWICO_FREE_NODE_HOST must remain 127.0.0.1")
        return cls(
            token=token, qwen_gguf_path=qwen, e5_model_path=e5,
            host=host,
            port=_int("SWICO_FREE_NODE_PORT", 8765, 1, 65_535),
            qwen_threads=_int("SWICO_FREE_QWEN_THREADS", 4, 1, 4),
            qwen_batch_size=_int("SWICO_FREE_QWEN_BATCH_SIZE", 128, 16, 256),
            e5_threads=_int("SWICO_FREE_E5_THREADS", 2, 1, 2),
            max_concurrent_generations=_int("SWICO_FREE_MAX_CONCURRENT_GENERATIONS", 1, 1, 1),
            max_queue_size=_int("SWICO_FREE_MAX_QUEUE_SIZE", 10, 0, 10),
            max_output_tokens=_int("SWICO_FREE_MAX_OUTPUT_TOKENS", 256, 64, 512),
            max_concurrent_embeddings=_int("SWICO_FREE_MAX_CONCURRENT_EMBEDDINGS", 1, 1, 1),
            max_embedding_queue_size=_int("SWICO_FREE_MAX_EMBEDDING_QUEUE_SIZE", 4, 0, 4),
        )
