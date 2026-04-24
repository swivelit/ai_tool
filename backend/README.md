# Backend

## Local setup

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m pytest
```

For Postgres URLs, use the SQLAlchemy psycopg 3 driver form:

```bash
DATABASE_URL=postgresql+psycopg://USER:PASSWORD@HOST:5432/DB_NAME
```

Run Alembic migrations before deployed startup. Runtime `create_all()` is only enabled by default for the local SQLite fallback.
