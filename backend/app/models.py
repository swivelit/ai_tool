from sqlmodel import SQLModel, Field
from typing import Optional
from datetime import datetime


class Item(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)

    intent: str               # reminder | note | task | document | other
    category: str             # Work | Home | Business | Other
    raw_text: str
    transcript: Optional[str] = None

    datetime_str: Optional[str] = None  # "2025-02-12 08:00" or natural text
    title: Optional[str] = None
    details: Optional[str] = None

    source: str               # "text" or "voice"

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
