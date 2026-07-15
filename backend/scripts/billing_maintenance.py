from __future__ import annotations

import argparse
import json
import os

from app.billing.razorpay_client import RazorpayClient
from app.billing.reconciliation import reconcile_razorpay_orders
from app.billing.service import recover_stale_usage_reservations
from app.database import SessionLocal


def main() -> None:
    parser = argparse.ArgumentParser(description="Internal Swico billing maintenance")
    sub = parser.add_subparsers(dest="command", required=True)
    stale = sub.add_parser("stale-reservations")
    stale.add_argument("--age-seconds", type=int, default=int(os.getenv("BILLING_STALE_RESERVATION_AGE_SECONDS", "1800")))
    razorpay = sub.add_parser("razorpay")
    razorpay.add_argument("--age-seconds", type=int, default=900)
    razorpay.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    with SessionLocal() as session:
        if args.command == "stale-reservations":
            recovered = recover_stale_usage_reservations(session, age_seconds=args.age_seconds)
            session.commit()
            print(json.dumps({"recovered_count": len(recovered), "request_ids": recovered}))
        else:
            results = reconcile_razorpay_orders(
                session, client=RazorpayClient(), age_seconds=args.age_seconds, apply=args.apply,
            )
            print(json.dumps({"apply": args.apply, "results": results}, default=str))


if __name__ == "__main__":
    main()
