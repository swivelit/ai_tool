import os
from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy import text

DB_URL = os.getenv("DATABASE_URL", "sqlite:///tamil_voice_ai.db")

connect_args = {"check_same_thread": False} if DB_URL.startswith("sqlite") else {}
engine = create_engine(DB_URL, echo=False, connect_args=connect_args)


def _sqlite_has_column(conn, table: str, column: str) -> bool:
    rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
    # PRAGMA table_info returns rows like: (cid, name, type, notnull, dflt_value, pk)
    for r in rows:
        if len(r) >= 2 and r[1] == column:
            return True
    return False


def _sqlite_add_column_if_missing(conn, table: str, column: str, coltype: str) -> None:
    if _sqlite_has_column(conn, table, column):
        return
    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}"))
    print(f"[MIGRATION] Added missing column: {table}.{column} ({coltype})")


def _run_sqlite_migrations() -> None:
    """
    Minimal SQLite migrations for Render deployments.
    SQLite doesn't auto-migrate. This patches existing tables safely.
    """
    if not DB_URL.startswith("sqlite"):
        return

    with engine.begin() as conn:
        # If table doesn't exist yet, create_all will handle it later.
        tables = conn.execute(text("SELECT name FROM sqlite_master WHERE type='table'")).fetchall()
        table_names = {t[0] for t in tables}

        # ---- Item table: ensure user_id exists ----
        if "item" in table_names:
            _sqlite_add_column_if_missing(conn, "item", "user_id", "INTEGER")

        # If you later add more columns, add them here similarly.
        # Example:
        # if "conversation" in table_names:
        #     _sqlite_add_column_if_missing(conn, "conversation", "user_id", "INTEGER")


def create_db_and_tables():
    """
    1) Create tables for fresh DB
    2) Run lightweight SQLite migrations for existing DB
    """
    SQLModel.metadata.create_all(engine)
    _run_sqlite_migrations()


def get_session():
    with Session(engine) as session:
        yield session
