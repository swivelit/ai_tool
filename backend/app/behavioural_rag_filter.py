"""
behavioural_rag_filter.py
───────────────────────────────────────────────────────
Behavioural RAG Safety Filter

This module is the SAFETY LAYER that sits between the OpenAI response
and the final JSON that is sent to the mobile UI.

Flow:
    OpenAI Response (raw_english)
        ↓
    [BehaviouralRAGFilter.apply()]
        ↓  - fetches real user data (diet, allergies, injuries, activity)
        ↓  - detects conflicts (rule-based, zero extra API calls)
        ↓  - remodels the response via OpenAI only when conflict found
        ↓  - re-translates the safe response back to Tamil (MT Task)
        ↓
    Safe Final Response → UI
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional, Set

from openai import OpenAI
from sqlmodel import Session, select

from .models import UserProfile, DailyRoutine

logger = logging.getLogger("behavioural_rag_filter")


# ── Keyword sets used for RULE-BASED conflict detection ──────────────────────

NON_VEG_KEYWORDS: Set[str] = {
    "chicken", "mutton", "beef", "pork", "fish", "prawn", "shrimp",
    "crab", "lobster", "lamb", "bacon", "sausage", "steak", "meat",
    "egg", "eggs", "turkey", "duck", "goat", "venison", "salami",
    # Tamil keywords
    "கோழி", "மட்டன்", "மீன்", "இறால்", "நண்டு", "முட்டை",
}

HIGH_ACTIVITY_KEYWORDS: Set[str] = {
    "run", "running", "sprint", "jogging", "jog", "push-up", "pushup",
    "pull-up", "pullup", "burpee", "hiit", "crossfit", "heavy lift",
    "deadlift", "squat", "plank", "jumping", "jump", "marathon",
}

SLEEP_KEYWORDS: Set[str] = {
    "midnight", "late night", "1am", "2am", "3am", "4am", "5am", 
    "stay up", "night owl", "all night", "overnight", "late meal",
    "midnight snack", "pre-dawn",
}


# ── Main Safety Filter class ─────────────────────────────────────────────────

class BehaviouralRAGFilter:
    """RAG-based safety layer that filters OpenAI responses using real user data.

    Usage (in main.py):
        from .behavioural_rag_filter import BehaviouralRAGFilter

        SAFETY_FILTER = BehaviouralRAGFilter(
            openai_api_key=OPENAI_API_KEY,
            translator=STAGE_TRANSLATOR,
        )

        # Call this BETWEEN the OpenAI response and the final output:
        result = SAFETY_FILTER.apply(result, session, user_id)
    """

    def __init__(
        self,
        openai_api_key: Optional[str] = None,
        translator: Any = None,
    ) -> None:
        self._openai = OpenAI(api_key=openai_api_key) if openai_api_key else None
        self.translator = translator  # StageTranslator instance for MT re-translation

    # ── Step 1: Fetch real user data from DB ─────────────────────────────────

    def _get_user_profile(self, session: Session, user_id: int) -> Dict[str, Any]:
        """Fetch diet/allergies (UserProfile) and wake/sleep (DailyRoutine) from DB.
        
        Returns an EMPTY profile if no data found. No assumptions made.
        """
        result: Dict[str, Any] = {
            "diet": "", "food_caution": "", "health_conditions": [], "activity": "",
            "wake_time": "", "sleep_time": "", "habits": []
        }
        try:
            # 1. Fetch questionnaire data
            u_row = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
            if u_row and u_row.answers_json:
                data = json.loads(u_row.answers_json)
                if isinstance(data, dict):
                    result["diet"] = str(data.get("food_preference", "")).strip().lower()
                    result["food_caution"] = str(data.get("food_caution", "")).strip().lower()
                    result["health_conditions"] = [str(c).strip().lower() for c in (data.get("health_conditions") or []) if str(c).strip()]
                    result["activity"] = str(data.get("daily_activity", "")).strip().lower()

                    # personality fields
                    result["personality_style"] = str(data.get("personality_style", "calm")).strip().lower()
                    result["communication_tone"] = str(data.get("communication_tone", "warm")).strip().lower()
                    result["answer_length"] = str(data.get("answer_length", "medium")).strip().lower()
                    result["main_goal"] = str(data.get("main_goal", "health")).strip().lower()
                    result["hobbies"] = [h.strip().lower() for h in (data.get("hobbies") or []) if h.strip()]

            # 2. Fetch routine data (Your new connection)
            r_row = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
            if r_row:
                result["wake_time"] = str(r_row.wake_time or "").strip()
                result["sleep_time"] = str(r_row.sleep_time or "").strip()
                result["habits"] = [h.strip().lower() for h in (r_row.daily_habits or "").split(",") if h.strip()]

        except Exception as exc:
            logger.warning("Could not load full user profile for safety filter: %s", exc)
        return result

    # ── Step 2: Detect conflicts (rule-based, zero API cost) ─────────────────

    def _detect_conflicts(
        self,
        response_text: str,
        profile: Dict[str, Any],
    ) -> List[Dict[str, str]]:
        """Check the AI response against user profile for unsafe recommendations."""
        conflicts: List[Dict[str, str]] = []
        lower = response_text.lower()
        tokens = set(re.findall(r"[a-z0-9\u0B80-\u0BFF]+", lower))

        # Rule 1 — Diet: Non-veg suggestion for vegetarian user
        diet = profile.get("diet", "")
        if diet in {"vegetarian", "vegan", "veg", "eggetarian"}:
            # If eggetarian, allow eggs, block other meat
            target_keywords = NON_VEG_KEYWORDS
            if diet == "eggetarian":
                target_keywords = NON_VEG_KEYWORDS - {"egg", "eggs", "முட்டை"}
            
            found = tokens & target_keywords
            if found:
                conflicts.append({
                    "type": "diet",
                    "detail": f"Non-vegetarian items ({', '.join(sorted(found))}) conflict with {diet} preference",
                })

        # Rule 2 — Allergy & Caution: Items mentioned in response
        caution = profile.get("food_caution", "")
        if caution == "avoid_sugary_foods" and any(kw in lower for kw in ["sugar", "sweet", "dessert", "candy"]):
             conflicts.append({"type": "caution", "detail": "Response contains sugary items for a sugar-conscious user"})
        
        # Check specific conditions
        for cond in profile.get("health_conditions", []):
            if cond == "allergy_digestion_kidney_or_other" and any(kw in lower for kw in ["allergy", "allergic"]):
                conflicts.append({"type": "health", "detail": "Response may trigger known health sensitivities"})

        # Rule 3 is removed because injury data is not collected.

        # Rule 4 — Activity level: Intense exercise suggested to a low-activity user
        activity = profile.get("activity", "")
        if activity in {"mostly_sitting", "light_movement", "low"}:
            found_heavy = tokens & HIGH_ACTIVITY_KEYWORDS
            if found_heavy:
                conflicts.append({
                    "type": "activity_level",
                    "detail": (
                        f"Intense activity ({', '.join(sorted(found_heavy))}) "
                        f"suggested for a {activity} user"
                    ),
                })

        # Rule 5 — Routine Conflict: Late-night suggestions for early sleepers
        sleep_time = profile.get("sleep_time", "")
        if sleep_time:
            # If user sleeps before 10:30 PM (22:30), check for night-owl suggestions
            try:
                hour = int(sleep_time.split(":")[0])
                if hour < 22: # User sleeps early
                    found_night = tokens & SLEEP_KEYWORDS
                    if found_night:
                        conflicts.append({
                            "type": "routine",
                            "detail": f"Late-night suggestions ({', '.join(sorted(found_night))}) conflict with user's sleep time ({sleep_time})",
                        })
            except (ValueError, IndexError):
                pass

        # Rule 6 — Personality Conflict: Private/Introvert suggestions
        personality = profile.get("personality_style", "")
        if personality in {"emotional_sensitive", "calm"}: # Often maps to Introverted
             if any(kw in lower for kw in ["party", "crowd", "stage", "performance", "public speaking"]):
                 conflicts.append({
                     "type": "personality",
                     "detail": f"This suggestion might be socially overwhelming for a {personality} user.",
                 })

        return conflicts

    # ── Step 3: Remodel response via OpenAI (only when conflict found) ────────

    def _remodel(
        self,
        original_english: str,
        profile: Dict[str, Any],
        conflicts: List[Dict[str, str]],
    ) -> Optional[str]:
        """Ask OpenAI to rewrite the response removing unsafe suggestions."""
        if not conflicts or self._openai is None:
            return None

        conflict_summary = "; ".join(c["detail"] for c in conflicts)
        prompt = (
            "You are a safety-aware health/wellness assistant. "
            "The following AI response contains content that conflicts with the user's profile.\n\n"
            f"--- Original Response ---\n{original_english}\n\n"
            f"--- User Profile ---\n{json.dumps(profile, ensure_ascii=False)}\n\n"
            f"--- Detected Conflicts ---\n{conflict_summary}\n\n"
            "Rewrite the response so that:\n"
            f"1. Matches the user's personality style: {profile.get('personality_style', 'balanced')}.\n"
            f"2. Uses the preferred tone: {profile.get('communication_tone', 'warm and clear')}.\n"
            f"3. Strictly follows the desired answer length: {profile.get('answer_length', 'medium')}.\n"
            f"4. All physical safety/physical conflicts are fixed.\n"
            f"5. The meaning and helpfulness are preserved.\n"
            "6. Do NOT mention the conflict or that you changed anything.\n"
            "Return ONLY the corrected response text."
        )
        try:
            resp = self._openai.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=512,
                temperature=0.4,
            )
            choice = resp.choices[0] if resp.choices else None
            if choice and choice.message and choice.message.content:
                return str(choice.message.content).strip()
        except Exception as exc:
            logger.warning("Safety remodel API call failed: %s", exc)
        return None

    # ── Step 4: Re-translate safe response (MT Task) ─────────────────────────

    def _retranslate(self, safe_english: str, result: Dict[str, Any], profile: Dict[str, Any]) -> None:
        """MT Task: Translate the safe remodeled English back to Tamil/Theni Tamil."""
        if not self.translator:
            return
        try:
            if hasattr(self.translator, "english_to_tamil_with_meta"):
                # Pass profile context for better translation tone matching
                meta = self.translator.english_to_tamil_with_meta(safe_english, profile)
                new_tamil = str(meta.get("tamil_text", "")).strip()
                if new_tamil:
                    result["tamil_text"] = new_tamil
                    if hasattr(self.translator, "tamil_to_thenitamil"):
                        result["theni_tamil_text"] = self.translator.tamil_to_thenitamil(new_tamil)
        except Exception as exc:
            logger.warning("MT re-translation of safe response failed: %s", exc)

    # ── Public entry point ────────────────────────────────────────────────────

    def apply(
        self,
        result: Dict[str, Any],
        session: Session,
        user_id: Optional[int],
    ) -> Dict[str, Any]:
        """Apply safety filtering to the OpenAI pipeline result.

        Call this AFTER OpenAI generates its response and BEFORE
        sending the final JSON to the UI.

        Args:
            result:  The pipeline result dict (must have 'remodeled_english'
                     or 'raw_english' key).
            session: SQLModel DB session.
            user_id: The logged-in user's ID.

        Returns:
            The (potentially modified) result dict.
        """
        if not user_id:
            return result  # Guest user — nothing to filter

        english_text = str(
            result.get("remodeled_english") or result.get("raw_english") or ""
        ).strip()
        if not english_text:
            return result

        # Step 1 — Load real user data
        profile = self._get_user_profile(session, int(user_id))

        # Step 2 — Detect conflicts
        conflicts = self._detect_conflicts(english_text, profile)
        if not conflicts:
            return result  # No conflict → zero latency, zero extra API calls

        logger.info(
            "Safety conflict detected for user %s: %s",
            user_id,
            json.dumps(conflicts, ensure_ascii=False),
        )

        # Step 3 — Remodel (safe alternative)
        safe_english = self._remodel(english_text, profile, conflicts)
        if safe_english:
            logger.info(
                "Response remodelled for user %s | %d chars → %d chars",
                user_id, len(english_text), len(safe_english),
            )
            result["raw_english"] = english_text          # keep original
            result["remodeled_english"] = safe_english    # replace with safe

            # Append to stage notes safely
            try:
                raw_notes = result.get("stage_notes", "[]")
                if isinstance(raw_notes, list):
                    notes = raw_notes
                else:
                    notes = json.loads(str(raw_notes))
            except Exception:
                notes = []

            if isinstance(notes, list):
                notes.append(
                    "Safety filter: "
                    + "; ".join(c["type"] for c in conflicts)
                    + " conflict(s) detected and remodelled."
                )
                result["stage_notes"] = json.dumps(notes, ensure_ascii=False)

            result["risk_level"] = "filtered"

            # Step 4 — MT Task: Re-translate safe response to Tamil
            self._retranslate(safe_english, result, profile)

        else:
            logger.warning(
                "Conflict detected but remodel failed for user %s. Returning original.",
                user_id,
            )

        return result
