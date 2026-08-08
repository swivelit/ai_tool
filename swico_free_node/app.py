from __future__ import annotations

import asyncio
import json
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

try:
    import psutil
except ImportError:  # pragma: no cover - installed on the Windows node
    psutil = None

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

    async def acquire(self, *, timeout_seconds: float | None = None) -> float:
        queued_at = time.perf_counter()
        async with self._condition:
            if self._active + self._waiting >= self._limit:
                raise CapacityBusyError()
            self._waiting += 1
            acquired = False
            try:
                while self._active >= self._active_limit:
                    if timeout_seconds is None:
                        await self._condition.wait()
                    else:
                        remaining = timeout_seconds - (time.perf_counter() - queued_at)
                        if remaining <= 0:
                            raise CapacityWaitExpired()
                        try:
                            await asyncio.wait_for(self._condition.wait(), remaining)
                        except asyncio.TimeoutError as exc:
                            raise CapacityWaitExpired() from exc
                self._waiting -= 1
                self._active += 1
                acquired = True
                return (time.perf_counter() - queued_at) * 1000
            except BaseException:
                if not acquired:
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

    @property
    def active(self) -> int:
        return self._active

    @property
    def waiting(self) -> int:
        return self._waiting

    @property
    def active_capacity(self) -> int:
        return self._active_limit

    @property
    def queue_capacity(self) -> int:
        return max(0, self._limit - self._active_limit)


class CapacityBusyError(HTTPException):
    def __init__(self) -> None:
        super().__init__(
            status_code=429,
            detail={"code": "swico_free_busy", "message": "Swico Free is busy."},
            headers={"Retry-After": "1"},
        )


class CapacityWaitExpired(RuntimeError):
    pass


config: NodeConfig | None = None
qwen: QwenRuntime | None = None
e5: E5Runtime | None = None
capacity: GenerationCapacity | None = None
embedding_capacity: GenerationCapacity | None = None
startup_metrics: dict[str, int] = {}
process_started_at = time.monotonic()
bearer = HTTPBearer(auto_error=False)
counter_lock = threading.Lock()
generation_counters = {
    "total_completed_generations": 0,
    "total_failed_generations": 0,
    "total_timed_out_generations": 0,
    "total_busy_rejections": 0,
}
process_peak_rss_bytes = 0
EMBEDDING_QUEUE_WAIT_SECONDS = 10.0
ABORT_GRACE_SECONDS = 2.0


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global config, qwen, e5, capacity, embedding_capacity, startup_metrics
    started = time.perf_counter()
    config = NodeConfig.from_environment()
    qwen_started = time.perf_counter()
    qwen = QwenRuntime(
        config.qwen_gguf_path,
        threads=config.qwen_threads,
        batch_size=config.qwen_batch_size,
    )
    qwen_elapsed = time.perf_counter()
    e5_started = time.perf_counter()
    e5 = E5Runtime(config.e5_model_path, threads=config.e5_threads)
    e5_elapsed = time.perf_counter()
    capacity = GenerationCapacity(config.max_concurrent_generations, config.max_queue_size)
    embedding_capacity = GenerationCapacity(
        config.max_concurrent_embeddings, config.max_embedding_queue_size,
    )
    startup_metrics = {
        "qwen_startup_ms": int((qwen_elapsed - qwen_started) * 1000),
        "e5_startup_ms": int((e5_elapsed - e5_started) * 1000),
        "model_startup_ms": int((e5_elapsed - started) * 1000),
    }
    yield


app = FastAPI(title="Swico Free inference node", docs_url=None, redoc_url=None, lifespan=lifespan)


def require_auth(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    if config is None or credentials is None or credentials.scheme.lower() != "bearer" or not secrets.compare_digest(credentials.credentials, config.token):
        raise HTTPException(401, {"code": "unauthorized", "message": "Authentication required."}, headers={"WWW-Authenticate": "Bearer"})


def _increment_counter(name: str) -> None:
    with counter_lock:
        generation_counters[name] += 1


def _counter_snapshot() -> dict[str, int]:
    with counter_lock:
        return dict(generation_counters)


def _process_metrics() -> dict[str, float | int]:
    global process_peak_rss_bytes
    if psutil is None:
        return {}
    try:
        process = psutil.Process(os.getpid())
        rss = int(process.memory_info().rss)
        process_peak_rss_bytes = max(process_peak_rss_bytes, rss)
        return {
            "process_rss_mb": round(rss / (1024 * 1024), 2),
            "process_peak_rss_mb": round(process_peak_rss_bytes / (1024 * 1024), 2),
            "process_cpu_percent": round(float(process.cpu_percent(interval=None)), 2),
        }
    except OSError:
        return {}


def _timeout_error() -> HTTPException:
    return HTTPException(
        status_code=504,
        detail={
            "code": "swico_free_timeout",
            "message": "Swico Free could not finish within the response-time limit.",
        },
    )


def _queue_wait_error() -> HTTPException:
    return HTTPException(
        status_code=429,
        detail={
            "code": "swico_free_busy",
            "message": "Swico Free is busy. Please try again shortly.",
        },
        headers={"Retry-After": "1"},
    )


async def _acquire_generation(
    node: NodeConfig, limit: GenerationCapacity, request_started: float,
) -> float:
    max_queue_wait_seconds = float(getattr(node, "max_queue_wait_seconds", 15))
    max_total_request_seconds = float(getattr(node, "max_total_request_seconds", 45))
    timeout_seconds = min(
        max_queue_wait_seconds,
        max_total_request_seconds,
    )
    try:
        queue_wait_ms = await limit.acquire(timeout_seconds=timeout_seconds)
    except CapacityBusyError:
        _increment_counter("total_busy_rejections")
        raise
    except CapacityWaitExpired as exc:
        if time.perf_counter() - request_started >= max_total_request_seconds:
            _increment_counter("total_timed_out_generations")
            raise _timeout_error() from exc
        _increment_counter("total_busy_rejections")
        raise _queue_wait_error() from exc
    if time.perf_counter() - request_started >= max_total_request_seconds:
        await limit.release()
        _increment_counter("total_timed_out_generations")
        raise _timeout_error()
    return queue_wait_ms


def _runtime() -> tuple[NodeConfig, QwenRuntime, E5Runtime, GenerationCapacity, GenerationCapacity]:
    if config is None or qwen is None or e5 is None or capacity is None or embedding_capacity is None:
        raise HTTPException(503, {"code": "swico_free_unavailable", "message": "Swico Free is unavailable."})
    return config, qwen, e5, capacity, embedding_capacity


@app.middleware("http")
async def request_size_limit(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > 1_500_000:
        raise HTTPException(413, {"code": "request_too_large", "message": "Request is too large."})
    return await call_next(request)


@app.get("/health")
async def health(_: None = Depends(require_auth)) -> dict[str, Any]:
    node, _qwen, _e5, limit, embeddings = _runtime()
    return {
        "status": "ok", "ready": True,
        "uptime_seconds": round(max(0.0, time.monotonic() - process_started_at), 3),
        "active_generations": limit.active,
        "waiting_generations": limit.waiting,
        "active_embeddings": embeddings.active,
        "waiting_embeddings": embeddings.waiting,
        "generation_capacity": limit.active_capacity,
        "generation_queue_capacity": limit.queue_capacity,
        "active_or_queued_generations": limit.waiting_or_active,
        "max_queue_size": node.max_queue_size,
        "active_or_queued_embeddings": embeddings.waiting_or_active,
        "max_embedding_queue_size": node.max_embedding_queue_size,
        "max_queue_wait_seconds": getattr(node, "max_queue_wait_seconds", 15),
        "max_total_request_seconds": getattr(node, "max_total_request_seconds", 45),
        **_counter_snapshot(),
        **_process_metrics(),
        **startup_metrics,
    }


@app.post("/v1/embed")
async def embed(payload: EmbedRequest, _: None = Depends(require_auth)) -> dict[str, Any]:
    _node, _qwen, runtime, _capacity, embeddings = _runtime()
    try:
        await embeddings.acquire(timeout_seconds=EMBEDDING_QUEUE_WAIT_SECONDS)
    except CapacityBusyError:
        raise
    except CapacityWaitExpired as exc:
        raise _queue_wait_error() from exc
    try:
        vectors = await asyncio.to_thread(runtime.embed, payload.texts, payload.modes)
        return {"vectors": vectors, "dimensions": 384}
    finally:
        await embeddings.release()


@app.post("/v1/generate")
async def generate(payload: GenerateRequest, _: None = Depends(require_auth)) -> dict[str, Any]:
    node, runtime, _e5, limit, _embeddings = _runtime()
    request_started = time.perf_counter()
    queue_wait_ms = await _acquire_generation(node, limit, request_started)
    cancellation = threading.Event()
    generation_started = time.perf_counter()
    generation_task = asyncio.create_task(asyncio.to_thread(
        runtime.generate,
        [item.model_dump() for item in payload.messages],
        min(node.max_output_tokens, payload.max_output_tokens),
        cancellation,
    ))
    release_deferred = False
    try:
        remaining = float(getattr(node, "max_total_request_seconds", 45)) - (time.perf_counter() - request_started)
        if remaining <= 0:
            raise asyncio.TimeoutError
        text, usage = await asyncio.wait_for(
            asyncio.shield(generation_task), timeout=remaining,
        )
        wall_generation_ms = (time.perf_counter() - generation_started) * 1000
        usage = dict(usage)
        usage["queue_wait_ms"] = round(queue_wait_ms, 2)
        usage["generation_ms"] = round(wall_generation_ms, 2)
        usage["total_node_latency_ms"] = round((time.perf_counter() - request_started) * 1000, 2)
        finish_reason = str(usage.get("finish_reason") or "stop")
        _increment_counter("total_completed_generations")
        return {
            "text": text, "usage": usage,
            "finish_reason": finish_reason,
            "truncated": bool(usage.get("truncated")) or finish_reason == "length",
        }
    except asyncio.TimeoutError as exc:
        cancellation.set()
        _increment_counter("total_timed_out_generations")
        try:
            await asyncio.wait_for(asyncio.shield(generation_task), timeout=ABORT_GRACE_SECONDS)
        except asyncio.TimeoutError:
            release_deferred = True
            generation_task.add_done_callback(
                lambda _task: asyncio.create_task(limit.release())
            )
        except BaseException:
            pass
        raise _timeout_error() from exc
    except BaseException:
        if not cancellation.is_set():
            _increment_counter("total_failed_generations")
        raise
    finally:
        if not release_deferred:
            await limit.release()


@app.post("/v1/generate/stream")
async def generate_stream(request: Request, payload: GenerateRequest, _: None = Depends(require_auth)) -> StreamingResponse:
    node, runtime, _e5, limit, _embeddings = _runtime()
    request_started = time.perf_counter()
    queue_wait_ms = await _acquire_generation(node, limit, request_started)
    if time.perf_counter() - request_started >= float(getattr(node, "max_total_request_seconds", 45)):
        await limit.release()
        _increment_counter("total_timed_out_generations")
        raise _timeout_error()
    messages = [item.model_dump() for item in payload.messages]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    cancellation = threading.Event()
    deadline_expired = threading.Event()

    def worker() -> None:
        generation_started = time.perf_counter()
        terminal_usage: dict[str, Any] = {}
        visible_output = False
        try:
            for delta, usage in runtime.stream(
                messages,
                min(node.max_output_tokens, payload.max_output_tokens),
                cancellation,
            ):
                if usage:
                    terminal_usage.update(usage)
                elif delta:
                    visible_output = True
                loop.call_soon_threadsafe(queue.put_nowait, ("usage" if usage else "delta", usage or delta))
            wall_generation_ms = (time.perf_counter() - generation_started) * 1000
            terminal_usage.update({
                "queue_wait_ms": round(queue_wait_ms, 2),
                "generation_ms": round(wall_generation_ms, 2),
                "total_node_latency_ms": round((time.perf_counter() - request_started) * 1000, 2),
            })
            if deadline_expired.is_set():
                _increment_counter("total_timed_out_generations")
                loop.call_soon_threadsafe(queue.put_nowait, (
                    "timeout", {**terminal_usage, "visible_output": visible_output},
                ))
            elif cancellation.is_set():
                loop.call_soon_threadsafe(queue.put_nowait, ("cancelled", terminal_usage))
            else:
                _increment_counter("total_completed_generations")
                loop.call_soon_threadsafe(queue.put_nowait, ("done", terminal_usage))
        except Exception:
            if deadline_expired.is_set():
                _increment_counter("total_timed_out_generations")
                loop.call_soon_threadsafe(queue.put_nowait, (
                    "timeout", {"visible_output": visible_output},
                ))
            else:
                _increment_counter("total_failed_generations")
                loop.call_soon_threadsafe(queue.put_nowait, (
                    "error", {"finish_reason": "error", "truncated": False},
                ))

    task = asyncio.create_task(asyncio.to_thread(worker))

    async def watch_disconnect() -> None:
        try:
            while not await request.is_disconnected():
                await asyncio.sleep(0.2)
            cancellation.set()
            queue.put_nowait(("cancel", None))
        except asyncio.CancelledError:
            raise

    disconnect_task = asyncio.create_task(watch_disconnect())

    async def watch_deadline() -> None:
        try:
            remaining = float(getattr(node, "max_total_request_seconds", 45)) - (time.perf_counter() - request_started)
            if remaining > 0:
                await asyncio.sleep(remaining)
            if not task.done():
                deadline_expired.set()
                cancellation.set()
        except asyncio.CancelledError:
            raise

    deadline_task = asyncio.create_task(watch_deadline())

    async def body():
        try:
            while True:
                kind, value = await queue.get()
                if kind == "delta":
                    yield f"data: {json.dumps({'delta': value}, ensure_ascii=False)}\n\n"
                elif kind == "usage":
                    yield f"data: {json.dumps({'usage': value}, ensure_ascii=False)}\n\n"
                elif kind == "error":
                    yield f"data: {json.dumps({'error': 'swico_free_unavailable', **(value or {})})}\n\n"
                    yield "data: [DONE]\n\n"
                    break
                elif kind == "timeout":
                    if value and value.get("visible_output"):
                        yield f"data: {json.dumps({**value, 'visible_output': None, 'finish_reason': 'timeout', 'truncated': True, 'completion_status': 'incomplete'}, ensure_ascii=False)}\n\n"
                    else:
                        yield "data: {\"error\":\"swico_free_timeout\"}\n\n"
                    yield "data: [DONE]\n\n"
                    break
                elif kind == "cancelled":
                    yield f"data: {json.dumps({**(value or {}), 'finish_reason': 'cancelled', 'truncated': False})}\n\n"
                    yield "data: [DONE]\n\n"
                    break
                elif kind == "cancel":
                    break
                else:
                    if value:
                        yield f"data: {json.dumps({'usage': value}, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
                    break
        finally:
            cancellation.set()
            disconnect_task.cancel()
            deadline_task.cancel()
            if task.done():
                await limit.release()
            else:
                async def finish_worker() -> None:
                    try:
                        await task
                    except BaseException:
                        pass
                    await limit.release()
                asyncio.create_task(finish_worker())

    return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


if __name__ == "__main__":
    import uvicorn
    cfg = NodeConfig.from_environment()
    uvicorn.run("app:app", host=cfg.host, port=cfg.port, workers=1)
