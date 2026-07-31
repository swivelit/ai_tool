from __future__ import annotations


def compress_runtime_text(text: str, token_limit: int) -> tuple[str, int, bool]:
    """Deterministic boundary-safe truncation; document text stays untrusted."""

    value = str(text or "").strip()
    char_limit = max(0, int(token_limit)) * 4
    if len(value) <= char_limit:
        return value, max(1, (len(value) + 3) // 4), False
    clipped = value[:char_limit].rsplit(" ", 1)[0].rstrip()
    return clipped, max(1, (len(clipped) + 3) // 4), True
