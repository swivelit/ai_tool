from __future__ import annotations
import json
import os
import shutil
import tempfile
import time
from fractions import Fraction
from pathlib import Path
from .storage import TEMPLATES, atomic, canonical, digest, hash_file, read, root, template_dir
from .models import audit, evidence, template_assertions
from .rights import EvidenceError, backup_json, remove_created, store_document, validate_review_metadata
from .template_errors import ACTIONS, TemplateError


def import_template(identifier, file, title):
    from .engine import probe
    from .media import local_source, copy_master
    source = local_source(file)
    directory = template_dir(identifier)
    if directory.exists(): raise TemplateError("template_existing")
    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # CLI holds the existing worker lock. Publish both files by one same-volume
    # rename only after probing the exact COPY (not a possibly changing source).
    # A crash leaves, at worst, a hidden private staging dir, never an import.
    staged = Path(tempfile.mkdtemp(prefix=".import-", dir=directory.parent))
    try:
        master = staged / "master.mp4"
        copy_master(source, master)
        media = probe(master)
        atomic(staged / "manifest.json", {"id":identifier,"title":title[:80],"template_sha256":hash_file(master),
                                          "media":media,"rights":{},"approval":None,"benchmark":None})
        if directory.exists(): raise TemplateError("template_existing")
        os.rename(staged, directory)
    except Exception as exc:
        if isinstance(exc, TemplateError): raise
        raise TemplateError("template_import_failed") from None
    finally:
        if staged.exists(): shutil.rmtree(staged)
    return {"imported": True, "id": identifier, "media": media, "rights_approved": False,
            "template_approved": False, "calibrated": False}


def normalize(file, output):
    """Explicit local preprocessing only. Never infer cadence or licence rights."""
    from .engine import probe
    from .media import local_source, copy_master, MAX_BYTES, LOCAL_INPUT
    from .runtime import capture, tool
    source = local_source(file)
    try:
        requested = Path(output).expanduser()
        # Resolve parent only: never follow/replace an existing output symlink.
        destination = requested.parent.resolve(strict=True) / requested.name
        if destination.suffix.lower() != ".mp4" or not destination.parent.is_dir():
            raise TemplateError("template_output_invalid")
    except OSError:
        raise TemplateError("template_output_invalid") from None
    if os.path.lexists(destination): raise TemplateError("template_output_existing")
    try:
        with tempfile.TemporaryDirectory(prefix=".swico-normalize-", dir=destination.parent) as scratch:
            snapshot = Path(scratch)/"source.media"
            result = Path(scratch)/"normalized.mp4"
            copy_master(source, snapshot)
            before = probe(snapshot)  # No VFR, malformed input or unknown-rate guess.
            if before["audio"] and before["audio"]["codec"] not in {"aac", "mp3", "alac"}:
                raise TemplateError("template_audio_unsupported")
            fps = Fraction(before["fps"])
            clock = f"{fps.denominator}/{fps.numerator}"
            capture([tool("ffmpeg"), "-nostdin", "-v", "error", "-n", "-xerror", "-copyts",
                *LOCAL_INPUT, "-i", str(snapshot), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
                # Proven quantized PTS round onto the explicit encoder clock.
                # No fps filter/-r/-setpts: those can drop/duplicate frames or
                # erase the final packet duration. Preserve source/audio PTS.
                "-fps_mode:v", "passthrough",
                "-enc_time_base:v", clock, "-c:v", "libx264", "-crf", "18", "-preset", "slow",
                "-threads", "4", "-pix_fmt", "yuv420p", "-c:a", "copy", "-map_metadata", "-1",
                "-map_chapters", "-1", "-movflags", "+faststart", "-avoid_negative_ts", "disabled",
                "-fs", str(MAX_BYTES), "-f", "mp4", str(result)], timeout=600)
            after = probe(result)  # Same production validator as import/render.
            if any(after[key] != before[key] for key in ("width", "height", "frames", "fps")):
                raise TemplateError("template_normalize_failed")
            tolerance = max(before["timing"]["tolerance_seconds"], after["timing"]["tolerance_seconds"])*2
            if abs(after["duration_seconds"]-before["duration_seconds"]) > tolerance:
                raise TemplateError("template_normalize_failed")
            if bool(after["audio"]) != bool(before["audio"]): raise TemplateError("template_normalize_failed")
            if before["audio"]:
                if after["audio"]["codec"] != before["audio"]["codec"] or any(
                    abs(after["audio"][key]-before["audio"][key]) > tolerance
                    for key in ("start_seconds", "duration_seconds")):
                    raise TemplateError("template_normalize_failed")
            # Decode the whole product before publishing a permanent master.
            capture([tool("ffmpeg"), "-nostdin", "-v", "error", "-xerror", *LOCAL_INPUT,
                     "-i", str(result), "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], timeout=120)
            result.chmod(0o600)
            with result.open("rb") as stream: os.fsync(stream.fileno())
            # Atomic no-replace publication, even if another process created OUTPUT.
            os.link(result, destination)
    except FileExistsError:
        raise TemplateError("template_output_existing") from None
    except Exception as exc:
        if isinstance(exc, TemplateError): raise
        raise TemplateError("template_normalize_failed") from None
    return {"normalized": True, "media": after, "audio_mode": "copy" if after["audio"] else "none",
            "rights_approved": False, "template_approved": False, "calibrated": False}


def rights_status(identifier):
    """Report safe local template-rights state without private paths or contents."""
    try:
        directory = template_dir(identifier)
    except ValueError:
        raise TemplateError("template_rights_unknown") from None
    manifest_path = directory / "manifest.json"
    master = directory / "master.mp4"
    if not directory.is_dir() or manifest_path.is_symlink() or master.is_symlink() or not manifest_path.is_file() or not master.is_file():
        raise TemplateError("template_rights_manifest_missing")
    manifest = read(manifest_path)
    rights = manifest.get("rights", {})
    try:
        evidence(rights)
        template_assertions(rights)
        ready = True
        blockers = []
    except EvidenceError as exc:
        ready = False
        blockers = [exc.code]
    return {"id": identifier, "ready": ready, "rights_approved": bool(ready and manifest.get("approval")),
            "template_approved": bool(manifest.get("approval")), "calibrated": bool(manifest.get("benchmark")),
            "blockers": blockers, "stored_evidence": {field: rights.get(field + "_file", "").split("/")[-1]
                                                         for field in ("permission", "licence") if rights.get(field + "_file")},
            "legal_conclusion": "Evidence integrity is not legal sufficiency; human rights review remains required."}


def add_rights(identifier, reviewer, reviewed_at, licence_file, permission_file,
               *, confirm_video_modification=False, confirm_video_distribution=False, confirm_audio_rights=False):
    """Copy genuine template evidence, invalidate approval/calibration, and publish atomically."""
    try:
        directory = template_dir(identifier)
    except ValueError:
        raise TemplateError("template_rights_unknown") from None
    manifest_path = directory / "manifest.json"
    master = directory / "master.mp4"
    if not directory.is_dir() or manifest_path.is_symlink() or master.is_symlink() or not manifest_path.is_file() or not master.is_file():
        raise TemplateError("template_rights_manifest_missing")
    if not all((confirm_video_modification, confirm_video_distribution, confirm_audio_rights)):
        raise TemplateError("template_rights_missing")
    try:
        reviewer, reviewed_at = validate_review_metadata(reviewer, reviewed_at)
        manifest = read(manifest_path)
        before_master = hash_file(master)
        created = []
        try:
            permission_name, permission_hash, was_created = store_document(permission_file, "template-" + identifier)
            if was_created: created.append(permission_name)
            licence_name, licence_hash, was_created = store_document(licence_file, "template-" + identifier)
            if was_created: created.append(licence_name)
            rights = {"rights_scope": "template", "reviewer": reviewer, "reviewed_at": reviewed_at,
                      "permission_file": permission_name, "permission_sha256": permission_hash,
                      "licence_file": licence_name, "licence_sha256": licence_hash,
                      "video_modification_confirmed": True, "video_distribution_confirmed": True,
                      "audio_rights_confirmed": True}
            manifest["rights"] = rights
            # Rights changes invalidate old human review and native calibration.
            manifest["approval"], manifest["benchmark"] = None, None
            backup = backup_json(manifest_path, "template-" + identifier)
            atomic(manifest_path, manifest)
        except Exception:
            remove_created(created)
            raise
        if hash_file(master) != before_master:
            raise EvidenceError("template_rights_update_failed")
        return {"updated": True, "id": identifier, "backup": bool(backup), "rights_approved": False,
                "template_approved": False, "calibrated": False,
                "stored_evidence": {"permission": permission_name.split("/")[-1], "licence": licence_name.split("/")[-1]},
                "legal_conclusion": "Recorded assertions and document hashes are not legal approval."}
    except TemplateError:
        raise
    except EvidenceError as exc:
        code = exc.code if exc.code in ACTIONS else "template_rights_evidence_failed"
        raise TemplateError(code) from None
    except (OSError, ValueError, KeyError):
        raise TemplateError("template_rights_update_failed") from None


def prepare(identifier):
    from .engine import Engine, iou
    engine = Engine()
    directory = template_dir(identifier)
    manifest = read(directory / "manifest.json")
    cap = engine.cv.VideoCapture(str(directory / "master.mp4"))
    frames, previous, previous_gray, track_id, shot = [], [], None, 0, 0
    review_dir = directory / "review"
    review_dir.mkdir(exist_ok=True, mode=0o700)
    index = 0
    try:
        while True:
            success, frame = cap.read()
            if not success:
                break
            if index >= 1800 or engine.safety.analyse_frame(frame):
                raise ValueError("Template exceeds bounds or safety policy")
            gray = engine.cv.resize(engine.cv.cvtColor(frame,engine.cv.COLOR_BGR2GRAY),(64,64))
            if previous_gray is not None and engine.np.abs(gray.astype(float)-previous_gray).mean()>35:
                shot += 1; previous = []
            current, used = [], set()
            for face in engine.faces(frame):
                box = [round(float(x),2) for x in face.bounding_box]
                candidates = [(iou(box,p["box"]),p) for p in previous if p["track"] not in used]
                score, prior = max(candidates,default=(0,None),key=lambda x:x[0])
                if score < .45:
                    track_id += 1
                identity = prior["track"] if score >= .45 else track_id
                used.add(identity)
                current.append({"track":identity,"box":box})
                x1,y1,x2,y2 = map(int,box)
                engine.cv.rectangle(frame,(x1,y1),(x2,y2),(0,255,0),1)
                engine.cv.putText(frame,f"track {identity}",(x1,max(15,y1)),engine.cv.FONT_HERSHEY_SIMPLEX,.45,(0,255,0),1)
            # All annotated frames are local fixed-template review material, not customer photos.
            engine.cv.imwrite(str(review_dir/f"{index:04d}.jpg"),frame,[engine.cv.IMWRITE_JPEG_QUALITY,75])
            frames.append({"shot":shot,"faces":current})
            previous, previous_gray, index = current, gray, index+1
    finally:
        cap.release()
    if index != manifest["media"]["frames"]:
        raise ValueError("Decoded frame count changed")
    atomic(directory/"tracks.json",{"frames":frames,"roles":{str(i):"exclude" for i in range(1,track_id+1)}})
    manifest["approval"],manifest["benchmark"] = None,None
    atomic(directory/"manifest.json",manifest)
    return {"frames":index,"tracks":track_id,"review_directory":str(review_dir)}


def review(identifier):
    directory = template_dir(identifier)
    manifest, tracks = read(directory/"manifest.json"), read(directory/"tracks.json")
    evidence(manifest["rights"])
    template_assertions(manifest["rights"])  # Video, distribution and audio are separate assertions.
    print(f"Inspect ALL numbered annotated frames in {directory / 'review'} locally. Never upload them.\nTrack roles are not inferred. Check each cut, background person and occlusion.")
    for track in tracks["roles"]:
        frames = [i for i,f in enumerate(tracks["frames"]) if any(str(t["track"])==track for t in f["faces"])]
        value = input(f"Track {track}, frames {min(frames)}–{max(frames)}: male/female/exclude: ").strip()
        if value not in {"male","female","exclude"}:
            raise ValueError("Explicit role required; review not saved")
        tracks["roles"][track] = value
    for frame in tracks["frames"]:
        selected = [tracks["roles"][str(f["track"])] for f in frame["faces"] if tracks["roles"][str(f["track"])] != "exclude"]
        if len(set(selected)) != len(selected):
            raise ValueError("Two targets assigned the same role in a frame; correct tracks before approval")
    if not {"male","female"}.issubset(set(tracks["roles"].values())):
        raise ValueError("Both explicit template roles must be annotated")
    if input("Reviewed every track/cut, excluded background, checked occlusion and audio rights? Type APPROVE: ") != "APPROVE":
        raise ValueError("Template not approved")
    atomic(directory/"tracks.json",tracks)
    manifest["approval"] = {"template_sha256":hash_file(directory/"master.mp4"),"tracks_sha256":hash_file(directory/"tracks.json"),
                            "profile_sha256":audit()["profile_hash"],"rights_sha256":digest(canonical(manifest["rights"]))}
    manifest["benchmark"] = None
    atomic(directory/"manifest.json",manifest)


def approved(identifier, *, calibrated=False):
    directory = template_dir(identifier)
    manifest = read(directory/"manifest.json")
    evidence(manifest["rights"])
    template_assertions(manifest["rights"])
    expected = {"template_sha256":hash_file(directory/"master.mp4"),"tracks_sha256":hash_file(directory/"tracks.json"),
                "profile_sha256":audit()["profile_hash"],"rights_sha256":digest(canonical(manifest["rights"]))}
    if manifest.get("approval") != expected:
        raise ValueError("Template/roles/profile/rights changed or unreviewed")
    if calibrated:
        from .calibration import validate
        from .engine import runtime_identity
        validate(manifest.get("benchmark"), expected, runtime_identity())
    return manifest


def benchmark(runs):
    from .storage import exclusive, cleanup_benchmarks
    with exclusive():
        cleanup_benchmarks()
        try: return _benchmark(runs)
        finally: cleanup_benchmarks()


def _benchmark(runs):
    from .engine import Engine
    import platform, tempfile
    if platform.system() != "Darwin" or platform.machine() != "x86_64" or runs < 3:
        raise ValueError("Native Intel Mac and at least three warm runs required")
    if input("Both source adults consent and you have permission to run this local benchmark? Type CONSENT: ") != "CONSENT":
        raise ValueError("Source consent required")
    sources = {role:Path(input(f"Local {role} source photo path: ")).expanduser().resolve(strict=True) for role in ("male","female")}
    start=time.monotonic(); engine=Engine(); load=time.monotonic()-start
    engine.sources(sources)
    for identifier in TEMPLATES:
        manifest=approved(identifier)
        variants = {}
        import uuid
        directory=root()/"benchmarks"/str(uuid.uuid4())
        directory.mkdir(mode=0o700)
        try:
            output=directory/"review.mp4"
            for enhance in ("off", "natural"):
                options = {"swap":"both", "enhance":enhance, "caption":""}
                first=engine.render(identifier,sources,options,output)
                timings=[engine.render(identifier,sources,options,output) for _ in range(runs)]
                print(f"Review {enhance} enhancement locally before continuing: {output}\nCheck likeness, eyes/mouth, flicker, occlusion, cuts, background, both roles and audio sync.")
                if input("Type QA-PASS only after watching the actual result: ") != "QA-PASS":
                    raise ValueError("Quality acceptance missing")
                variants[enhance] = {"warm_seconds":timings, "first_render_seconds":first,"quality_review":"operator-reviewed"}
        finally: shutil.rmtree(directory)
        # Shared Engine sessions are reused. "First render" is NOT a fresh
        # process cold-start benchmark. Initial model-load time is separate.
        manifest["benchmark"]={"schema":2,"runtime_sha256":digest(canonical(engine.runtime)),"warm_seconds":[value for variant in variants.values() for value in variant["warm_seconds"]],"variants":variants,"load_seconds":load,"runtime":engine.runtime,"machine":platform.machine(),
                               "os":platform.platform(),"approval_hash":digest(canonical(manifest["approval"])),"quality_review":"operator-reviewed","recorded_at":time.time()}
        atomic(template_dir(identifier)/"manifest.json",manifest)


def publish(api):
    # Check the entire catalogue locally before any metadata side effect. A stale
    # second template must not leave a half-updated publication after a tool change.
    manifests=[(identifier,approved(identifier,calibrated=True)) for identifier in TEMPLATES]
    for identifier,manifest in manifests:
        approval=manifest["approval"]
        api.post("/templates",{"id":identifier,"title":manifest["title"],"template_sha256":approval["template_sha256"],
            "tracks_sha256":approval["tracks_sha256"],"profile_sha256":approval["profile_sha256"],
            "rights_evidence_sha256":approval["rights_sha256"],"qa_evidence_sha256":digest(canonical(manifest["benchmark"])),
            "calibration_schema":2,"runtime_sha256":manifest["benchmark"]["runtime_sha256"],
            "warm_seconds":manifest["benchmark"]["warm_seconds"],"cold_seconds":[v["first_render_seconds"] for v in manifest["benchmark"]["variants"].values()],
            "startup_seconds":manifest["benchmark"]["load_seconds"],"profile":"quality-cpu",
            **{k:manifest["media"][k] for k in ("width","height","duration_seconds")}})
