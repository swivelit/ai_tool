"""Real PostgreSQL transactions; never accepted as in-memory concurrency evidence."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4
import pytest
from fastapi import HTTPException
from sqlmodel import select
from app.database import SessionLocal, engine
from app.video import service as svc
from app.video.models import VideoJob, VideoQuota, VideoOutbox, now
from app.models import PaymentOrder, WalletLedger, WebChatMessage
from tests.test_website_video import video, create, headers, mp4, sha, paid_fixture  # noqa: F401

pytestmark=pytest.mark.skipif(engine.dialect.name!="postgresql",reason="Requires explicit disposable PostgreSQL TEST_DATABASE_URL")


def test_postgres_six_concurrent_daily_reservations_grant_five(video,monkeypatch):
    _,user,auth,_=video
    monkeypatch.setenv("SWICO_VIDEO_UNLIMITED_EMAILS","")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED","true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS",user.email)
    def reserve(_):
        with SessionLocal() as session:
            svc.control(session)
            job=VideoJob(user_id=user.id,request_key=str(uuid4()),request_hash="a"*64,email=user.email,template_id="couple-01",manifest_hash="a"*64,frozen_json='{}',deadline=now()+timedelta(hours=1))
            try:
                svc.reserve_allowance(session,job,auth,user)
            except HTTPException:
                session.rollback();return False
            session.add(job);session.commit();return True
    with ThreadPoolExecutor(max_workers=6) as pool: result=list(pool.map(reserve,range(6)))
    assert result.count(True)==5
    with SessionLocal() as session: assert session.exec(select(VideoQuota)).one().used==5


def test_postgres_two_workers_cannot_claim_same_or_parallel_render(video):
    client,_,_,_=video
    job=create(client)
    assert client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"}).status_code==200
    with ThreadPoolExecutor(max_workers=2) as pool:
        result=list(pool.map(lambda _:client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"],range(2)))
    assert len([value for value in result if value])==1
    with SessionLocal() as session:
        row=session.get(VideoJob,job)
        assert row.state=="processing" and row.attempt==2


def test_postgres_duplicate_completion_has_one_ready_window_and_outbox(video):
    client,_,_,_=video
    job=create(client)
    client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"})
    claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    assert client.put(f"/api/video-worker/v1/jobs/{job}/output",headers=headers(claim),content=mp4()).status_code==200
    def complete(_):
        return client.post(f"/api/video-worker/v1/jobs/{job}/complete",headers=headers(claim),json={"outcome":"ready","sha256":sha(mp4())})
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(complete,range(2)))
    assert [r.status_code for r in results]==[200,200]
    assert results[0].json()["expires_at"]==results[1].json()["expires_at"]
    with SessionLocal() as session:
        assert len(session.exec(select(VideoOutbox)).all())==1
        assert len(session.exec(select(WebChatMessage)).all())==1


def test_postgres_video_checkout_callback_webhook_race_no_wallet(video,monkeypatch):
    from tests.test_web_billing import _webhook
    client,_,_,_=video
    job,payment,body=paid_fixture(video,monkeypatch)
    def complete(index):
        if index:
            return _webhook(client,"race-capture",{"event":"payment.captured","payload":{"payment":{"entity":payment}}})
        return client.post("/api/web/billing/verify",json=body)
    with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(complete,range(2)))
    assert [r.status_code for r in results]==[200,200]
    with SessionLocal() as session:
        assert session.get(VideoJob,job).state=="queued"
        assert len(session.exec(select(WebChatMessage)).all())==1
        assert session.exec(select(PaymentOrder)).one().credited_amount_micros==0
        assert not session.exec(select(WalletLedger)).all()
