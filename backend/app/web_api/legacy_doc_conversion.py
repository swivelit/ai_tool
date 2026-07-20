from __future__ import annotations

import os
from typing import Protocol


class LegacyDocConverter(Protocol):
    """Boundary for a future isolated .doc conversion worker.

    API processes must never execute office binaries themselves. A production
    implementation can satisfy this protocol by submitting to a separately
    sandboxed worker and returning a validated DOCX path.
    """

    def convert_to_docx(self, source_path: str) -> str: ...


def legacy_doc_conversion_enabled() -> bool:
    return os.getenv("WEB_LEGACY_DOC_CONVERSION_ENABLED", "false").strip().lower() in {
        "1", "true", "yes", "on",
    }


def configured_legacy_doc_converter() -> LegacyDocConverter | None:
    # No converter is bundled with the API service. Keeping this explicit
    # prevents the feature flag from implying that native .doc parsing exists.
    return None


def unavailable_message() -> str:
    if legacy_doc_conversion_enabled():
        return (
            "Legacy .doc conversion is enabled but no isolated converter worker is configured. "
            "Save this document as DOCX and upload it again."
        )
    return "Legacy .doc files require conversion. Save this document as DOCX and upload it again."
