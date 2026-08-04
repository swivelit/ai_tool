from __future__ import annotations

import re

from .models import QualityCheck


FENCED_CODE_OUTPUT_INSTRUCTION = (
    "Put any code, markup, configuration, or terminal output in a fenced "
    "Markdown block with an appropriate language tag. Keep prose explanation "
    "outside fenced blocks. If an explicit output contract requires a different "
    "representation or exact fence count, obey that explicit contract."
)

_FENCE_LINE = re.compile(r"(?m)^\s*```[^\n]*$")
_CODE_LINE = re.compile(
    r"^\s*(?:<[a-zA-Z/!]|(?:def|class|function|const|let|var|import|SELECT|CREATE\s+TABLE)\b)",
    re.IGNORECASE,
)
_INDENTED_CODE_LINE = re.compile(r"^\s{2,}.*[;{}>]\s*$")


def _outside_fence_lines(answer: str) -> list[str]:
    outside: list[str] = []
    in_fence = False
    for line in str(answer or "").splitlines():
        # A fence marker is structural only when it owns the Markdown line.
        # Inline code such as ``use ``` literally`` must not toggle state.
        if _FENCE_LINE.fullmatch(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            outside.append(line)
    return outside


def has_unfenced_code_like_content(answer: str) -> bool:
    lines = _outside_fence_lines(answer)
    if any(_CODE_LINE.match(line) for line in lines):
        return True
    run = 0
    for line in lines:
        if _INDENTED_CODE_LINE.match(line):
            run += 1
            if run >= 3:
                return True
        else:
            run = 0
    return False


def fenced_code_quality_check(answer: str) -> QualityCheck:
    unfenced = has_unfenced_code_like_content(answer)
    return QualityCheck(
        "output_fenced_code_present",
        "failed" if unfenced else "passed",
        "code_like_content_outside_fence" if unfenced else "",
    )


def fence_marker_count(answer: str) -> int:
    return len(_FENCE_LINE.findall(str(answer or "")))


def autoclose_unbalanced_fence(answer: str) -> tuple[str, bool]:
    value = str(answer or "")
    if fence_marker_count(value) % 2 == 0:
        return value, False
    separator = "" if value.endswith("\n") else "\n"
    return f"{value}{separator}```", True


def fence_integrity_quality_check(*, autoclosed: bool) -> QualityCheck:
    return QualityCheck(
        "output_fence_integrity",
        "passed",
        observations=(("fence_autoclosed", int(autoclosed)),),
    )
