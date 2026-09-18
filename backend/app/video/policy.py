"""Separate video publication gate; never unpublish the released Chat policies."""
import importlib.util
import json
from pathlib import Path


def video_policy_ready():
    try:
        directory = Path(__file__).resolve().parents[3] / "web/src/content"
        published = json.loads((directory / "legalContent.json").read_text())
        draft = json.loads((directory / "videoLegalDraft.json").read_text())
        if published["pages"] != draft["pages"]:
            return False
        # Reuse the released publication validator, including written approval,
        # owner-attestation/counsel semantics and exact content fingerprint.
        script = directory.parents[2] / "scripts/check-legal-publication.py"
        spec = importlib.util.spec_from_file_location("video_publication_check", script)
        if not spec or not spec.loader:
            return False
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return not module.findings()
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False
