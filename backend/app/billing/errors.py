from __future__ import annotations


class BillingError(RuntimeError):
    """Base class for safe, user-facing billing failures."""


class InsufficientCreditError(BillingError):
    def __init__(self, available_micros: int, estimated_required_micros: int) -> None:
        super().__init__("Add AI credit to continue.")
        self.available_micros = max(0, int(available_micros))
        self.estimated_required_micros = max(0, int(estimated_required_micros))


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
