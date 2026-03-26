from __future__ import annotations

import json
import os
import re
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote_plus
from zoneinfo import ZoneInfo

import requests
from sqlmodel import Session, select

from .models import Conversation, DailyRoutine, Item, User, UserProfile

try:
    from config import (
        AGENT_ALIGNMENT_CONFIG_PATH,
        AGENT_CONFIG_DIR,
        AGENT_LOGS_DIR,
        AGENT_MEMORY_CONFIG_PATH,
        AGENT_MEMORY_DIR,
        AGENT_ORCHESTRATOR_CONFIG_PATH,
        AGENT_PROFILER_SCHEMA_PATH,
        AGENT_STATE_DIR,
        AGENTIC_MODE_ENABLED,
        DATA_DIR,
        OPENAI_MODEL,
    )
except Exception:  # pragma: no cover
    BASE_DIR = Path(__file__).resolve().parent.parent
    DATA_DIR = BASE_DIR / "data"
    AGENT_CONFIG_DIR = DATA_DIR / "agents" / "config"
    AGENT_STATE_DIR = DATA_DIR / "agents" / "state"
    AGENT_MEMORY_DIR = DATA_DIR / "agents" / "memory"
    AGENT_LOGS_DIR = DATA_DIR / "agents" / "logs"
    AGENT_PROFILER_SCHEMA_PATH = AGENT_CONFIG_DIR / "profiler_slots.json"
    AGENT_ORCHESTRATOR_CONFIG_PATH = AGENT_CONFIG_DIR / "orchestrator_routes.json"
    AGENT_ALIGNMENT_CONFIG_PATH = AGENT_CONFIG_DIR / "alignment_rules.json"
    AGENT_MEMORY_CONFIG_PATH = AGENT_CONFIG_DIR / "memory_settings.json"
    AGENTIC_MODE_ENABLED = True
    OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-mini")

try:
    from stage_behaviour_questions import QUESTIONS as DEFAULT_QUESTIONS
except Exception:  # pragma: no cover
    DEFAULT_QUESTIONS = []

DEFAULT_PROFILER_SCHEMA = {
    "version": 1,
    "required_slots": [],
    "optional_slots": [],
    "slot_instructions": (
        "Collect the required profile slots naturally through friendly conversation. "
        "Do not ask the user like a rigid survey. Ask one smart follow-up at a time."
    ),
}

DEFAULT_ORCHESTRATOR_CONFIG = {
    "version": 1,
    "routes": {
        "fast_greeting": {
            "description": "Fast route for greeting/thanks/smalltalk.",
            "keywords": ["hi", "hello", "hey", "vanakkam", "thanks", "thank you", "good morning"],
        },
        "calendar": {
            "description": "Saved reminders, schedule, to-dos, routine, timeline.",
            "keywords": ["schedule", "reminder", "task", "todo", "plan", "today", "tomorrow", "calendar"],
        },
        "weather": {
            "description": "Current weather and forecast.",
            "keywords": ["weather", "temperature", "rain", "forecast", "climate"],
        },
        "web_search": {
            "description": "Current/public info that requires internet lookup.",
            "keywords": ["latest", "news", "current", "search", "internet", "who is", "what is"],
        },
        "clarify": {
            "description": "Missing critical context.",
            "keywords": ["this", "that", "it", "they", "there"],
        },
        "pipeline": {
            "description": "Default reasoning route.",
            "keywords": [],
        },
    },
}

DEFAULT_ALIGNMENT_RULES = {
    "version": 1,
    "instructions": {
        "preserve_facts": True,
        "avoid_new_claims": True,
        "respect_user_language": True,
        "tone_priority": ["communication_tone", "answer_length", "stress_support", "personality_style"],
    },
    "fallback_style": {
        "communication_tone": "warm",
        "answer_length": "medium",
        "personality_style": "practical",
    },
}

DEFAULT_MEMORY_CONFIG = {
    "version": 1,
    "semantic_cache_threshold": 0.95,
    "min_turns_before_sync": 6,
    "min_minutes_between_sync": 15,
    "max_conversations_per_sync": 20,
    "max_facts_per_sync": 5,
}


class AgenticService:
    def __init__(self, openai_client: Any, local_rag_service: Any) -> None:
        self.client = openai_client
        self.local_rag_service = local_rag_service
        self.model = os.getenv("OPENAI_AGENT_MODEL", os.getenv("OPENAI_JSON_MODEL", OPENAI_MODEL))
        self.enabled = bool(AGENTIC_MODE_ENABLED)
        self._ensure_dirs()
        self._ensure_defaults()

    # -----------------------------
    # bootstrap + file helpers
    # -----------------------------
    def _ensure_dirs(self) -> None:
        for path in (DATA_DIR, AGENT_CONFIG_DIR, AGENT_STATE_DIR, AGENT_MEMORY_DIR, AGENT_LOGS_DIR):
            Path(path).mkdir(parents=True, exist_ok=True)

    def _read_json(self, path: Path, default: Any) -> Any:
        try:
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
        return default

    def _write_json(self, path: Path, payload: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _append_jsonl(self, path: Path, payload: Dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    def _ensure_defaults(self) -> None:
        if not Path(AGENT_PROFILER_SCHEMA_PATH).exists():
            schema = dict(DEFAULT_PROFILER_SCHEMA)
            schema["required_slots"] = [
                {
                    "id": str(q.get("id", "")).strip(),
                    "prompt": str(q.get("prompt", "")).strip(),
                    "type": str(q.get("type", "single")).strip() or "single",
                    "options": list(q.get("options", [])),
                    "max_choices": q.get("max_choices"),
                    "required": True,
                }
                for q in list(DEFAULT_QUESTIONS or [])
                if str(q.get("id", "")).strip()
            ]
            self._write_json(Path(AGENT_PROFILER_SCHEMA_PATH), schema)

        if not Path(AGENT_ORCHESTRATOR_CONFIG_PATH).exists():
            self._write_json(Path(AGENT_ORCHESTRATOR_CONFIG_PATH), DEFAULT_ORCHESTRATOR_CONFIG)

        if not Path(AGENT_ALIGNMENT_CONFIG_PATH).exists():
            self._write_json(Path(AGENT_ALIGNMENT_CONFIG_PATH), DEFAULT_ALIGNMENT_RULES)

        if not Path(AGENT_MEMORY_CONFIG_PATH).exists():
            self._write_json(Path(AGENT_MEMORY_CONFIG_PATH), DEFAULT_MEMORY_CONFIG)

    # -----------------------------
    # llm helpers
    # -----------------------------
    def _extract_response_text(self, response: Any) -> str:
        output_text = getattr(response, "output_text", None)
        if output_text:
            return str(output_text).strip()

        chunks: List[str] = []
        for item in getattr(response, "output", None) or []:
            for part in getattr(item, "content", None) or []:
                text = getattr(part, "text", None)
                if text:
                    chunks.append(str(text))
                elif isinstance(part, dict) and part.get("text"):
                    chunks.append(str(part["text"]))
        return "\n".join(x.strip() for x in chunks if str(x).strip()).strip()

    def _llm_json(self, system_prompt: str, user_content: str, temperature: float = 0.2) -> Dict[str, Any]:
        response = self.client.responses.create(
            model=self.model,
            input=[
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt.strip()}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_content.strip()}]},
            ],
            temperature=temperature,
            text={"format": {"type": "json_object"}},
        )
        return json.loads(self._extract_response_text(response))

    def _llm_text(self, system_prompt: str, user_content: str, temperature: float = 0.2) -> str:
        response = self.client.responses.create(
            model=self.model,
            input=[
                {"role": "system", "content": [{"type": "input_text", "text": system_prompt.strip()}]},
                {"role": "user", "content": [{"type": "input_text", "text": user_content.strip()}]},
            ],
            temperature=temperature,
        )
        return self._extract_response_text(response)

    # -----------------------------
    # generic helpers
    # -----------------------------
    @staticmethod
    def _normalize_reply_language(value: Optional[str], fallback: str = "ta") -> str:
        normalized = str(value or "").strip().lower()
        if normalized in {"en", "english"}:
            return "en"
        if normalized in {"ta", "tamil", "mixed", "tanglish"}:
            return "ta"
        return fallback

    @staticmethod
    def _normalize_lookup_text(text: str) -> str:
        return " ".join(re.findall(r"[a-z0-9_\u0B80-\u0BFF]+", str(text or "").lower()))

    def _build_pipeline_result(
        self,
        *,
        raw_english: str,
        remodeled_english: Optional[str] = None,
        tamil_text: str = "",
        theni_tamil_text: str = "",
        route_taken: str,
        direct_answer_source: str = "",
        direct_answer_confidence: str = "",
        predicted_label: str = "agentic",
        risk_level: str = "low",
        stage_notes: Optional[List[str]] = None,
        core_meta: Optional[Dict[str, Any]] = None,
        remodel_meta: Optional[Dict[str, Any]] = None,
        review_meta: Optional[Dict[str, Any]] = None,
        translation_meta: Optional[Dict[str, Any]] = None,
        timings_ms: Optional[Dict[str, Any]] = None,
        cache_hit: str = "false",
    ) -> Dict[str, Any]:
        english = str(remodeled_english if remodeled_english is not None else raw_english).strip()
        return {
            "pipeline_version": "agentic_v1",
            "raw_english": str(raw_english or "").strip(),
            "remodeled_english": english,
            "tamil_text": str(tamil_text or "").strip(),
            "theni_tamil_text": str(theni_tamil_text or tamil_text or "").strip(),
            "direct_answer_source": str(direct_answer_source or ""),
            "direct_answer_confidence": str(direct_answer_confidence or ""),
            "predicted_label": str(predicted_label or "agentic"),
            "risk_level": str(risk_level or "low"),
            "route_taken": str(route_taken or "agentic"),
            "cache_hit": str(cache_hit or "false"),
            "stage_notes": json.dumps(stage_notes or [], ensure_ascii=False),
            "core_meta": json.dumps(core_meta or {}, ensure_ascii=False),
            "remodel_meta": json.dumps(remodel_meta or {}, ensure_ascii=False),
            "review_meta": json.dumps(review_meta or {}, ensure_ascii=False),
            "translation_meta": json.dumps(translation_meta or {}, ensure_ascii=False),
            "timings_ms": json.dumps(timings_ms or {"total_ms": 0.0}, ensure_ascii=False),
        }

    def _state_path(self, user_id: int, agent_name: str) -> Path:
        safe = re.sub(r"[^a-z0-9_-]+", "_", str(agent_name).lower())
        return Path(AGENT_STATE_DIR) / f"{user_id}_{safe}.json"

    def _read_state(self, user_id: int, agent_name: str, default: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        return self._read_json(self._state_path(user_id, agent_name), default or {})

    def _write_state(self, user_id: int, agent_name: str, payload: Dict[str, Any]) -> None:
        self._write_json(self._state_path(user_id, agent_name), payload)

    def _profiler_schema(self) -> Dict[str, Any]:
        return self._read_json(Path(AGENT_PROFILER_SCHEMA_PATH), DEFAULT_PROFILER_SCHEMA)

    def _route_config(self) -> Dict[str, Any]:
        return self._read_json(Path(AGENT_ORCHESTRATOR_CONFIG_PATH), DEFAULT_ORCHESTRATOR_CONFIG)

    def _alignment_config(self) -> Dict[str, Any]:
        return self._read_json(Path(AGENT_ALIGNMENT_CONFIG_PATH), DEFAULT_ALIGNMENT_RULES)

    def _memory_config(self) -> Dict[str, Any]:
        return self._read_json(Path(AGENT_MEMORY_CONFIG_PATH), DEFAULT_MEMORY_CONFIG)

    def _get_user_bundle(self, session: Session, user_id: int) -> Tuple[Optional[User], Optional[UserProfile], Optional[DailyRoutine]]:
        user = session.get(User, user_id)
        profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
        routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
        return user, profile, routine

    def _profile_answers(self, profile: Optional[UserProfile]) -> Dict[str, Any]:
        if not profile:
            return {}
        try:
            payload = json.loads(profile.answers_json or "{}")
            return payload if isinstance(payload, dict) else {}
        except Exception:
            return {}

    def _schema_slots(self) -> List[Dict[str, Any]]:
        schema = self._profiler_schema()
        out: List[Dict[str, Any]] = []
        seen = set()
        for slot in list(schema.get("required_slots") or []) + list(schema.get("optional_slots") or []):
            sid = str(slot.get("id", "")).strip()
            if sid and sid not in seen:
                seen.add(sid)
                out.append(slot)
        return out

    def _required_slot_ids(self) -> List[str]:
        return [str(x.get("id", "")).strip() for x in list(self._profiler_schema().get("required_slots") or []) if str(x.get("id", "")).strip()]

    def _missing_slots(self, answers: Dict[str, Any]) -> List[str]:
        return [sid for sid in self._required_slot_ids() if answers.get(sid) in (None, "", [], {})]

    def _completed_count(self, answers: Dict[str, Any]) -> int:
        return len(self._required_slot_ids()) - len(self._missing_slots(answers))

    def _merge_answers(self, current: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
        merged = dict(current or {})
        allowed = {str(slot.get("id", "")).strip(): slot for slot in self._schema_slots()}

        for key, value in (updates or {}).items():
            key = str(key or "").strip()
            if key not in allowed or value in (None, "", [], {}):
                continue

            slot_type = str(allowed[key].get("type", "single")).strip() or "single"
            if slot_type == "multi":
                if isinstance(value, list):
                    clean = [str(v).strip() for v in value if str(v).strip()]
                else:
                    clean = [str(value).strip()] if str(value).strip() else []
                if clean:
                    merged[key] = clean
            else:
                merged[key] = str(value).strip()

        return merged

    # -----------------------------
    # profile snapshot + sync
    # -----------------------------
    def persist_profile_snapshot(self, session: Session, user_id: int) -> Dict[str, Any]:
        user, profile, routine = self._get_user_bundle(session, user_id)
        answers = self._profile_answers(profile)
        snapshot = {
            "user_id": user_id,
            "saved_at": datetime.utcnow().isoformat() + "Z",
            "user": {
                "name": user.name if user else "",
                "place": user.place if user else "",
                "timezone": user.timezone if user else "Asia/Kolkata",
                "assistant_name": user.assistant_name if user else "Elli",
                "reply_language": self._normalize_reply_language(user.reply_language if user else "ta"),
            },
            "routine": {
                "wake_time": routine.wake_time if routine else None,
                "sleep_time": routine.sleep_time if routine else None,
                "work_start": routine.work_start if routine else None,
                "work_end": routine.work_end if routine else None,
                "daily_habits": routine.daily_habits if routine else None,
            },
            "profile_answers": answers,
            "profile_summary": profile.profile_summary if profile else None,
            "completed_slots": self._completed_count(answers),
            "total_slots": len(self._required_slot_ids()),
            "missing_slots": self._missing_slots(answers),
        }
        self._write_json(Path(AGENT_STATE_DIR) / f"{user_id}_profile_snapshot.json", snapshot)
        return snapshot

    def _summarize_profile(self, answers: Dict[str, Any], user: Optional[User], routine: Optional[DailyRoutine]) -> str:
        try:
            return self._llm_text(
                """
You summarize a user's structured profile for downstream personalization.
Keep it factual, useful, and compact.
Return plain text only.
""",
                json.dumps(
                    {
                        "answers": answers,
                        "user": {
                            "name": user.name if user else "",
                            "place": user.place if user else "",
                            "timezone": user.timezone if user else "Asia/Kolkata",
                            "reply_language": self._normalize_reply_language(user.reply_language if user else "ta"),
                        },
                        "routine": {
                            "wake_time": routine.wake_time if routine else None,
                            "sleep_time": routine.sleep_time if routine else None,
                            "work_start": routine.work_start if routine else None,
                            "work_end": routine.work_end if routine else None,
                            "daily_habits": routine.daily_habits if routine else None,
                        },
                    },
                    ensure_ascii=False,
                ),
                temperature=0.15,
            ).strip()
        except Exception:
            tone = answers.get("communication_tone", "warm")
            goal = answers.get("main_goal", "general support")
            return f"User prefers a {tone} tone. Main focus is {goal}."

    def sync_answers_to_profile(self, session: Session, user_id: int, answers: Dict[str, Any]) -> Dict[str, Any]:
        user, profile, routine = self._get_user_bundle(session, user_id)
        profile = profile or UserProfile(user_id=user_id, answers_json="{}", questions_version=2)

        merged = self._merge_answers(self._profile_answers(profile), answers)
        profile.answers_json = json.dumps(merged, ensure_ascii=False)
        profile.questions_version = max(int(profile.questions_version or 1), 2)

        completed = self._completed_count(merged) >= len(self._required_slot_ids())
        if completed:
            profile.profile_summary = self._summarize_profile(merged, user, routine)

        profile.updated_at = datetime.utcnow()
        session.add(profile)
        session.commit()
        session.refresh(profile)

        snapshot = self.persist_profile_snapshot(session, user_id)

        if completed and profile.profile_summary:
            session.add(
                Conversation(
                    user_id=user_id,
                    channel="system",
                    user_input=(
                        f"Profiler summary for user {user_id}: {profile.profile_summary}\n"
                        f"Structured profile: {json.dumps(merged, ensure_ascii=False)}"
                    ),
                    transcript=None,
                    llm_output_json=json.dumps({"source": "profiler_agent"}, ensure_ascii=False),
                    created_at=datetime.utcnow(),
                )
            )
            session.commit()

        return {"answers": merged, "summary": profile.profile_summary, "snapshot": snapshot}

    # -----------------------------
    # profiler agent
    # -----------------------------
    def get_profiler_state(self, session: Session, user_id: int) -> Dict[str, Any]:
        user, profile, _routine = self._get_user_bundle(session, user_id)
        answers = self._profile_answers(profile)
        state = self._read_state(user_id, "profiler", {"history": [], "status": "idle"})
        return {
            "status": state.get("status", "idle"),
            "history": state.get("history", []),
            "answers": answers,
            "completed_slots": self._completed_count(answers),
            "total_slots": len(self._required_slot_ids()),
            "missing_slots": self._missing_slots(answers),
            "preferred_reply_language": self._normalize_reply_language(user.reply_language if user else "ta"),
            "profile_summary": profile.profile_summary if profile else None,
        }

    def start_profiler(self, session: Session, user_id: int) -> Dict[str, Any]:
        state = self._read_state(user_id, "profiler", {"history": [], "status": "idle"})
        state["status"] = "active"
        state["started_at"] = state.get("started_at") or (datetime.utcnow().isoformat() + "Z")
        self._write_state(user_id, "profiler", state)

        current = self.get_profiler_state(session, user_id)
        if not current["missing_slots"]:
            return {
                "ok": True,
                "agent": "profiler",
                "assistant_reply": "Your profile is already complete. I can still refine it over time as we chat.",
                **current,
            }

        slot_map = {str(slot.get("id", "")).strip(): slot for slot in self._schema_slots()}
        first_missing = current["missing_slots"][0]
        first_prompt = str(slot_map.get(first_missing, {}).get("prompt", "Tell me a bit about yourself.")).strip()
        return {
            "ok": True,
            "agent": "profiler",
            "assistant_reply": f"Let’s get to know you better. {first_prompt}",
            **current,
        }

    def profiler_turn(self, session: Session, user_id: int, message: str, reply_language: Optional[str] = None) -> Dict[str, Any]:
        user, profile, routine = self._get_user_bundle(session, user_id)
        if not user:
            raise ValueError("User not found")

        answers = self._profile_answers(profile)
        state = self._read_state(user_id, "profiler", {"history": [], "status": "active"})
        history = list(state.get("history") or [])[-12:]
        resolved_lang = self._normalize_reply_language(reply_language, fallback=self._normalize_reply_language(user.reply_language))

        prompt = """
You are the Profiler Agent for a personal assistant app.

Your mission:
- Have a natural onboarding conversation.
- Extract structured profile facts from the latest user message.
- Ask only one best next follow-up.
- Use the user's preferred reply language.
- Never invent information.

Return ONLY JSON:
{
  "assistant_reply": "...",
  "updates": {"slot_id": "value or list"},
  "missing_slots": ["slot_id"],
  "completed": false,
  "confidence": 0.0
}
"""
        payload = {
            "user": {
                "name": user.name,
                "place": user.place,
                "timezone": user.timezone,
                "reply_language": resolved_lang,
            },
            "routine": {
                "wake_time": routine.wake_time if routine else None,
                "sleep_time": routine.sleep_time if routine else None,
                "work_start": routine.work_start if routine else None,
                "work_end": routine.work_end if routine else None,
                "daily_habits": routine.daily_habits if routine else None,
            },
            "schema": self._profiler_schema(),
            "current_answers": answers,
            "history": history,
            "latest_user_message": message,
        }

        try:
            llm_out = self._llm_json(prompt, json.dumps(payload, ensure_ascii=False), temperature=0.25)
        except Exception:
            llm_out = {
                "assistant_reply": "Tell me a little more about yourself.",
                "updates": {},
                "missing_slots": self._missing_slots(answers),
                "completed": False,
                "confidence": 0.0,
            }

        merged = self._merge_answers(answers, llm_out.get("updates") or {})
        sync = self.sync_answers_to_profile(session, user_id, merged)
        final_answers = sync["answers"]
        completed = self._completed_count(final_answers) >= len(self._required_slot_ids())

        assistant_reply = str(llm_out.get("assistant_reply", "")).strip()
        if not assistant_reply:
            slot_map = {str(slot.get("id", "")).strip(): slot for slot in self._schema_slots()}
            missing = self._missing_slots(final_answers)
            assistant_reply = (
                str(slot_map.get(missing[0], {}).get("prompt", "Tell me more about yourself.")).strip()
                if missing
                else "Perfect — I’ve got what I need and saved your profile."
            )

        history.extend(
            [
                {"role": "user", "text": message, "at": datetime.utcnow().isoformat() + "Z"},
                {"role": "assistant", "text": assistant_reply, "at": datetime.utcnow().isoformat() + "Z"},
            ]
        )
        state.update(
            {
                "status": "completed" if completed else "active",
                "history": history[-20:],
                "last_confidence": float(llm_out.get("confidence", 0.0) or 0.0),
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
        )
        self._write_state(user_id, "profiler", state)

        self._append_jsonl(
            Path(AGENT_LOGS_DIR) / f"profiler_{user_id}.jsonl",
            {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "user_id": user_id,
                "message": message,
                "assistant_reply": assistant_reply,
                "updates": llm_out.get("updates") or {},
                "completed": completed,
            },
        )

        return {
            "ok": True,
            "agent": "profiler",
            "assistant_reply": assistant_reply,
            "completed": completed,
            "answers": final_answers,
            "completed_slots": self._completed_count(final_answers),
            "total_slots": len(self._required_slot_ids()),
            "missing_slots": self._missing_slots(final_answers),
            "profile_summary": sync.get("summary"),
        }

    # -----------------------------
    # orchestrator + tools
    # -----------------------------
    def _quick_route(self, message: str) -> Optional[str]:
        normalized = self._normalize_lookup_text(message)
        routes = (self._route_config().get("routes") or {})
        for route_name in ("fast_greeting", "calendar", "weather"):
            for keyword in list((routes.get(route_name) or {}).get("keywords") or []):
                k = self._normalize_lookup_text(keyword)
                if k and (normalized == k or f" {k} " in f" {normalized} "):
                    return route_name

        if re.search(r"\b(latest|news|current|search|internet)\b", normalized):
            return "web_search"
        return None

    def _classify_route(self, user: Optional[User], message: str, reply_language: str) -> Dict[str, Any]:
        quick = self._quick_route(message)
        if quick:
            return {
                "route": quick,
                "reason": "keyword_router",
                "clarifying_question": "",
                "tool_name": quick if quick in {"calendar", "weather", "web_search"} else "",
                "tool_input": message,
                "confidence": 0.99,
            }

        try:
            result = self._llm_json(
                """
You are the Orchestrator Agent for a personal assistant app.

Choose exactly one route:
- fast_greeting
- clarify
- weather
- web_search
- calendar
- pipeline

Rules:
- greeting/thanks/smalltalk => fast_greeting
- schedule/reminder/todo/routine/event => calendar
- weather/forecast => weather
- current public information / internet lookup / news => web_search
- missing critical context => clarify
- everything else => pipeline

Return ONLY JSON:
{
  "route": "pipeline",
  "reason": "...",
  "clarifying_question": "",
  "tool_name": "",
  "tool_input": "",
  "confidence": 0.0
}
""",
                json.dumps(
                    {
                        "user": {
                            "name": user.name if user else "",
                            "place": user.place if user else "",
                            "timezone": user.timezone if user else "Asia/Kolkata",
                            "reply_language": reply_language,
                        },
                        "message": message,
                        "today": str(date.today()),
                    },
                    ensure_ascii=False,
                ),
                temperature=0.05,
            )
            route = str(result.get("route", "pipeline")).strip() or "pipeline"
            if route not in {"fast_greeting", "clarify", "weather", "web_search", "calendar", "pipeline"}:
                route = "pipeline"
            result["route"] = route
            result["tool_name"] = str(result.get("tool_name", route if route in {"weather", "web_search", "calendar"} else "")).strip()
            result["tool_input"] = str(result.get("tool_input", message)).strip() or message
            return result
        except Exception:
            return {
                "route": "pipeline",
                "reason": "fallback",
                "clarifying_question": "",
                "tool_name": "",
                "tool_input": message,
                "confidence": 0.0,
            }

    def _build_clarification_draft(self, classification: Dict[str, Any], message: str) -> str:
        clarifying_question = str(classification.get("clarifying_question", "")).strip()
        if clarifying_question:
            return clarifying_question

        normalized = self._normalize_lookup_text(message)
        if any(x in normalized for x in ["weather", "rain", "forecast"]):
            return "Which place should I check the weather for?"
        return "Could you tell me a bit more so I can answer accurately?"

    def _tool_calendar(self, session: Session, user_id: Optional[int], message: str, user: Optional[User]) -> str:
        if user_id is None:
            return "I need a signed-in user profile before I can check your schedule."

        tz = self._get_user_timezone(user)
        now_local = datetime.now(tz)
        normalized = self._normalize_lookup_text(message)
        scope = "upcoming"
        if "today" in normalized or "இன்று" in message:
            scope = "today"
        elif "tomorrow" in normalized or "நாளை" in message:
            scope = "tomorrow"

        items = list(
            session.exec(
                select(Item).where(Item.user_id == int(user_id)).order_by(Item.created_at.desc())
            ).all()
        )

        selected: List[Tuple[datetime, Item]] = []
        for item in items:
            parsed = self._parse_item_datetime(item.datetime_str, user)
            if parsed is None:
                continue
            if scope == "today" and parsed.date() != now_local.date():
                continue
            if scope == "tomorrow" and parsed.date() != (now_local.date() + timedelta(days=1)):
                continue
            if scope == "upcoming" and parsed < now_local:
                continue
            selected.append((parsed, item))

        selected.sort(key=lambda x: x[0])
        top = selected[:5]

        if not top:
            if scope == "today":
                return "You do not have any reminders scheduled for today."
            if scope == "tomorrow":
                return "You do not have any reminders scheduled for tomorrow."
            return "You do not have any upcoming reminders saved right now."

        lines = [f"- {dt.strftime('%d %b %I:%M %p')}: {item.title or item.raw_text}" for dt, item in top]
        label = "today" if scope == "today" else "tomorrow" if scope == "tomorrow" else "upcoming"
        return f"Here are your {label} reminders:\n" + "\n".join(lines)

    def _extract_location_candidate(self, text: str, user: Optional[User]) -> Optional[str]:
        raw = str(text or "").strip()
        for pattern in (
            r"\bin\s+([A-Za-z\s,.-]{2,})$",
            r"\bfor\s+([A-Za-z\s,.-]{2,})$",
            r"\bat\s+([A-Za-z\s,.-]{2,})$",
        ):
            match = re.search(pattern, raw, flags=re.IGNORECASE)
            if match:
                return match.group(1).strip(" ?.,")
        if user and user.place:
            return user.place
        return None

    @staticmethod
    def _weather_code_summary(code: int) -> str:
        mapping = {
            0: "clear sky",
            1: "mostly clear",
            2: "partly cloudy",
            3: "overcast",
            45: "foggy",
            48: "freezing fog",
            51: "light drizzle",
            53: "moderate drizzle",
            55: "dense drizzle",
            61: "slight rain",
            63: "moderate rain",
            65: "heavy rain",
            71: "slight snow",
            80: "rain showers",
            95: "thunderstorm",
        }
        return mapping.get(int(code), "unsettled weather")

    def _tool_weather(self, message: str, user: Optional[User]) -> str:
        location = self._extract_location_candidate(message, user)
        if not location:
            return "I need a location to check the weather. Tell me the city or place name."

        geo_url = (
            "https://geocoding-api.open-meteo.com/v1/search"
            f"?name={quote_plus(location)}&count=1&language=en&format=json"
        )
        geo_resp = requests.get(geo_url, timeout=12)
        geo_resp.raise_for_status()
        first = (((geo_resp.json() or {}).get("results") or []) or [None])[0]
        if not first:
            return f"I could not find a weather location match for {location}."

        weather_url = (
            "https://api.open-meteo.com/v1/forecast?"
            f"latitude={first.get('latitude')}&longitude={first.get('longitude')}"
            "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m"
            "&timezone=auto"
        )
        wx_resp = requests.get(weather_url, timeout=12)
        wx_resp.raise_for_status()
        current = (wx_resp.json() or {}).get("current") or {}

        label = f"{first.get('name')}, {first.get('country')}".strip().strip(",")
        return (
            f"Current weather in {label}: "
            f"{current.get('temperature_2m')}°C, feels like {current.get('apparent_temperature')}°C, "
            f"{self._weather_code_summary(int(current.get('weather_code', -1) or -1))}. "
            f"Wind speed is {current.get('wind_speed_10m')} km/h."
        )

    def _tool_web_search(self, message: str) -> str:
        query = str(message or "").strip()
        if not query:
            return "I need a search query first."

        try:
            ddg_resp = requests.get(
                f"https://api.duckduckgo.com/?q={quote_plus(query)}&format=json&no_redirect=1&no_html=1",
                timeout=12,
            )
            ddg_resp.raise_for_status()
            ddg_data = ddg_resp.json() or {}
            answer = str(ddg_data.get("Answer") or "").strip()
            abstract = str(ddg_data.get("AbstractText") or "").strip()
            heading = str(ddg_data.get("Heading") or "").strip()
            if answer or abstract:
                return f"{heading + ': ' if heading else ''}{answer or abstract}".strip()
        except Exception:
            pass

        try:
            search_resp = requests.get(
                "https://en.wikipedia.org/w/api.php",
                params={
                    "action": "opensearch",
                    "search": query,
                    "limit": 1,
                    "namespace": 0,
                    "format": "json",
                },
                timeout=12,
            )
            search_resp.raise_for_status()
            data = search_resp.json() or []
            title = data[1][0] if isinstance(data, list) and len(data) > 1 and data[1] else ""
            if title:
                summary_resp = requests.get(
                    f"https://en.wikipedia.org/api/rest_v1/page/summary/{quote_plus(title)}",
                    timeout=12,
                )
                summary_resp.raise_for_status()
                summary = (summary_resp.json() or {}).get("extract") or ""
                if str(summary).strip():
                    return str(summary).strip()
        except Exception:
            pass

        return "I could not fetch a reliable web result for that right now."

    # -----------------------------
    # alignment agent
    # -----------------------------
    def _align_answer(
        self,
        *,
        user: Optional[User],
        profile: Optional[UserProfile],
        routine: Optional[DailyRoutine],
        user_message: str,
        draft_answer: str,
        reply_language: str,
        route: str,
        tool_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        try:
            aligned = self._llm_json(
                """
You are the Alignment Agent for a personal assistant app.

Rewrite the draft answer so it matches the user's tone and preferences.
Do not change the factual meaning.
Do not add new claims.

If reply_language is 'ta', final_answer must be in Tamil.
If reply_language is 'en', final_answer must be in English.

Return ONLY JSON:
{
  "english_answer": "...",
  "final_answer": "...",
  "style_applied": ["..."],
  "code_switch": false
}
""",
                json.dumps(
                    {
                        "route": route,
                        "user_message": user_message,
                        "draft_answer": draft_answer,
                        "reply_language": reply_language,
                        "alignment_rules": self._alignment_config(),
                        "user": {
                            "name": user.name if user else "",
                            "place": user.place if user else "",
                            "assistant_name": user.assistant_name if user else "Elli",
                        },
                        "routine": {
                            "wake_time": routine.wake_time if routine else None,
                            "sleep_time": routine.sleep_time if routine else None,
                            "work_start": routine.work_start if routine else None,
                            "work_end": routine.work_end if routine else None,
                        },
                        "structured_profile": self._profile_answers(profile),
                        "profile_summary": profile.profile_summary if profile else "",
                        "tool_meta": tool_meta or {},
                    },
                    ensure_ascii=False,
                ),
                temperature=0.2,
            )
            english_answer = str(aligned.get("english_answer", "")).strip() or draft_answer
            final_answer = str(aligned.get("final_answer", "")).strip() or english_answer
            return {
                "english_answer": english_answer,
                "final_answer": final_answer,
                "style_applied": aligned.get("style_applied") or [],
                "code_switch": bool(aligned.get("code_switch", False)),
            }
        except Exception:
            return {
                "english_answer": draft_answer,
                "final_answer": draft_answer,
                "style_applied": ["fallback"],
                "code_switch": False,
            }

    # -----------------------------
    # memory agent
    # -----------------------------
    def _semantic_cache_lookup(self, session: Session, user_id: Optional[int], message: str) -> Optional[Dict[str, Any]]:
        if user_id is None:
            return None
        try:
            result = self.local_rag_service.try_answer(session, user_id, message)
        except Exception:
            return None
        if not isinstance(result, dict):
            return None

        try:
            score = float(str(result.get("direct_answer_confidence", "0") or "0").strip())
        except Exception:
            score = 0.0

        threshold = float((self._memory_config() or {}).get("semantic_cache_threshold", 0.95) or 0.95)
        route_taken = str(result.get("route_taken", "")).strip()

        if score >= threshold or route_taken in {"cached_answer", "local_schedule_rag", "local_routine_rag"}:
            return result
        return None

    def maybe_sync_memory(self, session: Session, user_id: Optional[int], force: bool = False) -> Dict[str, Any]:
        if user_id is None:
            return {"ok": False, "reason": "guest_user"}

        cfg = self._memory_config()
        state = self._read_state(user_id, "memory", {})
        last_sync_at = str(state.get("last_sync_at", "")).strip()
        last_sync_conversation_id = int(state.get("last_sync_conversation_id", 0) or 0)
        min_turns = int(cfg.get("min_turns_before_sync", 6) or 6)
        min_gap_minutes = int(cfg.get("min_minutes_between_sync", 15) or 15)
        max_rows = int(cfg.get("max_conversations_per_sync", 20) or 20)
        max_facts = int(cfg.get("max_facts_per_sync", 5) or 5)

        if not force and last_sync_at:
            try:
                last = datetime.fromisoformat(last_sync_at.replace("Z", "+00:00")).replace(tzinfo=None)
                elapsed = datetime.utcnow() - last
                if elapsed < timedelta(minutes=min_gap_minutes):
                    return {"ok": False, "reason": "cooldown"}
            except Exception:
                pass

        rows = list(
            session.exec(
                select(Conversation)
                .where(Conversation.user_id == int(user_id), Conversation.id > last_sync_conversation_id)
                .order_by(Conversation.id.asc())
            ).all()
        )
        if not force and len(rows) < min_turns:
            return {"ok": False, "reason": "not_enough_new_turns", "new_turns": len(rows)}

        rows = rows[:max_rows]
        if not rows:
            return {"ok": False, "reason": "no_new_conversations"}

        user, profile, routine = self._get_user_bundle(session, int(user_id))
        serialized_rows = [
            {
                "id": row.id,
                "channel": row.channel,
                "user_input": row.user_input,
                "transcript": row.transcript,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]

        try:
            llm_out = self._llm_json(
                """
You are the Memory & Cache Agent for a personal assistant app.

Read the recent conversations and:
1) write a short memory summary,
2) extract only durable user facts worth remembering,
3) suggest structured profile updates when obvious.

Do not invent facts.
If nothing durable was learned, return empty lists.

Return ONLY JSON:
{
  "summary": "...",
  "new_facts": ["..."],
  "profile_updates": {},
  "cache_candidates": ["..."]
}
""",
                json.dumps(
                    {
                        "user": {
                            "name": user.name if user else "",
                            "place": user.place if user else "",
                            "timezone": user.timezone if user else "Asia/Kolkata",
                        },
                        "routine": {
                            "wake_time": routine.wake_time if routine else None,
                            "sleep_time": routine.sleep_time if routine else None,
                            "work_start": routine.work_start if routine else None,
                            "work_end": routine.work_end if routine else None,
                        },
                        "current_profile_answers": self._profile_answers(profile),
                        "conversations": serialized_rows,
                    },
                    ensure_ascii=False,
                ),
                temperature=0.1,
            )
        except Exception:
            llm_out = {"summary": "", "new_facts": [], "profile_updates": {}, "cache_candidates": []}

        summary = str(llm_out.get("summary", "")).strip()
        facts = [str(x).strip() for x in list(llm_out.get("new_facts") or []) if str(x).strip()][:max_facts]
        profile_updates = llm_out.get("profile_updates") if isinstance(llm_out.get("profile_updates"), dict) else {}
        cache_candidates = [str(x).strip() for x in list(llm_out.get("cache_candidates") or []) if str(x).strip()][:max_facts]

        if profile_updates:
            self.sync_answers_to_profile(session, int(user_id), profile_updates)

        if summary or facts:
            memory_text = "\n".join([summary] + [f"- {x}" for x in facts if x]).strip()
            session.add(
                Conversation(
                    user_id=int(user_id),
                    channel="system",
                    user_input=f"Memory summary: {memory_text}" if memory_text else "Memory sync completed.",
                    transcript=None,
                    llm_output_json=json.dumps({"source": "memory_agent", "facts": facts}, ensure_ascii=False),
                    created_at=datetime.utcnow(),
                )
            )
            session.commit()

        self._append_jsonl(
            Path(AGENT_MEMORY_DIR) / f"{user_id}_{date.today().isoformat()}.jsonl",
            {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "user_id": user_id,
                "summary": summary,
                "facts": facts,
                "profile_updates": profile_updates,
                "cache_candidates": cache_candidates,
                "conversation_ids": [row.id for row in rows if row.id is not None],
            },
        )

        state.update(
            {
                "last_sync_at": datetime.utcnow().isoformat() + "Z",
                "last_sync_conversation_id": max(int(row.id or 0) for row in rows),
                "last_summary": summary,
                "last_facts": facts,
            }
        )
        self._write_state(int(user_id), "memory", state)
        self.persist_profile_snapshot(session, int(user_id))

        return {
            "ok": True,
            "summary": summary,
            "new_facts": facts,
            "profile_updates": profile_updates,
            "cache_candidates": cache_candidates,
        }

    # -----------------------------
    # main chat orchestrator
    # -----------------------------
    def orchestrate_chat(
        self,
        session: Session,
        user_id: Optional[int],
        message: str,
        reply_language: Optional[str],
        *,
        pipeline_runner: Callable[[Session, Optional[int], str, Optional[str]], Dict[str, Any]],
    ) -> Dict[str, Any]:
        if not self.enabled:
            return pipeline_runner(session, user_id, message, reply_language)

        total_start = time.perf_counter()
        user, profile, routine = self._get_user_bundle(session, int(user_id)) if user_id else (None, None, None)
        resolved_lang = self._normalize_reply_language(
            reply_language,
            fallback=self._normalize_reply_language(user.reply_language if user else "ta"),
        )

        semantic_hit = self._semantic_cache_lookup(session, user_id, message)
        if semantic_hit is not None:
            self.maybe_sync_memory(session, user_id, force=False)
            return semantic_hit

        classification = self._classify_route(user, message, resolved_lang)
        route = str(classification.get("route", "pipeline")).strip() or "pipeline"
        draft_english = ""
        tool_meta = {"classification": classification}

        if route == "fast_greeting":
            try:
                local = self.local_rag_service.try_answer(session, user_id, message)
            except Exception:
                local = None
            if isinstance(local, dict):
                self.maybe_sync_memory(session, user_id, force=False)
                return local
            draft_english = f"Hi {(user.name if user else 'there')}, how can I help you?"
        elif route == "clarify":
            draft_english = self._build_clarification_draft(classification, message)
        elif route == "calendar":
            draft_english = self._tool_calendar(session, user_id, message, user)
        elif route == "weather":
            try:
                draft_english = self._tool_weather(message, user)
            except Exception as exc:
                draft_english = f"I could not fetch the weather right now: {exc}"
        elif route == "web_search":
            try:
                draft_english = self._tool_web_search(classification.get("tool_input") or message)
            except Exception as exc:
                draft_english = f"I could not complete the web lookup right now: {exc}"
        else:
            pipeline_result = pipeline_runner(session, user_id, message, resolved_lang)
            self.maybe_sync_memory(session, user_id, force=False)
            return pipeline_result

        aligned = self._align_answer(
            user=user,
            profile=profile,
            routine=routine,
            user_message=message,
            draft_answer=draft_english,
            reply_language=resolved_lang,
            route=route,
            tool_meta=tool_meta,
        )
        english_answer = str(aligned.get("english_answer", draft_english)).strip() or draft_english
        final_answer = str(aligned.get("final_answer", english_answer)).strip() or english_answer

        result = self._build_pipeline_result(
            raw_english=draft_english,
            remodeled_english=english_answer,
            tamil_text=final_answer if resolved_lang == "ta" else "",
            theni_tamil_text=final_answer if resolved_lang == "ta" else "",
            route_taken=f"agentic_{route}",
            direct_answer_source=f"agentic_{route}",
            direct_answer_confidence=f"{float(classification.get('confidence', 0.0) or 0.0):.4f}",
            predicted_label=route,
            risk_level="low",
            stage_notes=[
                f"Orchestrator selected route: {route}.",
                "Alignment agent personalized the final response.",
            ],
            core_meta={"classification": classification, "tool_meta": tool_meta},
            remodel_meta={"aligned": aligned},
            review_meta={},
            translation_meta={"reply_language": resolved_lang, "aligned_output": True},
            timings_ms={"total_ms": round((time.perf_counter() - total_start) * 1000, 2)},
        )
        self.maybe_sync_memory(session, user_id, force=False)
        return result

    # -----------------------------
    # time helpers
    # -----------------------------
    @staticmethod
    def _get_user_timezone(user: Optional[User]) -> ZoneInfo:
        tz_name = (user.timezone if user and user.timezone else "Asia/Kolkata").strip() or "Asia/Kolkata"
        try:
            return ZoneInfo(tz_name)
        except Exception:
            return ZoneInfo("Asia/Kolkata")

    def _parse_item_datetime(self, raw_value: Optional[str], user: Optional[User]) -> Optional[datetime]:
        raw = str(raw_value or "").strip()
        if not raw:
            return None
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except Exception:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=self._get_user_timezone(user))
        return parsed.astimezone(self._get_user_timezone(user))