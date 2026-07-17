#!/usr/bin/env python3
"""Prevent retired cash-like token-credit wording in production web source."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1] / "web" / "src"
FORBIDDEN = (
    "AI credits",
    "Add credit",
    "Add AI credits",
    "Usage-value equivalent",
    "Equivalent to ₹",
    "Usage value consumed",
    "AI credits granted",
    "AI credits reversed",
)


def main() -> int:
    findings: list[str] = []
    for path in sorted(ROOT.rglob("*")):
        if path.suffix not in {".ts", ".tsx", ".json"} or ".test." in path.name:
            continue
        text = path.read_text(encoding="utf-8")
        for line_number, line in enumerate(text.splitlines(), 1):
            for phrase in FORBIDDEN:
                if phrase.casefold() in line.casefold():
                    findings.append(f"{path.relative_to(ROOT.parent.parent)}:{line_number}: forbidden customer wording: {phrase}")
    if findings:
        print("\n".join(findings))
        return 1
    print("web product-language check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
