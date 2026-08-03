from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import re
from typing import Any

from .models import QualityCheck
from .sentence_segmentation import (
    SENTENCE_VALIDATOR_VERSION, count_sentences,
)


_NUMBER_WORDS = {
    "one": 1,
    "two": 2,
    "three": 3,
    "four": 4,
    "five": 5,
    "six": 6,
    "seven": 7,
    "eight": 8,
    "nine": 9,
    "ten": 10,
    "eleven": 11,
    "twelve": 12,
    "ஐந்து": 5,
}
_BULLET_LINE = re.compile(r"^\s*(?:[-*+] |\d+[.)]\s+)")
_FENCED_BLOCK = re.compile(
    r"```(?P<language>[A-Za-z0-9_+.-]*)[^\S\n]*\n(?P<body>.*?)```",
    re.DOTALL,
)


def _number(value: str) -> int | None:
    normalized = str(value or "").strip().casefold()
    if normalized.isdigit():
        parsed = int(normalized)
        return parsed if 0 <= parsed <= 10_000 else None
    return _NUMBER_WORDS.get(normalized)


@dataclass(frozen=True)
class OutputContract:
    exact_bullet_count: int | None = None
    max_words_per_bullet: int | None = None
    max_total_words: int | None = None
    exact_fenced_block_count: int | None = None
    fenced_language: str | None = None
    fenced_block_prefixes: tuple[str, ...] = ()
    json_only: bool = False
    exact_json_keys: tuple[str, ...] = ()
    exact_sentence_count: int | None = None
    required_script: str | None = None
    exact_question_count: int | None = None
    exact_word_count: int | None = None
    required_phrase: str | None = None
    required_phrase_count: int | None = None
    required_final_word: str | None = None
    no_title: bool = False
    no_introductory_prose: bool = False

    @property
    def required(self) -> bool:
        return any((
            self.exact_bullet_count is not None,
            self.max_words_per_bullet is not None,
            self.max_total_words is not None,
            self.exact_fenced_block_count is not None,
            self.json_only,
            bool(self.exact_json_keys),
            self.exact_sentence_count is not None,
            self.required_script is not None,
            self.exact_question_count is not None,
            self.exact_word_count is not None,
            self.required_phrase_count is not None,
            self.required_final_word is not None,
            self.no_title,
            self.no_introductory_prose,
        ))

    def as_metadata(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def strict_visible_format(self) -> bool:
        return bool(
            self.json_only
            or self.exact_word_count is not None
            or self.exact_sentence_count is not None
            or self.required_script is not None
            or self.exact_bullet_count is not None
            or self.exact_fenced_block_count is not None
            or self.required_final_word is not None
        )

    @property
    def minimum_visible_output_tokens(self) -> int:
        """Conservative visible-token reserve for strict output contracts."""
        estimates = [64]
        if self.exact_word_count is not None:
            estimates.append(int(self.exact_word_count * 1.7) + 24)
        if self.exact_sentence_count is not None:
            estimates.append(self.exact_sentence_count * 28 + 24)
        if self.exact_bullet_count is not None:
            estimates.append(self.exact_bullet_count * 52 + 24)
        if self.exact_fenced_block_count is not None:
            estimates.append(self.exact_fenced_block_count * 180 + 32)
        if self.json_only:
            estimates.append(max(96, len(self.exact_json_keys) * 32 + 32))
        return min(6_000, max(estimates)) if self.required else 0

    @classmethod
    def from_metadata(cls, value: object) -> "OutputContract":
        if not isinstance(value, dict):
            return cls()
        integer_fields = {
            "exact_bullet_count", "max_words_per_bullet", "max_total_words",
            "exact_fenced_block_count", "exact_sentence_count",
            "exact_question_count", "exact_word_count", "required_phrase_count",
        }
        bounded: dict[str, Any] = {}
        for key in integer_fields:
            raw = value.get(key)
            if isinstance(raw, int) and not isinstance(raw, bool) and 0 <= raw <= 10_000:
                bounded[key] = raw
        for key in ("fenced_language", "required_phrase", "required_final_word"):
            raw = value.get(key)
            if isinstance(raw, str):
                bounded[key] = raw[:160]
        if str(value.get("required_script") or "").casefold() == "tamil":
            bounded["required_script"] = "tamil"
        for key in ("json_only", "no_title", "no_introductory_prose"):
            bounded[key] = value.get(key) is True
        prefixes = value.get("fenced_block_prefixes")
        keys = value.get("exact_json_keys")
        bounded["fenced_block_prefixes"] = tuple(
            str(item)[:160] for item in prefixes[:8]
        ) if isinstance(prefixes, (list, tuple)) else ()
        bounded["exact_json_keys"] = tuple(
            str(item)[:80] for item in keys[:32]
        ) if isinstance(keys, (list, tuple)) else ()
        return cls(**bounded)


def extract_output_contract(message: str) -> OutputContract:
    text = str(message or "")
    bullet_count = None
    match = re.search(
        r"\bexactly\s+([A-Za-z]+|\d+)\s+(?:bullet\s+points?|bullets?)\b",
        text,
        re.IGNORECASE,
    )
    if match:
        bullet_count = _number(match.group(1))

    max_words_per_bullet = None
    match = re.search(
        r"\beach\s+bullet\b[^.\n]{0,80}\b(?:no\s+more\s+than|at\s+most|maximum)\s+"
        r"([A-Za-z]+|\d+)\s+words?\b",
        text, re.IGNORECASE,
    )
    if match:
        max_words_per_bullet = _number(match.group(1))

    max_total_words = None
    match = re.search(
        r"\b(?:use|return|answer\s+in)\s+(?:no\s+more\s+than|at\s+most|maximum)\s+"
        r"([A-Za-z]+|\d+)\s+words?\b",
        text,
        re.IGNORECASE,
    )
    if match:
        max_total_words = _number(match.group(1))

    fenced_count = None
    fenced_language = None
    match = re.search(
        r"\bexactly\s+([A-Za-z]+|\d+)\s+fenced\s+"
        r"(?:(Python|JSON|JavaScript|TypeScript)\s+)?code\s+blocks?\b",
        text,
        re.IGNORECASE,
    )
    if match:
        fenced_count = _number(match.group(1))
        fenced_language = str(match.group(2) or "").casefold() or None

    prefix_matches = re.findall(
        r"\b(?:first|second|third|fourth)\s+block\s+must\s+begin\s+with:\s*\n+"
        r"([^\n]+)",
        text,
        re.IGNORECASE,
    )
    prefixes = tuple(value.strip()[:160] for value in prefix_matches if value.strip())

    json_only = bool(re.search(
        r"\b(?:return|output)\s+only\s+(?:valid\s+)?JSON\b|\bJSON[- ]only\b",
        text,
        re.IGNORECASE,
    ))
    exact_json_keys: tuple[str, ...] = ()
    key_heading = re.search(
        r"\bexactly\s+these\s+keys\s*:\s*$", text,
        re.IGNORECASE | re.MULTILINE,
    )
    if key_heading:
        keys: list[str] = []
        for line in text[key_heading.end():].splitlines():
            if not line.strip():
                if keys:
                    continue
                continue
            item = re.match(r"^\s*[-*+]\s*([A-Za-z_][\w-]*)\s*$", line)
            if not item:
                break
            keys.append(item.group(1))
        exact_json_keys = tuple(keys[:32])

    sentence_count = None
    match = re.search(
        r"\bexactly\s+([A-Za-z]+|\d+)\s+(?:simple\s+)?(?:Tamil\s+)?sentences?\b",
        text,
        re.IGNORECASE,
    ) or re.search(r"(ஐந்து)\s+.{0,20}வாக்கியங்களில்", text)
    if match:
        sentence_count = _number(match.group(1))
    required_script = None
    if (
        re.search(r"\bTamil\b[^.\n]{0,40}\bsentences?\b", text, re.IGNORECASE)
        or ("தமிழ்" in text and "வாக்கிய" in text)
    ):
        required_script = "tamil"

    question_count = None
    match = re.search(
        r"\b(?:ask|include)\s+exactly\s+([A-Za-z]+|\d+)\s+"
        r"(?:clarifying\s+)?questions?\b",
        text,
        re.IGNORECASE,
    )
    if match:
        question_count = _number(match.group(1))

    exact_word_count = None
    match = re.search(
        r"\b(?:of|with|using)?\s*exactly\s+(\d+)\s+words?\b",
        text,
        re.IGNORECASE,
    )
    if match:
        exact_word_count = _number(match.group(1))

    required_phrase = None
    required_phrase_count = None
    match = re.search(
        r"\b(?:include|use)\s+the\s+phrase\s+[“\"]([^”\"]{1,120})[”\"]\s+"
        r"exactly\s+(once|twice|[A-Za-z]+|\d+)",
        text,
        re.IGNORECASE,
    )
    if match:
        required_phrase = match.group(1)
        count_value = {"once": 1, "twice": 2}.get(match.group(2).casefold())
        required_phrase_count = count_value or _number(match.group(2))

    final_word = None
    match = re.search(
        r"\bend\s+with\s+the\s+word\s+[“\"]([^”\"\s]{1,80})[”\"]",
        text,
        re.IGNORECASE,
    )
    if match:
        final_word = match.group(1)

    return OutputContract(
        exact_bullet_count=bullet_count,
        max_words_per_bullet=max_words_per_bullet,
        max_total_words=max_total_words,
        exact_fenced_block_count=fenced_count,
        fenced_language=fenced_language,
        fenced_block_prefixes=prefixes,
        json_only=json_only,
        exact_json_keys=exact_json_keys,
        exact_sentence_count=sentence_count,
        required_script=required_script,
        exact_question_count=question_count,
        exact_word_count=exact_word_count,
        required_phrase=required_phrase,
        required_phrase_count=required_phrase_count,
        required_final_word=final_word,
        no_title=bool(re.search(
            r"\b(?:do\s+not\s+include|without)\s+(?:a\s+)?title\b|\bno\s+title\b",
            text,
            re.IGNORECASE,
        )),
        no_introductory_prose=bool(re.search(
            r"\bdo\s+not\s+add\s+(?:an?\s+)?introduction\b|"
            r"\bno\s+(?:introductory|surrounding)\s+prose\b",
            text,
            re.IGNORECASE,
        )),
    )


def output_contract_instruction(contract: OutputContract) -> str:
    if not contract.required:
        return ""
    rules: list[str] = []
    if contract.exact_bullet_count is not None:
        rules.append(f"Use exactly {contract.exact_bullet_count} bullet lines.")
    if contract.max_words_per_bullet is not None:
        rules.append(
            f"Use at most {contract.max_words_per_bullet} whitespace-delimited words per bullet."
        )
    if contract.max_total_words is not None:
        rules.append(f"Use at most {contract.max_total_words} total words.")
    if contract.exact_fenced_block_count is not None:
        language = f" labelled {contract.fenced_language}" if contract.fenced_language else ""
        rules.append(
            f"Return exactly {contract.exact_fenced_block_count} fenced code blocks{language}."
        )
    for index, prefix in enumerate(contract.fenced_block_prefixes, start=1):
        rules.append(f"Fenced block {index} must begin with {prefix!r}.")
    if contract.json_only:
        rules.append("Return one valid JSON object and no Markdown or surrounding prose.")
    if contract.exact_json_keys:
        rules.append("Use exactly these JSON keys: " + ", ".join(contract.exact_json_keys) + ".")
    if contract.exact_sentence_count is not None:
        rules.append(f"Use exactly {contract.exact_sentence_count} sentences.")
    if contract.required_script == "tamil":
        rules.append(
            "Write the answer in Tamil script; non-Tamil sentences do not "
            "satisfy this contract."
        )
    if contract.exact_question_count is not None:
        rules.append(f"Include exactly {contract.exact_question_count} questions.")
    if contract.exact_word_count is not None:
        rules.append(f"Use exactly {contract.exact_word_count} total words.")
    if contract.required_phrase and contract.required_phrase_count is not None:
        rules.append(
            f"Include {contract.required_phrase!r} exactly {contract.required_phrase_count} time(s)."
        )
    if contract.required_final_word:
        rules.append(f"End with the word {contract.required_final_word!r}.")
    if contract.no_title:
        rules.append("Do not include a title.")
    if contract.no_introductory_prose:
        rules.append("Do not include introductory or surrounding prose.")
    return "Mandatory output contract; every rule must pass:\n- " + "\n- ".join(rules)


def output_contract_hash(contract: OutputContract) -> str:
    payload = json.dumps(
        contract.as_metadata(), sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def canonicalize_output_contract(answer: str, contract: OutputContract) -> str:
    """Remove wrappers only when doing so preserves the generated semantics."""
    value = str(answer or "").strip()
    if not contract.required:
        return value

    if contract.json_only:
        decoder = json.JSONDecoder()
        candidates: list[dict[str, Any]] = []
        for index, character in enumerate(value):
            if character != "{":
                continue
            try:
                parsed, _end = decoder.raw_decode(value[index:])
            except (TypeError, ValueError):
                continue
            if not isinstance(parsed, dict):
                continue
            if contract.exact_json_keys and set(parsed) != set(
                contract.exact_json_keys
            ):
                continue
            candidates.append(parsed)
        if len(candidates) == 1:
            return json.dumps(
                candidates[0], ensure_ascii=False, separators=(",", ":")
            )

    if contract.exact_fenced_block_count is not None:
        matches = list(_FENCED_BLOCK.finditer(value))
        selected: list[re.Match[str]] = []
        for match in matches:
            if (
                contract.fenced_language
                and match.group("language").casefold()
                != contract.fenced_language.casefold()
            ):
                continue
            prefix_index = len(selected)
            if prefix_index < len(contract.fenced_block_prefixes):
                if not match.group("body").lstrip().startswith(
                    contract.fenced_block_prefixes[prefix_index]
                ):
                    continue
            selected.append(match)
            if len(selected) == contract.exact_fenced_block_count:
                break
        if len(selected) == contract.exact_fenced_block_count:
            return "\n\n".join(
                "```" + match.group("language") + "\n"
                + match.group("body").rstrip() + "\n```"
                for match in selected
            )
    return value


def validate_output_contract(
    answer: str,
    contract: OutputContract,
) -> tuple[QualityCheck, ...]:
    if not contract.required:
        return ()
    value = str(answer or "").strip()
    lines = [line for line in value.splitlines() if line.strip()]
    bullets = [line for line in lines if _BULLET_LINE.match(line)]
    checks: list[QualityCheck] = []

    def add(name: str, passed: bool, reason: str) -> None:
        checks.append(QualityCheck(
            f"output_contract_{name}",
            "passed" if passed else "failed",
            "" if passed else reason,
        ))

    if contract.exact_bullet_count is not None:
        add(
            "bullet_count",
            len(bullets) == contract.exact_bullet_count,
            "exact_bullet_count_failed",
        )
    if contract.max_words_per_bullet is not None:
        counts = [len(_BULLET_LINE.sub("", line).split()) for line in bullets]
        add(
            "bullet_words",
            bool(bullets) and all(
                count <= contract.max_words_per_bullet for count in counts
            ),
            "bullet_word_limit_failed",
        )
    if contract.max_total_words is not None:
        add(
            "max_words",
            len(value.split()) <= contract.max_total_words,
            "total_word_limit_failed",
        )

    fenced = list(_FENCED_BLOCK.finditer(value))
    if contract.exact_fenced_block_count is not None:
        add(
            "fence_count",
            len(fenced) == contract.exact_fenced_block_count,
            "exact_fence_count_failed",
        )
    if contract.fenced_language:
        add(
            "fence_language",
            bool(fenced) and all(
                match.group("language").casefold()
                == contract.fenced_language.casefold()
                for match in fenced
            ),
            "fence_language_failed",
        )
    for index, prefix in enumerate(contract.fenced_block_prefixes):
        add(
            f"fence_prefix_{index + 1}",
            index < len(fenced)
            and fenced[index].group("body").lstrip().startswith(prefix),
            "fence_prefix_failed",
        )

    parsed_json: object | None = None
    if contract.json_only or contract.exact_json_keys:
        try:
            parsed_json = json.loads(value)
            valid_json = isinstance(parsed_json, dict)
        except (TypeError, ValueError):
            valid_json = False
        if contract.json_only:
            add("json_only", valid_json, "json_only_failed")
        if contract.exact_json_keys:
            add(
                "json_keys",
                isinstance(parsed_json, dict)
                and set(parsed_json) == set(contract.exact_json_keys),
                "exact_json_keys_failed",
            )

    if contract.exact_sentence_count is not None:
        observed = count_sentences(value)
        checks.append(QualityCheck(
            "output_contract_sentence_count",
            "passed" if observed == contract.exact_sentence_count else "failed",
            "" if observed == contract.exact_sentence_count else "exact_sentence_count_failed",
            observations=(
                ("expected_sentence_count", contract.exact_sentence_count),
                ("observed_sentence_count", observed),
                ("validator_version", SENTENCE_VALIDATOR_VERSION),
            ),
        ))
    if contract.required_script == "tamil":
        contains_tamil_script = bool(re.search(r"[\u0B80-\u0BFF]", value))
        checks.append(QualityCheck(
            "output_contract_required_script",
            "passed" if contains_tamil_script else "failed",
            "" if contains_tamil_script else "required_tamil_script_failed",
            observations=(
                ("contains_tamil_script", int(contains_tamil_script)),
                ("validator_version", SENTENCE_VALIDATOR_VERSION),
            ),
        ))
    if contract.exact_question_count is not None:
        add(
            "question_count",
            value.count("?") == contract.exact_question_count,
            "exact_question_count_failed",
        )
    if contract.exact_word_count is not None:
        observed_word_count = len(value.split())
        checks.append(QualityCheck(
            "output_contract_word_count",
            (
                "passed"
                if observed_word_count == contract.exact_word_count
                else "failed"
            ),
            (
                ""
                if observed_word_count == contract.exact_word_count
                else "exact_word_count_failed"
            ),
            observations=(
                ("expected_word_count", contract.exact_word_count),
                ("observed_word_count", observed_word_count),
                (
                    "word_count_delta",
                    observed_word_count - contract.exact_word_count,
                ),
            ),
        ))
    if contract.required_phrase and contract.required_phrase_count is not None:
        add(
            "phrase_count",
            value.casefold().count(contract.required_phrase.casefold())
            == contract.required_phrase_count,
            "required_phrase_count_failed",
        )
    if contract.required_final_word:
        words = value.rstrip().rstrip(".!?,;:”“\"'").split()
        add(
            "final_word",
            bool(words)
            and words[-1].casefold() == contract.required_final_word.casefold(),
            "required_final_word_failed",
        )
    if contract.no_title:
        first = lines[0] if lines else ""
        looks_like_plain_title = bool(
            len(lines) > 1
            and len(first.split()) <= 10
            and not re.search(r"[.!?]$", first)
            and not _BULLET_LINE.match(first)
        )
        add(
            "no_title",
            not re.match(r"^\s*#{1,6}\s+|^\s*title\s*:", first, re.I)
            and not looks_like_plain_title,
            "title_present",
        )
    if contract.no_introductory_prose and contract.exact_bullet_count is not None:
        add(
            "no_intro",
            len(lines) == len(bullets),
            "introductory_prose_present",
        )
    return tuple(checks)


def contract_compliant_candidate(
    answer: str,
    contract: OutputContract,
) -> str | None:
    """Return a semantics-preserving compliant candidate or reject it."""
    value = canonicalize_output_contract(answer, contract)
    if any(
        check.status in {"failed", "error"}
        for check in validate_output_contract(value, contract)
    ):
        return None
    return value
