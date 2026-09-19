from __future__ import annotations
import hashlib
import io
import json
import struct
from datetime import timedelta
from uuid import uuid4
import pytest
from PIL import Image
from sqlmodel import select
from app.auth import AuthUser, get_current_user
from app.main import app
from app.database import SessionLocal
from app.models import PaymentOrder, WalletLedger, WebChatMessage
from app.video import router as routes, service as svc, maintenance
from app.video.config import AUP_VERSION, VIDEO_CONSENT_VERSION, settings
from app.video.media import normalize_image, instructions, validate_mp4, sha
from app.video.models import VideoControl, VideoJob, VideoTemplate, VideoQuota, VideoOutbox, now
from app.billing.service import fulfill_payment_once, reverse_credit_for_refund
from tests.conftest import create_test_user


class MemoryMedia:
    """Test double only. Production VideoCache has no memory fallback."""
    def __init__(self): self.data = {}; self.expiries = {}
    def health(self): return {"available":True}
    def reserve(self,*args): pass
    def put(self,job,part,data,deadline):
        if (job,part) in self.data and self.data[job,part] != data: raise ValueError("changed")
        self.data[job,part]=data;self.expiries[job,part]=deadline
    def pin(self,job,roles,deadline):
        if any((job,role) not in self.data for role in roles): raise ValueError("expired")
        for role in roles: self.expiries[job,role]=deadline
    def get(self,job,part): return self.data.get((job,part))
    def delete_sources(self,job):
        for role in ("male","female"): self.data.pop((job,role),None)
    def delete(self,job):
        self.delete_sources(job);self.data.pop((job,"output"),None)
    def expire_output(self,job,deadline): self.expiries[job,"output"]=deadline
    def has_output(self,job): return (job,"output") in self.data
    def clear_output(self,job): self.data.pop((job,"output"),None)


@pytest.fixture
def video(monkeypatch, client):
    user=create_test_user("video-owner","video@example.com")
    auth=AuthUser(firebase_uid=user.firebase_uid,email=user.email,email_verified=True)
    app.dependency_overrides[get_current_user]=lambda:auth
    monkeypatch.setattr(svc,"video_policy_ready",lambda:True)  # isolated authorization fixture, NOT legal approval
    for key,value in {"ENABLED":"true","PAID_CHECKOUT_ENABLED":"true","UNLIMITED_EMAILS":user.email,"WORKER_TOKEN_SHA256":sha(b"test-worker-token")}.items():
        monkeypatch.setenv("SWICO_VIDEO_"+key,value)
    store=MemoryMedia()
    monkeypatch.setattr(routes,"cache",lambda:store)
    monkeypatch.setattr("app.video.cache.cache",lambda:store)
    monkeypatch.setattr(maintenance,"cache",lambda:store)
    metadata={"id":"couple-01","title":"Fixture (not approved real media)","warm_seconds":[10,12,13],"profile_sha256":"a"*64,
              "calibration_schema":2,"runtime_sha256":"b"*64,"qa_evidence_sha256":"c"*64}
    with SessionLocal() as session:
        session.add(VideoControl(worker_seen_at=now(),worker_boot="test-boot-identity",capabilities_json=json.dumps({"ready":True,"native_inference_verified":True,"profile_hash":"a"*64,
                    "calibration_schema":2,"runtime_sha256":"b"*64,"calibrations":{"couple-01":"c"*64,"couple-02":"c"*64}})))
        session.add(VideoTemplate(id="couple-01",title=metadata["title"],manifest_hash="a"*64,metadata_json=json.dumps(metadata)))
        session.add(VideoTemplate(id="couple-02",title=metadata["title"],manifest_hash="a"*64,metadata_json=json.dumps({**metadata,"id":"couple-02"})))
        session.commit()
    yield client,user,auth,store
    app.dependency_overrides.pop(get_current_user,None)


def headers(job=None):
    result={"Authorization":"Bearer test-worker-token","X-Worker-Id":"intel-mac-01","X-Worker-Boot":"test-boot-identity"}
    if job:
        result.update({"X-Video-Fence":job["fence"],"X-Video-Attempt":str(job["attempt"])})
        if job.get("provenance_id"):
            result.update({"X-Video-Provenance":job["provenance_id"],"X-Video-Disclosure":"swico-ai-edited-v1"})
    return result


def image():
    stream=io.BytesIO();Image.new("RGB",(128,128),"white").save(stream,format="PNG");return stream.getvalue()


def create(client,key=None):
    response=client.post("/api/web/videos/jobs",json=consent_payload(key or str(uuid4()), "swap: male\nenhance: off"))
    assert response.status_code==201,response.text
    job=response.json()
    assert client.put(f"/api/web/videos/jobs/{job['id']}/photos/male",content=image()).status_code==200
    assert client.post(f"/api/web/videos/jobs/{job['id']}/preflight").status_code==200
    claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    assert claim["id"]==job["id"]
    assert client.post(f"/api/video-worker/v1/jobs/{job['id']}/complete",headers=headers(claim),json={"outcome":"valid"}).status_code==200
    return job["id"]


def consent_payload(request_key, instructions="swap: both\nenhance: off", **overrides):
    payload={"template_id":"couple-01","request_key":request_key,"instructions":instructions,"consent":True,"adult":True,
             "source_faces_adult":True,"source_face_permission":True,"source_photo_rights":True,
             "synthetic_media_acknowledged":True,"prohibited_use_acknowledged":True,
             "retention_acknowledged":True,"disclosure_acknowledged":True,
             "policy_version":AUP_VERSION,"consent_version":VIDEO_CONSENT_VERSION}
    payload.update(overrides)
    return payload


def mp4():
    # Structural fixture only; NEVER native inference/container decoder evidence.
    return b"".join(struct.pack(">I4s",8+len(v),k)+v for k,v in [(b"ftyp",b"isom0000"),(b"moov",b"videavc1"),(b"mdat",b"fixture")])


def test_source_face_consent_is_complete_and_versioned_before_job_creation(video):
    client, _, _, _ = video
    payload = consent_payload(str(uuid4()))
    payload.pop("source_photo_rights")
    response = client.post("/api/web/videos/jobs", json=payload)
    assert response.status_code == 422


def test_stale_source_face_consent_cannot_be_admitted_or_charged(video):
    client, _, _, _ = video
    job_id = create(client)
    with SessionLocal() as session:
        row = session.get(VideoJob, job_id)
        frozen = json.loads(row.frozen_json)
        frozen["consent"]["version"] = "video-source-consent-old"
        row.frozen_json = json.dumps(frozen)
        session.add(row)
        session.commit()
    response = client.post(f"/api/web/videos/jobs/{job_id}/admit", json={"funding":"paid"})
    assert response.status_code == 409
    with SessionLocal() as session:
        assert not session.exec(select(PaymentOrder)).all()


def test_worker_output_requires_job_bound_disclosure_and_provenance(video):
    client, _, _, _ = video
    job_id = create(client)
    assert client.post(f"/api/web/videos/jobs/{job_id}/admit", json={"funding":"complimentary"}).status_code == 200
    claim = client.post("/api/video-worker/v1/claim", headers=headers()).json()["job"]
    assert claim["provenance_id"].startswith("swico-v1-")
    assert client.put(f"/api/video-worker/v1/jobs/{job_id}/output", headers={**headers(claim), "X-Video-Provenance":"swico-v1-000000000000000000000000"}, content=mp4()).status_code == 422
    assert client.put(f"/api/video-worker/v1/jobs/{job_id}/output", headers=headers(claim), content=mp4()).status_code == 200


def test_complete_free_delivery_and_immutable_expiry(video,monkeypatch):
    client,user,auth,store=video
    job=create(client)
    result=client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"})
    assert result.status_code==200,result.text
    claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    output=client.put(f"/api/video-worker/v1/jobs/{job}/output",headers=headers(claim),content=mp4())
    assert output.status_code==200,output.text
    completed=client.post(f"/api/video-worker/v1/jobs/{job}/complete",headers=headers(claim),json={"outcome":"ready","sha256":sha(mp4())})
    assert completed.status_code==200,completed.text
    expiry=completed.json()["expires_at"]
    repeated=client.post(f"/api/video-worker/v1/jobs/{job}/complete",headers=headers(claim),json={"outcome":"ready","sha256":sha(mp4())})
    assert repeated.json()["expires_at"]==expiry
    monkeypatch.setenv("SWICO_VIDEO_ENABLED","false")
    response=client.get(f"/api/web/videos/jobs/{job}/media",headers={"Range":"bytes=0-7"})
    assert response.status_code==206
    assert response.headers["cache-control"]=="private, no-store"
    assert (job,"male") not in store.data
    with SessionLocal() as session:
        assert len(session.exec(select(WebChatMessage)).all())==1
        assert session.exec(select(WebChatMessage)).one().charge_micros==0
        assert len(session.exec(select(VideoOutbox)).all())==1
        assert not session.exec(select(WalletLedger)).all()
        row=session.get(VideoJob,job);row.expires_at=now()-timedelta(seconds=1);session.add(row);session.commit()
    assert client.get(f"/api/web/videos/jobs/{job}/media").status_code==410


@pytest.mark.parametrize("verified,email",[(False,"video@example.com"),(True,"forged@example.com"),(True,None)])
def test_verified_owned_email_boundary(video,verified,email):
    client,user,_,_=video
    app.dependency_overrides[get_current_user]=lambda:AuthUser(firebase_uid=user.firebase_uid,email=email,email_verified=verified)
    assert client.get("/api/web/videos/capabilities").status_code==403


def test_non_owner_media_and_worker_token(video):
    client,_,_,_=video
    job=create(client)
    second=create_test_user("other","other@example.com")
    app.dependency_overrides[get_current_user]=lambda:AuthUser(firebase_uid=second.firebase_uid,email=second.email,email_verified=True)
    assert client.get(f"/api/web/videos/jobs/{job}").status_code==404
    assert client.get(f"/api/web/videos/jobs/{job}/media",headers={"Range":"bytes=0-7"}).status_code==404
    assert client.post("/api/video-worker/v1/claim").status_code==401


def test_fenced_cancel_after_admission_shutdown(video,monkeypatch):
    client,_,_,_=video;job=create(client)
    client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"})
    claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    monkeypatch.setenv("SWICO_VIDEO_ENABLED","false")
    assert client.post(f"/api/web/videos/jobs/{job}/cancel").status_code==200
    assert client.post(f"/api/video-worker/v1/jobs/{job}/heartbeat",headers=headers(claim),json={"phase":"swap","percent":50}).status_code==409
    assert client.put(f"/api/video-worker/v1/jobs/{job}/output",headers=headers(claim),content=mp4()).status_code==409


def test_tester_quota_restore_exactly_once_no_wallet(video,monkeypatch):
    _,user,auth,_=video
    monkeypatch.setenv("SWICO_VIDEO_UNLIMITED_EMAILS","")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED","true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS",user.email)
    with SessionLocal() as session:
        jobs=[]
        for index in range(5):
            job=VideoJob(user_id=user.id,request_key=str(index),request_hash="a"*64,email=user.email,template_id="couple-01",manifest_hash="a"*64,frozen_json='{}',deadline=now()+timedelta(hours=1))
            svc.reserve_allowance(session,job,auth,user);session.add(job);session.flush();jobs.append(job)
        assert svc.allowance(session,auth,user)["remaining"]==0
        with pytest.raises(Exception): svc.reserve_allowance(session,jobs[0],auth,user)
        svc.restore_allowance(session,jobs[0],infrastructure=True);svc.restore_allowance(session,jobs[0],infrastructure=True)
        assert svc.allowance(session,auth,user)["remaining"]==1
        assert session.exec(select(VideoQuota)).one().used==4
        assert not session.exec(select(WalletLedger)).all()


def test_captured_video_never_wallet_and_refund_never_resurrects(video,monkeypatch):
    client,user,_,_=video
    monkeypatch.setattr("app.video.router.RazorpayClient.create_order",lambda *args:{"id":"order_video","amount":2500,"currency":"INR"})
    job_id=create(client)
    response=client.post(f"/api/web/videos/jobs/{job_id}/admit",json={"funding":"paid"})
    assert response.status_code==200,response.text
    with SessionLocal() as session:
        job=session.get(VideoJob,job_id);order=session.get(PaymentOrder,job.payment_id)
        assert order.credit_bucket is None
        order.provider_payment_id="pay_video";order.status="captured"
        fulfill_payment_once(session,order);fulfill_payment_once(session,order);session.commit()
        assert job.state=="queued"
        assert len(session.exec(select(WebChatMessage)).all())==1
        assert not session.exec(select(WalletLedger)).all()
        reverse_credit_for_refund(session,order,2500);fulfill_payment_once(session,order);session.commit()
        assert job.state=="refunded"
        assert order.credited_amount_micros==0


def test_late_capture_compensates_and_ambiguous_refund_not_reposted(video,monkeypatch):
    client,_,_,store=video
    monkeypatch.setattr("app.video.router.RazorpayClient.create_order",lambda *args:{"id":"order_late","amount":2500,"currency":"INR"})
    job_id=create(client);client.post(f"/api/web/videos/jobs/{job_id}/admit",json={"funding":"paid"})
    store.delete(job_id)
    with SessionLocal() as session:
        job=session.get(VideoJob,job_id);order=session.get(PaymentOrder,job.payment_id);order.provider_payment_id="pay_late";order.status="captured"
        fulfill_payment_once(session,order);session.commit()
        assert job.state=="refund_pending"
    calls=[]
    monkeypatch.setattr("app.video.maintenance.RazorpayClient.fetch_payment_refunds",lambda *args:{"items":[]})
    def ambiguous(*args): calls.append(1);raise TimeoutError()
    monkeypatch.setattr("app.video.maintenance.RazorpayClient.create_refund",ambiguous)
    maintenance.deliver_one()
    with SessionLocal() as session:
        intent=session.exec(select(VideoOutbox)).one();assert intent.state=="ambiguous";intent.due_at=now()-timedelta(seconds=1);session.add(intent);session.commit()
    maintenance.deliver_one()
    assert len(calls)==1
    with SessionLocal() as session: assert session.exec(select(VideoOutbox)).one().state=="manual_review"


@pytest.mark.parametrize("value",["make them dance","swap: stranger","caption: ok\nlocation: beach","swap: male\nswap: female","caption: "+"x"*101])
def test_prompt_grammar_rejects_unsupported(value):
    with pytest.raises(ValueError):instructions(value)


@pytest.mark.parametrize("data",[b"<svg></svg>",b"GIF89a",b"x"*(5*1024*1024+1)])
def test_reject_unsafe_photos(data):
    with pytest.raises(Exception):normalize_image(data)


def test_normalization_and_mp4_structure():
    normalized=normalize_image(image())
    assert normalized.startswith(b"\xff\xd8")
    assert not Image.open(io.BytesIO(normalized)).getexif()
    validate_mp4(mp4())
    with pytest.raises(ValueError):validate_mp4(mp4()[:-2])


def test_unknown_payment_product_fails_closed(video):
    _,user,_,_=video
    order=PaymentOrder(user_id=user.id,receipt="unknown",gross_amount_paise=2500,credited_amount_micros=0,platform_share_paise=0,purchase_type="unknown")
    with SessionLocal() as session:
        with pytest.raises(Exception):fulfill_payment_once(session,order)
        with pytest.raises(Exception):reverse_credit_for_refund(session,order,2500)


def paid_fixture(video, monkeypatch):
    client, _, _, _ = video
    monkeypatch.setattr("app.video.router.RazorpayClient.create_order",lambda *args:{"id":"order_video","amount":2500,"currency":"INR"})
    job = create(client)
    response = client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"paid"})
    assert response.status_code == 200
    order = response.json()["checkout"]["internal_order_id"]
    payment = {"id":"pay_video", "order_id":"order_video", "amount":2500, "currency":"INR", "status":"captured"}
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_payment", lambda *args: payment)
    import hmac
    body = {"internal_order_id":order,"razorpay_order_id":"order_video","razorpay_payment_id":"pay_video",
            "razorpay_signature":hmac.new(b"test_checkout_secret",b"order_video|pay_video",hashlib.sha256).hexdigest()}
    return job, payment, body


@pytest.mark.parametrize("change",[{"amount":2400},{"currency":"USD"},{"id":"pay_wrong"},{"order_id":"order_wrong"},{"status":"authorized"}])
def test_shared_verify_rejects_video_payment_mismatch(video,monkeypatch,change):
    client, _, _, _ = video
    job,payment,body = paid_fixture(video,monkeypatch)
    payment.update(change)
    response = client.post("/api/web/billing/verify",json=body)
    if change.get("status") == "authorized":
        assert response.status_code == 200
        assert response.json() == {"status":"pending", "credited":False}
    else:
        assert response.status_code in {400,409}
    with SessionLocal() as session:
        assert session.get(VideoJob,job).state == "checkout"
        assert not session.exec(select(WalletLedger)).all()


def test_shared_verify_webhooks_and_refund_replay_video_no_credit(video,monkeypatch):
    from tests.test_web_billing import _webhook
    client, _, _, _ = video
    job,payment,body = paid_fixture(video,monkeypatch)
    for _ in range(2):
        response=client.post("/api/web/billing/verify",json=body)
        assert response.status_code==200,response.text
        assert response.json()["credited"] is False
    captured={"event":"payment.captured","payload":{"payment":{"entity":payment}}}
    assert _webhook(client,"video-captured",captured).status_code==200
    for identity,amount in [("rfnd_partial",500),("rfnd_rest",2000),("rfnd_rest",2000)]:
        event={"event":"refund.processed","payload":{"refund":{"entity":{"id":identity,"payment_id":"pay_video","amount":amount,"currency":"INR"}}}}
        assert _webhook(client,str(uuid4()),event).status_code==200
    assert _webhook(client,"video-late-capture",captured).status_code==200
    with SessionLocal() as session:
        assert session.get(VideoJob,job).state=="refunded"
        assert len(session.exec(select(WebChatMessage)).all())==1
        assert session.exec(select(PaymentOrder)).one().refunded_amount_paise==2500
        assert not session.exec(select(WalletLedger)).all()


def test_video_refund_before_capture_and_order_paid_recovery(video,monkeypatch):
    from tests.test_web_billing import _webhook
    client, _, _, _ = video
    job,payment,_=paid_fixture(video,monkeypatch)
    event={"event":"refund.processed","payload":{"payment":{"entity":payment},"refund":{"entity":{"id":"rfnd_early","payment_id":"pay_video","amount":2500,"currency":"INR"}}}}
    assert _webhook(client,"video-early-refund",event).status_code==200
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_order_payments",lambda *args:{"items":[payment]})
    assert _webhook(client,"video-order-paid",{"event":"order.paid","payload":{"order":{"entity":{"id":"order_video","amount_paid":2500,"currency":"INR","status":"paid"}}}}).status_code==200
    with SessionLocal() as session:
        assert session.get(VideoJob,job).state=="refunded"
        assert not session.exec(select(WalletLedger)).all()


def test_daily_midnight_rollover_keeps_old_reservation_day(video,monkeypatch):
    from datetime import datetime,timezone
    client,user,auth,_=video
    monkeypatch.setenv("SWICO_VIDEO_UNLIMITED_EMAILS","")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED","true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS",user.email)
    monkeypatch.setattr(svc,"now",lambda:datetime(2026,9,18,18,29,59,tzinfo=timezone.utc))
    with SessionLocal() as session:
        job=VideoJob(user_id=user.id,request_key="midnight",request_hash="a"*64,email=user.email,template_id="couple-01",manifest_hash="a"*64,frozen_json='{}',deadline=now()+timedelta(hours=1))
        svc.reserve_allowance(session,job,auth,user)
        assert svc.allowance(session,auth,user)["remaining"]==4
        monkeypatch.setattr(svc,"now",lambda:datetime(2026,9,18,18,30,0,tzinfo=timezone.utc))
        assert svc.allowance(session,auth,user)["remaining"]==5
        svc.restore_allowance(session,job,infrastructure=True)
        assert session.exec(select(VideoQuota)).one().day=="2026-09-18"
        assert session.exec(select(VideoQuota)).one().used==0


def test_profile_change_after_preflight_blocks_new_payment(video):
    client, _, _, _ = video
    job=create(client)
    with SessionLocal() as session:
        row=session.get(VideoControl,1);metadata=json.loads(row.capabilities_json);metadata["profile_hash"]="b"*64
        row.capabilities_json=json.dumps(metadata);session.add(row);session.commit()
    assert client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"paid"}).status_code==409


@pytest.mark.parametrize("field,value",[("runtime_sha256","d"*64),("calibration_schema",1),("qa_evidence_sha256","e"*64)])
def test_stale_published_runtime_disables_new_requests_without_affecting_owner_control(video,field,value):
    client,_,_,_=video
    job=create(client)
    with SessionLocal() as session:
        template=session.get(VideoTemplate,"couple-01")
        data=json.loads(template.metadata_json);data[field]=value;template.metadata_json=json.dumps(data)
        session.add(template);session.commit()
    assert client.get("/api/web/videos/capabilities").json()["available"] is False
    response=client.post("/api/web/videos/jobs",json=consent_payload(str(uuid4())))
    assert response.status_code==503
    assert client.get(f"/api/web/videos/jobs/{job}").status_code==200
    assert client.post(f"/api/web/videos/jobs/{job}/cancel").status_code==200
    with SessionLocal() as session: assert not session.exec(select(PaymentOrder)).all()


def test_worker_health_authentication_is_independent_of_flags_and_control_row(video,monkeypatch):
    client,_,_,_=video
    monkeypatch.setenv("SWICO_VIDEO_ENABLED","false")
    monkeypatch.setenv("SWICO_VIDEO_PAID_CHECKOUT_ENABLED","false")
    with SessionLocal() as session:
        session.delete(session.get(VideoControl,1));session.commit()
    response=client.get("/api/video-worker/v1/health",headers=headers())
    assert response.status_code==200
    assert response.json()=={"authenticated":True,"schema_ready":True,"control_initialized":False,"worker_active":False,"templates_current":False}
    assert client.get("/api/video-worker/v1/health",headers={**headers(),"Authorization":"Bearer wrong"}).status_code==401


def test_old_worker_heartbeat_refused_and_readiness_can_be_withdrawn(video):
    client,_,_,_=video
    old={"boot_id":"test-boot-identity","ready":True,"native_inference_verified":True,"revision":"test","profile_hash":"a"*64,"disk_free_bytes":3000000000}
    assert client.post("/api/video-worker/v1/heartbeat",headers=headers(),json=old).status_code==422
    current={**old,"ready":False,"native_inference_verified":False,"calibration_schema":2,"runtime_sha256":"b"*64,"calibrations":{}}
    assert client.post("/api/video-worker/v1/heartbeat",headers=headers(),json=current).status_code==200
    assert not client.get("/api/web/videos/capabilities").json()["available"]


@pytest.mark.parametrize("timing",[float("nan"),float("inf"),-1,0,5000])
def test_publication_rejects_invalid_or_impossible_timings_with_checkout_disabled(video,monkeypatch,timing):
    client,_,_,_=video
    monkeypatch.setenv("SWICO_VIDEO_ENABLED","false")
    monkeypatch.setenv("SWICO_VIDEO_PAID_CHECKOUT_ENABLED","false")
    payload={"id":"couple-01","title":"Fixture only","template_sha256":"a"*64,"tracks_sha256":"a"*64,"profile_sha256":"a"*64,
             "rights_evidence_sha256":"a"*64,"qa_evidence_sha256":"c"*64,"runtime_sha256":"b"*64,"calibration_schema":2,
             "warm_seconds":[10,11,12,10,11,12],"cold_seconds":[15,15],"startup_seconds":2,"duration_seconds":5,
             "width":640,"height":480,"profile":"quality-cpu"}
    assert client.post("/api/video-worker/v1/templates",headers=headers(),json=payload).status_code==200
    payload["warm_seconds"][0]=timing
    assert client.post("/api/video-worker/v1/templates",headers={**headers(),"Content-Type":"application/json"},content=json.dumps(payload)).status_code==422


def test_queued_job_stale_runtime_restores_allowance_without_render(video,monkeypatch):
    client,user,auth,_=video
    monkeypatch.setenv("SWICO_VIDEO_UNLIMITED_EMAILS","")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED","true")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_EMAILS",user.email)
    job=create(client)
    assert client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"}).status_code==200
    with SessionLocal() as session:
        row=session.get(VideoControl,1);caps=json.loads(row.capabilities_json);caps["runtime_sha256"]="e"*64
        row.capabilities_json=json.dumps(caps);session.add(row);session.commit()
    assert client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"] is None
    with SessionLocal() as session:
        assert session.get(VideoJob,job).quota_state=="restored"
        assert session.exec(select(VideoQuota)).one().used==0


def test_busy_preflight_included_in_queue_estimate_and_paid_queue_claims_first(video):
    client,user,auth,_=video
    job=create(client)
    client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"})
    with SessionLocal() as session:
        original=session.get(VideoJob,job)
        busy=VideoJob(user_id=user.id,request_key=str(uuid4()),request_hash="f"*64,email=user.email,template_id="couple-01",
                      manifest_hash=original.manifest_hash,frozen_json=original.frozen_json,state="preflighting",deadline=now()+timedelta(seconds=100))
        session.add(busy);session.commit()
        busy_id=busy.id
    estimate=client.get(f"/api/web/videos/jobs/{job}").json()["eta_seconds"]
    assert estimate[1]>=100
    assert client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"] is None
    with SessionLocal() as session:
        busy=session.get(VideoJob,busy_id);busy.state="preflight_queued";session.add(busy);session.commit()
    assert client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]["id"]==job
    with SessionLocal() as session: assert not session.exec(select(PaymentOrder)).all()


def test_unapproved_video_policy_never_reuses_existing_chat_approval(video,monkeypatch):
    from app.video.policy import video_policy_ready
    assert video_policy_ready() is False  # Repository proposal is explicitly unapproved.
    monkeypatch.setattr(svc,"video_policy_ready",lambda:False)
    client,_,_,_=video
    assert client.get("/api/web/videos/capabilities").json()["available"] is False
    response=client.post("/api/web/videos/jobs",json=consent_payload("policy-blocked", "swap: male"))
    assert response.status_code==503


def test_capabilities_distinguish_configured_paid_from_effectively_available(video,monkeypatch):
    client,_,_,_=video
    monkeypatch.setattr(svc,"video_policy_ready",lambda:False)
    capabilities=client.get("/api/web/videos/capabilities").json()
    assert capabilities["paid_enabled"] is True
    assert capabilities["paid_configured"] is True
    assert capabilities["paid_available"] is False
    assert capabilities["available"] is False


def test_exhausted_allowance_does_not_extend_unpaid_photo_ttl(video,monkeypatch):
    client,_,_,store=video
    job=create(client)
    original=store.expiries[job,"male"]
    monkeypatch.setenv("SWICO_VIDEO_UNLIMITED_EMAILS","")
    monkeypatch.setenv("SWICO_WEEKLY_TESTER_CREDITS_ENABLED","false")
    assert client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"complimentary"}).status_code==409
    assert store.expiries[job,"male"]==original


def test_cache_sweep_failure_does_not_block_refund_email_processing(monkeypatch):
    from unittest.mock import Mock
    stop=Mock();stop.wait.side_effect=[False,True]
    monkeypatch.setattr(maintenance,"_stop",stop)
    def failed_sweep():raise RuntimeError("isolated fixture cache outage")
    delivered=[]
    monkeypatch.setattr(maintenance,"sweep",failed_sweep)
    monkeypatch.setattr(maintenance,"deliver_one",lambda:delivered.append(True))
    maintenance._loop()
    assert delivered==[True]


def test_transfer_limit_is_video_only_and_released_after_failure():
    import asyncio
    from app.video.transfers import VideoTransferLimit
    entered=[]
    async def endpoint(scope,receive,send):
        entered.append(scope["path"])
        raise RuntimeError("simulated disconnect")
    async def run():
        limiter=VideoTransferLimit(endpoint)
        async def receive():return {"type":"http.disconnect"}
        messages=[]
        async def send(message):messages.append(message)
        scope={"type":"http","path":"/api/web/videos/jobs/id/media"}
        limiter.slots.acquire();limiter.slots.acquire()
        await limiter(scope,receive,send)
        assert messages[0]["status"]==503 and not entered
        with pytest.raises(RuntimeError):await limiter({"type":"http","path":"/api/web/chat"},receive,send)
        limiter.slots.release();limiter.slots.release()
        with pytest.raises(RuntimeError):await limiter(scope,receive,send)
        assert limiter.slots.acquire(False) and limiter.slots.acquire(False)
    asyncio.run(run())


def test_email_retry_does_not_reset_expiry_or_regenerate(video,monkeypatch):
    client,_,_,_=video
    job_id=create(client)
    client.post(f"/api/web/videos/jobs/{job_id}/admit",json={"funding":"complimentary"})
    claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    client.put(f"/api/video-worker/v1/jobs/{job_id}/output",headers=headers(claim),content=mp4())
    result=client.post(f"/api/video-worker/v1/jobs/{job_id}/complete",headers=headers(claim),json={"outcome":"ready","sha256":sha(mp4())}).json()
    calls=[]
    class Sender:
        def send(self,**values):
            calls.append(values)
            if len(calls)==1:raise TimeoutError()
    monkeypatch.setattr(maintenance,"get_email_sender",lambda:Sender())
    maintenance.deliver_one()
    with SessionLocal() as session:
        intent=session.exec(select(VideoOutbox)).one();assert intent.state=="pending"
        intent.due_at=now()-timedelta(seconds=1);session.add(intent);session.commit()
    maintenance.deliver_one()
    assert len(calls)==2 and calls[0]["message_id"]==calls[1]["message_id"]
    assert calls[0]["to_email"]=="video@example.com"
    assert "/?video="+job_id in calls[0]["text_body"]
    assert client.get(f"/api/web/videos/jobs/{job_id}").json()["expires_at"]==result["expires_at"]
    with SessionLocal() as session:
        assert len(session.exec(select(WebChatMessage)).all())==1


def test_expired_lease_is_fenced_and_retried_with_same_funding(video):
    client,_,_,_=video;job_id=create(client)
    client.post(f"/api/web/videos/jobs/{job_id}/admit",json={"funding":"complimentary"})
    claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    with SessionLocal() as session:
        job=session.get(VideoJob,job_id);job.lease_until=now()-timedelta(seconds=1);session.add(job);session.commit()
    maintenance.sweep()
    next_claim=client.post("/api/video-worker/v1/claim",headers=headers()).json()["job"]
    assert next_claim["attempt"]==claim["attempt"]+1
    assert client.post(f"/api/video-worker/v1/jobs/{job_id}/heartbeat",headers=headers(claim),json={"phase":"swap","percent":50}).status_code==409


def test_paid_callback_validates_capture_and_shared_webhook_idempotency(video,monkeypatch):
    import hmac
    client,_,_,_=video
    monkeypatch.setattr("app.video.router.RazorpayClient.create_order",lambda *args:{"id":"order_http","amount":2500,"currency":"INR"})
    job=create(client);response=client.post(f"/api/web/videos/jobs/{job}/admit",json={"funding":"paid"}).json()
    order=response["checkout"]["internal_order_id"]
    monkeypatch.setenv("RAZORPAY_KEY_SECRET","test-secret")
    signature=hmac.new(b"test-secret",b"order_http|pay_http",hashlib.sha256).hexdigest()
    captured={"id":"pay_http","order_id":"order_http","amount":2500,"currency":"INR","status":"authorized"}
    monkeypatch.setattr("app.web_api.router.RazorpayClient.fetch_payment",lambda *args:captured)
    payload={"internal_order_id":order,"razorpay_order_id":"order_http","razorpay_payment_id":"pay_http","razorpay_signature":signature}
    assert client.post("/api/web/billing/verify",json=payload).json()["credited"] is False
    assert client.get(f"/api/web/videos/jobs/{job}").json()["state"]=="checkout"
    captured["status"]="captured";captured["amount"]=2499
    assert client.post("/api/web/billing/verify",json=payload).status_code==400
    captured["amount"]=2500
    assert client.post("/api/web/billing/verify",json=payload).json()["purchase_type"]=="video_template"
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET","webhook-test")
    event={"event":"payment.captured","payload":{"payment":{"entity":captured}}}
    raw=json.dumps(event).encode();sig=hmac.new(b"webhook-test",raw,hashlib.sha256).hexdigest()
    for event_id in ("event-one","event-one","event-two"):
        response=client.post("/api/web/billing/razorpay/webhook",content=raw,headers={"x-razorpay-event-id":event_id,"x-razorpay-signature":sig})
        assert response.status_code==200,response.text
    with SessionLocal() as session:
        assert len(session.exec(select(WebChatMessage)).all())==1
        assert not session.exec(select(WalletLedger)).all()
