#!/usr/bin/env python3
"""Prevent private routing and retired wording in customer-facing web assets."""

from __future__ import annotations

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
)


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
        for line_number, line in enumerate(text.splitlines(), 1):
            for phrase in FORBIDDEN:
                if phrase.casefold() in line.casefold():
                    findings.append(f"{path.relative_to(REPOSITORY_ROOT)}:{line_number}: forbidden customer wording: {phrase}")
    if findings:
        print("\n".join(findings))
        return 1
    print("web product-language check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
