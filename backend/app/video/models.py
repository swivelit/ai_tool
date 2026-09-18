from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4
from sqlalchemy import Column, DateTime, Text, UniqueConstraint, CheckConstraint
from sqlmodel import Field, SQLModel


def now() -> datetime:
    return datetime.now(timezone.utc)


def uid() -> str:
    return str(uuid4())


class VideoControl(SQLModel, table=True):
    __tablename__ = "video_control"
    id: int = Field(default=1, primary_key=True)
    maintenance_until: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    worker_seen_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    worker_boot: str = ""
    capabilities_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))


class VideoTemplate(SQLModel, table=True):
    __tablename__ = "video_template"
    id: str = Field(primary_key=True, max_length=32)
    title: str = Field(max_length=80)
    manifest_hash: str = Field(max_length=64)
    metadata_json: str = Field(sa_column=Column(Text, nullable=False))
    published_at: datetime = Field(default_factory=now, sa_column=Column(DateTime(timezone=True), nullable=False))


class VideoQuota(SQLModel, table=True):
    __tablename__ = "video_quota"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_video_quota_day"), CheckConstraint("used >= 0", name="ck_video_quota_nonnegative"))
    id: str = Field(default_factory=uid, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", index=True)
    day: str = Field(max_length=10)
    used: int = 0


class VideoJob(SQLModel, table=True):
    __tablename__ = "video_job"
    __table_args__ = (UniqueConstraint("user_id", "request_key", name="uq_video_request"),)
    id: str = Field(default_factory=uid, primary_key=True, max_length=36)
    user_id: int = Field(foreign_key="user.id", index=True)
    request_key: str = Field(max_length=80)
    request_hash: str = Field(max_length=64)
    email: str = Field(max_length=320)
    template_id: str = Field(foreign_key="video_template.id")
    manifest_hash: str = Field(max_length=64)
    frozen_json: str = Field(sa_column=Column(Text, nullable=False))
    inputs_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    options_json: str = Field(default="{}", sa_column=Column(Text, nullable=False))
    state: str = Field(default="uploading", index=True, max_length=32)
    funding: str = Field(default="none", max_length=16)
    quota_id: str | None = Field(default=None, foreign_key="video_quota.id")
    quota_state: str = Field(default="none", max_length=16)
    payment_id: str | None = Field(default=None, foreign_key="payment_order.id", unique=True)
    thread_id: str | None = Field(default=None, foreign_key="web_chat_thread.id", ondelete="SET NULL")
    created_at: datetime = Field(default_factory=now, sa_column=Column(DateTime(timezone=True), nullable=False, index=True))
    deadline: datetime = Field(sa_column=Column(DateTime(timezone=True), nullable=False))
    admitted_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    started_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    ready_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    expires_at: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    lease_until: datetime | None = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    fence: str = Field(default="", max_length=64)
    attempt: int = 0
    progress: int = 0
    phase: str = Field(default="upload", max_length=32)
    error: str = Field(default="", max_length=80)
    output_hash: str = Field(default="", max_length=64)
    output_size: int = 0


class VideoOutbox(SQLModel, table=True):
    __tablename__ = "video_outbox"
    __table_args__ = (UniqueConstraint("job_id", "kind", name="uq_video_outbox_event"),)
    id: str = Field(default_factory=uid, primary_key=True, max_length=36)
    job_id: str = Field(foreign_key="video_job.id", index=True)
    kind: str = Field(max_length=16)
    state: str = Field(default="pending", max_length=32)
    attempts: int = 0
    due_at: datetime = Field(default_factory=now, sa_column=Column(DateTime(timezone=True), nullable=False))
    provider_id: str = Field(default="", max_length=80)
    error: str = Field(default="", max_length=80)
