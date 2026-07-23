from __future__ import annotations

import os


DEFAULT_TOPUP_PACKAGES_PAISE = (1500, 29900)
_TRUE = {"1", "true", "yes", "on"}


def topup_packages() -> list[int]:
    raw = os.getenv(
        "BILLING_TOPUP_PACKAGES_PAISE",
        ",".join(str(value) for value in DEFAULT_TOPUP_PACKAGES_PAISE),
    )
    packages: list[int] = []
    for item in raw.split(","):
        try:
            value = int(item.strip())
        except ValueError:
            continue
        if value > 0 and value not in packages:
            packages.append(value)
    return packages


def topup_bounds() -> tuple[int, int]:
    return (
        int(os.getenv("BILLING_MIN_TOPUP_PAISE", "1500")),
        int(os.getenv("BILLING_MAX_TOPUP_PAISE", "50000")),
    )


def enforce_topup_packages() -> bool:
    return os.getenv("BILLING_ENFORCE_TOPUP_PACKAGES", "false").strip().lower() in _TRUE


def custom_topup_enabled() -> bool:
    return not enforce_topup_packages()


def validate_topup_amount(gross_amount_paise: int) -> int:
    amount = int(gross_amount_paise)
    minimum, maximum = topup_bounds()
    if amount % 100 != 0:
        raise ValueError("Top-up amount must use whole Indian Rupees.")
    if amount < minimum or amount > maximum:
        raise ValueError(f"Top-up must be between {minimum} and {maximum} paise.")
    if enforce_topup_packages() and amount not in topup_packages():
        raise ValueError("Select an available top-up package.")
    return amount
