from __future__ import annotations

import ast
import asyncio
import hmac
import os
from pathlib import PurePosixPath
import threading
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..web_ai.code_quality.repository_index import (
    _ecmascript_tokens,
    source_file,
)
from .isolation import detect_isolation_capabilities
from .runner import RunnerLimits, run_allowlisted_check


app = FastAPI(title="Swico Repository Validator", docs_url=None, redoc_url=None)
_STARTUP_CAPABILITIES = detect_isolation_capabilities()
_ALLOWED_CHECKS = frozenset({
    "python_ast", "python_compile", "python_lint", "python_typecheck",
    "python_pytest", "typescript_parse", "typescript_lint",
    "typescript_typecheck", "typescript_tests", "typescript_build",
    "api_schema_static", "migration_upgrade", "authorization_tests",
})
_EXECUTABLE_CHECKS = frozenset({
    "python_compile", "python_lint", "python_typecheck", "python_pytest",
    "typescript_lint", "typescript_typecheck", "typescript_tests",
    "typescript_build",
    "migration_upgrade", "authorization_tests",
})


@app.exception_handler(RequestValidationError)
async def _safe_validation_error(
    _request: Request, _error: RequestValidationError,
) -> JSONResponse:
    # Pydantic's default response echoes rejected input, which may be source.
    return JSONResponse(status_code=422, content={"detail": "invalid_request"})


class SourceFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=512)
    content: str = Field(max_length=2_000_000)

    @field_validator("path")
    @classmethod
    def safe_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if (
            path.is_absolute() or ".." in path.parts or "\\" in value
            or any(ord(char) < 32 or ord(char) == 127 for char in value)
        ):
            raise ValueError("unsafe path")
        return path.as_posix()


class ValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=64)
    repository_id: str = Field(min_length=1, max_length=160)
    source_version: str = Field(min_length=1, max_length=160)
    checks: list[str] = Field(max_length=24)
    required_checks: list[str] = Field(max_length=24)
    files: list[SourceFile] = Field(max_length=48)

    @field_validator("checks", "required_checks")
    @classmethod
    def allowed_checks(cls, values: list[str]) -> list[str]:
        if any(value not in _ALLOWED_CHECKS for value in values):
            raise ValueError("unsupported check")
        return list(dict.fromkeys(values))


def _authenticate(authorization: str = Header(default="")) -> None:
    expected = os.getenv("CODE_VALIDATOR_AUTH_TOKEN", "")
    supplied = authorization.removeprefix("Bearer ").strip()
    if not expected or not hmac.compare_digest(expected, supplied):
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/v1/isolation", dependencies=[Depends(_authenticate)])
def isolation_status() -> dict[str, object]:
    capability = _STARTUP_CAPABILITIES
    return {
        "isolation_level": capability.isolation_level,
        "executable_checks": capability.executable_checks,
        "reason_code": capability.reason_code,
    }


@app.post("/v1/validate", dependencies=[Depends(_authenticate)])
async def validate_repository(
    payload: ValidationRequest, request: Request,
) -> dict[str, object]:
    capability = _STARTUP_CAPABILITIES
    checks: list[dict[str, str]] = []
    by_path = {item.path: item.content for item in payload.files}
    for check_id in payload.checks:
        category = (
            "api_schema" if check_id == "api_schema_static"
            else "migration" if check_id == "migration_upgrade"
            else "authorization" if check_id == "authorization_tests"
            else "syntax" if check_id.endswith(("ast", "parse", "compile"))
            else "typecheck" if "typecheck" in check_id
            else "lint" if "lint" in check_id
            else "test" if "test" in check_id or "pytest" in check_id
            else "build"
        )
        if check_id in _EXECUTABLE_CHECKS:
            if capability.executable_checks:
                cancelled = threading.Event()
                task = asyncio.create_task(asyncio.to_thread(
                    run_allowlisted_check,
                    check_id,
                    files=by_path,
                    limits=RunnerLimits(
                        timeout_seconds=_bounded_environment_integer(
                            "CODE_VALIDATOR_TIMEOUT_SECONDS", 90, 1, 300
                        ),
                        output_bytes=_bounded_environment_integer(
                            "CODE_VALIDATOR_MAX_OUTPUT_BYTES",
                            65_536, 1_024, 262_144,
                        ),
                    ),
                    cancelled=cancelled.is_set,
                ))
                while not task.done():
                    if await request.is_disconnected():
                        cancelled.set()
                    await asyncio.sleep(0.05)
                result = await task
                if result.safe_code == "validation_cancelled":
                    raise HTTPException(499, "Validation cancelled")
                status, code = result.status, result.safe_code
            else:
                status, code = "skipped", "static_only"
        elif check_id == "python_ast":
            status, code = _python_ast_check(by_path)
        elif check_id == "typescript_parse":
            status, code = _typescript_parse_check(by_path)
        elif check_id == "api_schema_static":
            python_status, python_code = _python_ast_check(by_path)
            ts_status, ts_code = _typescript_parse_check(by_path)
            status = (
                "failed"
                if "failed" in {python_status, ts_status} else "passed"
            )
            code = python_code or ts_code
        else:
            status, code = "skipped", "unsupported_static_check"
        checks.append({
            "check_id": check_id,
            "category": category,
            "status": status,
            "safe_code": code,
        })
    required = set(payload.required_checks)
    by_id = {item["check_id"]: item["status"] for item in checks}
    passed = bool(required) and all(by_id.get(item) == "passed" for item in required)
    failed = any(by_id.get(item) == "failed" for item in required)
    status: Literal["passed", "failed", "static_only"]
    status = "passed" if passed else "failed" if failed else "static_only"
    return {
        "status": status,
        "isolation_level": capability.isolation_level,
        "checks": checks,
        "required_check_ids": payload.required_checks,
    }


def _bounded_environment_integer(
    name: str, default: int, minimum: int, maximum: int,
) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(maximum, max(minimum, value))


def _python_ast_check(files: dict[str, str]) -> tuple[str, str]:
    try:
        for path, content in files.items():
            if PurePosixPath(path).suffix in {".py", ".pyi"}:
                ast.parse(content, filename=path, type_comments=True)
    except (SyntaxError, ValueError):
        return "failed", "python_syntax_error"
    return "passed", ""


def _typescript_parse_check(files: dict[str, str]) -> tuple[str, str]:
    for path, content in files.items():
        if PurePosixPath(path).suffix not in {".ts", ".tsx", ".js", ".jsx"}:
            continue
        tokens = _ecmascript_tokens(source_file(path, content).text)
        stack: list[str] = []
        pairs = {"}": "{", "]": "[", ")": "("}
        for token in tokens:
            if token.value in pairs.values():
                stack.append(token.value)
            elif token.value in pairs:
                if not stack or stack.pop() != pairs[token.value]:
                    return "failed", "typescript_delimiter_error"
        if stack:
            return "failed", "typescript_delimiter_error"
    return "passed", ""
