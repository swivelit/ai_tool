#!/usr/bin/env python3
"""Secret-safe Render-to-laptop Swico Free probe."""

from __future__ import annotations

import argparse
import os
from urllib.parse import urlsplit

import httpx


def _base_url() -> tuple[str, str] | tuple[None, str]:
    value = os.getenv("SWICO_FREE_INFERENCE_BASE_URL", "").strip().rstrip("/")
    token = os.getenv("SWICO_FREE_INFERENCE_TOKEN", "").strip()
    parsed = urlsplit(value)
    if (
        not value or parsed.scheme != "https" or not parsed.hostname
        or parsed.username or parsed.password or parsed.query or parsed.fragment
    ):
        return None, "SWICO_FREE_INFERENCE_BASE_URL must be an HTTPS URL"
    if len(token) < 32 or any(character.isspace() for character in token):
        return None, "SWICO_FREE_INFERENCE_TOKEN is missing or weak"
    return value, token


def _check(client: httpx.Client, name: str, method: str, path: str, payload: dict | None = None) -> tuple[str, bool]:
    try:
        response = client.request(method, path, json=payload)
        if response.status_code >= 400:
            return name, False
        body = response.json()
        if name == "/health":
            ok = body.get("ready") is True
        elif name == "/v1/embed":
            vectors = body.get("vectors")
            ok = body.get("dimensions") == 384 and isinstance(vectors, list) and len(vectors) == 1 and len(vectors[0]) == 384
        else:
            ok = isinstance(body.get("text"), str) and bool(body["text"].strip())
        return name, bool(ok)
    except (httpx.HTTPError, ValueError, TypeError, KeyError):
        return name, False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe the authenticated Swico Free inference node")
    parser.add_argument("--pretty", action="store_true", help="print PASS/FAIL lines")
    args = parser.parse_args(argv)
    base_url, token_or_error = _base_url()
    if base_url is None:
        print(f"FAIL {token_or_error}")
        return 2
    token = token_or_error
    timeout = httpx.Timeout(15.0, connect=5.0)
    checks: list[tuple[str, bool]] = []
    with httpx.Client(
        base_url=base_url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        timeout=timeout,
    ) as client:
        checks.append(_check(client, "/health", "GET", "/health"))
        checks.append(_check(
            client, "/v1/embed", "POST", "/v1/embed",
            {"texts": ["swico free probe"], "modes": ["query"]},
        ))
        checks.append(_check(
            client, "/v1/generate", "POST", "/v1/generate",
            {"messages": [{"role": "user", "content": "Reply with exactly OK."}], "max_output_tokens": 8},
        ))
    passed = all(ok for _name, ok in checks)
    if args.pretty:
        for name, ok in checks:
            print(f"{'PASS' if ok else 'FAIL'} {name}")
    else:
        print("swico_free_probe=pass" if passed else "swico_free_probe=fail")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
