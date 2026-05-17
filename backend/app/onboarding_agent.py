"""
Deprecated backend-first onboarding compatibility route.

The supported onboarding runtime now lives on the phone via:

    mobile/lib/localAgents.ts

This backend module is intentionally kept lightweight so production deploys do
not need old optional LangChain / LangGraph / Chroma dependencies such as:

    langchain_core
    langchain_openai
    langgraph
    langchain_chroma
    langchain_community
    langchain_text_splitters

Previously this file tried to import those packages during app startup. On
Render, that produced warnings like:

    No module named 'langchain_core'

The route below remains only so old clients receive a clear response instead of
breaking backend startup.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()

# Kept as True so app/main.py treats the compatibility router as loaded.
# The legacy feature itself is intentionally disabled below.
LEGACY_ONBOARDING_AVAILABLE = True
LEGACY_ONBOARDING_IMPORT_ERROR: Optional[str] = None

LEGACY_ONBOARDING_DISABLED_DETAIL = (
    "Deprecated backend onboarding is disabled. "
    "The supported onboarding runtime is mobile local-first onboarding via "
    "mobile/lib/localAgents.ts."
)


class ChatRequest(BaseModel):
    user_id: str
    message: Optional[str] = None


@router.post("/chat")
async def onboarding_chat_unavailable(request: ChatRequest):
    """
    Compatibility endpoint for old clients that still call:

        POST /api/onboarding/chat

    This backend-first onboarding path was removed from production startup
    because it depends on legacy optional LangChain packages. The current
    mobile app should use the local onboarding flow instead.
    """
    logger.info(
        "Deprecated backend onboarding endpoint was requested for user_id=%s. "
        "Returning compatibility shutdown response.",
        request.user_id,
    )

    raise HTTPException(
        status_code=410,
        detail=LEGACY_ONBOARDING_DISABLED_DETAIL,
    )