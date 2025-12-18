import os
from sqlmodel import SQLModel, Session, create_engine

# Expect Postgres in production
DB_URL = os.getenv("DATABASE_URL")

if not DB_URL:
    raise RuntimeError("DATABASE_URL is not set")

# Render Postgres URLs sometimes start with postgres:// (deprecated)
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg://", 1)

engine = create_engine(
    DB_URL,
    echo=False,
    pool_pre_ping=True,   # important for Render
)


def create_db_and_tables():
    """
    Postgres-native schema creation.
    Safe to call multiple times.
    """
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
