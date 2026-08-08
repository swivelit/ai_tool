#!/usr/bin/env python3
"""Secret-safe Render-to-laptop Swico Free probe with actionable diagnostics."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
import socket
import ssl
from urllib.parse import urlsplit

import httpx


@dataclass(frozen=True)
class ProbeResult:
    name: str
    ok: bool
    category: str | None = None
    skipped: bool = False


def _timeout_seconds() -> float:
    try:
        value = float(os.getenv("SWICO_FREE_INFERENCE_TIMEOUT_SECONDS", "90"))
    except ValueError:
        value = 90.0
    return min(120.0, max(1.0, value))


def _base_url() -> tuple[str, str] | tuple[None, str]:
    value = os.getenv("SWICO_FREE_INFERENCE_BASE_URL", "").strip().rstrip("/")
    token = os.getenv("SWICO_FREE_INFERENCE_TOKEN", "").strip()
    parsed = urlsplit(value)
    if (
        not value or parsed.scheme != "https" or not parsed.hostname
        or parsed.username or parsed.password or parsed.query or parsed.fragment
    ):
        return None, "invalid_https_url"
    if len(token) < 32 or any(character.isspace() for character in token):
        return None, "invalid_token_configuration"
    return value, token


def _contains_dns_error(error: BaseException) -> bool:
    current: BaseException | None = error
    while current is not None:
        if isinstance(current, socket.gaierror):
            return True
        current = current.__cause__ or current.__context__
    message = str(error).lower()
    return any(value in message for value in ("name or service not known", "nodename nor servname", "temporary failure in name resolution"))


def _transport_category(error: httpx.HTTPError) -> str:
    if isinstance(error, httpx.ConnectTimeout):
        return "connect_timeout"
    if isinstance(error, httpx.ReadTimeout):
        return "request_timeout"
    if _contains_dns_error(error):
        return "dns_failure"
    current: BaseException | None = error
    while current is not None:
        if isinstance(current, ssl.SSLError):
            return "tls_failure"
        current = current.__cause__ or current.__context__
    if "ssl" in str(error).lower() or "certificate" in str(error).lower():
        return "tls_failure"
    return "connection_failed"


def _http_category(status_code: int) -> str:
    return {
        401: "http_401_auth_failed",
        404: "http_404_endpoint_missing",
        429: "http_429_busy",
        502: "http_502_upstream_unavailable",
        503: "http_503_unavailable",
    }.get(status_code, f"http_{status_code}")


def _check(client: httpx.Client, name: str, method: str, path: str, payload: dict | None = None) -> ProbeResult:
    try:
        response = client.request(method, path, json=payload)
    except httpx.HTTPError as error:
        return ProbeResult(name, False, _transport_category(error))
    if response.status_code >= 400:
        return ProbeResult(name, False, _http_category(response.status_code))
    try:
        body = response.json()
    except (ValueError, TypeError):
        return ProbeResult(name, False, "invalid_json")

    if not isinstance(body, dict):
        return ProbeResult(name, False, "invalid_json")
    if name == "/health":
        return ProbeResult(name, body.get("ready") is True, None if body.get("ready") is True else "health_not_ready")
    if name == "/v1/embed":
        vectors = body.get("vectors")
        valid = (
            body.get("dimensions") == 384
            and isinstance(vectors, list)
            and len(vectors) == 1
            and isinstance(vectors[0], list)
            and len(vectors[0]) == 384
        )
        return ProbeResult(name, valid, None if valid else "invalid_embedding_dimensions")
    text = body.get("text")
    valid = isinstance(text, str) and bool(text.strip())
    return ProbeResult(name, valid, None if valid else "empty_generation")


def _check_stream(client: httpx.Client) -> ProbeResult:
    name = "/v1/generate/stream"
    try:
        with client.stream(
            "POST", name,
            json={
                "messages": [{"role": "user", "content": "Reply with exactly OK."}],
                "max_output_tokens": 8,
            },
        ) as response:
            if response.status_code >= 400:
                return ProbeResult(name, False, _http_category(response.status_code))
            visible = False
            completed = False
            for line in response.iter_lines():
                value = str(line or "")
                if not value.startswith("data:"):
                    continue
                data = value[5:].strip()
                if "<think>" in data.lower() or "</think>" in data.lower():
                    return ProbeResult(name, False, "thinking_content_detected")
                if data == "[DONE]":
                    completed = True
                    continue
                if not data:
                    continue
                try:
                    event = json.loads(data)
                except ValueError:
                    return ProbeResult(name, False, "invalid_json")
                if not isinstance(event, dict):
                    return ProbeResult(name, False, "invalid_json")
                if any(key in event for key in ("reasoning", "reasoning_content", "thinking")):
                    return ProbeResult(name, False, "thinking_content_detected")
                delta = event.get("delta")
                if isinstance(delta, str):
                    if "<think>" in delta.lower() or "</think>" in delta.lower():
                        return ProbeResult(name, False, "thinking_content_detected")
                    visible = visible or bool(delta.strip())
            return ProbeResult(name, visible and completed, None if visible and completed else "stream_incomplete")
    except httpx.HTTPError as error:
        return ProbeResult(name, False, _transport_category(error))
    except (TypeError, ValueError):
        return ProbeResult(name, False, "stream_incomplete")


def _skip(name: str, category: str = "health_prerequisite_failed") -> ProbeResult:
    return ProbeResult(name, False, category, skipped=True)


def _print_result(result: ProbeResult, pretty: bool) -> None:
    if not pretty:
        return
    prefix = "SKIP" if result.skipped else "PASS" if result.ok else "FAIL"
    suffix = f" {result.category}" if result.category else ""
    print(f"{prefix} {result.name}{suffix}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe the authenticated Swico Free inference node")
    parser.add_argument("--pretty", action="store_true", help="print categorized PASS/FAIL/SKIP lines")
    parser.add_argument("--health-only", action="store_true", help="only check the authenticated health endpoint")
    args = parser.parse_args(argv)

    base_url, token_or_error = _base_url()
    if base_url is None:
        result = ProbeResult("configuration", False, token_or_error)
        _print_result(result, args.pretty)
        if not args.pretty:
            print(f"swico_free_probe=fail {result.category}")
        return 2

    timeout_seconds = _timeout_seconds()
    timeout = httpx.Timeout(timeout_seconds, connect=min(10.0, timeout_seconds))
    with httpx.Client(
        base_url=base_url,
        headers={"Authorization": f"Bearer {token_or_error}", "Accept": "application/json"},
        timeout=timeout,
    ) as client:
        health = _check(client, "/health", "GET", "/health")
        results = [health]
        if not args.health_only:
            if health.ok:
                results.extend([
                    _check(
                        client, "/v1/embed", "POST", "/v1/embed",
                        {"texts": ["swico free probe"], "modes": ["query"]},
                    ),
                    _check(
                        client, "/v1/generate", "POST", "/v1/generate",
                        {"messages": [{"role": "user", "content": "Reply with exactly OK."}], "max_output_tokens": 8},
                    ),
                    _check_stream(client),
                ])
            else:
                results.extend([
                    _skip("/v1/embed"),
                    _skip("/v1/generate"),
                    _skip("/v1/generate/stream"),
                ])

    for result in results:
        _print_result(result, args.pretty)
    passed = health.ok and (args.health_only or all(result.ok for result in results))
    if not args.pretty:
        print("swico_free_probe=pass" if passed else "swico_free_probe=fail")
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
