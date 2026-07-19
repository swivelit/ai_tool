from __future__ import annotations

import hashlib
import hmac
import logging
import os
import random
import time
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from typing import Any

import requests

from .errors import PaymentProviderUnavailableError, PaymentValidationError


logger = logging.getLogger(__name__)
_RETRYABLE_STATUSES = {408, 429, 500, 502, 503, 504}


class RazorpayClient:
    base_url = "https://api.razorpay.com/v1"

    def __init__(
        self, key_id: str | None = None, key_secret: str | None = None,
        *, sleep: Any = time.sleep, random_uniform: Any = random.uniform,
    ) -> None:
        self.key_id = (key_id if key_id is not None else os.getenv("RAZORPAY_KEY_ID", "")).strip()
        self.key_secret = (key_secret if key_secret is not None else os.getenv("RAZORPAY_KEY_SECRET", "")).strip()
        if not self.key_id or not self.key_secret:
            raise PaymentValidationError("Razorpay is not configured.")
        self._sleep = sleep
        self._random_uniform = random_uniform

    @staticmethod
    def _positive_int(name: str, default: int) -> int:
        try:
            return max(1, int(str(os.getenv(name, str(default))).strip()))
        except ValueError:
            return default

    @staticmethod
    def _positive_float(name: str, default: float) -> float:
        try:
            return max(0.001, float(str(os.getenv(name, str(default))).strip()))
        except ValueError:
            return default

    @staticmethod
    def _retry_after_seconds(value: str | None) -> float | None:
        if not value:
            return None
        try:
            return max(0.0, float(value.strip()))
        except ValueError:
            try:
                parsed = parsedate_to_datetime(value)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return max(0.0, (parsed - datetime.now(timezone.utc)).total_seconds())
            except (TypeError, ValueError, OverflowError):
                return None

    def _retry_delay(self, attempt: int, retry_after: str | None) -> float:
        base_ms = self._positive_int("RAZORPAY_READ_RETRY_BASE_MS", 500)
        max_ms = self._positive_int("RAZORPAY_READ_RETRY_MAX_MS", 4000)
        exponential = min(max_ms, base_ms * (2 ** max(0, attempt - 1)))
        jittered = min(max_ms, exponential + self._random_uniform(0, exponential * 0.25))
        header_delay = self._retry_after_seconds(retry_after)
        return min(max_ms / 1000, max(jittered / 1000, header_delay or 0.0))

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        normalized_method = str(method).upper()
        attempts = self._positive_int("RAZORPAY_READ_RETRY_ATTEMPTS", 3) if normalized_method == "GET" else 1
        timeout = self._positive_float("RAZORPAY_HTTP_TIMEOUT_SECONDS", 15)
        response = None
        for attempt in range(1, attempts + 1):
            retry_after = None
            status = None
            try:
                response = requests.request(
                    normalized_method, f"{self.base_url}{path}",
                    auth=(self.key_id, self.key_secret), timeout=timeout, **kwargs,
                )
                status = int(response.status_code)
                retry_after = response.headers.get("Retry-After")
                if status < 400:
                    if attempt > 1:
                        logger.info("razorpay_read_recovered", extra={
                            "method": normalized_method, "attempt": attempt, "status": status,
                        })
                    break
                if normalized_method != "GET" or status not in _RETRYABLE_STATUSES:
                    raise PaymentValidationError(f"Razorpay request failed with status {status}.")
            except (requests.ConnectionError, requests.Timeout) as exc:
                if normalized_method != "GET":
                    raise PaymentValidationError("Razorpay request could not be completed.") from exc
                if attempt >= attempts:
                    logger.error("razorpay_read_unavailable", extra={
                        "method": normalized_method, "attempt": attempt, "status": None,
                        "exception_class": type(exc).__name__,
                    })
                    raise PaymentProviderUnavailableError(
                        "Razorpay is temporarily unavailable after safe read retries."
                    ) from exc
            if attempt >= attempts:
                logger.error("razorpay_read_unavailable", extra={
                    "method": normalized_method, "attempt": attempt, "status": status,
                    "exception_class": None,
                })
                raise PaymentProviderUnavailableError(
                    "Razorpay is temporarily unavailable after safe read retries."
                )
            delay = self._retry_delay(attempt, retry_after)
            logger.warning("razorpay_read_retry", extra={
                "method": normalized_method, "attempt": attempt, "status": status,
                "delay_ms": int(delay * 1000),
            })
            self._sleep(delay)
        if response is None:
            raise PaymentProviderUnavailableError("Razorpay is temporarily unavailable after safe read retries.")
        payload = response.json()
        if not isinstance(payload, dict):
            raise PaymentValidationError("Razorpay returned an invalid response.")
        return payload

    def create_order(self, amount_paise: int, receipt: str) -> dict[str, Any]:
        return self._request("POST", "/orders", json={"amount": int(amount_paise), "currency": "INR", "receipt": receipt})

    def fetch_payment(self, payment_id: str) -> dict[str, Any]:
        return self._request("GET", f"/payments/{payment_id}")

    def fetch_order_payments(self, order_id: str) -> dict[str, Any]:
        return self._request("GET", f"/orders/{order_id}/payments")

    def fetch_payment_refunds(self, payment_id: str) -> dict[str, Any]:
        return self._request("GET", f"/payments/{payment_id}/refunds")


def verify_checkout_signature(provider_order_id: str, payment_id: str, signature: str, secret: str | None = None) -> bool:
    key = (secret if secret is not None else os.getenv("RAZORPAY_KEY_SECRET", "")).encode()
    expected = hmac.new(key, f"{provider_order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return bool(key) and hmac.compare_digest(expected, str(signature or ""))


def verify_webhook_signature(raw_body: bytes, signature: str, secret: str | None = None) -> bool:
    key = (secret if secret is not None else os.getenv("RAZORPAY_WEBHOOK_SECRET", "")).encode()
    expected = hmac.new(key, raw_body, hashlib.sha256).hexdigest()
    return bool(key) and hmac.compare_digest(expected, str(signature or ""))
