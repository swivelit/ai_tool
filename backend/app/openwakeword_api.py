from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

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


@router.post("/enrollment/reset")
async def reset_openwakeword_enrollment(
    user_id: int = Query(...),
    wake_phrase: str = Query(...),
):
    try:
        return service.reset(user_id, wake_phrase)
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/enrollment/status")
def get_openwakeword_enrollment_status(
    user_id: int = Query(...),
    wake_phrase: Optional[str] = Query(default=None),
):
    try:
        return service.status(user_id, wake_phrase)
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/enrollment/sample")
async def upload_openwakeword_sample(
    user_id: int = Query(...),
    wake_phrase: str = Query(...),
    sample_kind: str = Query(..., pattern="^(positive|negative)$"),
    file: UploadFile = File(...),
):
    suffix = os.path.splitext(file.filename or "")[-1] or ".bin"
    temp_path = write_upload_to_tempfile(await file.read(), suffix)

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
    user_id: int = Query(...),
    wake_phrase: str = Query(...),
):
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
    user_id: int = Query(...),
    wake_phrase: str = Query(...),
    custom_model_path: Optional[str] = Query(default=None),
    notes: Optional[str] = Query(default=None),
):
    try:
        return service.activate_custom_phrase(
            user_id=user_id,
            wake_phrase=wake_phrase,
            custom_model_path=custom_model_path,
            notes=notes,
        )
    except EnrollmentValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
