#!/usr/bin/env python3
"""Read-only proposed video policy comparison. Never records approval."""
import difflib
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def main():
    path=ROOT/"web/src/content"
    published=json.loads((path/"legalContent.json").read_text())
    proposed=json.loads((path/"videoLegalDraft.json").read_text())
    spec=importlib.util.spec_from_file_location("publication",ROOT/"scripts/check-legal-publication.py")
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    for label,value in (("Published",published),("Proposed (NOT APPROVED)",proposed)):
        print(label+" pages SHA256: "+module.legal_content_fingerprint(value))
    print("Approval metadata is excluded from page fingerprints. Existing approval cannot be reused.")
    for line in difflib.unified_diff(json.dumps(published["pages"],ensure_ascii=False,indent=2).splitlines(),
                                     json.dumps(proposed["pages"],ensure_ascii=False,indent=2).splitlines(),
                                     fromfile="published pages",tofile="proposed video pages",lineterm=""):
        print(line)


if __name__=="__main__":main()
