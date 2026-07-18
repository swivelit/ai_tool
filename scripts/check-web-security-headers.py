#!/usr/bin/env python3
"""Check security headers on an explicitly supplied deployed HTTPS URL."""

from __future__ import annotations

import argparse
import sys
from urllib.request import Request, urlopen
from urllib.parse import urlparse


REQUIRED = (
    "Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options",
    "X-Frame-Options", "Permissions-Policy", "Strict-Transport-Security",
)


def unsafe_headers(headers) -> list[str]:
    failures = [name for name in REQUIRED if not headers.get(name)]
    csp = str(headers.get("Content-Security-Policy") or "").lower()
    for directive in ("default-src", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'", "media-src 'self' blob:"):
        if directive not in csp:
            failures.append(f"Content-Security-Policy missing safe directive: {directive}")
    if str(headers.get("X-Content-Type-Options") or "").lower() != "nosniff":
        failures.append("X-Content-Type-Options must be nosniff")
    if str(headers.get("X-Frame-Options") or "").upper() not in {"DENY", "SAMEORIGIN"}:
        failures.append("X-Frame-Options must be DENY or SAMEORIGIN")
    referrer = str(headers.get("Referrer-Policy") or "").lower()
    if referrer in {"", "unsafe-url", "no-referrer-when-downgrade"}:
        failures.append("Referrer-Policy is absent or unsafe")
    permissions = str(headers.get("Permissions-Policy") or "").replace(" ", "").lower()
    for feature in ("camera=()", "geolocation=()", "microphone=(self)"):
        if feature not in permissions:
            failures.append(f"Permissions-Policy missing {feature}")
    hsts = str(headers.get("Strict-Transport-Security") or "").lower()
    if "max-age=" not in hsts or "includesubdomains" not in hsts:
        failures.append("Strict-Transport-Security must set max-age and includeSubDomains")
    else:
        try:
            age = int(next(part.split("=", 1)[1] for part in hsts.split(";") if part.strip().startswith("max-age=")))
            if age < 31_536_000:
                failures.append("Strict-Transport-Security max-age must be at least 31536000")
        except (StopIteration, ValueError):
            failures.append("Strict-Transport-Security max-age is invalid")
    return sorted(set(failures))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    args = parser.parse_args()
    parsed = urlparse(args.url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        print("header check requires a credential-free HTTPS URL", file=sys.stderr)
        return 2
    try:
        request = Request(args.url, method="HEAD", headers={"User-Agent": "SwicoLaunchHeaderCheck/1.0"})
        with urlopen(request, timeout=15) as response:
            failures = unsafe_headers(response.headers)
    except Exception as exc:
        print(f"security header check could not reach deployment: {type(exc).__name__}", file=sys.stderr)
        return 2
    if failures:
        for failure in failures:
            print(f"security header failure: {failure}")
        return 1
    print("deployed web security-header check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
