from __future__ import annotations

import os
from pathlib import Path


TEST_DB_PATH = Path(__file__).resolve().parents[1] / "data" / "db" / "pytest.sqlite3"
TEST_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

# Keep pytest isolated from developer/staging/production config values in .env.
# app.database calls load_dotenv(), which does not override existing environment
# variables, so these must be set before any app modules are imported.
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"
os.environ["AUTO_CREATE_TABLES"] = "true"
os.environ["JOB_WORKER_ENABLED"] = "false"
os.environ["RAG_ENABLE_FAST_RAG_SEMANTIC"] = "false"
os.environ["OPENAI_API_KEY"] = ""
os.environ["SARVAM_API_KEY"] = ""
os.environ["SENTRY_DSN"] = ""
