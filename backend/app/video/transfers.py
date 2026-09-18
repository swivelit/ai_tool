"""Per-API-process cap, held through the entire bounded binary response/request.

PostgreSQL/Valkey enforce global job/media budgets; this limits live buffer copies.
No effect on ordinary Chat/Voice uploads, and no disk spooling.
"""
import re
from threading import BoundedSemaphore
from starlette.responses import JSONResponse

_BINARY = re.compile(r"^/api/(?:web/videos/jobs/[^/]+/(?:media|photos/(?:male|female))|video-worker/v1/jobs/[^/]+/(?:output|inputs/(?:male|female)))$")


class VideoTransferLimit:
    def __init__(self, app):
        self.app = app
        self.slots = BoundedSemaphore(2)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not _BINARY.fullmatch(scope.get("path", "")):
            return await self.app(scope, receive, send)
        if not self.slots.acquire(blocking=False):
            response = JSONResponse({"detail":"Video transfer capacity busy; retry shortly"}, status_code=503,
                                    headers={"Retry-After":"2", "Cache-Control":"no-store"})
            return await response(scope, receive, send)
        try:
            return await self.app(scope, receive, send)
        finally:
            self.slots.release()
