from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
from typing import Callable

import httpx

from .repository_contract import RepositoryContract
from .repository_index import RepositorySourceFile
from .result_parser import (
    RepositoryValidationResult,
    parse_validator_response,
)


@dataclass(frozen=True)
class ValidationClientSettings:
    base_url: str
    auth_token: str
    timeout_seconds: int = 90


def unavailable_result(code: str = "validator_unavailable") -> RepositoryValidationResult:
    from .result_parser import ValidationCheckResult

    return RepositoryValidationResult(
        status="unavailable",
        isolation_level="unavailable",
        checks=(ValidationCheckResult(
            check_id="validator_availability",
            category="syntax",
            status="unavailable",
            safe_code=code,
        ),),
    )


class RepositoryValidationClient:
    def __init__(
        self,
        settings: ValidationClientSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.transport = transport

    def validation_capability_sync(self) -> str:
        """Return only a proven public capability, failing closed to static-only."""

        if not self.settings.base_url or not self.settings.auth_token:
            return "static_only"
        try:
            with httpx.Client(
                base_url=self.settings.base_url.rstrip("/"),
                timeout=min(2, self.settings.timeout_seconds),
            ) as client:
                response = client.get(
                    "/v1/isolation",
                    headers={
                        "Authorization": f"Bearer {self.settings.auth_token}"
                    },
                )
            if response.status_code != 200:
                return "static_only"
            payload = response.json()
            if (
                payload.get("isolation_level") == "executable"
                and payload.get("executable_checks") is True
            ):
                return "executable"
        except (httpx.HTTPError, ValueError, TypeError):
            pass
        return "static_only"

    async def validate(
        self,
        *,
        request_id: str,
        contract: RepositoryContract,
        files: tuple[RepositorySourceFile, ...],
        cancelled: Callable[[], bool] | None = None,
        proposed_files: dict[str, str] | None = None,
    ) -> RepositoryValidationResult:
        if not self.settings.base_url or not self.settings.auth_token:
            return unavailable_result("validator_not_configured")
        if cancelled and cancelled():
            raise asyncio.CancelledError
        requested_checks = {
            item.check_id for item in contract.validation_capabilities
            if item.required or not item.executable
        }
        selected = {item.path for item in contract.relevant_files}
        if "migration_upgrade" in requested_checks:
            selected.update(
                item.path for item in files
                if (
                    item.path in {"alembic.ini", "pyproject.toml"}
                    or item.path.startswith("alembic/")
                    or "/migrations/" in item.path
                )
            )
        if "authorization_tests" in requested_checks:
            selected.update(
                item.path for item in files
                if "test" in item.path.casefold()
                and any(
                    value in item.path.casefold()
                    for value in ("auth", "owner", "permission")
                )
            )
        file_values = {
            item.path: item.text for item in files if item.path in selected
        }
        file_values.update(proposed_files or {})
        proposed_paths = sorted(proposed_files or {})
        ordered_paths = [
            *proposed_paths,
            *(
                path for path in sorted(file_values)
                if path not in set(proposed_paths)
            ),
        ][:48]
        payload = {
            "request_id": request_id,
            "repository_id": contract.repository_id,
            "source_version": contract.source_version,
            "checks": sorted(requested_checks),
            "required_checks": list(contract.required_check_ids),
            "files": [
                {"path": path, "content": file_values[path]}
                for path in ordered_paths
            ],
        }
        try:
            async with httpx.AsyncClient(
                base_url=self.settings.base_url.rstrip("/"),
                timeout=self.settings.timeout_seconds,
                transport=self.transport,
            ) as client:
                health = await _request_with_cancellation(
                    client.get(
                        "/v1/isolation",
                        headers={
                            "Authorization": (
                                f"Bearer {self.settings.auth_token}"
                            )
                        },
                    ),
                    cancelled,
                )
                if health.status_code != 200:
                    return unavailable_result("isolation_check_failed")
                health_payload = health.json()
                if health_payload.get("isolation_level") not in {
                    "static_only", "executable"
                }:
                    return unavailable_result("isolation_check_failed")
                response = await _request_with_cancellation(
                    client.post(
                        "/v1/validate",
                        headers={
                            "Authorization": (
                                f"Bearer {self.settings.auth_token}"
                            )
                        },
                        json=payload,
                    ),
                    cancelled,
                )
            if response.status_code != 200:
                return unavailable_result("validator_non_success")
            result = parse_validator_response(response.json())
            if health_payload["isolation_level"] == "static_only" and any(
                item.executable and item.required
                for item in contract.validation_capabilities
            ):
                return RepositoryValidationResult(
                    status="static_only",
                    isolation_level="static_only",
                    checks=result.checks,
                    required_check_ids=contract.required_check_ids,
                )
            return result
        except asyncio.CancelledError:
            raise
        except (httpx.HTTPError, ValueError, TypeError):
            return unavailable_result("validator_unavailable")

    def validate_sync(
        self,
        *,
        request_id: str,
        contract: RepositoryContract,
        files: tuple[RepositorySourceFile, ...],
        cancelled: Callable[[], bool] | None = None,
        proposed_files: dict[str, str] | None = None,
    ) -> RepositoryValidationResult:
        return asyncio.run(self.validate(
            request_id=request_id,
            contract=contract,
            files=files,
            cancelled=cancelled,
            proposed_files=proposed_files,
        ))


async def _request_with_cancellation(
    awaitable,
    cancelled: Callable[[], bool] | None,
) -> httpx.Response:
    task = asyncio.create_task(awaitable)
    while not task.done():
        if cancelled and cancelled():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            raise asyncio.CancelledError
        await asyncio.wait({task}, timeout=0.05)
    return await task
