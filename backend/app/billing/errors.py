from __future__ import annotations


class BillingError(RuntimeError):
    """Base class for safe, user-facing billing failures."""


class InsufficientCreditError(BillingError):
    def __init__(self, available_micros: int, estimated_required_micros: int) -> None:
        super().__init__("Add AI credit to continue.")
        self.available_micros = max(0, int(available_micros))
        self.estimated_required_micros = max(0, int(estimated_required_micros))


class SubscriptionWeeklyLimitError(BillingError):
    """The active subscription window cannot fund the complete request."""

    def __init__(
        self, *, credit_bucket: str, remaining_micros: int, reset_at: str,
        payg_available_micros: int, payg_fallback_enabled: bool,
    ) -> None:
        super().__init__("This subscription's weekly allowance has been reached.")
        self.credit_bucket = credit_bucket
        self.remaining_micros = max(0, int(remaining_micros))
        self.reset_at = reset_at
        self.payg_available_micros = max(0, int(payg_available_micros))
        self.payg_fallback_enabled = bool(payg_fallback_enabled)


class UsageLimitReachedError(BillingError):
    def __init__(
        self, *, current_usage_micros: int, configured_limit_micros: int,
        remaining_micros: int, reset_at: str,
    ) -> None:
        super().__init__("Your monthly AI usage limit has been reached.")
        self.current_usage_micros = max(0, int(current_usage_micros))
        self.configured_limit_micros = max(0, int(configured_limit_micros))
        self.remaining_micros = max(0, int(remaining_micros))
        self.reset_at = reset_at


class PaymentValidationError(BillingError):
    pass


class PaymentProviderUnavailableError(BillingError):
    """An idempotent provider read remained unavailable after safe retries."""

    pass


class RateLimitError(BillingError):
    pass
