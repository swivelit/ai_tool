from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.ai.openai_catalog import get_model_spec  # noqa: E402


def _sanitize(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"sk-[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", text)
    return text[:200]


def _probe(client, model: str) -> dict:
    spec = get_model_spec(model)
    started = time.perf_counter()
    try:
        if spec.endpoint == "responses":
            response = client.responses.create(
                model=model,
                input="Say ok in one short sentence.",
                instructions="Return a short health probe answer.",
                max_output_tokens=16,
                store=False,
            )
            text = str(getattr(response, "output_text", "") or "").strip()
        else:
            kwargs = {
                "model": model,
                "messages": [{"role": "user", "content": "Say ok in one short sentence."}],
                "max_tokens": 16,
                "store": False,
            }
            if spec.supports_temperature:
                kwargs["temperature"] = 0
            response = client.chat.completions.create(**kwargs)
            text = str(response.choices[0].message.content or "").strip()
        return {
            "provider": "openai",
            "model": model,
            "endpoint": spec.endpoint,
            "ok": True,
            "latency_ms": int(round((time.perf_counter() - started) * 1000)),
            "text_preview": text[:40],
        }
    except Exception as exc:
        return {
            "provider": "openai",
            "model": model,
            "endpoint": spec.endpoint,
            "ok": False,
            "error_type": exc.__class__.__name__,
            "error_message_sanitized": _sanitize(exc),
            "latency_ms": int(round((time.perf_counter() - started) * 1000)),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe configured OpenAI text-generation models.")
    parser.add_argument("--models", default="gpt-5-nano,gpt-4.1-nano,gpt-4o-mini,gpt-5-mini,gpt-4.1-mini")
    args = parser.parse_args()
    if not os.getenv("OPENAI_API_KEY", "").strip():
        print(json.dumps({"ok": False, "skipped": True, "reason": "OPENAI_API_KEY absent"}, indent=2))
        return 0

    import openai

    client = openai.OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    models = [model.strip() for model in str(args.models or "").split(",") if model.strip()]
    results = [_probe(client, model) for model in models]
    print(json.dumps({"ok": all(row.get("ok") for row in results), "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
