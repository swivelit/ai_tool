from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class CreateOrderRequest(BaseModel):
    gross_amount_paise: int = Field(gt=0, strict=True)
    idempotency_key: str = Field(min_length=8, max_length=120, pattern=r"^[A-Za-z0-9_.:-]+$")
    credit_bucket: Literal["chat", "voice"] = "chat"


class PublicTopupTokenEstimate(BaseModel):
    tier: str
    tier_label: str
    estimated_blended_tokens: int | None
    range_min_tokens: int
    range_max_tokens: int


class PublicVoiceCreditEstimate(BaseModel):
    pricing_version: str
    estimated_stt_seconds: int
    estimated_stt_minutes: str
    estimated_tts_characters: int
    assumption: str


class TopupEstimateResponse(BaseModel):
    gross_amount_paise: int
    credit_bucket: Literal["chat", "voice"] = "chat"
    token_estimate: PublicTopupTokenEstimate | None = None
    voice_estimate: PublicVoiceCreditEstimate | None = None


class VerifyPaymentRequest(BaseModel):
    internal_order_id: str = Field(min_length=36, max_length=36)
    razorpay_order_id: str = Field(min_length=4, max_length=80)
    razorpay_payment_id: str = Field(min_length=4, max_length=80)
    razorpay_signature: str = Field(min_length=32, max_length=256)
