from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class DeviceAuthorizationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_id: str = Field(min_length=1, max_length=64)
    code_challenge: str = Field(min_length=43, max_length=128)
    device_description: str = Field(default="Swico CLI", min_length=1, max_length=120)
    scopes: list[Literal["chat", "agent"]] = Field(default_factory=lambda: ["chat"], max_length=2)


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


class CliTierRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tier: Literal["free", "lite", "standard", "pro"]


class CloudJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task: str = Field(min_length=1, max_length=8_000)


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
