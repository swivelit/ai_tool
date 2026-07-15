from __future__ import annotations

from pydantic import BaseModel, Field


class CreateOrderRequest(BaseModel):
    gross_amount_paise: int = Field(gt=0)
    idempotency_key: str = Field(min_length=8, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")


class VerifyPaymentRequest(BaseModel):
    internal_order_id: str = Field(min_length=36, max_length=36)
    razorpay_order_id: str = Field(min_length=4, max_length=80)
    razorpay_payment_id: str = Field(min_length=4, max_length=80)
    razorpay_signature: str = Field(min_length=32, max_length=256)

