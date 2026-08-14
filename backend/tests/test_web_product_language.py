from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check-web-product-language.py"
SPEC = importlib.util.spec_from_file_location("check_web_product_language", SCRIPT)
assert SPEC and SPEC.loader
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


def _run(tmp_path: Path, monkeypatch, source: str) -> tuple[int, str]:
    source_path = tmp_path / "CustomerCopy.tsx"
    source_path.write_text(source, encoding="utf-8")
    monkeypatch.setattr(CHECKER, "REPOSITORY_ROOT", tmp_path)
    monkeypatch.setattr(CHECKER, "production_files", lambda: [source_path])
    findings: list[str] = []
    monkeypatch.setattr("builtins.print", lambda value="": findings.append(str(value)))
    return CHECKER.main(), "\n".join(findings)


def test_single_double_and_template_literals_are_checked(tmp_path: Path, monkeypatch):
    for source in ("const x = 'micros'", 'const x = "micro-INR"', "const x = `₹125 per complete week`"):
        status, output = _run(tmp_path, monkeypatch, source)
        assert status == 1
        assert output


def test_internal_micros_identifiers_remain_allowed(tmp_path: Path, monkeypatch):
    status, output = _run(
        tmp_path,
        monkeypatch,
        "const remaining_micros = charge_micros; const limit = weekly_allowance_micros;",
    )
    assert status == 0
    assert output == "web product-language check passed"


def test_internal_micros_property_literals_remain_allowed(tmp_path: Path, monkeypatch):
    status, output = _run(
        tmp_path,
        monkeypatch,
        "const field = 'remaining_micros'; const allowance = \"weekly_allowance_micros\";",
    )
    assert status == 0
    assert output == "web product-language check passed"
