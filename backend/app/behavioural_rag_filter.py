"""
stage_safety_filter.py
───────────────────────────────────────────────────────
RAG Safety Filter 

This module is the SAFETY LAYER that sits between the OpenAI response
and the final JSON that is sent to the mobile UI.

Flow:
    OpenAI Response (raw_english)
        ↓
    [StageSafetyFilter.apply()]   ← This file
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

from .models import UserProfile

logger = logging.getLogger("stage_safety_filter")


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


# ── Main Safety Filter class ─────────────────────────────────────────────────

class StageSafetyFilter:
    """RAG-based safety layer that filters OpenAI responses using real user data.

    Usage (in main.py):
        from .stage_safety_filter import StageSafetyFilter

        SAFETY_FILTER = StageSafetyFilter(
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
        """Fetch diet / allergies / injuries / activity from the database.

        Returns an EMPTY profile if no data is found.
        No default values are assumed — only REAL user data triggers filtering.
        """
        try:
            row = session.exec(
                select(UserProfile).where(UserProfile.user_id == user_id)
            ).first()
            if row and row.answers_json:
                data = json.loads(row.answers_json)
                if isinstance(data, dict):
                    return {
                        "diet":     str(data.get("diet", "")).strip().lower(),
                        "allergies": [
                            str(a).strip().lower()
                            for a in (data.get("allergies") or [])
                            if str(a).strip()
                        ],
                        "injuries": [
                            str(i).strip().lower()
                            for i in (data.get("injuries") or [])
                            if str(i).strip()
                        ],
                        "activity": str(data.get("activity", "")).strip().lower(),
                    }
        except Exception as exc:
            logger.warning("Could not load user profile for safety filter: %s", exc)
        # Empty profile = no assumptions = no filtering
        return {"diet": "", "allergies": [], "injuries": [], "activity": ""}

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
        if diet in {"vegetarian", "vegan", "veg"}:
            found = tokens & NON_VEG_KEYWORDS
            if found:
                conflicts.append({
                    "type": "diet",
                    "detail": f"Non-vegetarian items in response: {', '.join(sorted(found))}",
                })

        # Rule 2 — Allergy: Any allergen mentioned in the response
        for allergen in profile.get("allergies", []):
            if allergen and allergen in lower:
                conflicts.append({
                    "type": "allergy",
                    "detail": f"Response contains allergen: {allergen}",
                })

        # Rule 3 — Injury: High-intensity activity suggested to an injured user
        if profile.get("injuries"):
            found_activity = tokens & HIGH_ACTIVITY_KEYWORDS
            if found_activity:
                conflicts.append({
                    "type": "injury",
                    "detail": (
                        f"High-intensity activity ({', '.join(sorted(found_activity))}) "
                        f"conflicts with user injuries: {', '.join(profile['injuries'])}"
                    ),
                })

        # Rule 4 — Activity level: Intense exercise suggested to a low-activity user
        activity = profile.get("activity", "")
        if activity == "low":
            found_heavy = tokens & HIGH_ACTIVITY_KEYWORDS
            if found_heavy:
                conflicts.append({
                    "type": "activity_level",
                    "detail": (
                        f"Intense activity ({', '.join(sorted(found_heavy))}) "
                        "suggested for a low-activity user"
                    ),
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
            "1. All conflicting items are replaced with safe alternatives.\n"
            "2. The meaning and helpfulness are preserved.\n"
            "3. The tone stays friendly and natural.\n"
            "4. Do NOT mention the conflict or that you changed anything.\n"
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

    def _retranslate(self, safe_english: str, result: Dict[str, Any]) -> None:
        """MT Task: Translate the safe remodeled English back to Tamil/Theni Tamil."""
        if not self.translator:
            return
        try:
            if hasattr(self.translator, "english_to_tamil_with_meta"):
                meta = self.translator.english_to_tamil_with_meta(safe_english, None)
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

            # Append to stage notes
            try:
                notes = json.loads(result.get("stage_notes", "[]"))
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
            self._retranslate(safe_english, result)

        else:
            logger.warning(
                "Conflict detected but remodel failed for user %s. Returning original.",
                user_id,
            )

        return result
