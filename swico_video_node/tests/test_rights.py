"""Local rights/provenance tooling tests; no legal or model acceptance claim."""
from __future__ import annotations

import json
import urllib.error
from pathlib import Path

import pytest

from swico_video_node import models, storage, templates
from swico_video_node.templates import _association_score
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


def test_legacy_crc32_sidecar_is_recorded_without_becoming_model_sha256(local, monkeypatch):
    monkeypatch.setattr(models, "_fetch_sidecar", lambda name: (models.model_hash_source(name), "a948738e"))
    report = models.provenance_status(fetch=True)
    item = next(value for value in report["items"] if value["asset"] == "2dfan4.onnx")
    assert item["upstream"] == {"algorithm": "crc32", "value": "a948738e", "url": models.model_hash_source("2dfan4.onnx")}
    assert item["upstream_sha256"] is None and item["matches_local_expected"] is None
    result = models.record_provenance("2dfan4.onnx", confirm_technical_hash=True)
    assert result["algorithm"] == "crc32" and result["sha256"] is None
    record = next(item for item in storage.read(local / "models.json")["assets"] if item["file"] == "2dfan4.onnx")
    assert record["sha256"] == ""
    assert record["provenance"]["algorithm"] == "crc32"
    assert record["provenance"]["value"] == "a948738e"


def test_independently_reviewed_sha256_route_is_explicit_and_does_not_download(local, monkeypatch):
    called = []
    monkeypatch.setattr(models, "_fetch_sidecar", lambda *_args: called.append(True))
    digest = "b" * 64
    result = models.record_expected_sha256("2dfan4.onnx", digest, "fixture reviewer", "2026-09-19", confirm=True)
    assert result["sha256"] == digest and not called
    record = next(item for item in storage.read(local / "models.json")["assets"] if item["file"] == "2dfan4.onnx")
    assert record["sha256"] == digest
    assert record["provenance"]["expected_sha256"]["source"] == "independent_operator_review"
    with pytest.raises(EvidenceError, match="provenance_sha256_invalid"):
        models.record_expected_sha256("2dfan4.onnx", "a948738e", "fixture", "2026-09-19", confirm=True)


def test_expected_sha256_can_be_derived_from_local_model_file_without_install(local, tmp_path):
    model_file = tmp_path / "reviewed-model.onnx"
    model_file.write_bytes(b"synthetic model bytes; not a real restricted weight")
    expected = __import__("hashlib").sha256(model_file.read_bytes()).hexdigest()
    result = models.record_expected_sha256("2dfan4.onnx", None, "fixture reviewer", "2026-09-19",
                                          confirm=True, model_file=str(model_file))
    assert result["sha256"] == expected
    record = next(item for item in storage.read(local / "models.json")["assets"] if item["file"] == "2dfan4.onnx")
    assert record["provenance"]["expected_sha256"]["source"] == "independent_operator_reviewed_bytes"
    model_file.write_bytes(b"changed outside worker storage")
    assert record["sha256"] == expected
    link = tmp_path / "model-link.onnx"
    link.symlink_to(model_file)
    with pytest.raises(EvidenceError, match="evidence_source_symlink"):
        models.record_expected_sha256("fan_68_5.onnx", None, "fixture reviewer", "2026-09-19",
                                      confirm=True, model_file=str(link))


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


def test_provenance_accepts_fixed_github_cdn_redirect_and_labels_crc32(local, monkeypatch):
    class Response:
        headers = {"Content-Length": "8"}
        def __enter__(self): return self
        def __exit__(self, *args): return False
        def read(self, _limit): return b"a948738e"

    redirect = urllib.error.HTTPError(
        models.model_hash_source("2dfan4.onnx"), 302, "redirect", {"Location": "https://release-assets.githubusercontent.com/github-production-release-asset/fixture?sig=bounded"}, None,
    )
    class Opener:
        calls = 0
        def open(self, _request, timeout=0):
            self.calls += 1
            if self.calls == 1: raise redirect
            return Response()
    opener = Opener()
    monkeypatch.setattr(models.urllib.request, "build_opener", lambda *_args: opener)
    url, value = models._fetch_sidecar("2dfan4.onnx")
    assert url.startswith("https://release-assets.githubusercontent.com/") and value == "a948738e"


def test_provenance_rejects_cdn_redirect_to_private_or_downgraded_destination(local, monkeypatch):
    class Opener:
        def open(self, _request, timeout=0):
            raise urllib.error.HTTPError(models.model_hash_source("2dfan4.onnx"), 302, "redirect", {"Location": "http://127.0.0.1/secret"}, None)
    monkeypatch.setattr(models.urllib.request, "build_opener", lambda *_args: Opener())
    with pytest.raises(EvidenceError, match="provenance_redirect_invalid"):
        models._fetch_sidecar("2dfan4.onnx")


def test_audit_report_is_actionable_without_private_absolute_paths(local):
    report = models.audit_report()
    encoded = json.dumps(report)
    assert report["ready"] is False
    assert report["manifest"] == "models.json" and report["rights_directory"] == "rights/"
    assert str(local) not in encoded
    assert "model_expected_hash_missing" in encoded and "model_bytes_not_installed" in encoded
    assert "template_rights_manifest_missing" in encoded and report["ready"] is False


def test_template_rights_remediation_does_not_point_to_model_evidence(local):
    for identifier in storage.TEMPLATES:
        directory = storage.template_dir(identifier)
        directory.mkdir(parents=True)
        (directory / "master.mp4").write_bytes(b"fixture master")
        storage.atomic(directory / "manifest.json", {"id": identifier, "rights": {}})
    report = models.audit_report()
    for item in report["templates"]:
        if "template_rights_manifest_missing" not in item["blockers"]:
            continue
        assert f"templates rights add --id {item['id']}" in " ".join(item["next_steps"])
        assert "models evidence add" not in " ".join(item["next_steps"])


def test_track_correction_is_bounded_atomic_and_invalidates_review(local):
    directory = storage.template_dir("couple-01")
    directory.mkdir(parents=True)
    master = directory / "master.mp4"
    master.write_bytes(b"permanent master")
    storage.atomic(directory / "manifest.json", {"id": "couple-01", "rights": {}, "approval": {"old": True}, "benchmark": {"old": True}})
    storage.atomic(directory / "tracks.json", {"frames": [
        {"shot": 0, "faces": [{"track": 1, "box": [0, 0, 10, 10]}]},
        {"shot": 0, "faces": [{"track": 1, "box": [1, 0, 11, 10]}]},
        {"shot": 1, "faces": [{"track": 1, "box": [30, 0, 40, 10]}]},
    ], "roles": {"1": "male"}})
    before = storage.hash_file(master)
    assert templates.tracks_status("couple-01")["tracks"][0]["frames"] == 3
    result = templates.correct_tracks("couple-01", "split", 1, at_frame=2)
    assert result["approval_invalidated"]
    assert storage.hash_file(master) == before
    tracks = storage.read(directory / "tracks.json")
    assert tracks["roles"] == {"1": "male", "2": "exclude"}
    assert tracks["frames"][2]["faces"][0]["track"] == 2
    assert storage.read(directory / "manifest.json")["approval"] is None
    templates.correct_tracks("couple-01", "reassign", 2, role="female")
    assert storage.read(directory / "tracks.json")["roles"]["2"] == "female"
    with pytest.raises(Exception, match="template_track_unknown"):
        templates.correct_tracks("couple-01", "exclude", 99)


def test_track_association_uses_local_feature_and_rejects_ambiguous_geometry():
    prior = {"box": [10, 10, 40, 40], "embedding": [1.0, 0.0, 0.0]}
    same_identity = _association_score([10, 10, 40, 40], [1.0, 0.0, 0.0], prior)
    crossing_identity = _association_score([10, 10, 40, 40], [0.0, 1.0, 0.0], prior)
    assert same_identity > crossing_identity
    # A human review path must not silently choose between equally plausible
    # faces; the render/prepare callers apply their documented margin.
    assert abs(_association_score([10, 10, 40, 40], [1.0, 0.0], {"box": [10, 10, 40, 40], "embedding": None}) -
               _association_score([10, 10, 40, 40], [0.0, 1.0], {"box": [10, 10, 40, 40], "embedding": None})) < .08
