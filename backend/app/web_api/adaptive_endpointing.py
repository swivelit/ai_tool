"""Pure, bounded helpers for adaptive realtime-voice endpointing.

Provider VAD is treated as a candidate boundary.  Text stability and low-cost
prosody cues may only change a bounded timer; prosody never commits a turn by
itself.  This module has no provider, network, database, billing, or logging
dependency and is deterministic when callers supply timestamps.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from enum import Enum
import math
import struct
from typing import Iterable


SAMPLE_RATE = 16_000
FRAME_SAMPLES = 512
FRAME_MS = FRAME_SAMPLES * 1000 // SAMPLE_RATE
PROSODY_HISTORY_MS = 1_440
PITCH_EVERY_N_FRAMES = 3
MIN_PITCH_HZ = 70.0
MAX_PITCH_HZ = 400.0
MIN_PITCH_CONFIDENCE = 0.58
MIN_VOICED_MATERIAL_MS = 288
RECENT_VOICED_WINDOW_MS = 192
PRECEDING_VOICED_WINDOW_MS = 384
TERMINAL_PITCH_DROP_SEMITONES = 1.25
TERMINAL_MAX_ENERGY_RISE_DB = 1.5
TRAILING_ENERGY_DROP_DB = 3.0
TRANSCRIPT_STABILITY_MS = 300
COMPLETE_CADENCE_REDUCTION_MS = 250
MIN_COMPLETE_CADENCE_DELAY_MS = 700
NEUTRAL_GRACE_MS = 400


class TranscriptClassification(str, Enum):
    COMPLETE = "complete"
    NEUTRAL = "neutral"
    UNFINISHED = "unfinished"


class EndpointAction(str, Enum):
    KEEP_LISTENING = "keep_listening"
    ENDPOINT_PENDING = "endpoint_pending"
    FINALIZE = "finalize"


@dataclass(frozen=True)
class EndpointEvidence:
    language: str
    accumulated_transcript: str = ""
    latest_partial: str = ""
    has_final_transcript: bool = False
    transcript_updated_at: float | None = None
    speech_started_at: float | None = None
    speech_ended_at: float | None = None
    utterance_duration_ms: int = 0
    terminal_cadence: bool = False
    trailing_off: bool = False
    voiced_duration_ms: int = 0
    explicit_end: bool = False
    maximum_duration_reached: bool = False
    speech_active: bool = False
    deadline_generation: int = 0


@dataclass(frozen=True)
class EndpointDecision:
    action: EndpointAction
    delay_ms: int
    reason: str
    confidence: float
    deadline_generation: int
    transcript_classification: TranscriptClassification


@dataclass(frozen=True)
class EndpointTiming:
    end_silence_ms: int
    unfinished_grace_ms: int
    max_endpoint_wait_ms: int
    max_utterance_ms: int


@dataclass(frozen=True)
class ProsodyMeasurement:
    timestamp_ms: int
    rms: float
    dbfs: float
    zero_crossing_rate: float
    voiced_confidence: float
    pitch_hz: float | None
    pitch_confidence: float


@dataclass(frozen=True)
class ProsodySummary:
    terminal_cadence: bool
    trailing_off: bool
    voiced_duration_ms: int


_EN_CONTINUATIONS = frozenset({
    "and", "but", "because", "so", "if", "when", "while", "although", "though",
    "that", "which", "who", "to", "for", "with", "from", "like", "then", "also",
    "actually", "basically", "well", "um", "uh",
})
_TA_CONTINUATIONS = frozenset({
    "மற்றும்", "ஆனால்", "ஏனெனில்", "அதனால்", "என்றால்", "பிறகு", "மேலும்", "அதாவது",
    "என்று", "என", "போல", "அப்புறம்", "ஆனா", "அதனால",
})
_TRAILING_MARKS = (",", ":", ";", "-", "–", "—", "...", "…")
_TERMINAL_MARKS = (".", "!", "?", "।")


def normalize_transcript(value: str) -> str:
    return " ".join(str(value or "").split()).strip()


def classify_transcript(
    accumulated_transcript: str,
    language: str,
    *,
    latest_partial: str = "",
    has_final_transcript: bool = False,
    transcript_updated_at: float | None = None,
    now: float | None = None,
) -> TranscriptClassification:
    """Classify bounded completion cues without an LLM or intent inference."""
    final = normalize_transcript(accumulated_transcript)
    partial = normalize_transcript(latest_partial)
    visible = partial if len(partial) > len(final) else final
    if not visible:
        return TranscriptClassification.NEUTRAL
    lowered = visible.casefold().rstrip()
    if lowered.endswith(_TRAILING_MARKS):
        return TranscriptClassification.UNFINISHED
    last = lowered.rstrip(".!?।").split()[-1] if lowered.rstrip(".!?।").split() else ""
    normalized_language = str(language).lower()
    continuations = _TA_CONTINUATIONS if normalized_language.startswith("ta") or normalized_language == "tanglish" else _EN_CONTINUATIONS
    if last in continuations:
        return TranscriptClassification.UNFINISHED
    partial_is_ahead = bool(partial and len(partial) > len(final))
    recently_changed = (
        now is not None and transcript_updated_at is not None
        and max(0.0, now - transcript_updated_at) * 1000 < TRANSCRIPT_STABILITY_MS
    )
    if partial_is_ahead or (recently_changed and not has_final_transcript):
        return TranscriptClassification.NEUTRAL
    if lowered.endswith(_TERMINAL_MARKS):
        return TranscriptClassification.COMPLETE
    # A stable provider-final phrase is useful completion evidence even when
    # probabilistic STT punctuation is absent. One-token phrases stay neutral.
    if has_final_transcript and len(lowered.split()) >= 2:
        return TranscriptClassification.COMPLETE
    return TranscriptClassification.NEUTRAL


def decide_endpoint(
    evidence: EndpointEvidence,
    timing: EndpointTiming,
    *,
    now: float | None = None,
) -> EndpointDecision:
    classification = classify_transcript(
        evidence.accumulated_transcript,
        evidence.language,
        latest_partial=evidence.latest_partial,
        has_final_transcript=evidence.has_final_transcript,
        transcript_updated_at=evidence.transcript_updated_at,
        now=now,
    )
    generation = evidence.deadline_generation
    usable = bool(normalize_transcript(evidence.accumulated_transcript) or normalize_transcript(evidence.latest_partial))
    if evidence.explicit_end:
        return EndpointDecision(EndpointAction.FINALIZE, 0, "explicit_end", 1.0, generation, classification)
    if evidence.maximum_duration_reached and usable:
        return EndpointDecision(EndpointAction.FINALIZE, 0, "maximum_utterance", 1.0, generation, classification)
    if evidence.speech_active or evidence.speech_ended_at is None:
        return EndpointDecision(EndpointAction.KEEP_LISTENING, 0, "speech_resumed", 1.0, generation, classification)

    if not usable:
        reason, delay, confidence = "no_clear_transcript", timing.max_endpoint_wait_ms, 0.2
    elif classification is not TranscriptClassification.COMPLETE and evidence.trailing_off:
        reason, delay, confidence = "trailing_off", timing.max_endpoint_wait_ms, 0.65
    elif classification is TranscriptClassification.UNFINISHED:
        reason = "unfinished_sentence"
        delay = timing.end_silence_ms + timing.unfinished_grace_ms
        confidence = 0.75
    elif evidence.latest_partial and (
        not evidence.has_final_transcript
        or len(normalize_transcript(evidence.latest_partial))
        > len(normalize_transcript(evidence.accumulated_transcript))
    ):
        reason, delay, confidence = "transcript_unstable", timing.max_endpoint_wait_ms, 0.45
    elif classification is TranscriptClassification.COMPLETE and evidence.terminal_cadence:
        reason = "complete_terminal_cadence"
        delay = max(MIN_COMPLETE_CADENCE_DELAY_MS, timing.end_silence_ms - COMPLETE_CADENCE_REDUCTION_MS)
        confidence = 0.82
    elif classification is TranscriptClassification.COMPLETE:
        reason, delay, confidence = "complete_neutral", timing.end_silence_ms, 0.68
    else:
        reason = "transcript_unstable"
        delay = timing.end_silence_ms + NEUTRAL_GRACE_MS
        confidence = 0.4

    delay = min(max(0, delay), timing.max_endpoint_wait_ms)
    remaining_utterance = max(0, timing.max_utterance_ms - max(0, evidence.utterance_duration_ms))
    delay = min(delay, remaining_utterance)
    return EndpointDecision(EndpointAction.ENDPOINT_PENDING, delay, reason, confidence, generation, classification)


def endpoint_deadline_due(
    decision: EndpointDecision,
    *,
    scheduled_at: float,
    now: float,
    current_generation: int,
) -> bool:
    """Generation-safe deadline check used by deterministic timer tests."""
    if decision.deadline_generation != current_generation:
        return False
    return bool(
        decision.action is EndpointAction.FINALIZE
        or (
            decision.action is EndpointAction.ENDPOINT_PENDING
            and max(0.0, now - scheduled_at) * 1000 >= decision.delay_ms
        )
    )


def append_final_segment(segments: list[str], value: str) -> bool:
    """Append a normalized provider-final segment exactly once."""
    cleaned = normalize_transcript(value)
    if not cleaned or cleaned in segments:
        return False
    segments.append(cleaned)
    return True


class VoiceProsodyTracker:
    """Keep at most 1.44 seconds of scalar measurements; never retain PCM."""

    def __init__(self) -> None:
        self._measurements: deque[ProsodyMeasurement] = deque(maxlen=PROSODY_HISTORY_MS // FRAME_MS)
        self._frame_count = 0

    @property
    def measurements(self) -> tuple[ProsodyMeasurement, ...]:
        return tuple(self._measurements)

    def reset(self) -> None:
        self._measurements.clear()
        self._frame_count = 0

    def accept_pcm_frame(self, pcm_s16le: bytes, timestamp_ms: int) -> ProsodySummary:
        if len(pcm_s16le) != FRAME_SAMPLES * 2:
            raise ValueError("prosody frames must contain exactly 512 int16 samples")
        samples = struct.unpack("<512h", pcm_s16le)
        scale = 1.0 / 32768.0
        normalized = [value * scale for value in samples]
        rms = math.sqrt(sum(value * value for value in normalized) / FRAME_SAMPLES)
        dbfs = 20.0 * math.log10(max(rms, 1e-7))
        crossings = sum(1 for left, right in zip(samples, samples[1:]) if (left < 0) != (right < 0))
        zcr = crossings / (FRAME_SAMPLES - 1)
        energy_confidence = _clamp((dbfs + 52.0) / 28.0)
        zcr_confidence = _clamp(1.0 - max(0.0, zcr - 0.18) / 0.25)
        voiced_confidence = energy_confidence * zcr_confidence
        pitch_hz: float | None = None
        pitch_confidence = 0.0
        if self._frame_count % PITCH_EVERY_N_FRAMES == 0 and voiced_confidence >= 0.2:
            pitch_hz, pitch_confidence = _estimate_pitch(normalized)
            voiced_confidence *= 0.55 + 0.45 * pitch_confidence
        self._frame_count += 1
        self._measurements.append(ProsodyMeasurement(
            timestamp_ms=int(timestamp_ms), rms=rms, dbfs=dbfs, zero_crossing_rate=zcr,
            voiced_confidence=_clamp(voiced_confidence), pitch_hz=pitch_hz,
            pitch_confidence=_clamp(pitch_confidence),
        ))
        return summarize_prosody(self._measurements)

    def summary(self) -> ProsodySummary:
        return summarize_prosody(self._measurements)


def _estimate_pitch(samples: list[float]) -> tuple[float | None, float]:
    """Bounded normalized autocorrelation across the 70-400 Hz voice range."""
    mean = sum(samples) / len(samples)
    centered = [value - mean for value in samples]
    min_lag = max(1, int(SAMPLE_RATE / MAX_PITCH_HZ))
    max_lag = min(len(centered) - 2, int(SAMPLE_RATE / MIN_PITCH_HZ))
    best_lag, best_score = 0, 0.0
    for lag in range(min_lag, max_lag + 1):
        left = centered[:-lag]
        right = centered[lag:]
        numerator = sum(a * b for a, b in zip(left, right))
        denominator = math.sqrt(sum(a * a for a in left) * sum(b * b for b in right))
        score = numerator / denominator if denominator > 1e-9 else 0.0
        if score > best_score:
            best_lag, best_score = lag, score
    if not best_lag or best_score < 0.35:
        return None, max(0.0, best_score)
    return SAMPLE_RATE / best_lag, best_score


def summarize_prosody(measurements: Iterable[ProsodyMeasurement]) -> ProsodySummary:
    values = list(measurements)
    voiced_duration = sum(FRAME_MS for item in values if item.voiced_confidence >= 0.45)
    if not values:
        return ProsodySummary(False, False, 0)
    latest_at = values[-1].timestamp_ms
    recent = [item for item in values if latest_at - item.timestamp_ms < RECENT_VOICED_WINDOW_MS]
    preceding = [
        item for item in values
        if RECENT_VOICED_WINDOW_MS <= latest_at - item.timestamp_ms
        < RECENT_VOICED_WINDOW_MS + PRECEDING_VOICED_WINDOW_MS
    ]
    recent_pitch = [item.pitch_hz for item in recent if item.pitch_hz and item.pitch_confidence >= MIN_PITCH_CONFIDENCE]
    preceding_pitch = [item.pitch_hz for item in preceding if item.pitch_hz and item.pitch_confidence >= MIN_PITCH_CONFIDENCE]
    enough_pitch = len(recent_pitch) >= 2 and len(preceding_pitch) >= 2 and voiced_duration >= MIN_VOICED_MATERIAL_MS
    pitch_drop = 0.0
    if enough_pitch:
        pitch_drop = 12.0 * math.log2(_median(preceding_pitch) / max(1.0, _median(recent_pitch)))
    recent_db = _mean([item.dbfs for item in recent])
    preceding_db = _mean([item.dbfs for item in preceding])
    terminal = bool(
        enough_pitch and pitch_drop >= TERMINAL_PITCH_DROP_SEMITONES
        and recent_db <= preceding_db + TERMINAL_MAX_ENERGY_RISE_DB
    )
    recent_voicing = _mean([item.voiced_confidence for item in recent])
    preceding_voicing = _mean([item.voiced_confidence for item in preceding])
    trailing = bool(
        len(recent) >= 3 and len(preceding) >= 4
        and preceding_db - recent_db >= TRAILING_ENERGY_DROP_DB
        and recent_voicing + 0.12 < preceding_voicing
    )
    return ProsodySummary(terminal, trailing, voiced_duration)


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else -120.0


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return (ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2)


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))
