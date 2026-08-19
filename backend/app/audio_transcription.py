from __future__ import annotations

from typing import Optional, Protocol


class SpeechToTextProvider(Protocol):
    def stt_file(
        self, file_path: str, language: Optional[str] = None, *,
        content_type: Optional[str] = None, filename: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> str: ...


def transcribe_audio_file(
    provider: SpeechToTextProvider,
    file_path: str,
    language: Optional[str] = None,
    *,
    content_type: Optional[str] = None,
    filename: Optional[str] = None,
    mode: Optional[str] = None,
) -> str:
    """Shared STT boundary used by legacy/mobile and standalone web routes."""
    kwargs = {"content_type": content_type, "filename": filename}
    if mode is not None:
        kwargs["mode"] = mode
    try:
        return provider.stt_file(file_path, language, **kwargs)
    except TypeError as exc:
        # Preserve compatibility with older injected provider doubles used by
        # the legacy mobile endpoint and third-party Sarvam SDK versions.
        if "unexpected keyword argument" not in str(exc):
            raise
        return provider.stt_file(file_path, language)
