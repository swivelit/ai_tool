from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import select

from app.database import SessionLocal
from app.models import Job, WebKnowledgeDocument
from app.web_api.upload_store import (
    EphemeralUpload,
    ExtractedChunk,
    get_upload_store,
    utc_iso,
)

from conftest import auth_headers, create_test_user


@pytest.fixture
def knowledge_enabled(monkeypatch):
    monkeypatch.setenv("WEB_TRIAG_ENABLED", "true")
    monkeypatch.setenv("WEB_TRIAG_SHADOW_MODE", "false")
    monkeypatch.setenv("WEB_RAG_HYBRID_ENABLED", "true")
    monkeypatch.setenv("WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED", "true")


def _upload(owner_user_id: int, upload_id: str, *, text: str = "private source body") -> EphemeralUpload:
    now = datetime.now(timezone.utc)
    return EphemeralUpload(
        id=upload_id,
        owner_user_id=owner_user_id,
        name="owner-notes.txt",
        extension=".txt",
        media_type="text/plain",
        size_bytes=len(text.encode()),
        created_at=utc_iso(now),
        expires_at=utc_iso(now + timedelta(minutes=10)),
        chunks=[ExtractedChunk(text=text, source="section 1")],
        source_locators=["section 1"],
        warnings=[],
    )


def _approve(client, uid: str, upload_id: str, **extra):
    return client.post(
        "/api/web/knowledge",
        headers=auth_headers(uid),
        json={
            "upload_id": upload_id,
            "confirm_persistence": True,
            **extra,
        },
    )


def test_knowledge_endpoints_require_authentication(client, knowledge_enabled):
    assert client.get("/api/web/knowledge").status_code == 401


def test_knowledge_api_and_bootstrap_are_disabled_by_default(client):
    create_test_user("disabled")
    bootstrap = client.get(
        "/api/web/bootstrap", headers=auth_headers("disabled")
    )
    assert bootstrap.status_code == 200
    assert bootstrap.json()["features"]["web_knowledge_library"] is False
    response = client.get(
        "/api/web/knowledge", headers=auth_headers("disabled")
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "knowledge_library_unavailable"


def test_bootstrap_exposes_enabled_knowledge_capability(
    client, knowledge_enabled
):
    create_test_user("enabled")
    response = client.get(
        "/api/web/bootstrap", headers=auth_headers("enabled")
    )
    assert response.status_code == 200
    assert response.json()["features"]["web_knowledge_library"] is True


def test_explicit_approval_is_required(client, knowledge_enabled):
    user = create_test_user("approval")
    get_upload_store().put(_upload(int(user.id), "10000000-0000-0000-0000-000000000001"))
    response = client.post(
        "/api/web/knowledge",
        headers=auth_headers("approval"),
        json={
            "upload_id": "10000000-0000-0000-0000-000000000001",
            "confirm_persistence": False,
        },
    )
    assert response.status_code == 422
    with SessionLocal() as session:
        assert session.exec(select(WebKnowledgeDocument)).all() == []


def test_expired_upload_is_rejected(client, knowledge_enabled):
    user = create_test_user("expired")
    upload = _upload(int(user.id), "20000000-0000-0000-0000-000000000002")
    expired = EphemeralUpload(
        **{
            **upload.__dict__,
            "expires_at": utc_iso(
                datetime.now(timezone.utc) - timedelta(seconds=1)
            ),
        }
    )
    get_upload_store().put(expired)
    response = _approve(client, "expired", expired.id)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "upload_expired_or_not_found"


def test_cross_owner_is_rejected_before_raw_upload_fetch(
    client, knowledge_enabled, monkeypatch
):
    owner = create_test_user("owner", email="owner@example.com")
    create_test_user("intruder", email="intruder@example.com")
    store = get_upload_store()
    upload = _upload(int(owner.id), "30000000-0000-0000-0000-000000000003")
    store.put(upload)
    original_get = store.get
    reads: list[str] = []

    def tracked_get(upload_id: str):
        reads.append(upload_id)
        return original_get(upload_id)

    monkeypatch.setattr(store, "get", tracked_get)
    response = _approve(client, "intruder", upload.id)
    assert response.status_code == 404
    assert reads == []


def test_repeated_approval_is_idempotent_and_content_free(
    client, knowledge_enabled, caplog
):
    user = create_test_user("repeat")
    upload = _upload(
        int(user.id),
        "40000000-0000-0000-0000-000000000004",
        text="do-not-return-this-private-body",
    )
    get_upload_store().put(upload)
    first = _approve(client, "repeat", upload.id)
    second = _approve(client, "repeat", upload.id)
    assert first.status_code == second.status_code == 201
    assert first.json()["document"]["id"] == second.json()["document"]["id"]
    assert "do-not-return-this-private-body" not in first.text
    assert set(first.json()) == {"document", "job"}
    assert "id" not in first.json()["job"]
    with SessionLocal() as session:
        documents = session.exec(select(WebKnowledgeDocument)).all()
        jobs = session.exec(select(Job).where(
            Job.job_type == "web_knowledge_ingest"
        )).all()
        assert len(documents) == 1
        assert len(jobs) == 1
        assert "do-not-return-this-private-body" not in jobs[0].payload_json
    assert "do-not-return-this-private-body" not in caplog.text


def test_source_version_update_invalidates_previous_document(
    client, knowledge_enabled
):
    user = create_test_user("version")
    first_upload = _upload(
        int(user.id), "50000000-0000-0000-0000-000000000005", text="version one"
    )
    get_upload_store().put(first_upload)
    first = _approve(client, "version", first_upload.id).json()["document"]
    second_upload = _upload(
        int(user.id), "50000000-0000-0000-0000-000000000006", text="version two"
    )
    get_upload_store().put(second_upload)
    second = _approve(
        client,
        "version",
        second_upload.id,
        replace_document_id=first["id"],
    )
    assert second.status_code == 201
    with SessionLocal() as session:
        previous = session.get(WebKnowledgeDocument, first["id"])
        current = session.get(
            WebKnowledgeDocument, second.json()["document"]["id"]
        )
        assert previous is not None and previous.status == "invalidated"
        assert current is not None and current.status == "indexing"
        assert previous.source_id == current.source_id
        assert previous.source_version != current.source_version


def test_list_status_reindex_delete_and_owner_isolation(
    client, knowledge_enabled
):
    owner = create_test_user("library-owner", email="library-owner@example.com")
    create_test_user("library-other", email="library-other@example.com")
    upload = _upload(
        int(owner.id), "60000000-0000-0000-0000-000000000006"
    )
    get_upload_store().put(upload)
    document = _approve(client, "library-owner", upload.id).json()["document"]

    assert client.get(
        f"/api/web/knowledge/{document['id']}",
        headers=auth_headers("library-other"),
    ).status_code == 404
    listing = client.get(
        "/api/web/knowledge", headers=auth_headers("library-owner")
    )
    assert listing.status_code == 200
    assert [item["id"] for item in listing.json()["items"]] == [document["id"]]

    operation_id = "70000000-0000-0000-0000-000000000007"
    first = client.post(
        f"/api/web/knowledge/{document['id']}/reindex",
        headers=auth_headers("library-owner"),
        json={"operation_id": operation_id},
    )
    second = client.post(
        f"/api/web/knowledge/{document['id']}/reindex",
        headers=auth_headers("library-owner"),
        json={"operation_id": operation_id},
    )
    assert first.status_code == second.status_code == 200
    assert first.json()["job"]["status"] == "queued"
    assert second.json()["job"]["status"] == "queued"
    with SessionLocal() as session:
        jobs = session.exec(select(Job).where(
            Job.user_id == int(owner.id),
            Job.job_type == "web_knowledge_ingest",
        )).all()
        # One approval ingest plus one idempotent re-index operation.
        assert len(jobs) == 2

    removed = client.delete(
        f"/api/web/knowledge/{document['id']}",
        headers=auth_headers("library-owner"),
    )
    assert removed.status_code == 204
    assert client.get(
        f"/api/web/knowledge/{document['id']}",
        headers=auth_headers("library-owner"),
    ).status_code == 404


def test_job_status_and_cancellation_hide_internal_identifiers(
    client, knowledge_enabled
):
    user = create_test_user("cancel")
    upload = _upload(
        int(user.id), "80000000-0000-0000-0000-000000000008"
    )
    get_upload_store().put(upload)
    document = _approve(client, "cancel", upload.id).json()["document"]
    status = client.get(
        f"/api/web/knowledge/{document['id']}/job",
        headers=auth_headers("cancel"),
    )
    assert status.status_code == 200
    assert status.json()["job"]["status"] == "queued"
    assert "id" not in status.json()["job"]

    cancelled = client.delete(
        f"/api/web/knowledge/{document['id']}/job",
        headers=auth_headers("cancel"),
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["job"]["status"] == "cancelled"
    status = client.get(
        f"/api/web/knowledge/{document['id']}",
        headers=auth_headers("cancel"),
    )
    assert status.json()["document"]["status"] == "failed"
    serialized = json.dumps(cancelled.json())
    assert "private source body" not in serialized
