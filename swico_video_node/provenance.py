"""Non-sensitive synthetic-media disclosure and output provenance helpers."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .runtime import capture, tool

DISCLOSURE_TEXT = "AI-EDITED / SYNTHETIC MEDIA - SWICO"
DISCLOSURE_TAG = "swico-ai-edited-v1"
PROVENANCE_PREFIX = "swico-v1-"
_ID_RE = re.compile(r"^swico-v1-[0-9a-f]{24}$")


def provenance_id(identity: str) -> str:
    """Return an opaque identifier without email, account, token or payment data."""
    return PROVENANCE_PREFIX + hashlib.sha256(("swico-video-output:v1:" + identity).encode()).hexdigest()[:24]


def metadata_args(identifier: str) -> list[str]:
    if not _ID_RE.fullmatch(identifier):
        raise ValueError("Invalid output provenance identifier")
    return [
        "-metadata", f"comment={DISCLOSURE_TEXT}",
        "-metadata", f"description={DISCLOSURE_TEXT};provenance={identifier}",
        "-metadata", f"com.swivel.swico.provenance={identifier}",
    ]


def draw_disclosure(draw, width: int, height: int, font) -> tuple[int, int, int, int]:
    """Draw a high-contrast disclosure bar and return its bounded rectangle."""
    left, top = 8, 4
    box = draw.textbbox((left, top), DISCLOSURE_TEXT, font=font, stroke_width=1)
    right = min(width, box[2] + 8)
    bottom = min(height, max(box[3] + 8, font.size + 12))
    draw.rectangle((0, 0, right, bottom), fill="black")
    draw.text((left, top), DISCLOSURE_TEXT, font=font, fill="white", stroke_width=1, stroke_fill="black")
    return 0, 0, right, bottom


def verify_output(path: Path, identifier: str, *, capture_fn=capture) -> dict:
    """Require the exact marker and opaque ID in the final MP4 container."""
    if not _ID_RE.fullmatch(identifier):
        raise ValueError("Invalid output provenance identifier")
    payload = json.loads(capture_fn([
        tool("ffprobe"), "-v", "error", "-show_entries",
        "format_tags=comment,description,com.swivel.swico.provenance",
        "-of", "json", str(path)
    ], limit=64 * 1024))
    tags = payload.get("format", {}).get("tags", {})
    expected_description = f"{DISCLOSURE_TEXT};provenance={identifier}"
    if tags.get("comment") != DISCLOSURE_TEXT or tags.get("description") != expected_description:
        raise ValueError("Synthetic disclosure metadata missing")
    if tags.get("com.swivel.swico.provenance") not in {identifier, None}:
        raise ValueError("Synthetic provenance metadata mismatch")
    return {"disclosure": DISCLOSURE_TAG, "provenance_id": identifier}
