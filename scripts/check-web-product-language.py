#!/usr/bin/env python3
"""Prevent private routing and retired wording in customer-facing web assets."""

from __future__ import annotations

import re
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = REPOSITORY_ROOT / "web"
SOURCE_ROOT = WEB_ROOT / "src"
FORBIDDEN = (
    "AI credits",
    "Add credit",
    "Add AI credits",
    "Usage-value equivalent",
    "Equivalent to ₹",
    "Usage value consumed",
    "AI credits granted",
    "AI credits reversed",
    "Estimated for Swico",
    "Actual usage depends on message size",
    "Pricing as of",
    "Pricing timestamp",
    "Measured requests",
    "Estimated requests",
    "openai",
    "gpt-",
    "chatgpt",
    "claude",
    "anthropic",
    "gemini",
    "google ai",
    "llama",
    "mistral",
    "deepseek",
    "sarvam",
    "₹125 per complete week",
)

PUBLIC_STRING_FORBIDDEN = (
    "micros",
    "micro-INR",
    "micro inr",
)
WEEKLY_RUPEES_ACCESS = re.compile(r"(?:\.weekly_allowance_rupees|['\"]weekly_allowance_rupees['\"])")


def production_files() -> list[Path]:
    files = [
        path for path in SOURCE_ROOT.rglob("*")
        if path.suffix in {".ts", ".tsx", ".json", ".css", ".html"}
        and ".test." not in path.name
    ]
    if (WEB_ROOT / "index.html").exists():
        files.append(WEB_ROOT / "index.html")
    public = WEB_ROOT / "public"
    if public.exists():
        files.extend(
            path for path in public.rglob("*")
            if path.is_file() and path.suffix in {".js", ".css", ".html", ".json", ".txt"}
        )
    dist = WEB_ROOT / "dist"
    if dist.exists():
        files.extend(
            path for path in dist.rglob("*")
            if path.is_file() and path.suffix in {".js", ".css", ".html", ".json"}
        )
    return sorted(set(files))


def main() -> int:
    findings: list[str] = []
    for path in production_files():
        text = path.read_text(encoding="utf-8")
        check_public_literals = "dist" not in path.relative_to(REPOSITORY_ROOT).parts
        for line_number, line in enumerate(text.splitlines(), 1):
            for phrase in FORBIDDEN:
                if phrase.casefold() in line.casefold():
                    findings.append(f"{path.relative_to(REPOSITORY_ROOT)}:{line_number}: forbidden customer wording: {phrase}")
            if WEEKLY_RUPEES_ACCESS.search(line):
                findings.append(f"{path.relative_to(REPOSITORY_ROOT)}:{line_number}: weekly_allowance_rupees must not be read by the web UI")
            # Internal *_micros fields are valid API/type compatibility names. Only
            # reject monetary-unit wording inside customer-facing string literals.
            if check_public_literals:
                string_literals = re.findall(r"(['\"])(.*?)\1|`([^`]*)`", line)
                literal_text = " ".join((single or double or template) for single, double, template in string_literals)
                for phrase in PUBLIC_STRING_FORBIDDEN:
                    if phrase.casefold() in literal_text.casefold():
                        findings.append(f"{path.relative_to(REPOSITORY_ROOT)}:{line_number}: forbidden public usage wording: {phrase}")
    if findings:
        print("\n".join(findings))
        return 1
    print("web product-language check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
