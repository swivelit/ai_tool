from __future__ import annotations

import math
import struct

from app.web_api.adaptive_endpointing import (
    EndpointAction, EndpointEvidence, EndpointTiming, ProsodyMeasurement,
    TranscriptClassification, VoiceProsodyTracker, append_final_segment,
    classify_transcript, decide_endpoint, endpoint_deadline_due, summarize_prosody,
)


TIMING = EndpointTiming(1100, 900, 2600, 30_000)


def evidence(text: str = "This is complete", **updates) -> EndpointEvidence:
    values = dict(
        language="en", accumulated_transcript=text, has_final_transcript=True,
        transcript_updated_at=9.0, speech_started_at=5.0, speech_ended_at=10.0,
        utterance_duration_ms=5_000, deadline_generation=3,
    )
    values.update(updates)
    return EndpointEvidence(**values)


def test_short_300_and_600_ms_pauses_do_not_finalize():
    decision = decide_endpoint(evidence(), TIMING, now=10.0)
    assert decision.delay_ms == 1100
    assert endpoint_deadline_due(decision, scheduled_at=10.0, now=10.3, current_generation=3) is False
    assert endpoint_deadline_due(decision, scheduled_at=10.0, now=10.6, current_generation=3) is False


def test_complete_neutral_and_reliable_terminal_cadence_delays():
    neutral = decide_endpoint(evidence(), TIMING, now=10.0)
    cadence = decide_endpoint(evidence(terminal_cadence=True, voiced_duration_ms=500), TIMING, now=10.0)
    assert neutral.reason == "complete_neutral" and neutral.delay_ms == 1100
    assert cadence.reason == "complete_terminal_cadence" and cadence.delay_ms == 850


def _measurement(at: int, pitch: float | None, dbfs: float, voiced: float = .9, confidence: float = .9):
    return ProsodyMeasurement(at, .1, dbfs, .05, voiced, pitch, confidence if pitch else 0.0)


def test_prosody_requires_multiple_reliable_falling_pitch_frames():
    preceding = [_measurement(at, 180.0, -20.0) for at in range(0, 320, 32)]
    # One noisy low frame cannot provide the two recent reliable observations.
    noisy = preceding + [_measurement(400, 140.0, -22.0)] + [
        _measurement(at, None, -22.0, .7) for at in range(432, 560, 32)
    ]
    assert summarize_prosody(noisy).terminal_cadence is False
    falling = preceding + [_measurement(at, 158.0, -22.0) for at in range(400, 592, 32)]
    assert summarize_prosody(falling).terminal_cadence is True
    rising = preceding + [_measurement(at, 205.0, -20.0) for at in range(400, 592, 32)]
    assert summarize_prosody(rising).terminal_cadence is False


def test_energy_and_voicing_trailing_off_extends_incomplete_transcript():
    values = [_measurement(at, 170.0, -18.0, .9) for at in range(0, 384, 32)]
    values += [_measurement(at, None, -27.0, .25) for at in range(400, 592, 32)]
    summary = summarize_prosody(values)
    assert summary.trailing_off is True
    decision = decide_endpoint(evidence("I was thinking and", trailing_off=True), TIMING, now=10.0)
    assert decision.reason == "trailing_off" and decision.delay_ms == 2600


def test_english_and_tamil_completeness_classification_examples():
    assert classify_transcript("A complete thought.", "en", has_final_transcript=True) is TranscriptClassification.COMPLETE
    assert classify_transcript("Maybe", "en", has_final_transcript=False) is TranscriptClassification.NEUTRAL
    for text in ("I stopped because", "apples and", "wait,", "wait—", "wait..."):
        assert classify_transcript(text, "en", has_final_transcript=True) is TranscriptClassification.UNFINISHED
    for text in ("நான் நினைத்தேன் ஆனால்", "அவர் சொன்னார் என்று"):
        assert classify_transcript(text, "ta", has_final_transcript=True) is TranscriptClassification.UNFINISHED


def test_neutral_unfinished_and_unstable_partial_deadlines():
    neutral = decide_endpoint(evidence("Maybe", has_final_transcript=False), TIMING, now=10.0)
    unfinished = decide_endpoint(evidence("I paused because"), TIMING, now=10.0)
    partial = decide_endpoint(evidence("", latest_partial="still changing", has_final_transcript=False), TIMING, now=10.0)
    assert neutral.delay_ms == 1500 and neutral.reason == "transcript_unstable"
    assert unfinished.delay_ms == 2000 and unfinished.reason == "unfinished_sentence"
    assert partial.delay_ms == 2600 and partial.reason == "transcript_unstable"


def test_partial_and_final_updates_recalculate_from_latest_evidence():
    first = decide_endpoint(evidence("I was thinking and"), TIMING, now=10.0)
    partial_update = decide_endpoint(evidence(
        "I was thinking and", latest_partial="I was thinking and then continued",
        transcript_updated_at=10.4,
    ), TIMING, now=10.4)
    final_update = decide_endpoint(evidence(
        "I was thinking and then continued", transcript_updated_at=10.8,
    ), TIMING, now=10.8)
    assert first.delay_ms == 2000
    assert partial_update.delay_ms == 2600
    assert final_update.delay_ms == 1100
    assert not endpoint_deadline_due(final_update, scheduled_at=10.8, now=11.3, current_generation=3)


def test_speech_resumption_and_stale_generation_cannot_finalize():
    pending = decide_endpoint(evidence(), TIMING, now=10.0)
    resumed = decide_endpoint(evidence(speech_active=True, speech_ended_at=None, deadline_generation=4), TIMING, now=10.5)
    assert resumed.action is EndpointAction.KEEP_LISTENING and resumed.reason == "speech_resumed"
    assert endpoint_deadline_due(pending, scheduled_at=10.0, now=20.0, current_generation=4) is False


def test_explicit_maximum_empty_and_segment_deduplication():
    explicit = decide_endpoint(evidence(explicit_end=True), TIMING, now=10.0)
    maximum = decide_endpoint(evidence(maximum_duration_reached=True), TIMING, now=10.0)
    empty = decide_endpoint(evidence("", has_final_transcript=False), TIMING, now=10.0)
    assert explicit.action is EndpointAction.FINALIZE and explicit.reason == "explicit_end"
    assert maximum.action is EndpointAction.FINALIZE and maximum.reason == "maximum_utterance"
    assert empty.action is EndpointAction.ENDPOINT_PENDING and empty.reason == "no_clear_transcript"
    segments: list[str] = []
    assert append_final_segment(segments, " hello ") is True
    assert append_final_segment(segments, "hello") is False
    assert segments == ["hello"]


def test_prosody_tracker_is_bounded_and_rejects_non_protocol_frames():
    tracker = VoiceProsodyTracker()
    silent = bytes(1024)
    for index in range(100):
        tracker.accept_pcm_frame(silent, index * 32)
    assert len(tracker.measurements) == 45
    assert tracker.summary().voiced_duration_ms == 0
    try:
        tracker.accept_pcm_frame(bytes(12), 0)
    except ValueError:
        pass
    else:
        raise AssertionError("invalid frame accepted")


def test_deterministic_pcm_fixture_detects_multi_frame_falling_cadence():
    tracker = VoiceProsodyTracker()

    def frame(hz: float, amplitude: int = 9000) -> bytes:
        return struct.pack("<512h", *(
            int(amplitude * math.sin(2 * math.pi * hz * sample / 16_000))
            for sample in range(512)
        ))

    for index in range(15):
        tracker.accept_pcm_frame(frame(180.0), index * 32)
    for index in range(15, 21):
        tracker.accept_pcm_frame(frame(155.0, 7500), index * 32)
    summary = tracker.summary()
    assert summary.voiced_duration_ms >= 300
    assert summary.terminal_cadence is True
