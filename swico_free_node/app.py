from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

try:
    from .config import NodeConfig
    from .e5_runtime import E5Runtime
    from .qwen_runtime import QwenRuntime
    from .schemas import EmbedRequest, GenerateRequest
except ImportError:  # pragma: no cover - direct uvicorn execution from this folder
    from config import NodeConfig
    from e5_runtime import E5Runtime
    from qwen_runtime import QwenRuntime
    from schemas import EmbedRequest, GenerateRequest


class GenerationCapacity:
    def __init__(self, active: int, queue: int) -> None:
        self._active_limit = active
        self._limit = active + queue
        self._active = 0
        self._waiting = 0
        self._condition = asyncio.Condition()

    async def acquire(self) -> None:
        async with self._condition:
            if self._active + self._waiting >= self._limit:
                raise HTTPException(429, {"code": "swico_free_busy", "message": "Swico Free is busy."})
            self._waiting += 1
            try:
                while self._active >= self._active_limit:
                    await self._condition.wait()
                self._waiting -= 1
                self._active += 1
            except BaseException:
                self._waiting -= 1
                self._condition.notify_all()
                raise

    async def release(self) -> None:
        async with self._condition:
            self._active = max(0, self._active - 1)
            self._condition.notify(1)

    @property
    def waiting_or_active(self) -> int:
        return self._active + self._waiting


config: NodeConfig | None = None
qwen: QwenRuntime | None = None
e5: E5Runtime | None = None
capacity: GenerationCapacity | None = None
bearer = HTTPBearer(auto_error=False)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global config, qwen, e5, capacity
    config = NodeConfig.from_environment()
    qwen = QwenRuntime(config.qwen_gguf_path)
    e5 = E5Runtime(config.e5_model_path)
    capacity = GenerationCapacity(config.max_concurrent_generations, config.max_queue_size)
    yield


app = FastAPI(title="Swico Free inference node", docs_url=None, redoc_url=None, lifespan=lifespan)


def require_auth(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    if config is None or credentials is None or credentials.scheme.lower() != "bearer" or not secrets.compare_digest(credentials.credentials, config.token):
        raise HTTPException(401, {"code": "unauthorized", "message": "Authentication required."}, headers={"WWW-Authenticate": "Bearer"})


def _runtime() -> tuple[NodeConfig, QwenRuntime, E5Runtime, GenerationCapacity]:
    if config is None or qwen is None or e5 is None or capacity is None:
        raise HTTPException(503, {"code": "swico_free_unavailable", "message": "Swico Free is unavailable."})
    return config, qwen, e5, capacity


@app.middleware("http")
async def request_size_limit(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > 1_500_000:
        raise HTTPException(413, {"code": "request_too_large", "message": "Request is too large."})
    return await call_next(request)


@app.get("/health")
async def health(_: None = Depends(require_auth)) -> dict[str, Any]:
    node, _qwen, _e5, limit = _runtime()
    return {"status": "ok", "ready": True, "active_or_queued_generations": limit.waiting_or_active, "max_queue_size": node.max_queue_size}


@app.post("/v1/embed")
async def embed(payload: EmbedRequest, _: None = Depends(require_auth)) -> dict[str, Any]:
    _node, _qwen, runtime, _capacity = _runtime()
    vectors = await asyncio.to_thread(runtime.embed, payload.texts, payload.modes)
    return {"vectors": vectors, "dimensions": 384}


@app.post("/v1/generate")
async def generate(payload: GenerateRequest, _: None = Depends(require_auth)) -> dict[str, Any]:
    node, runtime, _e5, limit = _runtime()
    await limit.acquire()
    try:
        messages = [item.model_dump() for item in payload.messages]
        text, usage = await asyncio.to_thread(runtime.generate, messages, min(node.max_output_tokens, payload.max_output_tokens))
        return {"text": text, "usage": usage, "finish_reason": "stop"}
    finally:
        await limit.release()


@app.post("/v1/generate/stream")
async def generate_stream(payload: GenerateRequest, _: None = Depends(require_auth)) -> StreamingResponse:
    node, runtime, _e5, limit = _runtime()
    await limit.acquire()
    messages = [item.model_dump() for item in payload.messages]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    def worker() -> None:
        try:
            for delta, usage in runtime.stream(messages, min(node.max_output_tokens, payload.max_output_tokens)):
                loop.call_soon_threadsafe(queue.put_nowait, ("usage" if usage else "delta", usage or delta))
            loop.call_soon_threadsafe(queue.put_nowait, ("done", None))
        except Exception:
            loop.call_soon_threadsafe(queue.put_nowait, ("error", None))

    task = asyncio.create_task(asyncio.to_thread(worker))

    async def body():
        try:
            while True:
                kind, value = await queue.get()
                if kind == "delta":
                    yield f"data: {json.dumps({'delta': value}, ensure_ascii=False)}\n\n"
                elif kind == "usage":
                    yield f"data: {json.dumps({'usage': value}, ensure_ascii=False)}\n\n"
                elif kind == "error":
                    yield "data: {\"error\": \"swico_free_unavailable\"}\n\n"
                    break
                else:
                    yield "data: [DONE]\n\n"
                    break
        finally:
            if not task.done():
                try:
                    await asyncio.shield(task)
                except Exception:
                    pass
            await limit.release()

    return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn
    cfg = NodeConfig.from_environment()
    uvicorn.run("app:app", host=cfg.host, port=cfg.port, workers=1)
