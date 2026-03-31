import os

from sqlalchemy.orm import sessionmaker
from sqlmodel import Session, create_engine

from config import DATABASE_PATH

DB_URL = os.getenv("DATABASE_URL", "").strip()

if not DB_URL:
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_URL = f"sqlite:///{DATABASE_PATH}"

if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg://", 1)

engine_kwargs = {
    "echo": False,
    "pool_pre_ping": True,
    "pool_recycle": int(os.getenv("DB_POOL_RECYCLE_SECONDS", "1800") or 1800),
}

if DB_URL.startswith("sqlite"):
    engine_kwargs["connect_args"] = {"check_same_thread": False}
else:
    engine_kwargs["pool_size"] = int(os.getenv("DB_POOL_SIZE", "10") or 10)
    engine_kwargs["max_overflow"] = int(os.getenv("DB_MAX_OVERFLOW", "20") or 20)

engine = create_engine(DB_URL, **engine_kwargs)
SessionLocal = sessionmaker(bind=engine, class_=Session, expire_on_commit=False)


def get_session():
    with SessionLocal() as session:
        yield session