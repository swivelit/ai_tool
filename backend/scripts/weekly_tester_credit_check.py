#!/usr/bin/env python3
"""Content-free operator check for weekly tester-credit configuration."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import sys
from sqlalchemy import inspect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.billing.tester_credit import weekly_tester_config, weekly_window
from app.database import engine


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    errors: list[str] = []
    config = None
    try:
        config = weekly_tester_config()
    except Exception as exc:
        errors.append(str(exc))
    current = datetime.now(timezone.utc)
    start, end = weekly_window(current)
    table_available = False
    try:
        table_available = inspect(engine).has_table("weekly_tester_credit_window")
        if not table_available:
            errors.append("weekly_tester_credit_window migration is not available")
    except Exception:
        errors.append("database schema inspection failed")
    payload = {
        "ok": not errors,
        "enabled": bool(config.enabled) if config else False,
        "allowance_micros": int(config.allowance_micros) if config else 0,
        "configured_subject_count": len(config.emails) if config else 0,
        "database_table_available": table_available,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "errors": errors,
    }
    print(json.dumps(payload, indent=2 if args.pretty else None, sort_keys=True))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
