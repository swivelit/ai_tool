from __future__ import annotations


class BillingError(RuntimeError):
    """Base class for safe, user-facing billing failures."""


class InsufficientCreditError(BillingError):
    def __init__(self, available_micros: int, estimated_required_micros: int) -> None:
        super().__init__("Add AI credit to continue.")
        self.available_micros = max(0, int(available_micros))
        self.estimated_required_micros = max(0, int(estimated_required_micros))


class PaymentValidationError(BillingError):
    pass


class RateLimitError(BillingError):
    pass
