"""Pinned headless FaceFusion CPU adapter. No CLI auto-download/pre_check calls."""
from __future__ import annotations
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from .models import audit
from .storage import atomic, hash_file, read, root, template_dir
from .runtime import capture, tool, tool_identity, native_host, identity_file, minimal_environment
from .media import probe


def runtime_identity():
    from importlib.metadata import version, distribution
    if sys.version_info[:2] != (3, 12):
        raise ValueError("Native video runtime requires the separate Python 3.12 environment")
    expected = {}
    records = {}
    for line in (Path(__file__).parent / "requirements-intel.lock").read_text().splitlines():
        if "==" in line and not line.startswith("#"):
            name, wanted = line.split("==", 1)
            if version(name) != wanted:
                raise ValueError("Native dependency changed: " + name + "; reinstall pinned environment and re-benchmark")
            expected[name] = wanted
            from .storage import digest
            record=distribution(name).read_text("RECORD")
            if not record: raise ValueError("Installed wheel RECORD missing: "+name)
            records[name]=digest(record.encode())
    native_host()
    import platform
    return {"schema": 2, "python": sys.version.split()[0], "python_sha256": identity_file(Path(sys.executable).resolve()),
            "packages": expected, "wheel_records":records,"system": platform.system(), "machine": platform.machine(),
            "os": platform.platform(), "tools": tool_identity(),
            "cpu": capture(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]).strip(),
            "settings": {"providers": ["cpu"], "threads": 4, "enhance_blend": 20,
                         "encode": "libx264/crf18/medium/yuv420p/audio-copy", "roles": "original-frame-independent"}}


class Engine:
    def __init__(self):
        self.runtime = runtime_identity()
        self.evidence = audit()
        sys.path.insert(0, str(root() / "engine/facefusion"))
        import cv2
        import numpy as np
        from facefusion import state_manager, face_detector, face_landmarker, face_recognizer, content_analyser, face_masker
        from facefusion.processors.modules import face_swapper, face_enhancer
        self.cv, self.np = cv2, np
        self.detector, self.landmarker, self.recognizer = face_detector, face_landmarker, face_recognizer
        self.safety, self.swapper, self.enhancer = content_analyser, face_swapper, face_enhancer
        values = {"execution_device_id": "0", "execution_providers": ["cpu"], "execution_thread_count": 4,
                  "execution_queue_count": 1, "face_detector_model": "retinaface", "face_detector_size": "640x640",
                  "face_detector_angles": [0,90,180,270], "face_detector_score": .65, "face_landmarker_model": "2dfan4",
                  "face_landmarker_score": .5, "face_swapper_model": "inswapper_128", "face_swapper_pixel_boost": "128x128",
                  "face_mask_types": ["box", "occlusion"], "face_mask_blur": .3, "face_mask_padding": (0,0,0,0),
                  "face_enhancer_model": "gfpgan_1.4", "face_enhancer_blend": 20, "video_memory_strategy": "strict",
                  "log_level": "error"}
        for key, value in values.items():
            state_manager.init_item(key, value)
        # Force every used session to load now, without upstream download helpers.
        for module in (face_detector, face_landmarker, face_recognizer, face_masker, content_analyser, face_swapper, face_enhancer):
            module.get_inference_pool()

    def faces(self, frame):
        from facefusion.face_helper import apply_nms, estimate_face_angle, convert_to_face_landmark_5
        from facefusion.typing import Face
        boxes, scores, landmarks = [], [], []
        for angle in (0,90,180,270):
            b,s,l = self.detector.detect_faces(frame) if angle == 0 else self.detector.detect_rotated_faces(frame, angle)
            boxes.extend(b); scores.extend(s); landmarks.extend(l)
        faces = []
        for index in apply_nms(boxes, scores, .65, .4):
            five = landmarks[index]
            approximate = self.landmarker.estimate_face_landmark_68_5(five)
            angle = estimate_face_angle(approximate)
            full, confidence = self.landmarker.detect_face_landmarks(frame, boxes[index], angle)
            aligned = convert_to_face_landmark_5(full) if confidence > .5 else five
            embedding, normalized = self.recognizer.calc_embedding(frame, aligned)
            # No demographic classifier; roles are explicit human-reviewed tracks.
            faces.append(Face(bounding_box=boxes[index], score_set={"detector":scores[index],"landmarker":confidence},
                              landmark_set={"5":five,"5/68":aligned,"68":full,"68/5":approximate}, angle=angle,
                              embedding=embedding,normed_embedding=normalized,gender=None,age=None,race=None))
        return faces

    def sources(self, paths: dict):
        sources = {}
        for role, path in paths.items():
            frame = self.cv.imread(str(path))
            if frame is None or self.safety.analyse_frame(frame):
                raise ValueError("safety_rejected")
            found = self.faces(frame)
            if len(found) != 1:
                raise ValueError("source_face_count")
            box = found[0].bounding_box.astype(int)
            crop = frame[max(0,box[1]):box[3],max(0,box[0]):box[2]]
            if crop.size == 0 or min(crop.shape[:2]) < 64 or self.cv.Laplacian(self.cv.cvtColor(crop,self.cv.COLOR_BGR2GRAY),self.cv.CV_64F).var() < 30:
                raise ValueError("source_quality")
            sources[role] = found[0]  # Never average the two identities.
        return sources

    @staticmethod
    def caption(value: str):
        # Deliberately bounded initial font coverage, surfaced BEFORE charging.
        if any(ord(c) < 32 or ord(c) > 126 for c in value) or len(value) > 100:
            raise ValueError("caption_unsupported")

    def render(self, template_id: str, paths: dict, options: dict, output: Path, progress=lambda *_:None, provenance: str | None = None):
        from PIL import Image, ImageDraw, ImageFont
        from .templates import approved
        from .provenance import draw_disclosure, metadata_args, provenance_id, verify_output
        manifest = approved(template_id)
        directory = template_dir(template_id)
        source = self.sources(paths)
        self.caption(options["caption"])
        tracks = read(directory / "tracks.json")
        meta = manifest["media"]
        target = directory / "master.mp4"
        cap = self.cv.VideoCapture(str(target))
        output_provenance = provenance or provenance_id(provenance_id_for_render(template_id, output))
        encoder = subprocess.Popen([tool("ffmpeg"),"-nostdin","-v","error","-y","-f","rawvideo","-pixel_format","bgr24",
            "-video_size",f"{meta['width']}x{meta['height']}","-framerate",meta["fps"],"-i","pipe:0","-i",str(target),
            "-map","0:v:0","-map","1:a?","-c:v","libx264","-crf","18","-preset","medium","-pix_fmt","yuv420p",
            "-c:a","copy","-map_metadata","-1",*metadata_args(output_provenance),"-movflags","+faststart",str(output)], stdin=subprocess.PIPE,stderr=subprocess.PIPE,env=minimal_environment())
        import threading
        error_tail = bytearray()
        def drain_errors():
            with encoder.stderr:
                while chunk := encoder.stderr.read(4096):
                    error_tail.extend(chunk)
                    if len(error_tail)>8192: del error_tail[:-8192]
        reader=threading.Thread(target=drain_errors,daemon=True);reader.start()
        start = time.monotonic()
        try:
            for index in range(meta["frames"]):
                success, original = cap.read()
                if not success or time.monotonic()-start > 14000:
                    raise ValueError("render_failed")
                if self.safety.analyse_frame(original):
                    raise ValueError("safety_rejected")
                faces = self.faces(original)
                final = original.astype(self.np.int16)
                used = set()
                for target_info in tracks["frames"][index]["faces"]:
                    role = tracks["roles"].get(str(target_info["track"]), "exclude")
                    if role not in source:
                        continue
                    matches = [(iou(target_info["box"], f.bounding_box), i, f) for i,f in enumerate(faces)]
                    score, face_index, face = max(matches, default=(0,-1,None), key=lambda x:x[0])
                    if score < .65 or face_index in used:
                        raise ValueError("template_changed")
                    used.add(face_index)
                    changed = self.swapper.swap_face(source[role], face, original.copy())
                    if options["enhance"] == "natural":
                        changed = self.enhancer.enhance_face(face, changed)
                    # Each role is identified against ORIGINAL frames; one encode.
                    final += changed.astype(self.np.int16) - original.astype(self.np.int16)
                image = Image.fromarray(self.np.clip(final,0,255).astype("uint8")[:,:,::-1])
                draw = ImageDraw.Draw(image)
                font = ImageFont.load_default(size=max(10, meta["height"]//28))
                draw_disclosure(draw, image.width, image.height, font)
                if options["caption"]:
                    draw.text((8,meta["height"]-28),options["caption"],font=font,fill="white",stroke_width=1,stroke_fill="black")
                encoder.stdin.write(self.np.array(image)[:,:,::-1].tobytes())
                progress("swap",int(90*(index+1)/meta["frames"]))
            encoder.stdin.close()
            if encoder.wait(timeout=120):
                from .runtime import RuntimeFailure, safe_error
                raise RuntimeFailure("encode " + json.dumps(safe_error(RuntimeError(error_tail.decode('utf8','replace')), 'ffmpeg')))
        finally:
            cap.release()
            if encoder.poll() is None:
                encoder.kill(); encoder.wait(timeout=10)
            reader.join(timeout=2)
        result = probe(output)
        if output.stat().st_size > 16777216 or result["frames"] != meta["frames"] or abs(result["duration_seconds"] - meta["duration_seconds"]) > .1:
            raise ValueError("render_failed")
        capture([tool("ffmpeg"),"-nostdin","-v","error","-i",str(output),"-f","null","-"],timeout=60)
        verify_output(output, output_provenance)
        return time.monotonic()-start


def provenance_id_for_render(template_id: str, output: Path) -> str:
    """Use a non-user, local identity for benchmark renders."""
    return f"benchmark:{template_id}:{output.name}"


def iou(a,b):
    intersection = max(0,min(a[2],b[2])-max(a[0],b[0])) * max(0,min(a[3],b[3])-max(a[1],b[1]))
    area = max(0,a[2]-a[0])*max(0,a[3]-a[1])+max(0,b[2]-b[0])*max(0,b[3]-b[1])-intersection
    return float(intersection/area) if area > 0 else 0
