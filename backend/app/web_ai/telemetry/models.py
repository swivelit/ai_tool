"""Immutable telemetry metadata contracts."""

from .metadata import SafeMetadata, UnsafeMetadataError, sanitize_metadata

__all__ = ["SafeMetadata", "UnsafeMetadataError", "sanitize_metadata"]
