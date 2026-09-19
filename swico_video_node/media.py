"""Bounded local media inspection. PTS, not equal rate headers, proves cadence.

No model imports, credential access, uploads, state writes or automatic conversion.
All rational math is exact; public summaries never contain source paths/tags.
"""
from fractions import Fraction
import json
import os
from pathlib import Path
import stat

from .runtime import capture, tool
from .template_errors import TemplateError

MAX_BYTES = 200 * 1024 * 1024
MAX_FRAMES = 1800
PHOTO_MAX_BYTES = 5 * 1024 * 1024
PHOTO_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
# At most one millisecond time-base tick plus ffprobe decimal rounding (1us).
# Never grant an entire frame of slack even when the time base is coarse.
MAX_JITTER = Fraction(1, 1000)
DECIMAL_EPSILON = Fraction(1, 1000000)
LOCAL_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi"]


def rational(value, code):
    try:
        if isinstance(value, bool) or not isinstance(value, (str, int, float)) or len(str(value)) > 64:
            raise ValueError()
        result = Fraction(str(value))
        if abs(result.numerator) > 10**15 or result.denominator > 10**9:
            raise ValueError()
        return result
    except (ValueError, ZeroDivisionError, OverflowError):
        raise TemplateError(code) from None


def local_source(file):
    try:
        source = Path(file).expanduser().resolve(strict=True)
        info = source.stat()
        if not stat.S_ISREG(info.st_mode):
            raise TemplateError("template_source_invalid")
        if not 0 < info.st_size <= MAX_BYTES:
            raise TemplateError("template_size_unsupported")
        return source
    except (OSError, RuntimeError, ValueError) as exc:
        if isinstance(exc, TemplateError): raise
        raise TemplateError("template_source_invalid") from None


def local_benchmark_photo(file):
    """Validate a selected benchmark photo before loading native dependencies."""
    if not isinstance(file, str) or not file.strip():
        raise ValueError("benchmark_source_invalid")
    try:
        candidate = Path(file).expanduser()
        if candidate.is_symlink() or candidate.suffix.lower() not in PHOTO_SUFFIXES:
            raise ValueError("benchmark_source_invalid")
        source = candidate.resolve(strict=True)
        info = source.stat()
        if not stat.S_ISREG(info.st_mode) or not os.access(source, os.R_OK) or not 0 < info.st_size <= PHOTO_MAX_BYTES:
            raise ValueError("benchmark_source_invalid")
        return source
    except (OSError, RuntimeError, ValueError):
        raise ValueError("benchmark_source_invalid") from None


def copy_master(source, destination):
    """Private bounded snapshot; never follow a source swapped to a link/device."""
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as incoming:
        if not stat.S_ISREG(os.fstat(incoming.fileno()).st_mode):
            raise TemplateError("template_source_invalid")
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as outgoing:
            size = 0
            while chunk := incoming.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES: raise TemplateError("template_size_unsupported")
                outgoing.write(chunk)
            outgoing.flush()
            os.fsync(outgoing.fileno())


def _inspect(source, report):
    executable = tool("ffprobe")  # Same validated, hash-bound resolver as rendering.
    data = json.loads(capture([executable, "-v", "error", *LOCAL_INPUT,
        "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base,duration,start_time,nb_frames:format=duration",
        "-of", "json", str(source)], limit=65536))
    streams = data["streams"]
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if len(streams) > 8 or len(videos) != 1 or len(audio) > 1:
        raise TemplateError("template_streams_unsupported")
    video = videos[0]
    width, height = video["width"], video["height"]
    if type(width) != int or type(height) != int:
        raise TemplateError("template_resolution_unsupported")
    report.update(width=width, height=height, even_dimensions=width % 2 == height % 2 == 0)
    duration = rational(video.get("duration", data.get("format", {}).get("duration")), "template_duration_unsupported")
    report["duration_seconds"] = float(duration)
    if not 1 <= duration <= 30: raise TemplateError("template_duration_unsupported")
    if not 64 <= min(width, height) <= max(width, height) <= 1920:
        raise TemplateError("template_resolution_unsupported")
    if not report["even_dimensions"]: raise TemplateError("template_odd_dimensions")
    fps = rational(video.get("r_frame_rate"), "template_cfr_required")
    average = rational(video.get("avg_frame_rate"), "template_fps_unsupported")
    report.update(nominal_fps=str(fps), average_fps=str(average))
    if not 1 <= fps <= 60 or not 1 <= average <= 60 or fps.denominator > 1000000:
        raise TemplateError("template_fps_unsupported")
    time_base = rational(video.get("time_base"), "template_timing_invalid")
    if not 0 < time_base <= 1: raise TemplateError("template_timing_invalid")
    tolerance = min(time_base, MAX_JITTER) + DECIMAL_EPSILON
    report["time_base"] = str(time_base)
    frames = json.loads(capture([executable, "-v", "error", *LOCAL_INPUT, "-select_streams", "v:0",
        "-show_entries", "frame=pts,best_effort_timestamp,best_effort_timestamp_time", "-of", "json", str(source)],
        timeout=60, limit=512*1024))["frames"]
    report["frames"] = len(frames)
    if not 2 <= len(frames) <= MAX_FRAMES: raise TemplateError("template_frames_unsupported")
    points = []
    for frame in frames:
        value = frame.get("pts", frame.get("best_effort_timestamp"))
        if value is None:
            point = rational(frame.get("best_effort_timestamp_time"), "template_timing_invalid")
        else:
            ticks = rational(value, "template_timing_invalid")
            if ticks.denominator != 1: raise TemplateError("template_timing_invalid")
            point = ticks * time_base
        points.append(point)
    deltas = [b-a for a,b in zip(points, points[1:])]
    if any(delta <= 0 for delta in deltas):
        report["classification"] = "invalid_timing"
        raise TemplateError("template_timing_invalid")
    period = 1/fps
    errors = [(point-points[0])-index*period for index,point in enumerate(points)]
    step_error = max(abs(delta-period) for delta in deltas)
    phase_error = max(abs(error) for error in errors)
    phase_span = max(errors)-min(errors)
    report["cadence"] = {"min_interval_seconds": float(min(deltas)), "max_interval_seconds": float(max(deltas)),
        "observed_fps": float(Fraction(len(points)-1, 1)/(points[-1]-points[0])),
        "max_interval_error_seconds": float(step_error), "max_phase_error_seconds": float(phase_error),
        "phase_span_seconds": float(phase_span), "tolerance_seconds": float(tolerance)}
    if max(step_error, phase_error, phase_span) > tolerance:
        report["classification"] = "vfr_or_nominal_mismatch"
        raise TemplateError("template_vfr_unsupported")
    # Raw-frame rendering starts at zero. Do not silently erase a source offset,
    # truncate a tail, or accept a partial decode/misreported frame count.
    if abs(points[0]) > tolerance or abs(duration-len(points)*period) > 2*tolerance:
        raise TemplateError("template_timing_invalid")
    if video.get("nb_frames") not in (None, "N/A") and rational(video["nb_frames"], "template_timing_invalid") != len(points):
        raise TemplateError("template_timing_invalid")
    audio_info = None
    if audio:
        stream = audio[0]
        codec = stream.get("codec_name")
        # Only fixed names are public; no native/freeform tags in reports.
        codec = codec if codec in {"aac", "mp3", "alac", "pcm_s16le", "opus", "vorbis", "flac"} else "other"
        start = rational(stream.get("start_time", "0"), "template_timing_invalid")
        length = rational(stream.get("duration", str(duration)), "template_timing_invalid")
        if abs(start) > 30 or not 0 < length <= 31: raise TemplateError("template_timing_invalid")
        audio_info = {"codec": codec, "start_seconds": float(start), "duration_seconds": float(length)}
    report.update(accepted=True, classification="stable_cfr", canonical_fps=str(fps), audio=audio_info,
                  reason=None, timestamp_quantized=step_error > DECIMAL_EPSILON)


def inspect_media(file):
    report = {"accepted": False, "classification": "unknown", "frames": None}
    try:
        _inspect(local_source(file), report)
    except Exception as exc:
        error = exc if isinstance(exc, TemplateError) else TemplateError("template_probe_failed")
        report.update(reason=error.code, action=error.action)
    return report


def probe(file):
    report = inspect_media(file)
    if not report["accepted"]: raise TemplateError(report["reason"])
    return {"width": report["width"], "height": report["height"], "fps": report["canonical_fps"],
            "frames": report["frames"], "duration_seconds": report["duration_seconds"],
            "timing": {"schema": 1, "nominal_fps": report["nominal_fps"], "average_fps": report["average_fps"],
                       "time_base": report["time_base"], **report["cadence"]}, "audio": report["audio"]}
