from __future__ import annotations

import logging

import pytest
import requests

from app.billing.errors import PaymentProviderUnavailableError, PaymentValidationError
from app.billing.razorpay_client import RazorpayClient


class _Response:
    def __init__(self, status: int, payload: dict | None = None, headers: dict | None = None):
        self.status_code = status
        self._payload = payload if payload is not None else {"ok": True}
        self.headers = headers or {}

    def json(self):
        return self._payload


def _client(sleeps: list[float] | None = None) -> RazorpayClient:
    target = sleeps if sleeps is not None else []
    return RazorpayClient(
        "rzp_test_safe", "unit-secret", sleep=target.append,
        random_uniform=lambda _start, _end: 0,
    )


def test_get_succeeds_first_attempt(monkeypatch):
    calls = []
    monkeypatch.setattr(requests, "request", lambda *args, **kwargs: calls.append((args, kwargs)) or _Response(200))
    assert _client().fetch_payment("pay_safe") == {"ok": True}
    assert len(calls) == 1 and calls[0][1]["timeout"] == 15


def test_get_503_then_success_and_timeout_then_success(monkeypatch):
    sleeps: list[float] = []
    outcomes = iter([_Response(503), _Response(200, {"recovered": True})])
    monkeypatch.setattr(requests, "request", lambda *args, **kwargs: next(outcomes))
    assert _client(sleeps).fetch_order_payments("order_safe") == {"recovered": True}
    assert sleeps == [0.5]

    sleeps.clear()
    outcomes2 = iter([requests.ReadTimeout("bounded timeout"), _Response(200)])
    def request(*args, **kwargs):
        value = next(outcomes2)
        if isinstance(value, BaseException):
            raise value
        return value
    monkeypatch.setattr(requests, "request", request)
    assert _client(sleeps).fetch_payment_refunds("pay_safe") == {"ok": True}
    assert sleeps == [0.5]


def test_429_honors_bounded_retry_after(monkeypatch):
    sleeps: list[float] = []
    outcomes = iter([_Response(429, headers={"Retry-After": "2"}), _Response(200)])
    monkeypatch.setattr(requests, "request", lambda *args, **kwargs: next(outcomes))
    assert _client(sleeps).fetch_payment("pay_safe") == {"ok": True}
    assert sleeps == [2.0]


def test_retries_stop_at_max_and_raise_distinct_unavailable(monkeypatch, caplog):
    monkeypatch.setenv("RAZORPAY_READ_RETRY_ATTEMPTS", "3")
    sleeps: list[float] = []
    calls = 0
    def request(*args, **kwargs):
        nonlocal calls
        calls += 1
        return _Response(503)
    monkeypatch.setattr(requests, "request", request)
    with caplog.at_level(logging.WARNING), pytest.raises(PaymentProviderUnavailableError):
        _client(sleeps).fetch_payment("pay_safe")
    assert calls == 3 and sleeps == [0.5, 1.0]
    rendered = caplog.text
    assert "unit-secret" not in rendered and "rzp_test_safe" not in rendered


def test_401_is_not_retried_and_post_order_is_never_blindly_retried(monkeypatch):
    calls = 0
    def unauthorized(*args, **kwargs):
        nonlocal calls
        calls += 1
        return _Response(401)
    monkeypatch.setattr(requests, "request", unauthorized)
    with pytest.raises(PaymentValidationError):
        _client().fetch_payment("pay_safe")
    assert calls == 1

    calls = 0
    monkeypatch.setattr(requests, "request", lambda *args, **kwargs: unauthorized(*args, **kwargs))
    with pytest.raises(PaymentValidationError):
        _client().create_order(1000, "receipt-safe")
    assert calls == 1


def test_post_connection_failure_is_not_retried(monkeypatch):
    calls = 0
    def unavailable(*args, **kwargs):
        nonlocal calls
        calls += 1
        raise requests.ConnectTimeout("no provider")
    monkeypatch.setattr(requests, "request", unavailable)
    with pytest.raises(PaymentValidationError):
        _client().create_order(1000, "receipt-safe")
    assert calls == 1

