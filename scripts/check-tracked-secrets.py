#!/usr/bin/env python3
"""Fail on high-confidence secrets in Git-tracked files without printing values."""

from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
PATTERNS = (
    ("Razorpay Live key", re.compile(r"rzp_live_[A-Za-z0-9]{8,}")),
    ("Razorpay Test key", re.compile(r"rzp_test_[A-Za-z0-9]{12,}")),
    ("OpenAI secret key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}")),
    ("private key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("JWT or Firebase token", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("passworded database URL", re.compile(r"\bpostgres(?:ql)?(?:\+[A-Za-z0-9_]+)?://([^\s/:]+):([^\s@]+)@")),
)
FORBIDDEN_WEB_NAMES = re.compile(
    r"\b(?:OPENAI_API_KEY|SARVAM_API_KEY|RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|DATABASE_URL|"
    r"GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_CREDENTIALS_JSON|EMAIL_PASS)\b"
)
PLACEHOLDERS = {"password", "pass", "your_password", "db_password", "example", "placeholder"}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True,
    )
    return [ROOT / item.decode() for item in result.stdout.split(b"\0") if item]


def scan() -> list[tuple[str, int, str]]:
    findings: list[tuple[str, int, str]] = []
    for path in tracked_files():
        try:
            raw = path.read_bytes()
            if b"\0" in raw:
                continue
            text = raw.decode("utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        relative = path.relative_to(ROOT).as_posix()
        for line_number, line in enumerate(text.splitlines(), start=1):
            if relative.startswith("web/") and FORBIDDEN_WEB_NAMES.search(line):
                findings.append((relative, line_number, "backend-only variable referenced by frontend"))
            for category, pattern in PATTERNS:
                match = pattern.search(line)
                if not match:
                    continue
                if category == "passworded database URL" and match.group(2).strip("<>[]{}$()").lower() in PLACEHOLDERS:
                    continue
                findings.append((relative, line_number, category))
    return sorted(set(findings))


def main() -> int:
    findings = scan()
    if findings:
        for path, line, category in findings:
            print(f"{path}:{line}: {category}")
        print(f"tracked-secret scan failed: {len(findings)} finding(s)")
        return 1
    print("tracked-secret scan passed: no high-confidence secrets or frontend secret references")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
