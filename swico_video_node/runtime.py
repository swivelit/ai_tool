"""Reviewed local tool identity shared by setup, launchd and every render child.

No PATH from the caller is trusted. Configuration contains paths/hashes, never
credentials. Relocating identical bytes is harmless; changing tools fails closed.
"""
from __future__ import annotations
import functools
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from .storage import atomic, canonical, digest, hash_file, read, root

SEARCH = ("/opt/local/bin", "/usr/local/bin", "/usr/bin", "/bin")


def minimal_environment():
    return {"PATH": ":".join(SEARCH), "LANG": "en_US.UTF-8", "HOME": str(root()),
            "SWICO_VIDEO_DATA_DIR": str(root())}


class RuntimeFailure(ValueError):
    pass


def safe_error(exc, stage="runtime"):
    from .template_errors import TemplateError
    # External stderr/exception messages may contain image paths, prompts, tokens
    # or URLs. Persist only allowlisted diagnostic facts, never raw payloads.
    text = str(exc).lower()
    codes = [code for code in ("no such file", "permission denied", "unknown encoder",
             "invalid data", "unsupported", "opset", "onnx", "libx264", "timeout", "numpy", "cv2", "scipy", "facefusion") if code in text]
    result={"stage": stage, "error_class": type(exc).__name__, "signals": codes[:8]}
    if isinstance(exc, TemplateError):
        result["reason"] = exc.code
    if isinstance(exc,ModuleNotFoundError) and exc.name and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_.]{0,100}",exc.name):
        result["missing_module"]=exc.name
    return result


def capture(argv, *, timeout=30, env=None, limit=32768):
    """Drain bounded output, including a noisy failing executable; no shell."""
    process = subprocess.Popen([str(a) for a in argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env or minimal_environment())
    buffers = [bytearray(), bytearray()]
    def drain(stream, target):
        with stream:
            while chunk := stream.read(4096):
                target.extend(chunk)
                if len(target) > limit:
                    del target[:-limit]
    threads = [threading.Thread(target=drain, args=(s, b), daemon=True)
               for s, b in zip((process.stdout, process.stderr), buffers)]
    for thread in threads: thread.start()
    try:
        status = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill(); process.wait()
        raise RuntimeFailure("runtime timeout") from None
    except BaseException:
        # An operator interrupt must not leave a codec writing into staging
        # while its caller removes the incomplete normalization directory.
        if process.poll() is None: process.kill()
        process.wait(timeout=5)
        raise
    finally:
        for thread in threads: thread.join(timeout=2)
    stdout, stderr = (b.decode("utf-8", "replace") for b in buffers)
    if status:
        facts = safe_error(RuntimeError(stderr), Path(str(argv[0])).name)
        raise RuntimeFailure(f"{facts['stage']} exit={status} signals={','.join(facts['signals']) or 'none'}")
    return stdout


def native_host():
    if platform.system() != "Darwin" or platform.machine() != "x86_64":
        raise RuntimeFailure("Requires native Darwin/x86_64 Intel, not ARM/Linux")
    result = subprocess.run(["/usr/sbin/sysctl", "-in", "sysctl.proc_translated"],
                            capture_output=True, text=True, timeout=5)
    if result.stdout.strip() == "1":
        raise RuntimeFailure("Translated Rosetta process is not a native Intel host")


@functools.lru_cache(maxsize=128)
def _file_digest(path, size, mtime, ctime):
    return hash_file(Path(path))


def identity_file(path):
    info = path.stat()
    return _file_digest(str(path), info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def inspect_tool(name, value):
    path = Path(value)
    if not path.is_absolute():
        raise RuntimeFailure(f"{name}: absolute executable path required")
    try: path = path.resolve(strict=True)
    except OSError: raise RuntimeFailure(f"{name}: executable missing") from None
    if not path.is_file() or not os.access(path, os.X_OK):
        raise RuntimeFailure(f"{name}: not an executable regular file")
    if path.stat().st_mode & 0o022:
        raise RuntimeFailure(f"{name}: group/world-writable executable refused")
    architecture = capture(["/usr/bin/file", "-b", path])
    if "Mach-O" not in architecture or "x86_64" not in architecture:
        raise RuntimeFailure(f"{name}: native Mach-O x86_64 slice required")
    version = capture([path, "-version"])
    if not version.startswith(name + " version "):
        raise RuntimeFailure(f"{name}: unexpected version contract")
    # Also bind non-system linked libraries: replacing libavcodec can change
    # output without changing the ffmpeg executable. Unresolved @rpath requires
    # operator review rather than pretending we have hashed its implementation.
    linked = {}
    for line in capture(["/usr/bin/otool", "-L", path]).splitlines()[1:]:
        location = line.strip().split(" (compatibility", 1)[0]
        if location.startswith(("/usr/lib/", "/System/Library/")): continue
        if location.startswith("@loader_path/"):
            location = str(path.parent / location[len("@loader_path/"):])
        if not location.startswith("/"):
            raise RuntimeFailure(f"{name}: unresolved dynamic library; use the supported MacPorts build")
        dependency = Path(location).resolve(strict=True)
        linked[dependency.name] = identity_file(dependency)
    return {"path": str(path), "sha256": identity_file(path), "version_sha256": digest(version.encode()),
            "version": version.splitlines()[0][:180], "libraries": linked}


def tools():
    config_path = root() / "runtime-tools.json"
    config = read(config_path) if config_path.exists() else None
    found = {}
    for name in ("ffmpeg", "ffprobe"):
        value = config["tools"][name]["path"] if config else next(
            (str(Path(p)/name) for p in SEARCH if (Path(p)/name).is_file()), "")
        if not value: raise RuntimeFailure(f"{name}: missing; install MacPorts ffmpeg")
        found[name] = inspect_tool(name, value)
        if config and found[name] != config["tools"][name]:
            raise RuntimeFailure(f"{name}: tool replaced; stop worker, configure tools and re-calibrate")
    return found


def tool(name):
    return tools()[name]["path"]


def tool_identity():
    return {name: {k:v for k,v in info.items() if k != "path"} for name,info in tools().items()}


def encode_smoke(selected):
    with tempfile.TemporaryDirectory(prefix="swico-codec-smoke-") as directory:
        output = Path(directory)/"test.mp4"
        capture([selected["ffmpeg"]["path"], "-nostdin", "-v", "error", "-f", "lavfi", "-i",
                 "color=c=black:s=64x64:r=2", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", output])
        data = json.loads(capture([selected["ffprobe"]["path"], "-v", "error", "-show_streams", "-of", "json", output]))
        if data["streams"][0]["codec_name"] != "h264": raise RuntimeFailure("libx264 smoke contract failed")
        capture([selected["ffmpeg"]["path"], "-nostdin", "-v", "error", "-i", output, "-f", "null", "-"])


def configure_tools(ffmpeg=None, ffprobe=None):
    from .storage import exclusive
    native_host()
    with exclusive():
        selected = {}
        for name,value in (("ffmpeg",ffmpeg),("ffprobe",ffprobe)):
            value = value or next((str(Path(p)/name) for p in SEARCH if (Path(p)/name).is_file()), "")
            if not value: raise RuntimeFailure(f"{name}: missing; install MacPorts ffmpeg")
            selected[name] = inspect_tool(name,value)
        encode_smoke(selected)
        atomic(root()/"runtime-tools.json", {"schema":1,"tools":selected})
    return {"tools":selected,"encode_decode_smoke":True,"native_model_inference":"not_run"}
