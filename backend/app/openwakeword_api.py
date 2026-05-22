from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse

from .auth import AuthUser, get_current_user, get_owned_user
from .database import get_session
from sqlmodel import Session

from .openwakeword_support import (
    AudioDecodeError,
    EnrollmentValidationError,
    OpenWakeWordNotInstalledError,
    OpenWakeWordSupport,
    TrainingNotSupportedError,
    write_upload_to_tempfile,
)

router = APIRouter(prefix="/api/openwakeword", tags=["openwakeword"])
service = OpenWakeWordSupport()

MAX_WAKEWORD_UPLOAD_BYTES = int(os.getenv("MAX_WAKEWORD_UPLOAD_BYTES", str(10 * 1024 * 1024)))
ALLOWED_WAKEWORD_CONTENT_TYPES = {
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/aac",
    "audio/webm",
    "application/octet-stream",
}


async def read_limited_upload(file: UploadFile) -> bytes:
    content_type = str(file.content_type or "").split(";")[0].strip().lower()
    if content_type and content_type not in ALLOWED_WAKEWORD_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported file type")
    data = await file.read(MAX_WAKEWORD_UPLOAD_BYTES + 1)
    if len(data) > MAX_WAKEWORD_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large")
    return data


def owned_user_id(session: Session, auth_user: AuthUser) -> int:
    return int(get_owned_user(session, auth_user).id)



@router.post("/enrollment/reset")
async def reset_openwakeword_enrollment(
    wake_phrase: str = Query(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    try:
        return service.reset(user_id, wake_phrase)
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/enrollment/status")
def get_openwakeword_enrollment_status(
    wake_phrase: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    try:
        return service.status(user_id, wake_phrase)
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/enrollment/model/status")
def get_openwakeword_model_status(
    wake_phrase: str = Query(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    try:
        return service.model_bundle_status(user_id, wake_phrase)
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/enrollment/model/download")
def download_openwakeword_model_bundle(
    wake_phrase: str = Query(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    try:
        bundle_path = service.build_model_bundle(user_id, wake_phrase)
        return FileResponse(
            path=str(bundle_path),
            media_type="application/zip",
            filename=bundle_path.name,
        )
    except OpenWakeWordNotInstalledError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TrainingNotSupportedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/enrollment/sample")
async def upload_openwakeword_sample(
    wake_phrase: str = Query(...),
    sample_kind: str = Query(..., pattern="^(positive|negative)$"),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    suffix = os.path.splitext(file.filename or "")[-1] or ".bin"
    temp_path = write_upload_to_tempfile(await read_limited_upload(file), suffix)

    try:
        return service.save_sample(
            user_id=user_id,
            wake_phrase=wake_phrase,
            sample_kind=sample_kind,  # type: ignore[arg-type]
            source_path=temp_path,
            source_filename=file.filename or f"sample{suffix}",
        )
    except AudioDecodeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


@router.post("/enrollment/finalize")
def finalize_openwakeword_enrollment(
    wake_phrase: str = Query(...),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    try:
        return service.finalize(user_id=user_id, wake_phrase=wake_phrase)
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OpenWakeWordNotInstalledError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TrainingNotSupportedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/enrollment/activate")
def activate_custom_openwakeword_phrase(
    wake_phrase: str = Query(...),
    custom_model_path: Optional[str] = Query(default=None),
    notes: Optional[str] = Query(default=None),
    session: Session = Depends(get_session),
    auth_user: AuthUser = Depends(get_current_user),
):
    user_id = owned_user_id(session, auth_user)
    try:
        return service.activate_custom_phrase(
            user_id=user_id,
            wake_phrase=wake_phrase,
            custom_model_path=custom_model_path,
            notes=notes,
        )
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
