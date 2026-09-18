from __future__ import annotations
import fcntl
import hashlib
import json
import logging
import logging.handlers
import os
import platform
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from .storage import atomic, canonical, cleanup_jobs, cleanup_benchmarks, confined, digest, hash_file, read, root, template_dir
from .runtime import minimal_environment, safe_error, tools
from .models import audit
from . import __version__

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Video API redirects are forbidden")


class Api:
    def __init__(self):
        self.config=read(root()/"config.json")
        from urllib.parse import urlparse
        url=urlparse(self.config["api_base"])
        if url.scheme!="https" or not url.hostname or url.username or url.query or url.fragment or url.path not in {"","/"} or self.config.get("worker_id")!="intel-mac-01":
            raise ValueError("Worker configuration requires the pinned HTTPS API origin and worker identity")
        path=root()/"worker.token"
        if path.stat().st_mode & 0o077 or path.is_symlink():
            raise ValueError("Worker credential permissions invalid")
        self.token=path.read_text().strip()
        self.boot=secrets.token_hex(16)
        self.opener=urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None, job=None, binary=False):
        headers={"Authorization":"Bearer "+self.token,"X-Worker-Id":"intel-mac-01","X-Worker-Boot":self.boot}
        if job:
            headers.update({"X-Video-Fence":job["fence"],"X-Video-Attempt":str(job["attempt"])})
        data=body if isinstance(body,bytes) else canonical(body) if body is not None else None
        headers["Content-Type"]="application/octet-stream" if isinstance(body,bytes) else "application/json"
        request=urllib.request.Request(self.config["api_base"]+"/api/video-worker/v1"+path,data=data,headers=headers,method=method)
        with self.opener.open(request, timeout=25) as response:
            result=response.read(2*1024*1024+1)
            if len(result)>2*1024*1024:
                raise ValueError("API response exceeds bound")
            return result if binary else json.loads(result)

    def post(self,path,body,job=None):
        return self.request("POST",path,body,job)


def readiness():
    from .templates import approved
    from .engine import runtime_identity
    runtime=runtime_identity()
    result=audit()
    calibrations={}
    for name in ("couple-01","couple-02"):
        calibrations[name]=digest(canonical(approved(name,calibrated=True)["benchmark"]))
    if platform.system()!="Darwin" or platform.machine()!="x86_64":
        raise ValueError("Worker native platform must be Intel macOS")
    free=shutil.disk_usage(root()).free
    if free < 2*1024**3:
        raise ValueError("At least 2 GiB local free space required")
    return {"ready":True,"native_inference_verified":True,"revision":__version__,"profile_hash":result["profile_hash"],"disk_free_bytes":free,
            "calibration_schema":2,"runtime_sha256":digest(canonical(runtime)),"calibrations":calibrations}


def terminate_tree(process):
    # Child owns a new session; never signal any unrelated process group.
    if process.poll() is None:
        try:
            os.killpg(process.pid,signal.SIGTERM)
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=5)
        except ProcessLookupError:
            pass
    # Descendants can outlive a gracefully terminated parent.
    try:
        os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError:
        pass


def guard_parent(descriptor):
    """A parent crash closes the only pipe writer: kill THIS owned process group.

    The inherited flock also blocks a launchd replacement until this child exits.
    Never use this helper in an interactive shell's process group.
    """
    import stat
    if os.getpgrp()!=os.getpid() or descriptor < 3 or not stat.S_ISFIFO(os.fstat(descriptor).st_mode):
        raise ValueError("Native child requires its owned session and supervision pipe")
    def watch():
        try:
            os.read(descriptor,1)
        finally:
            os.killpg(os.getpgrp(),signal.SIGKILL)
    threading.Thread(target=watch,name="video-parent-liveness",daemon=True).start()


def child_process(directory: Path):
    guard_parent(int(os.environ.get("SWICO_VIDEO_PARENT_FD","-1")))
    from .engine import Engine
    from .templates import approved
    directory=confined(directory,root()/"jobs")
    job=read(directory/"request.json")
    stage="calibration"
    try:
        local=approved(job["template"]["id"],calibrated=True)
        if local["approval"]["template_sha256"]!=job["template"]["template_sha256"] or local["approval"]["profile_sha256"]!=job["template"]["profile_sha256"] or local["approval"]["tracks_sha256"]!=job["template"]["tracks_sha256"]:
            raise ValueError("template_changed")
        if local["benchmark"]["runtime_sha256"]!=job["template"].get("runtime_sha256") or digest(canonical(local["benchmark"]))!=job["template"].get("qa_evidence_sha256"):
            raise ValueError("template_changed")
        stage="engine_import_onnx_load"
        engine=Engine()
        stage="source_validation"
        paths={role:directory/(role+".jpg") for role in job["inputs"]}
        engine.sources(paths)
        engine.caption(job["options"]["caption"])
        if job["state"]=="preflighting":
            result={"outcome":"valid"}
        else:
            stage="native_render_encode"
            engine.render(job["template"]["id"],paths,job["options"],directory/"output.mp4",
                          lambda phase,percent:atomic(directory/"progress.json",{"phase":phase,"percent":percent}))
            result={"outcome":"ready","sha256":hash_file(directory/"output.mp4")}
    except Exception as exc:
        atomic(root()/"logs/last-native-error.json",safe_error(exc,stage))
        allowed={"source_face_count","source_quality","safety_rejected","caption_unsupported","template_changed"}
        result={"outcome":"invalid" if job["state"]=="preflighting" else "failed","reason":str(exc) if str(exc) in allowed else "render_failed"}
    atomic(directory/"result.json",result)


def child_environment(read_fd):
    tools()  # Refuse missing/replaced tools before admitting native child startup.
    return {**minimal_environment(),"SWICO_VIDEO_PARENT_FD":str(read_fd)}


def execute(api,job,stop,lock_fd):
    directory=root()/"jobs"/job["id"]
    import uuid
    uuid.UUID(job["id"])
    directory.mkdir(mode=0o700)
    process=None
    read_fd=write_fd=None
    heartbeat_info=readiness()
    try:
        atomic(directory/"request.json",job)
        for role,expected in job["inputs"].items():
            if role not in {"male","female"}:
                raise ValueError("Invalid role")
            data=api.request("GET",f"/jobs/{job['id']}/inputs/{role}",job=job,binary=True)
            if digest(data)!=expected:
                raise ValueError("Input hash mismatch")
            (directory/(role+".jpg")).write_bytes(data)
        read_fd,write_fd=os.pipe()
        safe=child_environment(read_fd)
        process=subprocess.Popen([sys.executable,"-m","swico_video_node","_process",str(directory)],env=safe,
                                 cwd=Path(__file__).resolve().parents[1],start_new_session=True,pass_fds=(read_fd,lock_fd),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        # Do not retain arbitrary native stderr (may include customer paths). A
        # bounded reader classifies it, so import failures are diagnosable too.
        def drain():
            tail=bytearray()
            with process.stderr:
                while chunk:=process.stderr.read(4096):
                    tail.extend(chunk)
                    if len(tail)>8192:del tail[:-8192]
            if tail:atomic(root()/"logs/last-child-stderr.json",safe_error(RuntimeError(tail.decode("utf8","replace")),"native_child"))
        reader=threading.Thread(target=drain,daemon=True);reader.start()
        os.close(read_fd);read_fd=None
        deadline=datetime.fromisoformat(job["deadline"]).timestamp()
        while process.poll() is None:
            if stop.wait(5) or time.time()>=deadline:
                raise RuntimeError("Worker stopping/deadline")
            progress=read(directory/"progress.json") if (directory/"progress.json").exists() else {"phase":"validation","percent":0}
            api.post(f"/jobs/{job['id']}/heartbeat",progress,job)
            current=readiness()
            if any(current[k]!=heartbeat_info[k] for k in ("profile_hash","runtime_sha256","calibrations")):
                raise ValueError("Runtime changed during processing; stop and reconcile")
            api.post("/heartbeat",{**current,"boot_id":api.boot})
            atomic(root()/"liveness.json",{"pid":os.getpid(),"parent_pid":os.getppid(),"time":time.time()})
        if process.returncode or not (directory/"result.json").exists():
            raise RuntimeError("Native child failed")
        result=read(directory/"result.json")
        if result["outcome"]=="ready":
            api.post(f"/jobs/{job['id']}/heartbeat",{"phase":"upload","percent":99},job)
            output=directory/"output.mp4"
            if output.stat().st_size>16777216:
                raise ValueError("Output limit exceeded")
            api.request("PUT",f"/jobs/{job['id']}/output",output.read_bytes(),job)
        # Durable remote finalization before deleting output. On uncertainty do NOT
        # re-render the job here; lease recovery owns retries and cache finalize.
        api.post(f"/jobs/{job['id']}/complete",result,job)
    finally:
        if process:
            terminate_tree(process)
            reader.join(timeout=3)
        for descriptor in (read_fd,write_fd):
            if descriptor is not None:os.close(descriptor)
        # No customer media survives a worker iteration, even on failed transfer.
        shutil.rmtree(confined(directory,root()/"jobs"))


def run():
    os.umask(0o077)
    lock=(root()/"worker.lock").open("a+")
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
        raise ValueError("Another local Swico video worker owns the lock") from None
    cleanup_jobs();cleanup_benchmarks()
    from .service import startup_logs
    startup_logs()
    logger=logging.getLogger("swico_video_node")
    handler=logging.handlers.RotatingFileHandler(root()/"logs/worker.log",maxBytes=1024*1024,backupCount=3)
    logger.addHandler(handler);logger.setLevel(logging.INFO)
    stop=threading.Event()
    for sig in (signal.SIGINT,signal.SIGTERM):
        signal.signal(sig,lambda *_:stop.set())
    api=Api();delay=2
    while not stop.is_set():
        try:
            atomic(root()/"liveness.json",{"pid":os.getpid(),"parent_pid":os.getppid(),"time":time.time()})
            api.post("/heartbeat",{**readiness(),"boot_id":api.boot})
            job=api.post("/claim",{}).get("job")
            if job:
                execute(api,job,stop,lock.fileno())
            delay=2
        except Exception as exc:
            logger.warning("worker_cycle_failed %s",json.dumps(safe_error(exc,"worker_cycle")))
            # Immediately withdraw stale readiness, even on runtime changes.
            # Fenced in-flight cleanup/settlement endpoints do not require ready.
            try: api.post("/heartbeat",{"boot_id":api.boot,"ready":False,"native_inference_verified":False,"revision":__version__,
                                       "profile_hash":"0"*64,"disk_free_bytes":0,"runtime_sha256":"0"*64,"calibration_schema":2,"calibrations":{}})
            except Exception: pass
            delay=min(60,delay*2)
        stop.wait(delay)
