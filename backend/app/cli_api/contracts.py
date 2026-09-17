from __future__ import annotations

import json
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DeviceAuthorizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(min_length=1, max_length=64)
    code_challenge: str = Field(min_length=43, max_length=128)
    device_description: str = Field(default="Swico CLI", min_length=1, max_length=120)
    scopes: list[Literal["chat", "agent"]] = Field(default_factory=lambda: ["chat"], max_length=2)
    tier: Literal["lite", "standard", "pro"] | None = None


class DeviceTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    grant_type: Literal["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]
    device_code: str | None = Field(default=None, min_length=20, max_length=256)
    refresh_token: str | None = Field(default=None, min_length=20, max_length=256)
    code_verifier: str | None = Field(default=None, min_length=43, max_length=128)


class DeviceApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_code: str = Field(min_length=9, max_length=9)
    approved: bool


class CliChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    message: str = Field(min_length=1, max_length=16_000)
    thread_id: str | None = Field(default=None, max_length=36)
    input_mode: Literal["text"] = "text"
    search_mode: Literal["auto", "on", "off"] = "auto"
    attachment_ids: list[str] = Field(default_factory=list, max_length=5)
    repository_id: str | None = Field(default=None, max_length=36)
    output_schema: dict[str, Any] | None = None

    @field_validator("output_schema")
    @classmethod
    def validate_output_schema(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) > 64 * 1024:
            raise ValueError("output_schema exceeds the 64 KiB limit")
        if not value:
            raise ValueError("output_schema must be a non-empty JSON Schema object")
        return value


class CliTierRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tier: Literal["lite", "standard", "pro"]


class CloudJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID = Field(default_factory=uuid4)
    source: Literal["workspace_snapshot", "task_only"] = "workspace_snapshot"
    task: str = Field(min_length=1, max_length=8_000)

    @field_validator("task")
    @classmethod
    def validate_task(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("task must contain non-whitespace text")
        return value.strip()


class CloudSnapshotFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=512)
    data_base64: str = Field(min_length=0, max_length=8 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class CloudSnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    files: list[CloudSnapshotFile] = Field(max_length=5_000)


class CloudJobClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str | None = Field(default=None, min_length=1, max_length=36)


class CloudJobResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["completed", "failed", "cancelled"]
    result: dict[str, Any] = Field(default_factory=dict)
    failure_code: str | None = Field(default=None, max_length=64)

    @field_validator("result")
    @classmethod
    def validate_result(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) > 16 * 1024:
            raise ValueError("result metadata exceeds the 16 KiB limit")
        return value


class SteeringRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    instruction: str = Field(min_length=1, max_length=2_000)
    sequence: int = Field(ge=1, le=10_000)
    idempotency_key: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")

    @field_validator("instruction")
    @classmethod
    def validate_instruction(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("instruction must contain non-whitespace text")
        return value.strip()


class AgentRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    task: str = Field(min_length=1, max_length=8_000)
    thread_id: str | None = Field(default=None, max_length=36)


class AgentAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol_version: Literal[1, 2]
    action_id: str = Field(min_length=8, max_length=64)
    action_type: Literal[
        "list_files", "search_text", "read_file", "read_file_range", "apply_patch",
        "create_file", "delete_file", "move_file", "run_command", "git_status", "git_diff",
        "mcp_tool",
        "spawn_subagent",
        "web_search",
    ]
    payload_hash: str | None = Field(default=None, min_length=64, max_length=64)
    reservation_id: str | None = Field(default=None, min_length=8, max_length=64)
    payload: dict[str, object] | None = None


class AgentPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=8_000)
    context: str = Field(default="", max_length=20_000)


class AgentSubagentTask(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    task: str = Field(min_length=1, max_length=2_000)


class AgentSubagentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: str = Field(min_length=8, max_length=64)
    tasks: list[AgentSubagentTask] = Field(min_length=1, max_length=4)
    context: str = Field(default="", max_length=8_000)


class AgentResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: str = Field(min_length=8, max_length=64)
    result_hash: str = Field(min_length=64, max_length=64)
    status: Literal["succeeded", "failed", "unknown"]
