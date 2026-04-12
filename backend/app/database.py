import os
from typing import Generator

from sqlalchemy.orm import sessionmaker
from sqlmodel import Session, create_engine


def _normalize_database_url(raw_url: str) -> str:
    url = (raw_url or "").strip()

    if not url:
        return "sqlite:///./app.db"

    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+psycopg://", 1)

    if url.startswith("postgresql://") and "+psycopg" not in url:
        return url.replace("postgresql://", "postgresql+psycopg://", 1)

    return url


DATABASE_URL = _normalize_database_url(os.getenv("DATABASE_URL", ""))

IS_SQLITE = DATABASE_URL.startswith("sqlite")
IS_POSTGRES = DATABASE_URL.startswith("postgresql")

connect_args = {}
engine_kwargs = {
    "echo": os.getenv("SQL_ECHO", "false").lower() == "true",
}

if IS_SQLITE:
    connect_args["check_same_thread"] = False
else:
    connect_args["connect_timeout"] = int(os.getenv("DB_CONNECT_TIMEOUT", "10"))

    engine_kwargs.update(
        {
            "pool_pre_ping": True,
            "pool_recycle": int(os.getenv("DB_POOL_RECYCLE", "300")),
            "pool_size": int(os.getenv("DB_POOL_SIZE", "2")),
            "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "2")),
            "pool_timeout": int(os.getenv("DB_POOL_TIMEOUT", "10")),
            "pool_use_lifo": True,
        }
    )

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    **engine_kwargs,
)

SessionLocal = sessionmaker(
    bind=engine,
    class_=Session,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
)


def get_session() -> Generator[Session, None, None]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()