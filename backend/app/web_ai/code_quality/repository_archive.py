from __future__ import annotations

from dataclasses import dataclass
import io
from pathlib import PurePosixPath
import stat
import unicodedata
import zipfile

from .repository_index import RepositorySourceFile, source_file


class UnsafeRepositoryArchive(ValueError):
    """A content-free validation failure safe to return to an authenticated owner."""


_ARCHIVE_SUFFIXES = frozenset({
    ".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar",
    ".war", ".whl",
})
_IGNORED_PARTS = frozenset({
    ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build",
    ".next", ".nuxt", ".venv", "venv", "__pycache__", "coverage",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".turbo",
    "bower_components", "target", "out",
})
_TEXT_EXTENSIONS = frozenset({
    ".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".json", ".toml",
    ".yaml", ".yml", ".ini", ".cfg", ".md", ".txt",
})
_TEXT_NAMES = frozenset({
    "dockerfile", "makefile", "requirements.txt", "requirements-dev.txt",
    ".eslintrc", ".gitignore",
})


@dataclass(frozen=True)
class ArchiveLimits:
    max_archive_bytes: int
    max_uncompressed_bytes: int
    max_files: int
    max_compression_ratio: int = 100
    max_file_bytes: int = 2_000_000


@dataclass(frozen=True)
class ValidatedRepositoryArchive:
    files: tuple[RepositorySourceFile, ...]
    ignored_file_count: int
    total_uncompressed_bytes: int


def _safe_path(raw: str) -> str:
    name = unicodedata.normalize("NFC", str(raw or ""))
    if (
        not name
        or name.startswith(("/", "\\"))
        or "\\" in name
        or ":" in name
        or any(
            ord(char) == 127
            or unicodedata.category(char) in {"Cc", "Cf"}
            for char in name
        )
    ):
        raise UnsafeRepositoryArchive("unsafe_filename")
    path = PurePosixPath(name)
    reserved = {
        "con", "prn", "aux", "nul",
        *(f"com{value}" for value in range(1, 10)),
        *(f"lpt{value}" for value in range(1, 10)),
    }
    if (
        path.is_absolute()
        or len(path.as_posix()) > 512
        or any(
            part in {"", ".", ".."}
            or len(part) > 255
            or part.endswith((" ", "."))
            or part.casefold().split(".", 1)[0] in reserved
            for part in path.parts
        )
    ):
        raise UnsafeRepositoryArchive("unsafe_archive_path")
    return path.as_posix()


def _special_entry(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    if not mode or stat.S_IFMT(mode) == 0:
        return False
    return not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))


def inspect_repository_zip(
    archive: bytes,
    *,
    limits: ArchiveLimits,
) -> ValidatedRepositoryArchive:
    if len(archive) > limits.max_archive_bytes:
        raise UnsafeRepositoryArchive("archive_too_large")
    try:
        package = zipfile.ZipFile(io.BytesIO(archive), "r")
    except (zipfile.BadZipFile, OSError) as exc:
        raise UnsafeRepositoryArchive("invalid_zip_archive") from exc
    files: list[RepositorySourceFile] = []
    ignored = 0
    total = 0
    seen: set[str] = set()
    with package:
        entries = package.infolist()
        if len(entries) > limits.max_files:
            raise UnsafeRepositoryArchive("archive_entry_limit")
        for info in entries:
            path = _safe_path(info.filename)
            folded = path.casefold()
            if folded in seen:
                raise UnsafeRepositoryArchive("duplicate_archive_path")
            seen.add(folded)
            if info.flag_bits & 0x1:
                raise UnsafeRepositoryArchive("encrypted_archive")
            if _special_entry(info):
                raise UnsafeRepositoryArchive("special_archive_entry")
            if info.is_dir():
                continue
            suffix = PurePosixPath(path).suffix.casefold()
            if suffix in _ARCHIVE_SUFFIXES:
                raise UnsafeRepositoryArchive("nested_archive")
            total += max(0, int(info.file_size))
            if total > limits.max_uncompressed_bytes:
                raise UnsafeRepositoryArchive("archive_uncompressed_limit")
            compressed = max(1, int(info.compress_size))
            if info.file_size / compressed > limits.max_compression_ratio:
                raise UnsafeRepositoryArchive("archive_compression_ratio")
            parts = {part.casefold() for part in PurePosixPath(path).parts}
            name = PurePosixPath(path).name.casefold()
            if parts & _IGNORED_PARTS:
                ignored += 1
                continue
            if suffix not in _TEXT_EXTENSIONS and name not in _TEXT_NAMES:
                ignored += 1
                continue
            if info.file_size > limits.max_file_bytes:
                ignored += 1
                continue
            try:
                raw = package.read(info)
            except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
                raise UnsafeRepositoryArchive("invalid_archive_entry") from exc
            if b"\x00" in raw:
                ignored += 1
                continue
            try:
                text = raw.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                ignored += 1
                continue
            files.append(source_file(path, text))
    if not files:
        raise UnsafeRepositoryArchive("repository_has_no_supported_text")
    return ValidatedRepositoryArchive(
        files=tuple(sorted(files, key=lambda item: item.path)),
        ignored_file_count=ignored,
        total_uncompressed_bytes=total,
    )
