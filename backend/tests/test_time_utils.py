from datetime import datetime, timedelta, timezone

from app.time_utils import ensure_utc


def test_ensure_utc_keeps_aware_utc_input_in_utc() -> None:
    value = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)

    result = ensure_utc(value)

    assert result == value
    assert result.tzinfo is timezone.utc


def test_ensure_utc_converts_aware_non_utc_input() -> None:
    source_timezone = timezone(timedelta(hours=5, minutes=30))
    value = datetime(2026, 7, 16, 15, 0, tzinfo=source_timezone)

    result = ensure_utc(value)

    assert result == datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)
    assert result.tzinfo is timezone.utc


def test_ensure_utc_interprets_naive_input_as_utc() -> None:
    value = datetime(2026, 7, 16, 9, 30)

    result = ensure_utc(value)

    assert result == datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)
    assert result.tzinfo is timezone.utc


def test_ensure_utc_does_not_mutate_input() -> None:
    value = datetime(2026, 7, 16, 9, 30)
    original = (value, value.tzinfo)

    result = ensure_utc(value)

    assert (value, value.tzinfo) == original
    assert result is not value
