"""Local rights/provenance tooling tests; no legal or model acceptance claim."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from swico_video_node import models, storage, templates
from swico_video_node.rights import EvidenceError


@pytest.fixture
def local(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SWICO_VIDEO_DATA_DIR", str(tmp_path / "private"))
    storage.init("intel-mac-01", "https://example.invalid")
    capsys.readouterr()
    return storage.root()


def document(path: Path, text: str = "Synthetic fixture only; not a licence or permission grant.") -> Path:
    path.write_bytes(text.encode("utf-8"))
    return path


def test_model_evidence_is_copied_hashed_private_and_source_changes_do_not_matter(local, tmp_path):
    licence = document(tmp_path / "real-licence.pdf")
    permission = document(tmp_path / "real-permission.pdf")
    result = models.add_evidence("2dfan4.onnx", "fixture reviewer", "2026-09-18", str(licence), str(permission))
    assert result["updated"] and result["rights_directory"] == "rights/"
    assert str(licence) not in json.dumps(result)
    manifest = storage.read(local / "models.json")
    record = next(item for item in manifest["assets"] if item["file"] == "2dfan4.onnx")
    assert record["permission_file"].startswith("evidence/model-2dfan4/")
    assert Path(record["permission_file"]).name == record["permission_file"].split("/")[-1]
    stored = local / "rights" / record["permission_file"]
    assert stored.is_file() and stored.stat().st_mode & 0o077 == 0
    original_hash = record["permission_sha256"]
    permission.write_text("changed outside private storage")
    assert storage.hash_file(stored) == original_hash
    assert models.evidence_status(manifest)["items"][4]["ready"] is True
    assert list((local / "rights" / "backups").glob("models-*.json"))


def test_model_evidence_rejects_symlink_missing_and_restricted_licence_bypass(local, tmp_path):
    licence = document(tmp_path / "licence.txt")
    with pytest.raises(EvidenceError, match="evidence_source_missing"):
        models.add_evidence("2dfan4.onnx", "fixture", "2026-09-18", str(tmp_path / "missing"), str(licence))
    symlink = tmp_path / "link.txt"
    symlink.symlink_to(licence)
    with pytest.raises(EvidenceError, match="evidence_source_symlink"):
        models.add_evidence("2dfan4.onnx", "fixture", "2026-09-18", str(symlink), str(licence))
    with pytest.raises(EvidenceError, match="restricted_permission_required"):
        models.add_evidence("inswapper_128.onnx", "fixture", "2026-09-18", str(licence), permission_basis="applicable_licence")
    with pytest.raises(EvidenceError, match="model_permission_required"):
        models.add_evidence("inswapper_128.onnx", "fixture", "2026-09-18", str(licence))
    directory = tmp_path / "evidence-directory"
    directory.mkdir()
    with pytest.raises(EvidenceError, match="evidence_source_not_regular"):
        models.add_evidence("2dfan4.onnx", "fixture", "2026-09-18", str(directory), str(licence))
    assert storage.read(local / "models.json")["code_review"] == {}


def test_model_evidence_update_has_private_backup_and_atomic_failure_leaves_manifest(local, tmp_path, monkeypatch):
    licence = document(tmp_path / "licence.txt")
    permission = document(tmp_path / "permission.txt")
    original = (local / "models.json").read_bytes()
    monkeypatch.setattr(models, "atomic", lambda *args: (_ for _ in ()).throw(OSError("fixture")))
    with pytest.raises(EvidenceError, match="model_evidence_update_failed"):
        models.add_evidence("2dfan4.onnx", "fixture", "2026-09-18", str(licence), str(permission))
    assert (local / "models.json").read_bytes() == original
    assert not list((local / "rights" / "evidence").rglob("*"))


def test_template_rights_requires_known_import_and_invalidates_approval_without_touching_master(local, tmp_path):
    directory = storage.template_dir("couple-01")
    directory.mkdir(parents=True)
    master = directory / "master.mp4"
    master.write_bytes(b"fixture master bytes")
    storage.atomic(directory / "manifest.json", {"id": "couple-01", "title": "fixture", "rights": {},
                                                   "approval": {"old": True}, "benchmark": {"old": True}})
    before = storage.hash_file(master)
    licence = document(tmp_path / "licence.txt")
    permission = document(tmp_path / "permission.txt")
    with pytest.raises(Exception, match="template_rights_missing"):
        templates.add_rights("couple-01", "fixture", "2026-09-18", str(licence), str(permission))
    permission_link = tmp_path / "permission-link.txt"
    permission_link.symlink_to(permission)
    with pytest.raises(Exception, match="evidence_source_symlink"):
        templates.add_rights("couple-01", "fixture", "2026-09-18", str(licence), str(permission_link),
                             confirm_video_modification=True, confirm_video_distribution=True, confirm_audio_rights=True)
    result = templates.add_rights("couple-01", "fixture", "2026-09-18", str(licence), str(permission),
                                 confirm_video_modification=True, confirm_video_distribution=True, confirm_audio_rights=True)
    manifest = storage.read(directory / "manifest.json")
    assert result["updated"] and manifest["approval"] is None and manifest["benchmark"] is None
    assert storage.hash_file(master) == before
    assert templates.rights_status("couple-01")["ready"]
    with pytest.raises(Exception, match="template_rights_unknown"):
        templates.rights_status("unknown")
    assert list((local / "rights" / "backups").glob("template-couple-01-*.json"))


def test_template_rights_rejects_missing_master_and_source_special_file(local, tmp_path):
    directory = storage.template_dir("couple-02")
    directory.mkdir(parents=True)
    storage.atomic(directory / "manifest.json", {"id": "couple-02", "rights": {}})
    with pytest.raises(Exception, match="template_rights_manifest_missing"):
        templates.rights_status("couple-02")
    (directory / "manifest.json").unlink()
    directory.rmdir()
    directory.mkdir(parents=True)
    (directory / "master.mp4").mkdir()
    storage.atomic(directory / "manifest.json", {"id": "couple-02", "rights": {}})
    with pytest.raises(Exception, match="template_rights_manifest_missing"):
        templates.rights_status("couple-02")


def test_provenance_uses_bounded_hash_sidecars_without_model_download(local, monkeypatch):
    calls = []
    monkeypatch.setattr(models, "_fetch_sidecar", lambda name: calls.append(name) or (models.model_hash_source(name), "a" * 64))
    result = models.provenance_status()
    assert not calls and all(item["upstream_sha256"] is None for item in result["items"])
    fetched = models.provenance_status(fetch=True)
    assert len(calls) == len(models.ASSETS) and all(item["technical_only"] for item in fetched["items"])
    assert all("onnx" not in item["sidecar"] for item in fetched["items"])
    with pytest.raises(EvidenceError, match="provenance_confirmation_required"):
        models.record_provenance("2dfan4.onnx", confirm_technical_hash=False)
    updated = models.record_provenance("2dfan4.onnx", confirm_technical_hash=True)
    assert updated["sha256"] == "a" * 64
    manifest = storage.read(local / "models.json")
    record = next(item for item in manifest["assets"] if item["file"] == "2dfan4.onnx")
    assert record["provenance"]["technical_only"] is True
    assert record["provenance"]["sha256"] == record["sha256"]


def test_provenance_rejects_unallowlisted_url_and_oversized_sidecar(local, monkeypatch):
    monkeypatch.setattr(models, "model_hash_source", lambda _name: "http://metadata.invalid/model.hash")
    with pytest.raises(EvidenceError, match="provenance_fetch_failed"):
        models._fetch_sidecar("2dfan4.onnx")

    class Response:
        headers = {"Content-Length": str(models.PROVENANCE_MAX_BYTES + 1)}
        def __enter__(self): return self
        def __exit__(self, *args): return False

    monkeypatch.setattr(models, "model_hash_source", lambda _name: "https://github.com/facefusion/facefusion-assets/releases/download/models-3.0.0/2dfan4.hash")
    monkeypatch.setattr(models.urllib.request, "build_opener", lambda *_args: type("Opener", (), {"open": lambda *_args, **_kwargs: Response()})())
    with pytest.raises(EvidenceError, match="provenance_response_invalid"):
        models._fetch_sidecar("2dfan4.onnx")


def test_audit_report_is_actionable_without_private_absolute_paths(local):
    report = models.audit_report()
    encoded = json.dumps(report)
    assert report["ready"] is False
    assert report["manifest"] == "models.json" and report["rights_directory"] == "rights/"
    assert str(local) not in encoded
    assert "model_expected_hash_missing" in encoded and "model_bytes_not_installed" in encoded
    assert "template_rights_manifest_missing" in encoded and report["ready"] is False
