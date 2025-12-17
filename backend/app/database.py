import os
from sqlmodel import SQLModel, Session, create_engine

DB_URL = os.getenv("DATABASE_URL", "sqlite:///tamil_voice_ai.db")
connect_args = {"check_same_thread": False} if DB_URL.startswith("sqlite") else {}

engine = create_engine(DB_URL, echo=False, connect_args=connect_args)

def create_db_and_tables():
    SQLModel.metadata.create_all(engine)

def get_session():
    with Session(engine) as session:
        yield session
