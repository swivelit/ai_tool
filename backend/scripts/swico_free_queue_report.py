"""Print safe operational counters for the durable Swico Free queue."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlmodel import Session

from app.database import engine
from app.web_api.swico_free_queue import (
    durable_queue_enabled,
    queue_diagnostics,
    queue_worker_enabled,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Show safe Swico Free queue metrics")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--watch-seconds", type=float, default=None, metavar="SECONDS")
    args = parser.parse_args()
    if args.watch_seconds is not None and args.watch_seconds <= 0:
        parser.error("--watch-seconds must be greater than zero")

    def report() -> dict[str, object]:
        with Session(engine) as session:
            metrics = queue_diagnostics(session)
        live = live_runtime_status()
        return {
            "queue_enabled": durable_queue_enabled(),
            "worker_enabled": queue_worker_enabled(),
            "worker_running": live["worker_running"] if live else None,
            "worker_running_observation": (
                "live_process" if live else "live_process_unavailable"
            ),
            "configured_poll_seconds": float(os.getenv("SWICO_FREE_QUEUE_POLL_SECONDS", "0.25")),
            **metrics,
        }

    try:
        while True:
            print(json.dumps(report(), indent=2 if args.pretty else None, sort_keys=True), flush=True)
            if args.watch_seconds is None:
                break
            time.sleep(max(0.1, float(args.watch_seconds)))
    except KeyboardInterrupt:
        return 0
    return 0


def live_runtime_status() -> dict[str, object] | None:
    """Read only the safe local runtime payload; failures are non-fatal."""
    try:
        port = int(os.getenv("PORT", "10000"))
        if not 1 <= port <= 65535:
            return None
        request = Request(
            f"http://127.0.0.1:{port}/internal/swico-free-queue-runtime",
            headers={"Accept": "application/json"},
            method="GET",
        )
        with urlopen(request, timeout=0.5) as response:
            if int(getattr(response, "status", 200)) != 200:
                return None
            value = json.loads(response.read(4096).decode("utf-8"))
        if not isinstance(value, dict) or not isinstance(value.get("worker_running"), bool):
            return None
        return {"worker_running": value["worker_running"]}
    except (OSError, URLError, ValueError, TypeError, json.JSONDecodeError):
        return None


if __name__ == "__main__":
    sys.exit(main())
