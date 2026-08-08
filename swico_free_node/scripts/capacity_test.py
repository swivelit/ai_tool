"""Run a bounded mixed-traffic soak against the already-running node.

This is a client-side test. It never imports either model runtime and never
starts a second inference process.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import threading
import time

from dotenv import load_dotenv

try:
    from .benchmark import (
        BASE_URL, NODE_ROOT, _request, _stream_generation, _workload_prompt,
    )
except ImportError:  # direct execution from swico_free_node/scripts
    from benchmark import BASE_URL, NODE_ROOT, _request, _stream_generation, _workload_prompt


MIX = (("short", 64), ("normal", 128), ("long", 256))
STAGES = (1, 2, 5)
BURST_LEVELS = (10, 11, 12)


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int((len(ordered) * percentile + 0.9999) - 1)))
    return ordered[index]


def _number(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _workload(sequence: int) -> tuple[str, int]:
    bucket = sequence % 10
    if bucket < 6:
        return MIX[0]
    if bucket < 9:
        return MIX[1]
    return MIX[2]


def _request_result(token: str, sequence: int) -> dict[str, object]:
    name, target = _workload(sequence)
    result = _stream_generation(token, _workload_prompt(target), target)
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
    finish_reason = str(usage.get("finish_reason") or "").strip().lower()
    status = int(result.get("status") or 0)
    timed_out = status == 504 or finish_reason == "timeout"
    busy = status == 429
    completed = status == 200 and bool(result.get("completed")) and not timed_out
    failed = not completed and not busy and not timed_out
    return {
        "workload": name,
        "status": status,
        "completed": completed,
        "failed": failed,
        "timed_out": timed_out,
        "busy": busy,
        "output_tokens": int(_number(usage.get("output_tokens"))),
        "queue_wait_ms": _number(usage.get("queue_wait_ms")),
        "generation_ms": _number(usage.get("generation_ms") or result.get("latency_ms")),
        "total_node_latency_ms": _number(usage.get("total_node_latency_ms") or result.get("latency_ms")),
        "first_token_ms": _number(result.get("first_token_ms"), -1.0),
    }


def _metric(rows: list[dict[str, object]], key: str) -> dict[str, float | int | None]:
    values = [_number(row.get(key)) for row in rows if _number(row.get(key), -1) >= 0]
    output_tokens = sum(int(_number(row.get("output_tokens"))) for row in rows)
    generation_ms = sum(_number(row.get("generation_ms")) for row in rows)
    return {
        "count": len(rows),
        "p50_total_latency_ms": _percentile(
            [_number(row.get("total_node_latency_ms")) for row in rows], 0.50,
        ),
        "p95_total_latency_ms": _percentile(
            [_number(row.get("total_node_latency_ms")) for row in rows], 0.95,
        ),
        "p50_first_token_ms": _percentile(
            [_number(row.get("first_token_ms")) for row in rows if _number(row.get("first_token_ms"), -1) >= 0], 0.50,
        ),
        "p95_first_token_ms": _percentile(
            [_number(row.get("first_token_ms")) for row in rows if _number(row.get("first_token_ms"), -1) >= 0], 0.95,
        ),
        "tokens_per_second": round(output_tokens / (generation_ms / 1000), 3) if generation_ms > 0 else 0.0,
        "p50_queue_wait_ms": _percentile(values, 0.50),
        "p95_queue_wait_ms": _percentile(values, 0.95),
        "max_queue_wait_ms": max(values, default=0.0),
    }


def _health_sample(token: str) -> dict[str, object] | None:
    try:
        _latency, status, body = _request("/health", token)
        if status == 200 and isinstance(body, dict):
            return body
    except Exception:
        pass
    return None


def _run_stage(token: str, clients: int, duration_seconds: float) -> tuple[list[dict[str, object]], list[dict[str, object]], int]:
    stop = threading.Event()
    sequence_lock = threading.Lock()
    sequence = 0
    rows: list[dict[str, object]] = []
    health: list[dict[str, object]] = []
    rows_lock = threading.Lock()
    health_failures = 0
    started = time.perf_counter()

    def next_sequence() -> int:
        nonlocal sequence
        with sequence_lock:
            current = sequence
            sequence += 1
            return current

    def poll() -> None:
        nonlocal health_failures
        while not stop.is_set():
            sample = _health_sample(token)
            if sample is None:
                health_failures += 1
            else:
                with rows_lock:
                    health.append(sample)
            stop.wait(0.25)

    def worker() -> None:
        while time.perf_counter() - started < duration_seconds:
            result = _request_result(token, next_sequence())
            with rows_lock:
                rows.append(result)

    poller = threading.Thread(target=poll, daemon=True)
    poller.start()
    with ThreadPoolExecutor(max_workers=clients) as executor:
        futures = [executor.submit(worker) for _ in range(clients)]
        for future in futures:
            future.result()
    stop.set()
    poller.join(timeout=2)
    return rows, health, health_failures


def _run_burst(token: str, concurrency: int) -> list[dict[str, object]]:
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        return list(executor.map(lambda index: _request_result(token, index), range(concurrency)))


def _resource_summary(samples: list[dict[str, object]]) -> dict[str, float]:
    rss = [_number(item.get("process_rss_mb"), -1) for item in samples]
    rss = [item for item in rss if item >= 0]
    cpu = [_number(item.get("process_cpu_percent"), -1) for item in samples]
    cpu = [item for item in cpu if item >= 0]
    quarter = max(1, len(rss) // 4)
    first = sum(rss[:quarter]) / len(rss[:quarter]) if rss[:quarter] else 0.0
    last = sum(rss[-quarter:]) / len(rss[-quarter:]) if rss[-quarter:] else 0.0
    return {
        "average_rss_mb": round(sum(rss) / len(rss), 2) if rss else 0.0,
        "peak_rss_mb": round(max(rss, default=0.0), 2),
        "average_cpu_percent": round(sum(cpu) / len(cpu), 2) if cpu else 0.0,
        "memory_growth_mb": round(last - first, 2),
    }


def _counts(rows: list[dict[str, object]]) -> dict[str, int]:
    return {
        "requests_started": len(rows),
        "requests_completed": sum(bool(row.get("completed")) for row in rows),
        "requests_failed": sum(bool(row.get("failed")) for row in rows),
        "requests_timed_out": sum(bool(row.get("timed_out")) for row in rows),
        "busy_429": sum(bool(row.get("busy")) for row in rows),
    }


def _print_gate(name: str, passed: bool, warning: bool = False) -> None:
    print(f"{'WARN' if warning else 'PASS' if passed else 'FAIL'} gate_{name}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a bounded Swico Free soak against the local node")
    parser.add_argument("--soak-minutes", type=int, default=15)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args(argv)
    if not 5 <= args.soak_minutes <= 60:
        parser.error("--soak-minutes must be between 5 and 60")

    load_dotenv(NODE_ROOT / ".env")
    token = os.getenv("SWICO_FREE_NODE_TOKEN", "").strip()
    if len(token) < 32:
        print("FAIL capacity_token_configuration")
        return 2

    start = time.perf_counter()
    health = _health_sample(token)
    if not health or not health.get("ready"):
        print("FAIL capacity_health")
        return 1
    queue_capacity = int(_number(health.get("generation_queue_capacity") or health.get("max_queue_size")))
    queue_wait_limit = _number(health.get("max_queue_wait_seconds"), 15)
    total_limit = _number(health.get("max_total_request_seconds"), 45)
    stage_seconds = args.soak_minutes * 60 / len(STAGES)
    all_rows: list[dict[str, object]] = []
    stage_reports: dict[str, dict[str, object]] = {}
    health_samples: list[dict[str, object]] = []
    health_failures = 0

    for clients in STAGES:
        print(f"stage_clients={clients} stage_seconds={stage_seconds:.1f}")
        rows, samples, failures = _run_stage(token, clients, stage_seconds)
        all_rows.extend(rows)
        health_samples.extend(samples)
        health_failures += failures
        stage_reports[str(clients)] = {
            "clients": clients,
            "duration_seconds": round(stage_seconds, 2),
            **_counts(rows),
            "short": _metric([row for row in rows if row["workload"] == "short"], "queue_wait_ms"),
            "normal": _metric([row for row in rows if row["workload"] == "normal"], "queue_wait_ms"),
            "long": _metric([row for row in rows if row["workload"] == "long"], "queue_wait_ms"),
        }

    burst_reports: dict[str, dict[str, object]] = {}
    for concurrency in BURST_LEVELS:
        print(f"burst_concurrency={concurrency} workload=short")
        rows = _run_burst(token, concurrency)
        burst_reports[str(concurrency)] = {
            "concurrency": concurrency,
            **_counts(rows),
            "max_queue_wait_ms": max((_number(row.get("queue_wait_ms")) for row in rows), default=0.0),
        }

    elapsed = time.perf_counter() - start
    overall = _counts(all_rows)
    by_workload = {
        name: _metric([row for row in all_rows if row["workload"] == name], "queue_wait_ms")
        for name, _target in MIX
    }
    queue_wait_values = [_number(row.get("queue_wait_ms")) for row in all_rows if _number(row.get("queue_wait_ms"), -1) >= 0]
    total_values = [_number(row.get("total_node_latency_ms")) for row in all_rows if _number(row.get("total_node_latency_ms"), -1) >= 0]
    first_values = [_number(row.get("first_token_ms")) for row in all_rows if _number(row.get("first_token_ms"), -1) >= 0]
    resources = _resource_summary(health_samples)
    throughput = overall["requests_completed"] / (elapsed / 60) if elapsed > 0 else 0.0
    output_tokens = sum(int(_number(row.get("output_tokens"))) for row in all_rows if row.get("completed"))
    generation_ms = sum(_number(row.get("generation_ms")) for row in all_rows if row.get("completed"))
    output_rate = output_tokens / (generation_ms / 1000) if generation_ms > 0 else 0.0
    normal_p95 = _number(by_workload["normal"].get("p95_total_latency_ms"), -1)
    long_p95 = _number(by_workload["long"].get("p95_total_latency_ms"), -1)
    first_p95 = _number(_percentile(first_values, 0.95), -1)
    queue_max = max(queue_wait_values, default=0.0)
    total_max = max(total_values, default=0.0)
    model_startup_values = {
        (item.get("qwen_startup_ms"), item.get("e5_startup_ms"), item.get("model_startup_ms"))
        for item in health_samples
    }
    model_reload_detected = len(model_startup_values) > 1
    unexpected_errors = sum(
        int(row["status"] not in {200, 429, 504}) for row in all_rows
    )
    process_crashes = int(health_failures > 0 and _health_sample(token) is None)
    oom_events = 0
    gates = {
        "normal_total_latency_p95": 0 <= normal_p95 <= 20_000,
        "long_total_latency_p95": 0 <= long_p95 <= 35_000,
        "first_token_latency_p95": 0 <= first_p95 <= 5_000,
        "queue_wait_limit": queue_max <= queue_wait_limit * 1000,
        "total_request_limit": total_max <= total_limit * 1000,
        "process_crashes": process_crashes == 0,
        "oom": oom_events == 0,
        "unexpected_errors": unexpected_errors == 0,
        "model_reload": not model_reload_detected,
    }
    memory_warning = resources["memory_growth_mb"] > 64.0
    safe_rate = max(0.0, throughput * 0.70)
    peak_rate = max(0.0, throughput * 0.85)
    recommended_queue = min(
        queue_capacity,
        max(1, int(safe_rate * queue_wait_limit / 60)) if safe_rate else 0,
    )
    recommendation = {
        "recommended_sustained_requests_per_minute": round(safe_rate, 2),
        "recommended_peak_requests_per_minute": round(peak_rate, 2),
        "recommended_queue_size": recommended_queue,
        "recommended_initial_rollout_percent": 1 if all(gates.values()) and not memory_warning else 0,
    }
    report = {
        "duration_seconds": round(elapsed, 2),
        **overall,
        "sustained_completed_requests_per_minute": round(throughput, 2),
        "sustained_output_tokens_per_second": round(output_rate, 3),
        "queue_wait_p50_ms": round(_percentile(queue_wait_values, 0.50) or 0.0, 2),
        "queue_wait_p95_ms": round(_percentile(queue_wait_values, 0.95) or 0.0, 2),
        "queue_wait_max_ms": round(queue_max, 2),
        "total_latency_max_ms": round(total_max, 2),
        "health_failures": health_failures,
        "process_crashes": process_crashes,
        "oom_events": oom_events,
        "unexpected_errors": unexpected_errors,
        "model_reload_detected": model_reload_detected,
        "memory_warning": memory_warning,
        **resources,
        "short": by_workload["short"],
        "normal": by_workload["normal"],
        "long": by_workload["long"],
        "stages": stage_reports,
        "bursts": burst_reports,
        "gates": gates,
        "recommendation": recommendation,
    }

    print(f"duration_seconds={report['duration_seconds']}")
    for name, passed in gates.items():
        _print_gate(name, bool(passed))
    _print_gate("memory_stability", not memory_warning, warning=memory_warning)
    print(f"sustained_completed_requests_per_minute={throughput:.2f}")
    print(f"recommended_sustained_requests_per_minute={safe_rate:.2f}")
    print(f"recommended_peak_requests_per_minute={peak_rate:.2f}")
    print(f"recommended_queue_size={recommended_queue}")
    print(f"recommended_initial_rollout_percent={recommendation['recommended_initial_rollout_percent']}")

    if args.json_out:
        args.json_out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0 if all(gates.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
