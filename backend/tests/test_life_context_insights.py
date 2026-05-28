"""
Tests for enriched life context summary functions.
Run: cd backend && python -m pytest tests/test_life_context_insights.py -v

Note: These test the logic as ported to Python equivalents, since the actual
functions are in TypeScript. Use this as a reference spec for the TS functions.
"""

DISTANCE_PER_STEP_METERS = 0.762

STEP_GOALS = {
    "under_13": 12000,
    "13_17": 12000,
    "18_25": 10000,
    "26_35": 10000,
    "36_45": 9000,
    "46_60": 8000,
    "60_plus": 7000,
}

SCREEN_WARN_HOURS = {
    "under_13": 1.0,
    "13_17": 2.0,
    "18_25": 6.0,
    "26_35": 7.0,
    "36_45": 6.0,
    "46_60": 5.0,
    "60_plus": 4.0,
}


def movement_summary(steps, distance_m=None, confidence="high", age_group=None):
    if steps is None or steps < 0:
        return None
    if distance_m is None:
        distance_m = round(steps * DISTANCE_PER_STEP_METERS)
    km = distance_m / 1000
    goal = STEP_GOALS.get(age_group, 10000)
    pct = round((steps / goal) * 100)
    if pct >= 100:
        goal_note = f"goal achieved ({pct}%!)"
    elif pct >= 70:
        goal_note = f"{pct}% of daily goal"
    else:
        goal_note = f"{pct}% of daily goal - keep it up"
    return f"{steps:,} steps ({goal_note}), ~{km:.1f} km walked ({confidence} confidence)"


def screen_summary(screen_ms, unlocks=None, confidence="high", age_group=None):
    if screen_ms is None or screen_ms < 0:
        return None
    hours = screen_ms / 3_600_000
    warn_h = SCREEN_WARN_HOURS.get(age_group, 6.0)
    if hours <= warn_h * 0.5:
        rating = "healthy"
    elif hours <= warn_h:
        rating = "moderate"
    elif hours <= warn_h * 1.5:
        rating = "high"
    else:
        rating = "very high"
    unlock_note = f", {unlocks} phone unlocks" if unlocks and unlocks > 0 else ""
    if hours >= 1:
        time_str = f"{hours:.1f} hours"
    else:
        time_str = f"{round(screen_ms / 60000)} minutes"
    return f"{time_str} screen time today ({rating}{unlock_note}, {confidence} confidence)"


class TestMovementSummary:
    def test_adult_at_goal(self):
        result = movement_summary(10200, age_group="26_35")
        assert "goal achieved" in result
        assert "102%" in result

    def test_adult_partial_goal(self):
        result = movement_summary(7500, age_group="26_35")
        assert "75%" in result
        assert "daily goal" in result

    def test_child_goal_is_higher(self):
        result = movement_summary(10000, age_group="under_13")
        assert "goal achieved" not in result
        assert "83%" in result

    def test_senior_lower_goal(self):
        result = movement_summary(7000, age_group="60_plus")
        assert "goal achieved" in result

    def test_low_steps_encouragement(self):
        result = movement_summary(3000, age_group="26_35")
        assert "keep it up" in result

    def test_none_steps_returns_none(self):
        assert movement_summary(None) is None

    def test_distance_calculated_when_missing(self):
        result = movement_summary(5000, age_group="26_35")
        assert "km" in result

    def test_custom_distance_used_when_provided(self):
        result = movement_summary(5000, distance_m=4000, age_group="26_35")
        assert "4.0 km" in result


class TestScreenSummary:
    def test_healthy_rating_adult(self):
        result = screen_summary(2 * 3_600_000, age_group="26_35")
        assert "healthy" in result

    def test_high_rating_adult(self):
        result = screen_summary(8 * 3_600_000, age_group="26_35")
        assert "high" in result

    def test_very_high_rating(self):
        result = screen_summary(11 * 3_600_000, age_group="26_35")
        assert "very high" in result

    def test_child_1_hour_is_moderate(self):
        result = screen_summary(1 * 3_600_000, age_group="under_13")
        assert "moderate" in result

    def test_child_2_hours_is_high(self):
        result = screen_summary(2 * 3_600_000, age_group="under_13")
        assert "high" in result

    def test_senior_3_hours_is_moderate(self):
        result = screen_summary(3 * 3_600_000, age_group="60_plus")
        assert "moderate" in result

    def test_unlocks_included_when_provided(self):
        result = screen_summary(3 * 3_600_000, unlocks=42, age_group="26_35")
        assert "42 phone unlocks" in result

    def test_none_returns_none(self):
        assert screen_summary(None) is None
