import os

from sqlmodel import Session, create_engine

from config import DATABASE_PATH

DB_URL = os.getenv("DATABASE_URL", "").strip()

if not DB_URL:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_URL = f"sqlite:///{DATABASE_PATH}"

# Normalize Render / Postgres URLs
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg://", 1)

engine_kwargs = {
    "echo": False,
    "pool_pre_ping": True,
}

if DB_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}

engine = create_engine(DB_URL, **engine_kwargs)


def get_session():
    with Session(engine) as session:
        yield session