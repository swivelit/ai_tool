from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.database import SessionLocal  # noqa: E402
from app.web_ai.rollout_metrics import (  # noqa: E402
    RolloutReportConfigurationError,
    RolloutReportSettings,
    build_rollout_report,
)


def render_report_json(report: dict[str, object], *, pretty: bool) -> str:
    return json.dumps(
        report,
        sort_keys=True,
        separators=None if pretty else (",", ":"),
        indent=2 if pretty else None,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Print a content-free TRIAG rollout acceptance report."
    )
    parser.add_argument("--window-hours", type=int)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        settings = RolloutReportSettings.from_environ()
        window_hours = (
            settings.default_window_hours
            if args.window_hours is None else int(args.window_hours)
        )
        with SessionLocal() as session:
            report = build_rollout_report(
                session,
                window_hours=window_hours,
                settings=settings,
            )
    except RolloutReportConfigurationError as exc:
        print(str(exc), file=sys.stderr)
        return 78
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception:
        print("rollout_report_failed", file=sys.stderr)
        return 1
    print(render_report_json(report, pretty=bool(args.pretty)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
