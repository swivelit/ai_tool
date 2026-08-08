"""Print safe operational counters for the durable Swico Free queue."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlmodel import Session

from app.database import engine
from app.web_api.swico_free_queue import (
    durable_queue_enabled,
    queue_metrics,
    queue_worker_enabled,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Show safe Swico Free queue metrics")
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    with Session(engine) as session:
        metrics = queue_metrics(session)
    result = {
        "queue_enabled": durable_queue_enabled(),
        "worker_enabled": queue_worker_enabled(),
        # A separate CLI process cannot observe an in-process thread without
        # adding a heartbeat schema.  Keep this explicit rather than claiming
        # that an enabled worker is definitely alive.
        "worker_running": None,
        "worker_running_observation": "not_observable_from_cli_process",
        "configured_poll_seconds": float(os.getenv("SWICO_FREE_QUEUE_POLL_SECONDS", "0.25")),
        **metrics,
    }
    print(json.dumps(result, indent=2 if args.pretty else None, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
