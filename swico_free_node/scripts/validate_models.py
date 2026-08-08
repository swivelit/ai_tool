from __future__ import annotations

import os
from pathlib import Path
import sys
import time

from dotenv import load_dotenv

NODE_ROOT = Path(__file__).resolve().parents[1]
if str(NODE_ROOT) not in sys.path:
    sys.path.insert(0, str(NODE_ROOT))

from e5_runtime import E5Runtime, validate_e5_artifacts  # noqa: E402
from qwen_runtime import QwenRuntime  # noqa: E402


def _configured_path(name: str) -> Path:
    return Path(os.getenv(name, "").strip()).expanduser()


def _safe_error(error: Exception, *paths: Path) -> str:
    message = str(error) or type(error).__name__
    for path in paths:
        if str(path):
            message = message.replace(str(path), f"<{path.name or 'configured-path'}>")
    return message[:300]


def main() -> int:
    load_dotenv(NODE_ROOT / ".env")
    qwen_path = _configured_path("SWICO_FREE_QWEN_GGUF_PATH")
    e5_path = _configured_path("SWICO_FREE_E5_MODEL_PATH")
    try:
        if qwen_path.suffix.lower() != ".gguf" or not qwen_path.is_file():
            raise RuntimeError("SWICO_FREE_QWEN_GGUF_PATH must point to an existing .gguf file")
        with qwen_path.open("rb") as handle:
            if handle.read(4) != b"GGUF":
                raise RuntimeError("configured Qwen file is not a GGUF artifact")
        print("PASS Qwen GGUF artifact")

        validate_e5_artifacts(e5_path)
        print("PASS E5 local artifact layout")

        started = time.perf_counter()
        qwen = QwenRuntime(
            qwen_path,
            threads=int(os.getenv("SWICO_FREE_QWEN_THREADS", "4")),
            batch_size=int(os.getenv("SWICO_FREE_QWEN_BATCH_SIZE", "128")),
        )
        qwen_started_ms = int((time.perf_counter() - started) * 1000)
        print(f"PASS Qwen initialization ({qwen_started_ms} ms)")

        e5_started = time.perf_counter()
        e5 = E5Runtime(e5_path, threads=int(os.getenv("SWICO_FREE_E5_THREADS", "2")))
        e5_started_ms = int((time.perf_counter() - e5_started) * 1000)
        print(f"PASS E5 initialization ({e5_started_ms} ms)")

        vectors = e5.embed(["validation text"], ["query"])
        if len(vectors) != 1 or len(vectors[0]) != 384:
            raise RuntimeError("E5 smoke test did not return exactly 384 dimensions")
        print("PASS E5 384-dimensional smoke test")

        text, usage = qwen.generate(
            [{"role": "user", "content": "Reply with exactly OK."}], 8,
        )
        if not text.strip() or int(usage.get("output_tokens", 0)) < 1:
            raise RuntimeError("Qwen smoke test returned no generated tokens")
        print("PASS Qwen generation smoke test")
        print("PASS both local models initialized and completed tiny smoke tests")
        return 0
    except Exception as error:
        print(f"FAIL {_safe_error(error, qwen_path, e5_path)}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
