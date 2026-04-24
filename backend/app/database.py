import os
from pathlib import Path
from typing import Generator

from sqlalchemy import event
from sqlalchemy.orm import sessionmaker
from sqlmodel import Session, create_engine
from dotenv import load_dotenv


load_dotenv()

DEFAULT_SQLITE_PATH = (
    Path(__file__).resolve().parents[1] / "data" / "db" / "ai_tool.sqlite3"
)
DEFAULT_SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)


def _normalize_database_url(raw_url: str) -> str:
    url = (raw_url or "").strip()

    if not url:
        return f"sqlite:///{DEFAULT_SQLITE_PATH.as_posix()}"

    if url.startswith("postgresql+psycopg2://"):
        return url.replace("postgresql+psycopg2://", "postgresql+psycopg://", 1)

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

if IS_SQLITE:
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

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
