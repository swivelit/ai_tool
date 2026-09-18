"""No implicit model downloads. Rights evidence and exact asset hashes required."""
from __future__ import annotations
import json
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path
from .storage import ENGINE_COMMIT, atomic, canonical, confined, digest, hash_file, read, root

# Inventory follows the PINNED code, not today's mutable model catalogue.
ASSETS = {
    "inswapper_128.onnx": ("swapper", "InsightFace restricted pretrained weights; commercial grant required"),
    "arcface_w600k_r50.onnx": ("embedding", "InsightFace restricted pretrained weights; commercial grant required"),
    "retinaface_10g.onnx": ("detector", "InsightFace restricted pretrained weights; commercial grant required"),
    "2dfan4.onnx": ("landmarks", "Review upstream model and conversion licence"),
    "fan_68_5.onnx": ("landmarks", "Review FaceFusion model licence"),
    "dfl_xseg.onnx": ("occlusion", "Review GPL model and distribution obligations"),
    "bisenet_resnet_34.onnx": ("mask", "Review upstream model and conversion licence"),
    "gfpgan_1.4.onnx": ("enhancer", "Review Apache-2.0 model and dependencies"),
    "open_nsfw.onnx": ("safety", "Review Yahoo model/conversion licence; safety must remain enabled"),
}


def skeleton():
    return {"profile": "quality-cpu", "engine_commit": ENGINE_COMMIT, "code_review": {}, "assets": [
        {"file": name, "purpose": kind, "source": f"https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/{name}",
         "sha256": "", "licence_reference": note, "reviewer": "", "reviewed_at": "", "permission_file": "", "permission_sha256": "", "licence_file": "", "licence_sha256": ""}
        for name, (kind, note) in ASSETS.items()]}


def evidence(record: dict):
    for field in ("permission", "licence"):
        path = confined(root() / "rights" / record.get(field + "_file", ""), root() / "rights")
        if not path.is_file() or path.stat().st_size < 20 or hash_file(path) != record.get(field + "_sha256"):
            raise ValueError(f"Missing genuine {field} document/hash in local rights directory")
    if not record.get("reviewer") or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", record.get("reviewed_at", "")):
        raise ValueError("Named rights reviewer and review date required")


def audit(*, require_files=True):
    manifest = read(root() / "models.json")
    if manifest.get("engine_commit") != ENGINE_COMMIT or manifest.get("profile") != "quality-cpu":
        raise ValueError("Model profile/engine identity changed")
    evidence(manifest.get("code_review", {}))
    assets = manifest.get("assets", [])
    if len(assets) != len(ASSETS) or {a.get("file") for a in assets} != set(ASSETS):
        raise ValueError("Complete model dependency inventory required")
    for asset in assets:
        evidence(asset)
        expected_source = f"https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/{asset['file']}"
        if asset.get("source") != expected_source or not re.fullmatch(r"[a-f0-9]{64}", asset.get("sha256", "")):
            raise ValueError("Reviewed upstream source and actual SHA-256 required: " + asset["file"])
        if require_files:
            path = root() / "engine/facefusion/.assets/models" / asset["file"]
            if not path.is_file() or hash_file(path) != asset["sha256"]:
                raise ValueError("Model missing or modified: " + asset["file"])
    if require_files:
        checkout = root() / "engine/facefusion"
        commit = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.check_output(["git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=all"], text=True)
        if commit != ENGINE_COMMIT or dirty:
            raise ValueError("Engine checkout modified; re-review required")
    implementation = {name: hash_file(Path(__file__).parent / name) for name in ("engine.py", "models.py", "templates.py", "requirements-intel.lock")}
    return {"profile_hash": digest(canonical({"manifest": manifest, "implementation": implementation})), "asset_count": len(assets), "rights_evidence_verified": True,
            "legal_conclusion": "Operator/counsel responsibility; document integrity is not a licence grant"}


def install():
    audit(require_files=False)
    manifest = read(root() / "models.json")
    destination = root() / "engine/facefusion/.assets/models"
    if not (root() / "engine/facefusion/facefusion").is_dir():
        raise ValueError("Run setup_macos.sh first")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    for asset in manifest["assets"]:
        target = destination / asset["file"]
        if target.exists() and hash_file(target) == asset["sha256"]:
            continue
        # Explicit operator invocation only. HTTPS source is fixed; verify bytes.
        temporary = target.with_suffix(".download")
        try:
            with urllib.request.urlopen(asset["source"], timeout=60) as response, temporary.open("wb") as out:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 1024 ** 3:
                        raise ValueError("Model download exceeds bound")
                    out.write(chunk)
            if hash_file(temporary) != asset["sha256"]:
                raise ValueError("Model SHA-256 mismatch")
            temporary.chmod(0o600)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return audit()
