from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit


LOCAL_DEV_CORS_ENV = "CORS_ALLOW_LOCAL_DEV_ORIGINS"
PRODUCTION_CORS_ENV = "CORS_ALLOW_ORIGINS"

# Retained for local backend development. Production must provide an explicit
# HTTPS CORS_ALLOW_ORIGINS value instead of using this fallback.
DEFAULT_CORS_ORIGINS = (
    "http://localhost",
    "http://127.0.0.1",
    "http://localhost:19006",
    "http://127.0.0.1:19006",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
)


@dataclass(frozen=True)
class ConfiguredCorsOrigins:
    production: tuple[str, ...]
    local_dev: tuple[str, ...]
    effective: tuple[str, ...]


def _split_origins(value: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in str(value or "").split(",") if item.strip())


def _deduplicate(origins: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(origins))


def _valid_port(parsed: object) -> bool:
    try:
        port = parsed.port  # type: ignore[attr-defined]
    except ValueError:
        return False
    return port is not None and 1 <= port <= 65_535


def exact_https_origin(origin: str) -> bool:
    """Return whether origin is one exact, credential-free HTTPS origin."""
    if not origin or origin != origin.strip() or "*" in origin:
        return False
    try:
        parsed = urlsplit(origin)
        hostname = parsed.hostname
        _ = parsed.port
    except ValueError:
        return False
    return bool(
        parsed.scheme == "https"
        and hostname
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and origin == f"https://{parsed.netloc}"
    )


def exact_local_dev_origin(origin: str) -> bool:
    """Return whether origin is an exact HTTP localhost/127.0.0.1 origin."""
    if not origin or origin != origin.strip() or "*" in origin:
        return False
    try:
        parsed = urlsplit(origin)
        hostname = parsed.hostname
        has_valid_port = _valid_port(parsed)
    except ValueError:
        return False
    return bool(
        parsed.scheme == "http"
        and hostname in {"localhost", "127.0.0.1"}
        and has_valid_port
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and origin == f"http://{parsed.netloc}"
    )


def configured_cors_origins(
    environ: Mapping[str, str] | None = None,
) -> ConfiguredCorsOrigins:
    env = environ or {}
    production = _split_origins(env.get(PRODUCTION_CORS_ENV, ""))
    local_dev = _split_origins(env.get(LOCAL_DEV_CORS_ENV, ""))
    return ConfiguredCorsOrigins(
        production=production,
        local_dev=local_dev,
        effective=_deduplicate(production + local_dev),
    )


def effective_cors_origins(
    environ: Mapping[str, str] | None = None,
    *,
    production: bool = False,
) -> tuple[str, ...]:
    configured = configured_cors_origins(environ)
    if production:
        production_origins = tuple(
            origin for origin in configured.production if exact_https_origin(origin)
        )
    else:
        production_origins = configured.production or DEFAULT_CORS_ORIGINS
    local_origins = tuple(
        origin for origin in configured.local_dev if exact_local_dev_origin(origin)
    )
    return _deduplicate(production_origins + local_origins)


def cors_configuration_errors(
    environ: Mapping[str, str] | None = None,
    *,
    require_production_origins: bool = False,
) -> list[str]:
    configured = configured_cors_origins(environ)
    errors: list[str] = []
    if require_production_origins and not configured.production:
        errors.append("CORS_ALLOW_ORIGINS must list approved HTTPS origins")
    elif require_production_origins and (
        len(configured.production) != len(set(configured.production))
        or any(not exact_https_origin(origin) for origin in configured.production)
    ):
        errors.append(
            "CORS_ALLOW_ORIGINS must contain unique exact HTTPS origins without wildcards or trailing slashes"
        )
    if len(configured.local_dev) != len(set(configured.local_dev)) or any(
        not exact_local_dev_origin(origin) for origin in configured.local_dev
    ):
        errors.append(
            "CORS_ALLOW_LOCAL_DEV_ORIGINS must contain unique exact HTTP loopback origins with explicit ports"
        )
    return errors
