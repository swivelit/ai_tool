from email.message import Message
import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check-web-security-headers.py"
SPEC = importlib.util.spec_from_file_location("check_web_security_headers", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _safe_headers() -> Message:
    headers = Message()
    headers["Content-Security-Policy"] = "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    headers["X-Content-Type-Options"] = "nosniff"
    headers["X-Frame-Options"] = "DENY"
    headers["Permissions-Policy"] = "camera=(), geolocation=(), microphone=(self)"
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return headers


def test_safe_headers_pass_without_network():
    assert MODULE.unsafe_headers(_safe_headers()) == []


def test_missing_or_unsafe_headers_fail_without_network():
    headers = _safe_headers()
    del headers["X-Frame-Options"]
    headers.replace_header("Strict-Transport-Security", "max-age=60")
    failures = MODULE.unsafe_headers(headers)
    assert "X-Frame-Options" in failures
    assert any("max-age" in item for item in failures)


def test_img_src_must_explicitly_permit_blob_previews():
    headers = _safe_headers()
    headers.replace_header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
    failures = MODULE.unsafe_headers(headers)
    assert any("img-src" in item and "blob" in item for item in failures)
