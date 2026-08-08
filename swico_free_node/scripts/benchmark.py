from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path

from dotenv import load_dotenv


NODE_ROOT = Path(__file__).resolve().parents[1]


def _request(url: str, token: str, payload: dict | None = None) -> tuple[float, dict]:
    request = urllib.request.Request(
        url,
        method="POST" if payload is not None else "GET",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=15) as response:
        body = json.loads(response.read().decode())
    return (time.perf_counter() - started) * 1000, body


def main() -> int:
    load_dotenv(NODE_ROOT / ".env")
    token = os.getenv("SWICO_FREE_NODE_TOKEN", "").strip()
    if len(token) < 32:
        print("FAIL SWICO_FREE_NODE_TOKEN is missing or weak")
        return 2
    base = "http://127.0.0.1:8765"
    try:
        health_ms, health = _request(f"{base}/health", token)
        embed_ms, embed = _request(
            f"{base}/v1/embed", token,
            {"texts": ["benchmark text"], "modes": ["query"]},
        )
        generation_ms, generation = _request(
            f"{base}/v1/generate", token,
            {"messages": [{"role": "user", "content": "Reply with exactly OK."}], "max_output_tokens": 32},
        )
    except Exception:
        print("FAIL benchmark request")
        return 1
    usage = generation.get("usage") if isinstance(generation.get("usage"), dict) else {}
    output_tokens = int(usage.get("output_tokens") or 0)
    prompt_ms = usage.get("prompt_processing_ms", "unavailable")
    generation_tps = (output_tokens / (generation_ms / 1000)) if generation_ms > 0 and output_tokens else 0
    print(f"model_startup_ms={health.get('model_startup_ms', 'unavailable')}")
    print(f"qwen_startup_ms={health.get('qwen_startup_ms', 'unavailable')}")
    print(f"e5_startup_ms={health.get('e5_startup_ms', 'unavailable')}")
    print(f"qwen_prompt_processing_ms={prompt_ms}")
    print(f"qwen_generated_tokens={output_tokens}")
    print(f"qwen_tokens_per_second={generation_tps:.2f}")
    print(f"e5_embedding_latency_ms={embed_ms:.2f}")
    print(f"qwen_request_latency_ms={generation_ms:.2f}")
    print(f"health_latency_ms={health_ms:.2f}")
    print(f"active_or_queued_generations={health.get('active_or_queued_generations', 'unavailable')}")
    print(f"active_or_queued_embeddings={health.get('active_or_queued_embeddings', 'unavailable')}")
    if embed.get("dimensions") != 384 or not isinstance(generation.get("text"), str) or not generation["text"].strip():
        print("FAIL benchmark response validation")
        return 1
    print("PASS benchmark")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
