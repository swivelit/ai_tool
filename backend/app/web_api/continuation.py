from __future__ import annotations

from dataclasses import dataclass
import json
import re

from sqlmodel import Session, select

from ..ai.completion_quality import MarkdownFenceState, markdown_fence_state
from ..models import WebChatMessage


MAX_CONTINUATION_DEPTH = 12
_OUTLINE_LINE = re.compile(
    r"^\s*(?:#{1,6}\s+)?(?:cell|step|part|section)\s+\d+\b.*$",
    re.IGNORECASE,
)
_FENCE_LANGUAGE = re.compile(r"^\s{0,3}(?:`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)")
_SAFE_LANGUAGES = {
    "", "html", "xml", "css", "javascript", "js", "typescript", "ts",
    "json", "python", "py", "bash", "sh", "shell", "sql", "text", "code",
}
_SAFE_RENDER_PREFIX = re.compile(
    r"^(?:`{3,8}|~{3,8})"
    r"(?:html|xml|css|javascript|js|typescript|ts|json|python|py|"
    r"bash|sh|shell|sql|text|code)?\n$"
)


class ContinuationResolutionError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


@dataclass(frozen=True)
class ContinuationChain:
    root_user: WebChatMessage
    segments: tuple[WebChatMessage, ...]
    target: WebChatMessage
    fence_state: MarkdownFenceState

    @property
    def root_assistant_id(self) -> str:
        return self.segments[0].id

    @property
    def segment_index(self) -> int:
        return len(self.segments)


@dataclass(frozen=True)
class ContinuationPacket:
    text: str
    render_prefix: str
    fence_state: MarkdownFenceState
    rewind_characters: int = 0


def metadata_dict(row: WebChatMessage) -> dict[str, object]:
    try:
        value = json.loads(row.metadata_json or "{}")
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def write_metadata(row: WebChatMessage, metadata: dict[str, object]) -> None:
    row.metadata_json = json.dumps(
        metadata, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


def resolve_continuation_chain(
    session: Session,
    *,
    user_id: int,
    thread_id: str,
    continue_message_id: str,
) -> ContinuationChain:
    current = session.exec(
        select(WebChatMessage).where(
            WebChatMessage.id == continue_message_id,
            WebChatMessage.user_id == user_id,
            WebChatMessage.thread_id == thread_id,
            WebChatMessage.role == "assistant",
            WebChatMessage.status == "complete",
            WebChatMessage.superseded_at.is_(None),
        ).with_for_update()
    ).first()
    if current is None:
        raise ContinuationResolutionError(
            "continuation_not_found",
            "The response to continue is no longer available.",
            404,
        )
    target_metadata = metadata_dict(current)
    if not bool(target_metadata.get("truncated")):
        raise ContinuationResolutionError(
            "continuation_not_allowed",
            "Only a truncated response can be continued.",
            409,
        )
    if (
        target_metadata.get("continued_by_message_id")
        or target_metadata.get("continuation_consumed")
    ):
        raise ContinuationResolutionError(
            "continuation_already_claimed",
            "This response is already being continued.",
            409,
        )

    seen: set[str] = set()
    reverse_segments: list[WebChatMessage] = []
    root_user: WebChatMessage | None = None
    for _depth in range(MAX_CONTINUATION_DEPTH):
        if current.id in seen:
            raise ContinuationResolutionError(
                "continuation_chain_invalid",
                "This continuation chain is invalid.",
                409,
            )
        seen.add(current.id)
        reverse_segments.append(current)
        paired_user = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.user_id == user_id,
                WebChatMessage.thread_id == thread_id,
                WebChatMessage.role == "user",
                WebChatMessage.request_id == current.request_id,
                WebChatMessage.superseded_at.is_(None),
            )
        ).first()
        if paired_user is None:
            raise ContinuationResolutionError(
                "continuation_source_missing",
                "The original request is no longer available.",
                409,
            )
        user_metadata = metadata_dict(paired_user)
        assistant_metadata = metadata_dict(current)
        parent_id = str(
            user_metadata.get("continuation_parent_message_id")
            or user_metadata.get("continue_message_id")
            or assistant_metadata.get("continuation_parent_message_id")
            or ""
        )
        if not parent_id:
            root_user = paired_user
            break
        parent = session.exec(
            select(WebChatMessage).where(
                WebChatMessage.id == parent_id,
                WebChatMessage.user_id == user_id,
                WebChatMessage.thread_id == thread_id,
                WebChatMessage.role == "assistant",
                WebChatMessage.status == "complete",
                WebChatMessage.superseded_at.is_(None),
            )
        ).first()
        if parent is None:
            raise ContinuationResolutionError(
                "continuation_parent_missing",
                "A previous continuation segment is no longer available.",
                409,
            )
        current = parent
    else:
        raise ContinuationResolutionError(
            "continuation_chain_too_deep",
            "This response has too many continuation segments.",
            409,
        )
    if root_user is None:
        raise ContinuationResolutionError(
            "continuation_source_missing",
            "The original request is no longer available.",
            409,
        )
    segments = tuple(reversed(reverse_segments))
    rendered_chain = "\n".join(segment.content for segment in segments)
    return ContinuationChain(
        root_user=root_user,
        segments=segments,
        target=segments[-1],
        fence_state=markdown_fence_state(rendered_chain),
    )


def safe_render_prefix(state: MarkdownFenceState) -> str:
    if not state.is_open:
        return ""
    language = state.language.casefold()
    if language not in _SAFE_LANGUAGES:
        language = ""
    marker = state.fence_character * max(3, min(8, state.fence_length))
    return f"{marker}{language}\n"


def sanitize_render_prefix(value: object) -> str:
    candidate = value if isinstance(value, str) else ""
    return candidate if _SAFE_RENDER_PREFIX.fullmatch(candidate) else ""


def build_continuation_packet(
    chain: ContinuationChain,
    *,
    max_characters: int = 14_000,
    tail_characters: int = 7_000,
) -> ContinuationPacket:
    root = chain.root_user.content
    requirement_lines = [
        line for line in root.splitlines()
        if re.match(r"^\s*(?:\d+[.)]|[-*])\s+\S", line)
    ]
    root_excerpt = root
    if len(root_excerpt) > 5_000:
        important = "\n".join(requirement_lines)
        root_excerpt = root_excerpt[:3_000].rstrip()
        if important:
            root_excerpt += "\n\nImportant requirements:\n" + important[:2_000]

    outline: list[str] = []
    for segment in chain.segments:
        for line in segment.content.splitlines():
            if _OUTLINE_LINE.match(line):
                outline.append(line.strip())
            fence = _FENCE_LANGUAGE.match(line)
            if fence and fence.group(1):
                language = fence.group(1)
                outline.append(f"fenced code: {language}")
    outline_text = "\n".join(dict.fromkeys(outline))[:2_500]

    combined = "\n".join(segment.content for segment in chain.segments)
    partial_line = ""
    resumable = combined
    if combined and not combined.endswith(("\n", "\r")):
        boundary = combined.rfind("\n") + 1
        partial_line = combined[boundary:]
        resumable = combined[:boundary]
    retained_tail = resumable[-max(1, tail_characters):]
    if len(retained_tail) < len(resumable):
        retained_tail = "[Earlier response text omitted before this exact tail]\n" + retained_tail

    state = markdown_fence_state(resumable)
    fence_text = (
        f"Open fence: character={state.fence_character!r}, length={state.fence_length}, "
        f"language={state.language or 'plain'}, opening_position={state.opening_position}."
        if state.is_open else "No fenced code block is currently open."
    )
    instruction = (
        "Continue at the line boundary immediately before the incomplete terminal "
        "line. Return that line as a complete replacement, then finish the remaining "
        "requested work. Do not repeat any earlier completed line or section."
    )
    if state.is_open:
        instruction += (
            " The website joins this segment to the prior Markdown document. Continue "
            "inside the already-open fence without opening another fence, and close it "
            "when that code section is complete."
        )
    partial_line_text = partial_line or "(the prior response ended at a line boundary)"
    packet = (
        f"CURRENT CONTINUATION INSTRUCTION\n{instruction}\n\n"
        f"ORIGINAL USER REQUEST AND REQUIREMENTS\n{root_excerpt}\n\n"
        f"EXACT TERMINAL RESPONSE TAIL\n{retained_tail}\n\n"
        f"INCOMPLETE TERMINAL LINE TO REPLACE\n{partial_line_text}\n\n"
        f"MARKDOWN FENCE STATE\n{fence_text}\n\n"
        f"COMPLETED SECTION OUTLINE\n{outline_text or '(none detected)'}"
    )
    if len(packet) > max_characters:
        overflow = len(packet) - max_characters
        removable = max(0, len(outline_text) - 200)
        outline_text = outline_text[: max(0, len(outline_text) - min(overflow, removable))]
        packet = (
            f"CURRENT CONTINUATION INSTRUCTION\n{instruction}\n\n"
            f"ORIGINAL USER REQUEST AND REQUIREMENTS\n{root_excerpt}\n\n"
            f"EXACT TERMINAL RESPONSE TAIL\n{retained_tail}\n\n"
            f"INCOMPLETE TERMINAL LINE TO REPLACE\n{partial_line_text}\n\n"
            f"MARKDOWN FENCE STATE\n{fence_text}\n\n"
            f"COMPLETED SECTION OUTLINE\n{outline_text or '(omitted for prompt budget)'}"
        )
    if len(packet) > max_characters:
        keep = max(1_000, len(retained_tail) - (len(packet) - max_characters))
        raw_tail = resumable[-keep:]
        retained_tail = (
            "[Earlier response text omitted before this exact tail]\n" + raw_tail
        )
        packet = (
            f"CURRENT CONTINUATION INSTRUCTION\n{instruction}\n\n"
            f"ORIGINAL USER REQUEST AND REQUIREMENTS\n{root_excerpt}\n\n"
            f"EXACT TERMINAL RESPONSE TAIL\n{retained_tail}\n\n"
            f"INCOMPLETE TERMINAL LINE TO REPLACE\n{partial_line_text}\n\n"
            f"MARKDOWN FENCE STATE\n{fence_text}"
        )
    return ContinuationPacket(
        text=packet,
        render_prefix=safe_render_prefix(state),
        fence_state=state,
        rewind_characters=len(partial_line),
    )
