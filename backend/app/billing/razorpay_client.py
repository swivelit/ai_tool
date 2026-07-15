from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any

import requests

from .errors import PaymentValidationError


class RazorpayClient:
    base_url = "https://api.razorpay.com/v1"

    def __init__(self, key_id: str | None = None, key_secret: str | None = None) -> None:
        self.key_id = (key_id if key_id is not None else os.getenv("RAZORPAY_KEY_ID", "")).strip()
        self.key_secret = (key_secret if key_secret is not None else os.getenv("RAZORPAY_KEY_SECRET", "")).strip()
        if not self.key_id or not self.key_secret:
            raise PaymentValidationError("Razorpay is not configured.")

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        response = requests.request(
            method, f"{self.base_url}{path}", auth=(self.key_id, self.key_secret), timeout=15, **kwargs
        )
        if response.status_code >= 400:
            raise PaymentValidationError(f"Razorpay request failed with status {response.status_code}.")
        payload = response.json()
        if not isinstance(payload, dict):
            raise PaymentValidationError("Razorpay returned an invalid response.")
        return payload

    def create_order(self, amount_paise: int, receipt: str) -> dict[str, Any]:
        return self._request("POST", "/orders", json={"amount": int(amount_paise), "currency": "INR", "receipt": receipt})

    def fetch_payment(self, payment_id: str) -> dict[str, Any]:
        return self._request("GET", f"/payments/{payment_id}")


def verify_checkout_signature(provider_order_id: str, payment_id: str, signature: str, secret: str | None = None) -> bool:
    key = (secret if secret is not None else os.getenv("RAZORPAY_KEY_SECRET", "")).encode()
    expected = hmac.new(key, f"{provider_order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return bool(key) and hmac.compare_digest(expected, str(signature or ""))


def verify_webhook_signature(raw_body: bytes, signature: str, secret: str | None = None) -> bool:
    key = (secret if secret is not None else os.getenv("RAZORPAY_WEBHOOK_SECRET", "")).encode()
    expected = hmac.new(key, raw_body, hashlib.sha256).hexdigest()
    return bool(key) and hmac.compare_digest(expected, str(signature or ""))

