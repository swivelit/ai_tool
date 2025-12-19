import os
from sqlmodel import Session, create_engine

DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise RuntimeError("DATABASE_URL is not set")

# Normalize Render URLs
if DB_URL.startswith("postgres://"):
    DB_URL = DB_URL.replace("postgres://", "postgresql+psycopg://", 1)

engine = create_engine(
    DB_URL,
    echo=False,
    pool_pre_ping=True,
)

def get_session():
    with Session(engine) as session:
        yield session
