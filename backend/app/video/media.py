"""Bounded in-memory media handling; never invoke a repository command or spool."""
import hashlib
import io
import struct
import warnings
from PIL import Image, ImageOps

RAW_LIMIT = 5 * 1024 * 1024
IMAGE_LIMIT = 2 * 1024 * 1024


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def normalize_image(data: bytes) -> bytes:
    if len(data) > RAW_LIMIT:
        raise ValueError("photo_too_large")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
                raise ValueError("unsupported_photo")
            if not 64 <= min(image.size) or image.width * image.height > 12_000_000:
                raise ValueError("photo_dimensions")
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((2048, 2048))
            output = io.BytesIO()
            image.save(output, format="JPEG", quality=90)
    result = output.getvalue()
    if len(result) > IMAGE_LIMIT:
        raise ValueError("normalized_photo_too_large")
    return result


def instructions(text: str) -> dict:
    result = {"swap": "both", "enhance": "off", "caption": ""}
    seen = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        key, separator, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if not separator or key not in result or key in seen:
            raise ValueError("Use only swap, enhance and caption, once each on separate lines.")
        seen.add(key)
        result[key] = value
    if result["swap"] not in {"both", "male", "female"} or result["enhance"] not in {"off", "natural"}:
        raise ValueError("Unsupported swap or enhance instruction")
    if len(result["caption"]) > 100 or any(ord(character) < 32 or ord(character) > 126 for character in result["caption"]):
        raise ValueError("Caption must be at most 100 printable characters")
    return result


def validate_mp4(data: bytes) -> None:
    # Bounded structural validation, not a claim of semantic/native decoding.
    # Worker additionally decodes/ffprobes the completed video before transfer.
    offset, boxes = 0, set()
    while offset < len(data):
        if len(data) - offset < 8:
            raise ValueError("truncated_mp4")
        length, kind = struct.unpack_from(">I4s", data, offset)
        header = 8
        if length == 1:
            if len(data) - offset < 16:
                raise ValueError("truncated_mp4")
            length = struct.unpack_from(">Q", data, offset + 8)[0]
            header = 16
        if length < header or offset + length > len(data):
            raise ValueError("invalid_mp4_box")
        boxes.add(kind)
        offset += length
    if not {b"ftyp", b"moov", b"mdat"}.issubset(boxes) or b"vide" not in data or b"avc1" not in data:
        raise ValueError("unsupported_mp4")
