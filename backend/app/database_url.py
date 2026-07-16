from __future__ import annotations


POSTGRES_URL_SCHEMES = frozenset(
    {
        "postgres",
        "postgresql",
        "postgresql+psycopg",
        "postgresql+psycopg2",
    }
)


def database_url_scheme(raw_url: str) -> str:
    """Return a normalized URL scheme without exposing any URL components."""
    value = str(raw_url or "").strip()
    scheme, separator, _remainder = value.partition("://")
    return scheme.lower() if separator else ""


def is_postgres_database_url(raw_url: str) -> bool:
    return database_url_scheme(raw_url) in POSTGRES_URL_SCHEMES


def is_sqlite_database_url(raw_url: str) -> bool:
    return database_url_scheme(raw_url).split("+", 1)[0] == "sqlite"


def normalize_database_url(raw_url: str) -> str:
    """Normalize accepted PostgreSQL aliases to the psycopg 3 driver form."""
    url = str(raw_url or "").strip()
    scheme = database_url_scheme(url)
    if scheme in {"postgres", "postgresql", "postgresql+psycopg2"}:
        _original_scheme, _separator, remainder = url.partition("://")
        return f"postgresql+psycopg://{remainder}"
    return url
