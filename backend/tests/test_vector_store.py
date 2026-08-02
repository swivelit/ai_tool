from types import SimpleNamespace

from sqlalchemy.dialects import postgresql
import pytest

from app.global_qa_cache import _upsert_vector_for_row
from app.time_utils import utc_now
from app.vector_store import (
    VectorStore,
    pgvector_search_statement,
    pgvector_upsert_statement,
)


class _Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def all(self):
        return self.rows


class _KeywordOnlySession:
    def __init__(self, rows=()):
        self.calls = []
        self.commits = 0
        self.rollbacks = 0
        self.rows = rows

    def exec(self, statement, *, params=None):
        self.calls.append((statement, params))
        return _Rows(self.rows)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class _FailingSession(_KeywordOnlySession):
    def exec(self, statement, *, params=None):
        self.calls.append((statement, params))
        raise RuntimeError("vector query failed")


def _pgvector_store() -> VectorStore:
    store = VectorStore(SimpleNamespace(), backend="pgvector")
    store._resolved_backend = "pgvector"
    return store


def test_pgvector_upsert_uses_keyword_bound_parameters():
    session = _KeywordOnlySession()
    store = _pgvector_store()
    content = "user text'); DROP TABLE vector_store_entries; --"

    store.upsert(
        session,
        user_id=7,
        source_type="global_qa",
        source_id="answer-1",
        content_hash="safe-hash",
        content_text=content,
        embedding=[0.25, -0.5],
    )

    assert len(session.calls) == 1
    statement, params = session.calls[0]
    sql = str(statement)
    assert ":content_text" in sql
    assert ":embedding" in sql
    assert content not in sql
    assert params["content_text"] == content
    assert params["source_type"] == "global_qa"
    assert params["embedding"] == "[0.25000000,-0.50000000]"
    assert session.commits == 1


def test_pgvector_search_keeps_source_filter_parameterized():
    row = {
        "source_type": "global_qa",
        "source_id": "1",
        "content_text": "answer",
        "updated_at": utc_now(),
        "score_semantic": 0.9,
    }
    session = _KeywordOnlySession([
        SimpleNamespace(_mapping=row),
    ])
    store = _pgvector_store()
    source_type = "global_qa'); DELETE FROM vector_store_entries; --"

    results = store.search(
        session,
        user_id=9,
        query_embedding=[0.1, 0.2],
        source_types=[source_type],
        limit=3,
    )

    statement, params = session.calls[0]
    sql = str(statement)
    assert "source_type = ANY(CAST(:source_types AS TEXT[]))" in sql
    assert source_type not in sql
    assert params["source_types"] == [source_type]
    assert params["user_id"] == 9
    assert params["limit"] == 3
    assert results[0]["source_id"] == "1"


def test_backend_answer_vector_upsert_no_longer_uses_positional_exec(
    monkeypatch,
):
    session = _KeywordOnlySession()
    store = _pgvector_store()
    monkeypatch.setattr(
        "app.global_qa_cache.get_vector_store", lambda: store
    )
    row = SimpleNamespace(
        id=42,
        canonical_question="How does a queue work?",
        real_embedding_json="[0.1,0.2]",
        real_embedding_norm=0.2236,
        real_embedding_kind="text-embedding-test",
        embedding_kind="token_hash_v1",
        embedding_json="[]",
        embedding_norm=0.0,
        updated_at=utc_now(),
    )

    _upsert_vector_for_row(session, row)

    assert len(session.calls) == 1
    assert session.calls[0][1]["source_id"] == "42"
    assert session.commits == 1


def _postgresql_sql(statement) -> str:
    return str(statement.compile(dialect=postgresql.dialect()))


def test_pgvector_upsert_compiles_for_postgresql_without_unresolved_embedding():
    sql = _postgresql_sql(pgvector_upsert_statement())

    assert "CAST(%(embedding)s AS vector)" in sql
    assert "CAST(%(embedding_json)s AS JSONB)" in sql
    assert ":embedding" not in sql


def test_pgvector_search_compiles_vector_and_source_list_for_postgresql():
    sql = _postgresql_sql(
        pgvector_search_statement(filter_source_types=True)
    )

    assert sql.count("CAST(%(embedding)s AS vector)") == 2
    assert "ANY(CAST(%(source_types)s AS TEXT[]))" in sql
    assert ":embedding" not in sql
    assert ":source_types" not in sql


def test_pgvector_failure_rolls_back_the_failed_session_transaction():
    session = _FailingSession()
    with pytest.raises(RuntimeError, match="vector query failed"):
        _pgvector_store().upsert(
            session,
            user_id=7,
            source_type="global_qa",
            source_id="answer-2",
            content_hash="safe-hash-2",
            content_text="safe text",
            embedding=[0.1, 0.2],
        )

    assert session.commits == 0
    assert session.rollbacks == 1
