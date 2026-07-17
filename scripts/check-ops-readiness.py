#!/usr/bin/env python3
"""Validate a local-only operational ownership file without printing values."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
from typing import Any


REQUIRED_FIELDS = (
    "primary_on_call",
    "backup_on_call",
    "incident_commander",
    "checkout_disable_owner",
    "refund_owner",
    "ledger_adjustment_approvers",
    "customer_communications_owner",
    "razorpay_owner",
    "render_database_owner",
    "incident_channel",
    "backup_contact_method",
    "acknowledgement_target_minutes",
    "customer_update_target_minutes",
    "evidence_location",
    "last_access_tested_at",
    "last_drill_completed_at",
)
TIMESTAMP_FIELDS = ("last_access_tested_at", "last_drill_completed_at")
TARGET_FIELDS = ("acknowledgement_target_minutes", "customer_update_target_minutes")
STRING_FIELDS = tuple(
    field for field in REQUIRED_FIELDS
    if field not in TARGET_FIELDS and field not in TIMESTAMP_FIELDS and field != "ledger_adjustment_approvers"
)


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, list):
        return not value or any(_blank(item) for item in value)
    return False


def _identity(value: Any) -> str:
    return value.strip().casefold() if isinstance(value, str) else ""


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def readiness_findings(data: Any) -> tuple[list[str], list[str]]:
    if not isinstance(data, dict):
        return [], ["file"]
    missing = sorted(field for field in REQUIRED_FIELDS if field not in data or _blank(data[field]))
    invalid: set[str] = set()

    for field in STRING_FIELDS:
        if field not in missing and not isinstance(data.get(field), str):
            invalid.add(field)

    primary = _identity(data.get("primary_on_call"))
    backup = _identity(data.get("backup_on_call"))
    if primary and backup and primary == backup:
        invalid.update(("primary_on_call", "backup_on_call"))

    approvers = data.get("ledger_adjustment_approvers")
    if isinstance(approvers, list):
        distinct = {_identity(value) for value in approvers if _identity(value)}
        if len(distinct) < 2:
            invalid.add("ledger_adjustment_approvers")
    elif "ledger_adjustment_approvers" not in missing:
        invalid.add("ledger_adjustment_approvers")

    for field in TARGET_FIELDS:
        value = data.get(field)
        if field not in missing and (isinstance(value, bool) or not isinstance(value, int) or value <= 0):
            invalid.add(field)
    for field in TIMESTAMP_FIELDS:
        if field not in missing and not _valid_timestamp(data.get(field)):
            invalid.add(field)

    return missing, sorted(invalid)


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate local operational ownership readiness.")
    parser.add_argument("--file", required=True, type=Path)
    args = parser.parse_args()
    try:
        data = json.loads(args.file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        print("invalid: file")
        return 2

    missing, invalid = readiness_findings(data)
    for field in missing:
        print(f"missing: {field}")
    for field in invalid:
        print(f"invalid: {field}")
    if missing or invalid:
        return 1
    print("operational readiness check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
