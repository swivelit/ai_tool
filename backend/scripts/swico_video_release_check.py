"""Read-only, redacted video readiness. Does not contact customers/providers."""
from __future__ import annotations
import argparse
import json
import hashlib
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlmodel import select
from sqlalchemy import inspect
from app.database import SessionLocal, engine
from app.email_service import email_delivery_runtime_status
from app.video.config import settings, TEMPLATE_IDS
from app.video.models import VideoControl, VideoTemplate
from app.video.service import healthy,templates_current
from app.video.cache import cache
from app.video.policy import video_policy_ready


def check():
    checks = {}
    feature_configured_enabled = False
    paid_configured_enabled = False
    try:
        cfg=settings()
        feature_configured_enabled = bool(cfg.enabled)
        paid_configured_enabled = bool(cfg.paid)
        checks["configuration"]=True
        checks["current_legal_publication_approved"]=video_policy_ready()
        checks["feature_enabled"]=cfg.enabled
        checks["paid_checkout_enabled"]=cfg.paid
        checks["worker_token_digest_configured"]=bool(cfg.worker_digest)
        checks["schema"]=all(inspect(engine).has_table(t) for t in ("video_control","video_template","video_job","video_quota","video_outbox"))
        with SessionLocal() as session:
            row=session.get(VideoControl,1)
            checks["worker_current_native_calibration"]=bool(row and healthy(row))
            checks["two_templates_published"]=templates_current(session,row)
        checks["cache_headroom"]=cache().health()["available"]
        checks["smtp"]=email_delivery_runtime_status(require_otp_secret=False)["configured"]
        checks["razorpay_configured"]=bool(os.getenv("RAZORPAY_KEY_ID") and os.getenv("RAZORPAY_KEY_SECRET") and os.getenv("RAZORPAY_WEBHOOK_SECRET"))
    except Exception as exc:
        checks["error_class"]=type(exc).__name__
    required=("configuration","current_legal_publication_approved","worker_token_digest_configured","schema","worker_current_native_calibration","two_templates_published","cache_headroom","smtp","razorpay_configured")
    prerequisites_ready = all(checks.get(k) is True for k in required)
    blocking_checks = [key for key in required if checks.get(key) is not True]
    if paid_configured_enabled and not feature_configured_enabled:
        blocking_checks.append("paid_requires_feature_enabled")
    rollout_safe = (not feature_configured_enabled and not paid_configured_enabled) or (prerequisites_ready and feature_configured_enabled)
    if paid_configured_enabled and not feature_configured_enabled:
        release_state = "unsafe_paid_checkout_without_feature"
    elif (feature_configured_enabled or paid_configured_enabled) and not prerequisites_ready:
        release_state = "unsafe_enabled_missing_prerequisites"
    elif not prerequisites_ready:
        release_state = "disabled_pending_prerequisites"
    else:
        release_state = "ready_for_operator_release"
    return {"ready":prerequisites_ready,"prerequisites_ready":prerequisites_ready,
            "rollout_safe":rollout_safe,"feature_configured_enabled":feature_configured_enabled,
            "paid_configured_enabled":paid_configured_enabled,"release_state":release_state,
            "blocking_checks":list(dict.fromkeys(blocking_checks)),"checks":checks,
            "external_acceptance":"Operator must separately verify actual rights, per-template quality, provider test payments/refunds, SMTP and Valkey persistence policy"}


if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--pretty",action="store_true");args=parser.parse_args()
    result=check();print(json.dumps(result,indent=2 if args.pretty else None));sys.exit(0 if result["ready"] else 1)
