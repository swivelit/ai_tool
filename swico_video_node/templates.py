from __future__ import annotations
import json
import shutil
import time
from pathlib import Path
from .storage import TEMPLATES, atomic, canonical, digest, hash_file, read, root, template_dir
from .models import audit, evidence


def import_template(identifier, file, title):
    from .engine import probe
    source = Path(file).expanduser().resolve(strict=True)
    if source.stat().st_size > 200*1024*1024:
        raise ValueError("Template master exceeds 200 MiB")
    media = probe(source)
    directory = template_dir(identifier)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (directory / "master.mp4").exists():
        raise ValueError("Template already exists; archive it explicitly before replacing/re-reviewing")
    shutil.copyfile(source, directory / "master.mp4")
    (directory / "master.mp4").chmod(0o600)
    atomic(directory / "manifest.json", {"id":identifier,"title":title[:80],"template_sha256":hash_file(directory/"master.mp4"),
                                          "media":media,"rights":{},"approval":None,"benchmark":None})


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
    evidence(manifest["rights"])  # Must cover video modification/distribution AND audio.
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
    expected = {"template_sha256":hash_file(directory/"master.mp4"),"tracks_sha256":hash_file(directory/"tracks.json"),
                "profile_sha256":audit()["profile_hash"],"rights_sha256":digest(canonical(manifest["rights"]))}
    if manifest.get("approval") != expected:
        raise ValueError("Template/roles/profile/rights changed or unreviewed")
    if calibrated and (not manifest.get("benchmark") or manifest["benchmark"].get("approval_hash") != digest(canonical(expected)) or set(manifest["benchmark"].get("variants", {})) != {"off", "natural"}):
        raise ValueError("Full-clip native calibration/quality review required")
    return manifest


def benchmark(runs):
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
        with tempfile.TemporaryDirectory(prefix="benchmark-",dir=root()) as temp:
            output=Path(temp)/"review.mp4"
            for enhance in ("off", "natural"):
                options = {"swap":"both", "enhance":enhance, "caption":""}
                cold=engine.render(identifier,sources,options,output)
                timings=[engine.render(identifier,sources,options,output) for _ in range(runs)]
                print(f"Review {enhance} enhancement locally before continuing: {output}\nCheck likeness, eyes/mouth, flicker, occlusion, cuts, background, both roles and audio sync.")
                if input("Type QA-PASS only after watching the actual result: ") != "QA-PASS":
                    raise ValueError("Quality acceptance missing")
                variants[enhance] = {"warm_seconds":timings, "cold_seconds":cold}
        manifest["benchmark"]={"warm_seconds":[value for variant in variants.values() for value in variant["warm_seconds"]],"variants":variants,"load_seconds":load,"runtime":engine.runtime,"machine":platform.machine(),
                               "os":platform.platform(),"approval_hash":digest(canonical(manifest["approval"])),"quality_review":"operator-reviewed","recorded_at":time.time()}
        atomic(template_dir(identifier)/"manifest.json",manifest)


def publish(api):
    for identifier in TEMPLATES:
        manifest=approved(identifier,calibrated=True)
        approval=manifest["approval"]
        api.post("/templates",{"id":identifier,"title":manifest["title"],"template_sha256":approval["template_sha256"],
            "tracks_sha256":approval["tracks_sha256"],"profile_sha256":approval["profile_sha256"],
            "rights_evidence_sha256":approval["rights_sha256"],"qa_evidence_sha256":digest(canonical(manifest["benchmark"])),
            "warm_seconds":manifest["benchmark"]["warm_seconds"],"cold_seconds":[v["cold_seconds"] for v in manifest["benchmark"]["variants"].values()],
            "startup_seconds":manifest["benchmark"]["load_seconds"],"profile":"quality-cpu",
            **{k:manifest["media"][k] for k in ("width","height","duration_seconds")}})
