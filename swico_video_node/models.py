"""Local model inventory, rights evidence and fixed technical provenance.

No function in this module downloads model weights implicitly. Commercial
permission remains an independent, operator/counsel-owned gate.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import os
import re
import stat
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from .rights import EvidenceError, backup_json, evidence_file_status, store_document, validate_review_metadata
from .storage import ENGINE_COMMIT, TEMPLATES, atomic, canonical, digest, hash_file, read, root, template_dir
from .runtime import identity_file

MODEL_HOST = "github.com"
MODEL_RELEASE_TAG = "models-3.0.0"
MODEL_RELEASE_BASE = f"https://{MODEL_HOST}/facefusion/facefusion-assets/releases/download/{MODEL_RELEASE_TAG}"
PROVENANCE_MAX_BYTES = 16 * 1024
MODEL_MAX_BYTES = 1024 * 1024 * 1024
PROVENANCE_MAX_REDIRECTS = 3
PROVENANCE_HOSTS = frozenset({"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"})
RESTRICTED_ASSETS = frozenset({"inswapper_128.onnx", "arcface_w600k_r50.onnx", "retinaface_10g.onnx"})

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

_NEXT = {
    "reviewer_missing": "Provide a real accountable reviewer name or role with models evidence add.",
    "reviewed_at_missing": "Provide the real review date with models evidence add.",
    "permission_evidence_missing": "Import genuine separate commercial permission evidence with models evidence add.",
    "licence_evidence_missing": "Import the applicable genuine licence evidence with models evidence add.",
    "restricted_permission_required": "Restricted weights require actual right-holder commercial permission; a licence keyword is not a grant.",
    "model_expected_hash_missing": "Obtain an independently reviewed full-model SHA-256 and record it with models provenance record --sha256; a legacy CRC32 sidecar is not a model SHA-256.",
    "model_bytes_not_installed": "After evidence and technical review pass, explicitly run models install --profile quality-cpu.",
    "model_bytes_hash_mismatch": "Stop; investigate the installed bytes against the reviewed technical hash.",
    "model_source_unreviewed": "Review the pinned FaceFusion source and record fixed provenance; do not substitute another URL.",
    "engine_checkout_missing": "Run the existing explicit setup/engine checkout step, then rerun models audit.",
    "engine_checkout_changed": "Review the pinned engine checkout again; do not reset it automatically.",
    "engine_wrong_revision": "Run engine status and the explicit engine recovery command; do not reset or clean the checkout.",
    "engine_tracked_changes": "Review or archive tracked engine changes before recovery; do not silently trust them.",
    "engine_untracked_changes": "Review or archive untracked engine changes before recovery; do not silently trust them.",
    "engine_not_repository": "Inspect the separate engine directory; only an empty first-run directory may be initialized by bootstrap.",
    "engine_path_symlink": "Inspect the engine path and remove the unsafe symlink only through operator-reviewed recovery.",
    "template_rights_missing": "Run templates rights add with genuine licence/permission evidence and all three explicit assertions.",
    "template_rights_manifest_missing": "Verify the already imported template has its private master.mp4 and manifest.json; do not re-import a reviewed master.",
}


def _template_next(identifier: str, blocker: str) -> str:
    """Keep template remediation pointed at template evidence, not models."""
    if blocker in {"template_rights_missing", "permission_evidence_missing", "licence_evidence_missing",
                   "reviewer_missing", "reviewed_at_missing"}:
        return (f"Run templates rights add --id {identifier} --reviewer '<real reviewer or role>' "
                "--reviewed-at YYYY-MM-DD --licence-file FILE --permission-file FILE "
                "--confirm-video-modification --confirm-video-distribution --confirm-audio-rights "
                "with genuine template evidence.")
    return _NEXT.get(blocker, "Resolve the template rights blocker and rerun models audit.")


def model_source(name: str) -> str:
    return f"{MODEL_RELEASE_BASE}/{name}"


def model_hash_source(name: str) -> str:
    if name not in ASSETS:
        raise EvidenceError("provenance_asset_unknown")
    return f"{MODEL_RELEASE_BASE}/{name.removesuffix('.onnx')}.hash"


def _engine_issues(engine: dict) -> list[str]:
    """Return an actionable issue even for a missing checkout with no git output."""
    if engine.get("state") == "ready":
        return []
    if engine.get("issues"):
        return list(engine["issues"])
    state = engine.get("state", "engine_status_unavailable")
    return ["engine_checkout_missing" if state == "missing" else state]


def skeleton():
    return {"profile": "quality-cpu", "engine_commit": ENGINE_COMMIT, "code_review": {}, "assets": [
        {"file": name, "purpose": kind, "source": model_source(name),
         "sha256": "", "licence_reference": note, "reviewer": "", "reviewed_at": "",
         "permission_file": "", "permission_sha256": "", "licence_file": "", "licence_sha256": "",
         "provenance": {"scheme": "facefusion_hash_sidecar", "url": model_hash_source(name), "sha256": ""}}
        for name, (kind, note) in ASSETS.items()]}


def _fields(record: dict, *, restricted: bool) -> tuple[str, ...]:
    if restricted and record.get("permission_basis") == "applicable_licence":
        raise EvidenceError("restricted_permission_required")
    return ("licence",) if record.get("permission_basis") == "applicable_licence" and not restricted else ("permission", "licence")


def evidence(record: dict, *, restricted: bool = False):
    """Verify only local bytes and review metadata; never interpret documents."""
    if not isinstance(record, dict):
        raise EvidenceError("licence_evidence_missing")
    fields = _fields(record, restricted=restricted)
    for field in fields:
        if evidence_file_status(record, field)["status"] != "verified":
            raise EvidenceError(f"{field}_evidence_missing")
    if not record.get("reviewer"):
        raise EvidenceError("reviewer_missing")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(record.get("reviewed_at", ""))):
        raise EvidenceError("reviewed_at_missing")


def template_assertions(record: dict):
    required = ("video_modification_confirmed", "video_distribution_confirmed", "audio_rights_confirmed")
    if record.get("rights_scope") != "template" or any(record.get(item) is not True for item in required):
        raise EvidenceError("template_rights_missing")


def _asset_record(manifest: dict, name: str) -> dict:
    return next((item for item in manifest.get("assets", []) if isinstance(item, dict) and item.get("file") == name), {})


def _record_model_evidence(manifest: dict, asset: str, reviewer: str, reviewed_at: str,
                           licence_file: str, permission_file: str | None, permission_basis: str | None):
    if asset != "code_review" and asset not in ASSETS:
        raise EvidenceError("model_asset_unknown")
    reviewer, reviewed_at = validate_review_metadata(reviewer, reviewed_at)
    restricted = asset in RESTRICTED_ASSETS
    if permission_basis not in {None, "applicable_licence"}:
        raise EvidenceError("evidence_metadata_invalid")
    if restricted and permission_basis == "applicable_licence":
        raise EvidenceError("restricted_permission_required")
    if not licence_file:
        raise EvidenceError("licence_evidence_missing")
    if restricted or permission_basis != "applicable_licence":
        if not permission_file:
            raise EvidenceError("model_permission_required")
    scope = "model-code-review" if asset == "code_review" else "model-" + asset.removesuffix(".onnx")
    created: list[str] = []
    try:
        licence_name, licence_hash, was_created = store_document(licence_file, scope)
        if was_created: created.append(licence_name)
        permission_name = permission_hash = ""
        if permission_file:
            permission_name, permission_hash, was_created = store_document(permission_file, scope)
            if was_created: created.append(permission_name)
        record = dict(manifest.get("code_review", {}) if asset == "code_review" else _asset_record(manifest, asset))
        record.update({"reviewer": reviewer, "reviewed_at": reviewed_at, "licence_file": licence_name,
                       "licence_sha256": licence_hash, "permission_file": permission_name,
                       "permission_sha256": permission_hash})
        if permission_basis:
            record["permission_basis"] = permission_basis
        else:
            record.pop("permission_basis", None)
        if asset == "code_review":
            manifest["code_review"] = record
        else:
            for item in manifest.get("assets", []):
                if item.get("file") == asset:
                    item.update(record)
                    break
        return created
    except Exception:
        from .rights import remove_created
        remove_created(created)
        raise


def add_evidence(asset: str, reviewer: str, reviewed_at: str, licence_file: str,
                 permission_file: str | None = None, permission_basis: str | None = None):
    manifest_path = root() / "models.json"
    created: list[str] = []
    try:
        manifest = read(manifest_path)
        created = _record_model_evidence(manifest, asset, reviewer, reviewed_at, licence_file, permission_file, permission_basis)
        backup = backup_json(manifest_path, "models")
        atomic(manifest_path, manifest)
        return {"updated": True, "asset": asset, "backup": bool(backup), "evidence_files": len(created),
                "rights_directory": "rights/", "legal_conclusion": "Evidence integrity is not a legal grant."}
    except EvidenceError:
        from .rights import remove_created
        remove_created(created)
        raise
    except (OSError, ValueError, KeyError):
        from .rights import remove_created
        remove_created(created)
        raise EvidenceError("model_evidence_update_failed") from None


def evidence_status(manifest: dict | None = None):
    manifest = manifest if manifest is not None else read(root() / "models.json")
    records = {item.get("file"): item for item in manifest.get("assets", []) if isinstance(item, dict)}
    result = []
    for name in ("code_review", *ASSETS):
        record = manifest.get("code_review", {}) if name == "code_review" else records.get(name, {})
        restricted = name in RESTRICTED_ASSETS
        try:
            fields = _fields(record, restricted=restricted)
        except EvidenceError as exc:
            fields = ("permission", "licence")
            status_blocker = [exc.code]
        else:
            status_blocker = []
        files = [evidence_file_status(record, field) for field in fields]
        missing = status_blocker + [item["field"] + "_evidence_missing" for item in files if item["status"] != "verified"]
        if not record.get("reviewer"): missing.append("reviewer_missing")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(record.get("reviewed_at", ""))): missing.append("reviewed_at_missing")
        result.append({"asset": name, "restricted_commercial_grant_required": restricted, "files": files,
                       "reviewer": bool(record.get("reviewer")), "reviewed_at": bool(record.get("reviewed_at")),
                       "ready": not missing, "blockers": list(dict.fromkeys(missing))})
    return {"items": result, "rights_directory": "rights/", "legal_conclusion": "Document integrity is not a licence grant."}


def audit(*, require_files=True):
    manifest = read(root() / "models.json")
    if manifest.get("engine_commit") != ENGINE_COMMIT or manifest.get("profile") != "quality-cpu":
        raise ValueError("Model profile/engine identity changed")
    evidence(manifest.get("code_review", {}))
    assets = manifest.get("assets", [])
    if len(assets) != len(ASSETS) or {a.get("file") for a in assets} != set(ASSETS):
        raise ValueError("Complete model dependency inventory required")
    for asset in assets:
        name = asset["file"]
        evidence(asset, restricted=name in RESTRICTED_ASSETS)
        if asset.get("source") != model_source(name) or not re.fullmatch(r"[a-f0-9]{64}", asset.get("sha256", "")):
            raise ValueError("Reviewed upstream source and actual SHA-256 required: " + name)
        provenance = asset.get("provenance") or {}
        expected = provenance.get("expected_sha256")
        if expected and expected.get("value") != asset.get("sha256"):
            raise ValueError("Technical provenance does not match expected SHA-256: " + name)
        if require_files:
            path = root() / "engine/facefusion/.assets/models" / name
            if not path.is_file() or identity_file(path) != asset["sha256"]:
                raise ValueError("Model missing or modified: " + name)
    if require_files:
        from .engine_status import status as engine_status
        checkout = engine_status()
        if checkout["state"] != "ready":
            raise ValueError("Engine checkout is not ready: " + ",".join(_engine_issues(checkout)))
    implementation = {name: hash_file(Path(__file__).parent / name) for name in (
        "engine.py", "media.py", "template_errors.py", "models.py", "rights.py", "templates.py", "runtime.py", "calibration.py", "requirements-intel.lock")}
    return {"profile_hash": digest(canonical({"manifest": manifest, "implementation": implementation})), "asset_count": len(assets), "rights_evidence_verified": True,
            "legal_conclusion": "Operator/counsel responsibility; document integrity is not a licence grant"}


def audit_report():
    """Complete actionable local inventory without private absolute paths."""
    from .engine_status import status as engine_status
    engine = engine_status()
    report = {"ready": False, "manifest": "models.json", "rights_directory": "rights/", "items": [],
              "engine": engine,
              "legal_conclusion": "Document integrity is not a legal grant. Restricted weights require right-holder commercial permission."}
    try:
        manifest = read(root() / "models.json")
    except (OSError, ValueError):
        report["blockers"] = list(dict.fromkeys(_engine_issues(engine) + ["models_manifest_missing"]))
        report["next_steps"] = list(dict.fromkeys(
            [_NEXT.get(item, "Inspect the separate engine checkout before continuing.") for item in report["blockers"]]
            + ["Run the existing local worker init command before adding evidence."]
        ))
        return report
    records = {a.get("file"): a for a in manifest.get("assets", []) if isinstance(a, dict)}
    all_blockers: list[str] = []
    all_blockers.extend(_engine_issues(engine))
    for name in ("code_review", *ASSETS):
        record = manifest.get("code_review", {}) if name == "code_review" else records.get(name, {})
        restricted = name in RESTRICTED_ASSETS
        try:
            fields = _fields(record, restricted=restricted)
        except EvidenceError as exc:
            fields = ("permission", "licence")
            blockers = [exc.code]
        else:
            blockers = []
        for field in fields:
            if evidence_file_status(record, field)["status"] != "verified": blockers.append(field + "_evidence_missing")
        if not record.get("reviewer"): blockers.append("reviewer_missing")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(record.get("reviewed_at", ""))): blockers.append("reviewed_at_missing")
        if name != "code_review":
            if not re.fullmatch(r"[a-f0-9]{64}", record.get("sha256", "")): blockers.append("model_expected_hash_missing")
            path = root() / "engine/facefusion/.assets/models" / name
            if not path.is_file(): blockers.append("model_bytes_not_installed")
            elif hash_file(path) != record.get("sha256"): blockers.append("model_bytes_hash_mismatch")
            if record.get("source") != model_source(name): blockers.append("model_source_unreviewed")
        blockers = list(dict.fromkeys(blockers))
        all_blockers.extend(blockers)
        report["items"].append({"asset": name, "restricted_commercial_grant_required": restricted,
                                "blockers": blockers, "next_steps": [_NEXT.get(item, "Resolve this independently and rerun models audit.") for item in blockers]})
    template_items = []
    for identifier in TEMPLATES:
        blockers = []
        try:
            directory = template_dir(identifier)
            manifest_path, master = directory / "manifest.json", directory / "master.mp4"
            if not directory.is_dir() or manifest_path.is_symlink() or master.is_symlink() or not manifest_path.is_file() or not master.is_file():
                blockers.append("template_rights_manifest_missing")
            else:
                rights = read(manifest_path).get("rights", {})
                try:
                    evidence(rights)
                    template_assertions(rights)
                except EvidenceError as exc:
                    blockers.append(exc.code)
        except (OSError, ValueError):
            blockers.append("template_rights_manifest_missing")
        blockers = list(dict.fromkeys(blockers))
        template_items.append({"id": identifier, "ready": not blockers, "blockers": blockers,
                               "next_steps": [_template_next(identifier, item) for item in blockers]})
    report["templates"] = template_items
    report["template_blockers"] = list(dict.fromkeys(item for record in template_items for item in record["blockers"]))
    try:
        report.update(audit())
        report["blockers"] = list(dict.fromkeys(all_blockers + report["template_blockers"]))
        report["next_steps"] = list(dict.fromkeys(
            [_NEXT.get(item, "Resolve the reported model or engine blocker and rerun models audit.") for item in all_blockers]
            + [step for record in template_items for step in record["next_steps"]]
        ))
        report["ready"] = not report["blockers"]
    except (EvidenceError, ValueError, OSError, subprocess.SubprocessError) as exc:
        code = exc.code if isinstance(exc, EvidenceError) else "model_audit_blocked"
        report["blockers"] = list(dict.fromkeys(all_blockers + report["template_blockers"] + [code]))
        report["next_steps"] = list(dict.fromkeys(
            [_NEXT.get(item, "Resolve the reported review or installation blocker and rerun models audit.") for item in all_blockers]
            + [step for record in template_items for step in record["next_steps"]]
            + [_NEXT.get(code, "Resolve the reported review or installation blocker and rerun models audit.")]
        ))
    return report


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl=None):
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


def _allowed_resource_url(name: str, url: str) -> bool:
    """Allow only the fixed FaceFusion release asset and its GitHub CDN hop."""
    if name not in ASSETS:
        return False
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment:
        return False
    try:
        port = parsed.port
    except ValueError:
        return False
    if parsed.hostname not in PROVENANCE_HOSTS or port not in (None, 443):
        return False
    fixed = urlsplit(model_source(name))
    if parsed.hostname == MODEL_HOST:
        return not parsed.query and (parsed.path == fixed.path or parsed.path == urlsplit(model_hash_source(name)).path)
    # GitHub release assets use an opaque, signed path.  The host is fixed and
    # the redirect is followed only from the fixed github.com URL, never from
    # an operator-supplied URL.
    return parsed.hostname in {"release-assets.githubusercontent.com", "objects.githubusercontent.com"} and bool(parsed.path)


def _open_fixed_resource(name: str, url: str, *, timeout: int = 10):
    if not _allowed_resource_url(name, url):
        raise EvidenceError("provenance_fetch_failed")
    opener = urllib.request.build_opener(_NoRedirect())
    current = url
    for _ in range(PROVENANCE_MAX_REDIRECTS + 1):
        request = urllib.request.Request(current, headers={"Accept": "application/octet-stream, text/plain", "User-Agent": "swico-video-provenance/2"})
        try:
            return current, opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as exc:
            if exc.code not in {301, 302, 303, 307, 308}:
                raise
            location = exc.headers.get("Location")
            try:
                exc.close()
            except Exception:
                # Some deterministic test doubles do not carry urllib's file
                # handle; redirect safety does not depend on closing it.
                pass
            if not location:
                raise EvidenceError("provenance_redirect_invalid")
            next_url = urljoin(current, location)
            if not _allowed_resource_url(name, next_url):
                raise EvidenceError("provenance_redirect_invalid")
            current = next_url
    raise EvidenceError("provenance_redirect_limit")


def _bounded_response(response, limit: int) -> bytes:
    length = response.headers.get("Content-Length")
    if length and (not length.isdigit() or int(length) > limit):
        raise EvidenceError("provenance_response_invalid")
    body = response.read(limit + 1)
    if len(body) > limit:
        raise EvidenceError("provenance_response_invalid")
    return body


def _sidecar_details(name: str) -> tuple[str, str, str]:
    """Return final URL, algorithm and the upstream sidecar value."""
    url = model_hash_source(name)
    try:
        final_url, response = _open_fixed_resource(name, url)
        with response:
            body = _bounded_response(response, PROVENANCE_MAX_BYTES)
        value = body.decode("ascii").strip()
        if re.fullmatch(r"[a-fA-F0-9]{8}", value):
            return final_url, "crc32", value.lower()
        if re.fullmatch(r"[a-fA-F0-9]{64}", value):
            return final_url, "sha256", value.lower()
        raise EvidenceError("provenance_response_invalid")
    except EvidenceError:
        raise
    except (OSError, UnicodeError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        raise EvidenceError("provenance_fetch_failed") from None


def _fetch_sidecar(name: str) -> tuple[str, str]:
    final_url, _algorithm, value = _sidecar_details(name)
    return final_url, value


def provenance_status(*, fetch=False):
    try:
        manifest = read(root() / "models.json")
    except (OSError, ValueError):
        manifest = skeleton()
    records = {item.get("file"): item for item in manifest.get("assets", []) if isinstance(item, dict)}
    items = []
    for name in ASSETS:
        record = records.get(name, {})
        item = {"asset": name, "source": model_source(name), "sidecar": model_hash_source(name),
                "local_expected_sha256": record.get("sha256") or None, "technical_only": True,
                "commercial_authorization": "not inferred"}
        if fetch:
            try:
                final_url, upstream = _fetch_sidecar(name)
                algorithm = "crc32" if len(upstream) == 8 else "sha256"
                item["upstream"] = {"algorithm": algorithm, "value": upstream, "url": final_url}
                item["upstream_sha256"] = upstream if algorithm == "sha256" else None
                item["upstream_crc32"] = upstream if algorithm == "crc32" else None
                item["matches_local_expected"] = None if algorithm != "sha256" else bool(record.get("sha256") == upstream)
            except EvidenceError as exc:
                item["error"] = exc.code
        else:
            item["upstream_sha256"] = None
            item["upstream_crc32"] = None
            item["fetch"] = "Pass --fetch to retrieve only this bounded .hash sidecar; ONNX bytes are never downloaded."
        items.append(item)
    return {"scheme": "facefusion_hash_sidecar", "release_tag": MODEL_RELEASE_TAG, "items": items,
            "technical_only": True, "legal_authorization": "never inferred"}


def record_provenance(asset: str, *, confirm_technical_hash: bool):
    if asset not in ASSETS:
        raise EvidenceError("provenance_asset_unknown")
    if not confirm_technical_hash:
        raise EvidenceError("provenance_confirmation_required")
    url, upstream = _fetch_sidecar(asset)
    path = root() / "models.json"
    try:
        manifest = read(path)
        record = _asset_record(manifest, asset)
        if not record:
            raise EvidenceError("model_asset_unknown")
        algorithm = "crc32" if len(upstream) == 8 else "sha256"
        provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
        provenance.update({"scheme": "facefusion_hash_sidecar", "url": url, "algorithm": algorithm,
                           "value": upstream, "recorded_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                           "technical_only": True, "commercial_authorization": "not inferred"})
        if algorithm == "sha256":
            current = record.get("sha256", "")
            if current and current != upstream:
                raise EvidenceError("provenance_sha256_conflict")
            record["sha256"] = upstream
            # Retain the historical field for older local reports while the
            # algorithm-labelled fields above remain authoritative.
            provenance["sha256"] = upstream
            provenance["expected_sha256"] = {"algorithm": "sha256", "value": upstream, "source": "fixed_upstream_sidecar"}
        record["provenance"] = provenance
        backup = backup_json(path, "models")
        atomic(path, manifest)
        return {"updated": True, "asset": asset, "sha256": upstream if algorithm == "sha256" else None,
                "algorithm": algorithm, "upstream_value": upstream, "backup": bool(backup),
                "technical_only": True, "legal_authorization": "not supplied by this command"}
    except EvidenceError:
        raise
    except (OSError, ValueError, KeyError):
        raise EvidenceError("model_evidence_update_failed") from None


def _local_model_sha256(source_name: str) -> str:
    """Hash an operator-supplied model file without copying or installing it."""
    try:
        source = Path(source_name).expanduser()
        absolute = Path(os.path.abspath(source))
        if any(part.is_symlink() for part in (absolute, *absolute.parents)):
            raise EvidenceError("evidence_source_symlink")
        resolved = absolute.resolve(strict=True)
        info = resolved.stat()
        if not stat.S_ISREG(info.st_mode):
            raise EvidenceError("evidence_source_not_regular")
        if not 1 <= info.st_size <= MODEL_MAX_BYTES:
            raise EvidenceError("evidence_source_size_invalid")
        descriptor = os.open(resolved, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        result = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, "rb") as stream:
            while chunk := stream.read(1024 * 1024):
                total += len(chunk)
                if total > MODEL_MAX_BYTES:
                    raise EvidenceError("evidence_source_size_invalid")
                result.update(chunk)
        if total != info.st_size:
            raise EvidenceError("evidence_source_changed")
        return result.hexdigest()
    except EvidenceError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise EvidenceError("evidence_source_missing") from None


def record_expected_sha256(asset: str, value: str | None, reviewer: str, reviewed_at: str, *, confirm: bool,
                           model_file: str | None = None):
    """Record an independently reviewed full-model SHA-256; never downloads bytes."""
    if asset not in ASSETS:
        raise EvidenceError("provenance_asset_unknown")
    if not confirm:
        raise EvidenceError("provenance_confirmation_required")
    if model_file:
        if value:
            raise EvidenceError("provenance_sha256_invalid")
        value = _local_model_sha256(model_file)
    if not re.fullmatch(r"[a-fA-F0-9]{64}", value or ""):
        raise EvidenceError("provenance_sha256_invalid")
    reviewer, reviewed_at = validate_review_metadata(reviewer, reviewed_at)
    path = root() / "models.json"
    try:
        manifest = read(path)
        record = _asset_record(manifest, asset)
        if not record:
            raise EvidenceError("model_asset_unknown")
        current = record.get("sha256", "")
        normalized = value.lower()
        if current and current != normalized:
            raise EvidenceError("provenance_sha256_conflict")
        record["sha256"] = normalized
        provenance = record.get("provenance") if isinstance(record.get("provenance"), dict) else {}
        provenance["expected_sha256"] = {"algorithm": "sha256", "value": normalized,
                                          "source": "independent_operator_reviewed_bytes" if model_file else "independent_operator_review",
                                          "reviewer": reviewer,
                                          "reviewed_at": reviewed_at, "technical_only": True}
        record["provenance"] = provenance
        backup = backup_json(path, "models")
        atomic(path, manifest)
        return {"updated": True, "asset": asset, "sha256": normalized, "backup": bool(backup),
                "technical_only": True, "commercial_authorization": "not inferred"}
    except EvidenceError:
        raise
    except (OSError, ValueError, KeyError):
        raise EvidenceError("model_evidence_update_failed") from None


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
        if target.is_symlink():
            raise ValueError("Model destination is a symlink")
        temporary = target.with_suffix(".download")
        try:
            _final_url, response = _open_fixed_resource(asset["file"], asset["source"], timeout=60)
            with response, temporary.open("wb") as out:
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > MODEL_MAX_BYTES:
                        raise ValueError("Model download exceeds bound")
                    out.write(chunk)
            if hash_file(temporary) != asset["sha256"]:
                raise ValueError("Model SHA-256 mismatch")
            temporary.chmod(0o600)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return audit()
