from __future__ import annotations

from dataclasses import dataclass
import re


_FENCE_LINE = re.compile(
    r"^[ \t]{0,3}(?P<fence>`{3,}|~{3,})(?P<suffix>[^\r\n]*)$"
)
_SECTION_HEADING = re.compile(
    r"^[ \t]*(?:"
    r"#{1,6}[ \t]+(?:cell|step|part|section)[ \t]+\d+\b.*"
    r"|(?:cell|step|part|section)[ \t]+\d+[ \t]*"
    r"(?:$|[—–:.-][ \t]*\S.*)"
    r")$",
    re.IGNORECASE,
)
_UNFINISHED_LIST_MARKER = re.compile(
    r"^[ \t]*(?:[-+*]|\d+[.)])[ \t]*$"
)


@dataclass(frozen=True)
class MarkdownFenceState:
    is_open: bool
    fence_character: str = ""
    fence_length: int = 0
    language: str = ""
    opening_position: int = -1
    is_closed: bool = True


def markdown_fence_state(text: str) -> MarkdownFenceState:
    """Return the terminal fenced-code state without interpreting inline code."""

    value = str(text or "")
    active: MarkdownFenceState | None = None
    position = 0
    for line_with_end in value.splitlines(keepends=True):
        line = line_with_end.rstrip("\r\n")
        match = _FENCE_LINE.match(line)
        if match:
            fence = match.group("fence")
            suffix = match.group("suffix").strip()
            if active is None:
                language = suffix.split(maxsplit=1)[0] if suffix else ""
                active = MarkdownFenceState(
                    is_open=True,
                    fence_character=fence[0],
                    fence_length=len(fence),
                    language=language,
                    opening_position=position,
                    is_closed=False,
                )
            elif (
                fence[0] == active.fence_character
                and len(fence) >= active.fence_length
                and not suffix
            ):
                active = None
        position += len(line_with_end)
    return active or MarkdownFenceState(is_open=False)


def incomplete_markdown_reason(text: str, answer_class: object) -> str:
    """Return a conservative, deterministic reason for obvious truncation."""

    value = str(text or "")
    if not value.strip():
        return ""

    open_fence: tuple[str, int, int] | None = None
    closed_fences: list[tuple[int, int, bool]] = []
    lines = value.splitlines()
    for index, line in enumerate(lines):
        match = _FENCE_LINE.match(line)
        if not match:
            continue
        fence = match.group("fence")
        marker = fence[0]
        length = len(fence)
        suffix = match.group("suffix")
        if open_fence is None:
            open_fence = (marker, length, index)
            continue
        open_marker, open_length, open_index = open_fence
        if (
            marker == open_marker
            and length >= open_length
            and not suffix.strip()
        ):
            closed_fences.append((
                open_index,
                index,
                any(line.strip() for line in lines[open_index + 1 : index]),
            ))
            open_fence = None

    if open_fence is not None:
        _marker, _length, opener_index = open_fence
        meaningful_code = any(
            line.strip() for line in lines[opener_index + 1 :]
        )
        return (
            "unmatched_code_fence"
            if meaningful_code else "empty_final_code_block"
        )
    final_meaningful_index = next(
        (
            index
            for index in range(len(lines) - 1, -1, -1)
            if lines[index].strip()
        ),
        -1,
    )
    if (
        closed_fences
        and closed_fences[-1][1] == final_meaningful_index
        and not closed_fences[-1][2]
    ):
        return "empty_final_code_block"

    normalized_class = str(answer_class or "").strip().lower()
    if normalized_class not in {"detailed", "long_form"}:
        return ""
    final_line = next(
        (line.strip() for line in reversed(lines) if line.strip()),
        "",
    )
    if _SECTION_HEADING.match(final_line):
        return "dangling_section_heading"
    if _UNFINISHED_LIST_MARKER.fullmatch(final_line):
        return "unfinished_list_marker"
    return ""
