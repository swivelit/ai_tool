from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

from dotenv import load_dotenv


NODE_ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "http://127.0.0.1:8765"


def _timeout_seconds() -> float:
    try:
        value = float(os.getenv("SWICO_FREE_INFERENCE_TIMEOUT_SECONDS", "90"))
    except ValueError:
        value = 90.0
    return min(120.0, max(1.0, value))


def _token() -> str:
    token = os.getenv("SWICO_FREE_NODE_TOKEN", "").strip()
    if len(token) < 32:
        raise RuntimeError("SWICO_FREE_NODE_TOKEN is missing or weak")
    return token


def _request(
    path: str, token: str, payload: dict | None = None,
) -> tuple[float, int, dict]:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        method="POST" if payload is not None else "GET",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps(payload).encode() if payload is not None else None,
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
            return (time.perf_counter() - started) * 1000, response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return (time.perf_counter() - started) * 1000, int(error.code), {}


def _stream_generation(token: str, prompt: str, max_output_tokens: int) -> dict[str, object]:
    request = urllib.request.Request(
        f"{BASE_URL}/v1/generate/stream",
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps({
            "messages": [{"role": "user", "content": prompt}],
            "max_output_tokens": max_output_tokens,
        }).encode(),
    )
    started = time.perf_counter()
    first_token_ms: float | None = None
    usage: dict[str, object] = {}
    visible_characters = 0
    completed = False
    try:
        with urllib.request.urlopen(request, timeout=_timeout_seconds()) as response:
            for raw_line in response:
                line = raw_line.decode(errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    completed = True
                    continue
                if not data:
                    continue
                event = json.loads(data)
                if not isinstance(event, dict):
                    continue
                if isinstance(event.get("usage"), dict):
                    usage.update(event["usage"])
                if event.get("finish_reason"):
                    usage["finish_reason"] = event["finish_reason"]
                if "truncated" in event:
                    usage["truncated"] = bool(event["truncated"])
                delta = event.get("delta")
                if isinstance(delta, str) and delta:
                    visible_characters += len(delta)
                    if first_token_ms is None:
                        first_token_ms = (time.perf_counter() - started) * 1000
            elapsed_ms = (time.perf_counter() - started) * 1000
            return {
                "status": int(response.status), "latency_ms": elapsed_ms,
                "first_token_ms": first_token_ms,
                "usage": usage, "visible_characters": visible_characters,
                "completed": completed,
            }
    except urllib.error.HTTPError as error:
        return {
            "status": int(error.code), "latency_ms": (time.perf_counter() - started) * 1000,
            "first_token_ms": first_token_ms, "usage": usage,
            "visible_characters": visible_characters, "completed": False,
        }
    except Exception:
        return {
            "status": 0, "latency_ms": (time.perf_counter() - started) * 1000,
            "first_token_ms": first_token_ms, "usage": usage,
            "visible_characters": visible_characters, "completed": False,
        }


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) * percentile + 0.9999) - 1)))
    return ordered[index]


def _format_ms(value: float | None) -> str:
    return "unavailable" if value is None else f"{value:.2f}"


def _workload_prompt(target_tokens: int) -> str:
    return (
        f"Write a useful, self-contained educational answer in approximately {target_tokens} output tokens. "
        "Use clear paragraphs and include concrete details. Do not mention this instruction."
    )


def _run_workload(token: str, name: str, target_tokens: int, warmup: int, iterations: int) -> dict[str, object]:
    prompt = _workload_prompt(target_tokens)
    for _ in range(max(0, warmup)):
        _stream_generation(token, prompt, target_tokens)
        _request("/v1/embed", token, {"texts": ["benchmark embedding"], "modes": ["query"]})
    rows: list[dict[str, object]] = []
    for index in range(max(1, iterations)):
        e5_ms, e5_status, e5_body = _request(
            "/v1/embed", token,
            {"texts": ["benchmark embedding"], "modes": ["query"]},
        )
        generation = _stream_generation(token, prompt, target_tokens)
        usage = generation.get("usage") if isinstance(generation.get("usage"), dict) else {}
        output_tokens = int(usage.get("output_tokens") or 0)
        row = {
            "index": index + 1,
            "output_tokens": output_tokens,
            "generation_latency_ms": float(generation["latency_ms"]),
            "total_request_latency_ms": e5_ms + float(generation["latency_ms"]),
            "first_token_ms": generation.get("first_token_ms"),
            "prompt_processing_ms": usage.get("prompt_processing_ms"),
            "e5_latency_ms": e5_ms,
            "e5_status": e5_status,
            "e5_dimensions": e5_body.get("dimensions"),
            "generation_status": generation.get("status"),
            "completed": generation.get("completed") is True,
        }
        rows.append(row)
        print(
            f"{name.lower()}_iteration={index + 1} output_tokens={output_tokens} "
            f"generation_latency_ms={float(row['generation_latency_ms']):.2f} "
            f"total_request_latency_ms={float(row['total_request_latency_ms']):.2f} "
            f"first_token_latency_ms={_format_ms(row['first_token_ms'])} "
            f"prompt_processing_ms={row['prompt_processing_ms'] if row['prompt_processing_ms'] is not None else 'unavailable'} "
            f"e5_latency_ms={e5_ms:.2f}"
        )
    generations = [float(row["generation_latency_ms"]) for row in rows]
    first_tokens = [float(row["first_token_ms"]) for row in rows if row["first_token_ms"] is not None]
    e5_latencies = [float(row["e5_latency_ms"]) for row in rows]
    return {
        "name": name, "target_tokens": target_tokens, "rows": rows,
        "p50_generation_ms": _percentile(generations, 0.50),
        "p95_generation_ms": _percentile(generations, 0.95),
        "p50_total_request_ms": _percentile(
            [float(row["total_request_latency_ms"]) for row in rows], 0.50,
        ),
        "p95_total_request_ms": _percentile(
            [float(row["total_request_latency_ms"]) for row in rows], 0.95,
        ),
        "p50_first_token_ms": _percentile(first_tokens, 0.50),
        "p95_first_token_ms": _percentile(first_tokens, 0.95),
        "p50_e5_ms": _percentile(e5_latencies, 0.50),
        "p95_e5_ms": _percentile(e5_latencies, 0.95),
    }


def _load_request(token: str, max_output_tokens: int) -> dict[str, object]:
    return _stream_generation(
        token,
        "Write a useful answer with concrete detail. Do not mention this benchmark.",
        max_output_tokens,
    )


def _load_level(token: str, concurrency: int, queue_capacity: int) -> dict[str, object]:
    stop = threading.Event()
    samples: list[dict[str, object]] = []

    def poll_health() -> None:
        while not stop.is_set():
            try:
                _latency, status, body = _request("/health", token)
                if status == 200:
                    samples.append(body)
            except Exception:
                pass
            stop.wait(0.05)

    poller = threading.Thread(target=poll_health, daemon=True)
    poller.start()
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        rows = list(executor.map(lambda _item: _load_request(token, 256), range(concurrency)))
    elapsed_ms = (time.perf_counter() - started) * 1000
    stop.set()
    poller.join(timeout=2)
    active_samples = [int(row.get("active_generations") or 0) for row in samples]
    waiting_samples = [int(row.get("waiting_generations") or 0) for row in samples]
    busy = sum(1 for row in rows if int(row.get("status") or 0) == 429)
    return {
        "concurrency": concurrency,
        "elapsed_ms": elapsed_ms,
        "successes": sum(1 for row in rows if int(row.get("status") or 0) == 200 and row.get("completed") is True),
        "busy_429": busy,
        "max_active_observed": max(active_samples, default=0),
        "max_waiting_observed": max(waiting_samples, default=0),
        "queue_capacity": queue_capacity,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Warm Swico Free capacity benchmark")
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--load", action="store_true", help="also run bounded 1/2/5/10/11 concurrency checks")
    parser.add_argument("--load-only", action="store_true")
    args = parser.parse_args(argv)
    load_dotenv(NODE_ROOT / ".env")
    try:
        token = _token()
        health_ms, health_status, health = _request("/health", token)
        if health_status != 200 or health.get("ready") is not True:
            print("FAIL benchmark health")
            return 1
        embed_ms, embed_status, embed = _request(
            "/v1/embed", token,
            {"texts": ["benchmark embedding"], "modes": ["query"]},
        )
        if embed_status != 200 or embed.get("dimensions") != 384:
            print("FAIL benchmark embedding")
            return 1
        print(f"model_startup_ms={health.get('model_startup_ms', 'unavailable')}")
        print(f"qwen_startup_ms={health.get('qwen_startup_ms', 'unavailable')}")
        print(f"e5_startup_ms={health.get('e5_startup_ms', 'unavailable')}")
        print(f"health_latency_ms={health_ms:.2f}")
        print(f"warmup_iterations={max(0, args.warmup)}")
        print(f"benchmark_iterations={max(1, args.iterations)}")
        results: dict[str, dict[str, object]] = {}
        if not args.load_only:
            for name, target in (("SHORT", 64), ("NORMAL", 128), ("LONG", 256)):
                result = _run_workload(token, name, target, args.warmup, args.iterations)
                results[name] = result
                for metric in (
                    "p50_generation_ms", "p95_generation_ms", "p50_first_token_ms",
                    "p95_first_token_ms", "p50_e5_ms", "p95_e5_ms",
                    "p50_total_request_ms", "p95_total_request_ms",
                ):
                    print(f"{name.lower()}_{metric}={_format_ms(result[metric])}")
        if args.load or args.load_only:
            queue_capacity = int(health.get("generation_queue_capacity") or health.get("max_queue_size") or 0)
            generation_capacity = int(health.get("generation_capacity") or 1)
            print("load_test=benchmark_derived")
            load_results = []
            for concurrency in (1, 2, 5, 10, 11, 12):
                result = _load_level(token, concurrency, queue_capacity)
                load_results.append(result)
                print(
                    f"load_concurrency={concurrency} successes={result['successes']} "
                    f"busy_429={result['busy_429']} max_active_observed={result['max_active_observed']} "
                    f"max_waiting_observed={result['max_waiting_observed']} elapsed_ms={float(result['elapsed_ms']):.2f}"
                )
            limit_check = all(int(row["max_active_observed"]) <= generation_capacity for row in load_results)
            queue_check = all(int(row["max_waiting_observed"]) <= queue_capacity for row in load_results)
            overflow = next(
                row for row in load_results
                if row["concurrency"] == generation_capacity + queue_capacity + 1
            )
            busy_check = int(overflow["busy_429"]) >= 1
            print(f"load_capacity_check={'PASS' if limit_check and queue_check and busy_check else 'FAIL'}")
        if "NORMAL" in results:
            normal_p95 = float(results["NORMAL"]["p95_generation_ms"] or 0)
            long_p95 = float(results["LONG"]["p95_generation_ms"] or 0)
            normal_rpm = 60_000 / normal_p95 if normal_p95 > 0 else 0
            long_rpm = 60_000 / long_p95 if long_p95 > 0 else 0
            queue_capacity = int(health.get("generation_queue_capacity") or health.get("max_queue_size") or 0)
            print("capacity_statistics=benchmark_derived_estimates_only")
            print(f"normal_requests_per_minute_single_worker={normal_rpm:.2f}")
            print(f"long_requests_per_minute_single_worker={long_rpm:.2f}")
            print(f"recommended_max_queue_size={queue_capacity}")
            print(f"estimated_time_for_last_request_in_full_queue_ms={(queue_capacity + 1) * normal_p95:.2f}")
            print("registered_user_capacity=not_estimated")
        print(f"e5_probe_latency_ms={embed_ms:.2f}")
        print("PASS benchmark")
        return 0
    except Exception:
        print("FAIL benchmark request")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
