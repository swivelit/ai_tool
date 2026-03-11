from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from openai import OpenAI
from pydantic import BaseModel
from sqlmodel import Session, select

from .database import get_session
from .models import Conversation, DailyRoutine, Item, QACache, User, UserProfile

CURRENT_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = CURRENT_DIR.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from config import LOGS_DIR, PIPELINE_VERSION  # noqa: E402
from stage_behaviour_questions import BehaviourQuestionnaire, QUESTIONS as PIPELINE_QUESTIONS  # noqa: E402
from stage_english_remodel import EnglishRemodeler  # noqa: E402
from stage_openai_core import OpenAICore  # noqa: E402
from stage_translate import StageTranslator  # noqa: E402

load_dotenv()
PERSONALITY_QUESTIONS_VERSION = 1
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set (env var missing)")

client = OpenAI(api_key=OPENAI_API_KEY)

app = FastAPI(title="Tamil Voice AI Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STAGE_BEHAVIOUR = BehaviourQuestionnaire()
STAGE_CORE = OpenAICore()
STAGE_REMODELER = EnglishRemodeler(STAGE_CORE)
STAGE_TRANSLATOR = StageTranslator(STAGE_CORE)
STAGE_CACHE: Dict[str, Dict[str, Any]] = {}


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = datetime.utcnow()
    body_text = ""
    try:
        body = await request.body()
        if body:
            body_text = body.decode("utf-8", errors="ignore")[:1500]
    except Exception:
        pass
    response = await call_next(request)
    ms = int((datetime.utcnow() - start).total_seconds() * 1000)
    print(f"[REQ] {request.method} {request.url.path} {response.status_code} {ms}ms body={body_text[:300]}")
    return response


@app.get("/")
def root():
    return {"ok": True, "message": "Tamil Voice AI backend. Use /health"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/health")
def api_health():
    return {"status": "ok", "mode": PIPELINE_VERSION}


PARSE_DT_PROMPT = """
You convert natural language datetime into ISO datetime.
Input includes:
- timezone (IANA)
- now (ISO)
- text

Return ONLY JSON:
{
  "iso": "YYYY-MM-DDTHH:MM:SS" or null,
  "human": "human readable summary",
  "confidence": 0.0 to 1.0
}
"""

SYSTEM_PROMPT = """
You are a personal AI assistant.

You will receive JSON input with:
- context:
    - user (name, place, timezone)
    - routine (daily schedule and habits)
    - personality (communication style, motivation, sensitivity)
- input (the user's message)

Rules:
- Always respect the user's routine when suggesting times or actions
- Always match your tone to the personality profile
- If personality is missing, be neutral and polite
- If routine is missing, ask clarifying questions
- Never suggest actions outside wake/sleep boundaries unless explicitly asked
- If a request conflicts with routine, explain and suggest an alternative

Return ONLY JSON:
{
  "intent": "reminder|note|task|document|other",
  "category": "Work|Home|Business|Other",
  "datetime": "... or null",
  "title": "...",
  "details": "..."
}
"""

PERSONALITY_QUESTIONS = [
    "How would you describe yourself in one sentence?",
    "Do you prefer strict reminders or gentle nudges?",
    "Are you more spontaneous or planned?",
    "What usually motivates you?",
    "How do you want the assistant to talk to you?",
]

PERSONALITY_SUMMARY_PROMPT = """
You are analyzing a user's personality.

Based on their answers, create a concise profile including:
- communication tone
- motivation style
- structure vs flexibility preference
- emotional sensitivity

Return plain text. No JSON.
"""

CHECKIN_PROMPT = """
- Match message tone to personality
- If personality prefers gentle nudges, avoid commands
- If personality prefers strictness, be direct

You will receive:
- user profile (name, place, timezone)
- user routine (wake_time, sleep_time, work_start, work_end, daily_habits)

Create 3–8 smart check-ins for today.
Respect the user's routine and time boundaries.

Each check-in must include:
- title
- when (HH:MM 24h)
- message (address user by name)

Return ONLY JSON:
{ "checkins": [ { "title":"...", "when":"08:00", "message":"..." } ] }
"""


class ParseDatetimeRequest(BaseModel):
    text: str
    timezone: str = "Asia/Kolkata"
    now_iso: Optional[str] = None


class DailyRoutineIn(BaseModel):
    wake_time: str
    sleep_time: str
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    daily_habits: Optional[str] = None


class DailyRoutineOut(DailyRoutineIn):
    user_id: int


class TextAnalysisRequest(BaseModel):
    text: str
    user_id: Optional[int] = None
    meta: Optional[Dict[str, Any]] = None


class PersonalityAnswersIn(BaseModel):
    answers: Dict[str, str]


class TextAnalysisResponse(BaseModel):
    id: int
    intent: str
    category: str
    raw_text: str
    transcript: Optional[str] = None
    datetime: Optional[str] = None
    title: Optional[str] = None
    details: Optional[str] = None


class UserCreate(BaseModel):
    name: str
    place: Optional[str] = None
    timezone: Optional[str] = "Asia/Kolkata"
    assistant_name: Optional[str] = "Elli"


class PipelineChatRequest(BaseModel):
    user_id: int
    message: str


def llm_json(system_prompt: str, user_content: str, temperature: float = 0.2) -> Dict[str, Any]:
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
    )
    return json.loads(resp.choices[0].message.content)


def normalize_category(raw: str) -> str:
    cr = (raw or "Other").lower()
    if cr == "work":
        return "Work"
    if cr == "home":
        return "Home"
    if cr == "business":
        return "Business"
    return "Other"


def validate_hhmm(v: str) -> None:
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", str(v or "").strip()):
        raise HTTPException(400, f"Invalid time format: {v}")


def normalize_optional(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    v = str(v).strip()
    return v if v else None


def item_to_response(item: Item) -> TextAnalysisResponse:
    return TextAnalysisResponse(
        id=item.id,
        intent=item.intent,
        category=item.category,
        raw_text=item.raw_text,
        transcript=item.transcript,
        datetime=item.datetime_str,
        title=item.title,
        details=item.details,
    )


def log_conversation(
    session: Session,
    user_id: Optional[int],
    channel: str,
    user_input: str,
    transcript: Optional[str],
    llm_json_out: Optional[dict],
):
    row = Conversation(
        user_id=user_id,
        channel=channel,
        user_input=user_input,
        transcript=transcript,
        llm_output_json=json.dumps(llm_json_out, ensure_ascii=False) if llm_json_out else None,
        created_at=datetime.utcnow(),
    )
    session.add(row)
    session.commit()


def upsert_qa_cache(session: Session, user_id: Optional[int], question: str, answer_json: dict):
    q = select(QACache).where(QACache.question == question)
    if user_id is not None:
        q = q.where(QACache.user_id == user_id)
    row = session.exec(q).first()
    if row:
        row.answer = json.dumps(answer_json, ensure_ascii=False)
        row.hits = (row.hits or 0) + 1
        row.updated_at = datetime.utcnow()
        session.add(row)
        session.commit()
        return
    session.add(
        QACache(
            user_id=user_id,
            question=question,
            answer=json.dumps(answer_json, ensure_ascii=False),
            hits=1,
            updated_at=datetime.utcnow(),
        )
    )
    session.commit()


def build_user_context(session: Session, user_id: int) -> dict:
    user = session.get(User, user_id)
    if not user:
        return {}
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if profile and profile.questions_version != PERSONALITY_QUESTIONS_VERSION:
        personality = None
    elif profile and profile.profile_summary:
        personality = profile.profile_summary
    else:
        personality = "No personality profile yet. Be neutral and helpful."
    return {
        "user": {
            "name": user.name,
            "place": user.place,
            "timezone": user.timezone,
        },
        "routine": (
            {
                "wake_time": routine.wake_time,
                "sleep_time": routine.sleep_time,
                "work_start": routine.work_start,
                "work_end": routine.work_end,
                "daily_habits": routine.daily_habits,
            }
            if routine
            else None
        ),
        "personality": personality,
    }


def _infer_hobbies(habits_text: str) -> List[str]:
    text = (habits_text or "").lower()
    hobbies: List[str] = []
    if "music" in text:
        hobbies.append("music")
    if "movie" in text or "cinema" in text:
        hobbies.append("movies")
    if "read" in text or "book" in text:
        hobbies.append("reading")
    if "cook" in text:
        hobbies.append("cooking")
    if "travel" in text or "trip" in text:
        hobbies.append("travel")
    return hobbies[:3] or ["music"]


def _infer_tone(summary: str) -> str:
    s = (summary or "").lower()
    if any(word in s for word in ["direct", "strict", "brief"]):
        return "short_direct"
    if any(word in s for word in ["detailed", "explain"]):
        return "detailed"
    if any(word in s for word in ["casual", "friendly"]):
        return "friendly_casual"
    if any(word in s for word in ["formal", "respectful"]):
        return "respectful"
    return "warm"


def _infer_personality_style(summary: str) -> str:
    s = (summary or "").lower()
    if "calm" in s:
        return "calm"
    if "friendly" in s:
        return "friendly"
    if "ambitious" in s or "goal" in s:
        return "ambitious"
    if "sensitive" in s or "emotional" in s:
        return "emotional_sensitive"
    return "practical"


def _default_stage_answers(
    user: Optional[User],
    routine: Optional[DailyRoutine],
    db_profile: Optional[UserProfile],
) -> Dict[str, Any]:
    habits_text = routine.daily_habits if routine else ""
    summary = db_profile.profile_summary if db_profile and db_profile.profile_summary else ""
    return {
        "age_group": "26-35",
        "gender_context": "prefer_not_to_say",
        "life_stage": "none_of_these",
        "food_preference": "mixed_flexible",
        "health_conditions": ["none"],
        "food_caution": "no_special_caution",
        "daily_activity": "moderate_walks",
        "sleep_pattern": "average",
        "personality_style": _infer_personality_style(summary),
        "stress_support": "step_by_step_plan",
        "communication_tone": _infer_tone(summary),
        "answer_length": "medium",
        "hobbies": _infer_hobbies(habits_text or ""),
        "main_goal": "career_or_business",
        "family_role": "working_professional",
    }


def _sync_stage_profile(session: Session, user_id: Optional[int]) -> Dict[str, Any]:
    uid = str(user_id or "guest")
    user = session.get(User, user_id) if user_id else None
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first() if user_id else None
    db_profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first() if user_id else None

    answers = _default_stage_answers(user, routine, db_profile)
    profile = {
        "profile_version": "ai_tool_db_bridge",
        "user_id": uid,
        "created_at": datetime.utcnow().isoformat() + "Z",
        "answers": answers,
        "behaviour_rules": STAGE_BEHAVIOUR._derive_behaviour_rules(answers),
        "rag_personality_hints": STAGE_BEHAVIOUR._infer_personality_rag_from_answers(answers),
        "app_profile": {
            "name": user.name if user else "Guest",
            "place": user.place if user else "",
            "timezone": user.timezone if user else "Asia/Kolkata",
            "assistant_name": user.assistant_name if user else "Elli",
        },
        "daily_routine": {
            "wake_time": routine.wake_time if routine else "07:30",
            "sleep_time": routine.sleep_time if routine else "23:30",
            "work_start": routine.work_start if routine else "09:30",
            "work_end": routine.work_end if routine else "18:30",
            "daily_habits": routine.daily_habits if routine else "",
        },
    }

    existing = None
    if STAGE_BEHAVIOUR.profile_exists(uid):
        try:
            existing = STAGE_BEHAVIOUR.load_profile(uid)
        except Exception:
            existing = None
    if existing:
        profile["created_at"] = existing.get("created_at", profile["created_at"])

    profile = STAGE_BEHAVIOUR._upgrade_profile(profile)
    if db_profile and db_profile.profile_summary:
        stage_summary = str(profile.get("profile_summary", "")).strip()
        profile["profile_summary"] = (
            f"{stage_summary}\n\nExisting app personality summary: {db_profile.profile_summary.strip()}".strip()
        )

    STAGE_BEHAVIOUR.save_profile(uid, profile)
    return profile


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return json.dumps(str(value), ensure_ascii=False)


def _log_stage_history(user_id: Optional[int], profile: Dict[str, Any], query: str, result: Dict[str, Any]) -> None:
    uid = str(user_id or "guest")
    log_path = LOGS_DIR / f"{uid}_history.jsonl"
    record = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "user_id": uid,
        "query": query,
        "profile_summary": profile.get("profile_summary", ""),
        "profile_card": profile.get("profile_card", {}),
        "result": result,
    }
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def _run_stage_pipeline(session: Session, user_id: Optional[int], message: str) -> Dict[str, Any]:
    uid = str(user_id or "guest")
    cache_key = f"{uid}::{' '.join(message.strip().lower().split())}"
    if cache_key in STAGE_CACHE:
        cached = dict(STAGE_CACHE[cache_key])
        cached["cache_hit"] = "true"
        return cached

    profile = _sync_stage_profile(session, user_id)
    total_start = time.perf_counter()
    timings: Dict[str, float] = {}
    stage_notes: List[str] = []

    t0 = time.perf_counter()
    profile_context = STAGE_BEHAVIOUR.build_runtime_context(profile, user_query=message)
    timings["context_ms"] = round((time.perf_counter() - t0) * 1000, 2)

    t0 = time.perf_counter()
    direct_match = STAGE_REMODELER.get_direct_answer_match(message)
    timings["direct_match_ms"] = round((time.perf_counter() - t0) * 1000, 2)

    core_meta: Dict[str, Any] = {"answer": "", "answer_style": "", "risk_level": "low", "safety_notes": ""}
    remodel_meta: Dict[str, Any] = {}
    review_meta: Dict[str, Any] = {}
    translation_meta: Dict[str, Any] = {}
    route_taken = "full_pipeline"
    direct_answer_source = ""
    direct_answer_confidence = ""
    predicted_label = "unknown"
    risk_level = "low"

    if direct_match and direct_match.confidence >= 0.92:
        raw_english = direct_match.answer
        remodeled_english = direct_match.answer
        route_taken = "dataset_direct_answer"
        direct_answer_source = f"{direct_match.match_type}:{direct_match.query}"
        direct_answer_confidence = f"{direct_match.confidence:.4f}"
        predicted_label = direct_match.label
        stage_notes.append("Used a high-confidence direct answer from the local dataset.")
    else:
        t0 = time.perf_counter()
        core_meta = STAGE_CORE.answer_user_query_structured(message, profile_context)
        timings["core_answer_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        raw_english = str(core_meta.get("answer", "")).strip()

        t0 = time.perf_counter()
        remodel_meta = STAGE_REMODELER.remodel_with_meta(message, raw_english, profile)
        timings["remodel_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        remodeled_english = str(remodel_meta.get("answer", raw_english)).strip() or raw_english

        t0 = time.perf_counter()
        review_meta = STAGE_CORE.review_answer(message, remodeled_english, profile_context)
        timings["review_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        remodeled_english = str(review_meta.get("final_answer", remodeled_english)).strip() or remodeled_english

        route_taken = str(remodel_meta.get("route", "full_rewrite"))
        predicted_label = str(remodel_meta.get("predicted_label", "unknown"))
        risk_level = str(remodel_meta.get("risk_level") or core_meta.get("risk_level") or "low")
        direct_answer_source = str(remodel_meta.get("direct_answer_source", ""))
        if remodel_meta.get("direct_answer_confidence") not in (None, ""):
            direct_answer_confidence = f"{float(remodel_meta.get('direct_answer_confidence', 0.0)):.4f}"

        for note in (core_meta.get("safety_notes"), remodel_meta.get("route_reason"), review_meta.get("review_note")):
            if str(note or "").strip():
                stage_notes.append(str(note).strip())

    t0 = time.perf_counter()
    translation_meta = STAGE_TRANSLATOR.english_to_tamil_with_meta(remodeled_english, profile)
    tamil_text = str(translation_meta.get("tamil_text", "")).strip()
    timings["english_to_tamil_ms"] = round((time.perf_counter() - t0) * 1000, 2)

    t0 = time.perf_counter()
    theni_tamil_text = STAGE_TRANSLATOR.tamil_to_thenitamil(tamil_text)
    timings["tamil_to_theni_ms"] = round((time.perf_counter() - t0) * 1000, 2)

    total_ms = round((time.perf_counter() - total_start) * 1000, 2)
    result: Dict[str, Any] = {
        "pipeline_version": PIPELINE_VERSION,
        "raw_english": raw_english,
        "remodeled_english": remodeled_english,
        "tamil_text": tamil_text,
        "theni_tamil_text": theni_tamil_text,
        "direct_answer_source": direct_answer_source,
        "direct_answer_confidence": direct_answer_confidence,
        "predicted_label": predicted_label,
        "risk_level": risk_level,
        "route_taken": route_taken,
        "cache_hit": "false",
        "stage_notes": _safe_json(stage_notes),
        "core_meta": _safe_json(core_meta),
        "remodel_meta": _safe_json(remodel_meta),
        "review_meta": _safe_json(review_meta),
        "translation_meta": _safe_json(translation_meta),
        "timings_ms": json.dumps({**timings, "total_ms": total_ms}, ensure_ascii=False),
    }

    _log_stage_history(user_id, profile, message, result)
    STAGE_CACHE[cache_key] = dict(result)
    if len(STAGE_CACHE) > 128:
        first_key = next(iter(STAGE_CACHE))
        STAGE_CACHE.pop(first_key, None)
    return result


def _metadata_for_item(session: Session, user_id: Optional[int], text: str, fallback_details: str) -> Dict[str, Any]:
    user_context = {}
    if user_id:
        user_context = build_user_context(session, user_id)
    if user_id and not user_context.get("personality"):
        user_context["personality"] = "Unknown personality. Be neutral and helpful."

    user_content = json.dumps({"context": user_context, "input": text}, ensure_ascii=False)

    try:
        data = llm_json(SYSTEM_PROMPT, user_content, temperature=0.2)
        if not data.get("details"):
            data["details"] = fallback_details
        return data
    except Exception:
        clean_text = " ".join(text.strip().split())
        return {
            "intent": "other",
            "category": "Other",
            "datetime": None,
            "title": (clean_text[:60] + "...") if len(clean_text) > 60 else clean_text,
            "details": fallback_details,
        }


def _normalized_pipeline_result(result: Dict[str, Any]) -> Dict[str, Any]:
    def _maybe(value: Any, default: Any):
        if isinstance(value, str):
            text = value.strip()
            if text and text[:1] in "[{":
                try:
                    return json.loads(text)
                except Exception:
                    return default
        return value if value not in (None, "") else default

    return {
        "pipeline_version": result.get("pipeline_version", PIPELINE_VERSION),
        "raw_english": result.get("raw_english", ""),
        "remodeled_english": result.get("remodeled_english", ""),
        "tamil_text": result.get("tamil_text", ""),
        "theni_tamil_text": result.get("theni_tamil_text", ""),
        "direct_answer_source": result.get("direct_answer_source", ""),
        "direct_answer_confidence": result.get("direct_answer_confidence", ""),
        "predicted_label": result.get("predicted_label", ""),
        "risk_level": result.get("risk_level", ""),
        "route_taken": result.get("route_taken", ""),
        "cache_hit": result.get("cache_hit", "false"),
        "stage_notes": _maybe(result.get("stage_notes"), []),
        "core_meta": _maybe(result.get("core_meta"), {}),
        "remodel_meta": _maybe(result.get("remodel_meta"), {}),
        "review_meta": _maybe(result.get("review_meta"), {}),
        "translation_meta": _maybe(result.get("translation_meta"), {}),
        "timings_ms": _maybe(result.get("timings_ms"), {}),
    }


@app.post("/parse-datetime")
def parse_datetime(payload: ParseDatetimeRequest):
    now_iso = payload.now_iso or datetime.utcnow().isoformat()
    user_content = json.dumps({"timezone": payload.timezone, "now": now_iso, "text": payload.text}, ensure_ascii=False)
    out = llm_json(PARSE_DT_PROMPT, user_content, temperature=0.0)
    return {
        "iso": out.get("iso"),
        "human": out.get("human") or "",
        "confidence": float(out.get("confidence") or 0.0),
    }


@app.post("/users")
def create_user(payload: UserCreate, session: Session = Depends(get_session)):
    assistant_name = (payload.assistant_name or "Elli").strip() or "Elli"
    user = User(
        name=payload.name,
        place=payload.place,
        timezone=payload.timezone or "Asia/Kolkata",
        assistant_name=assistant_name,
    )
    session.add(user)
    session.commit()
    session.refresh(user)

    profile = UserProfile(
        user_id=user.id,
        answers_json=json.dumps({}, ensure_ascii=False),
        questions_version=PERSONALITY_QUESTIONS_VERSION,
    )
    session.add(profile)
    session.commit()
    return user


@app.get("/users/{user_id}")
def get_user(user_id: int, session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    return user


@app.get("/personality/questions")
def get_personality_questions():
    return {"version": PERSONALITY_QUESTIONS_VERSION, "questions": PERSONALITY_QUESTIONS}


@app.get("/api/questions")
def get_pipeline_questions():
    return {"questions": PIPELINE_QUESTIONS}


@app.get("/api/profile/{user_id}")
def get_pipeline_profile(user_id: int, session: Session = Depends(get_session)):
    profile = _sync_stage_profile(session, user_id)
    return {"exists": True, "profile": profile}


@app.post("/api/profile/{user_id}")
def save_pipeline_profile(user_id: int, payload: PersonalityAnswersIn, session: Session = Depends(get_session)):
    answers_json = json.dumps(payload.answers, ensure_ascii=False)
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if profile:
        profile.answers_json = answers_json
        profile.profile_summary = None
        profile.questions_version = PERSONALITY_QUESTIONS_VERSION
        profile.updated_at = datetime.utcnow()
    else:
        profile = UserProfile(
            user_id=user_id,
            answers_json=answers_json,
            questions_version=PERSONALITY_QUESTIONS_VERSION,
            updated_at=datetime.utcnow(),
        )
        session.add(profile)
    session.commit()
    session.refresh(profile)
    stage_profile = _sync_stage_profile(session, user_id)
    return {"ok": True, "profile": stage_profile}


@app.post("/api/chat")
def pipeline_chat(payload: PipelineChatRequest, session: Session = Depends(get_session)):
    result = _run_stage_pipeline(session, payload.user_id, payload.message)
    return {"ok": True, "result": _normalized_pipeline_result(result)}


@app.post("/users/{user_id}/questionnaire")
def save_mobile_questionnaire(user_id: int, payload: Dict[str, Any], session: Session = Depends(get_session)):
    raw = payload.get("payload", payload)
    mapped = DailyRoutineIn(
        wake_time=str(raw.get("wake") or raw.get("wake_time") or "07:30"),
        sleep_time=str(raw.get("sleep") or raw.get("sleep_time") or "23:30"),
        work_start=raw.get("workStart") or raw.get("work_start"),
        work_end=raw.get("workEnd") or raw.get("work_end"),
        daily_habits=raw.get("dailyHabits") or raw.get("daily_habits"),
    )
    return upsert_daily_routine(user_id, mapped, session)


@app.post("/users/{user_id}/generate-daily-checkins")
def generate_daily_checkins(user_id: int, session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(404, "User not found")
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    if not routine:
        raise HTTPException(400, "Daily routine not set. Please configure routine first.")
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    user_content = json.dumps(
        {
            "user": {"name": user.name, "place": user.place, "timezone": user.timezone},
            "personality": profile.profile_summary if profile and profile.profile_summary else "No personality profile yet. Be neutral and helpful.",
            "routine": {
                "wake_time": routine.wake_time,
                "sleep_time": routine.sleep_time,
                "work_start": routine.work_start,
                "work_end": routine.work_end,
                "daily_habits": routine.daily_habits,
            },
            "today": str(date.today()),
        },
        ensure_ascii=False,
    )
    out = llm_json(CHECKIN_PROMPT, user_content, temperature=0.2)
    checkins = out.get("checkins", [])
    checkins.sort(key=lambda x: x.get("when", "99:99"))
    log_conversation(session, user_id, "system", "generate-daily-checkins", None, out)
    return {"checkins": checkins}


@app.get("/users/{user_id}/daily-routine", response_model=DailyRoutineOut)
def get_daily_routine(user_id: int, session: Session = Depends(get_session)):
    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    if not routine:
        raise HTTPException(404, "Daily routine not set")
    return routine


@app.put("/users/{user_id}/daily-routine", response_model=DailyRoutineOut)
def upsert_daily_routine(user_id: int, payload: DailyRoutineIn, session: Session = Depends(get_session)):
    work_start = normalize_optional(payload.work_start)
    work_end = normalize_optional(payload.work_end)
    daily_habits = normalize_optional(payload.daily_habits)
    validate_hhmm(payload.wake_time)
    validate_hhmm(payload.sleep_time)
    if work_start:
        validate_hhmm(work_start)
    if work_end:
        validate_hhmm(work_end)

    routine = session.exec(select(DailyRoutine).where(DailyRoutine.user_id == user_id)).first()
    if routine:
        routine.wake_time = payload.wake_time
        routine.sleep_time = payload.sleep_time
        routine.work_start = work_start
        routine.work_end = work_end
        routine.daily_habits = daily_habits
        routine.updated_at = datetime.utcnow()
    else:
        routine = DailyRoutine(
            user_id=user_id,
            wake_time=payload.wake_time,
            sleep_time=payload.sleep_time,
            work_start=work_start,
            work_end=work_end,
            daily_habits=daily_habits,
            updated_at=datetime.utcnow(),
        )
        session.add(routine)
    session.commit()
    session.refresh(routine)
    STAGE_CACHE.clear()
    _sync_stage_profile(session, user_id)
    return routine


@app.get("/users/{user_id}/personality")
def get_personality(user_id: int, session: Session = Depends(get_session)):
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if not profile:
        raise HTTPException(404, "Personality profile not found")
    return {"answers": json.loads(profile.answers_json or "{}"), "summary": profile.profile_summary}


@app.post("/users/{user_id}/personality")
def save_personality_answers(user_id: int, payload: PersonalityAnswersIn, session: Session = Depends(get_session)):
    answers_json = json.dumps(payload.answers, ensure_ascii=False)
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if profile:
        profile.answers_json = answers_json
        profile.profile_summary = None
        profile.updated_at = datetime.utcnow()
    else:
        profile = UserProfile(user_id=user_id, answers_json=answers_json, updated_at=datetime.utcnow())
        session.add(profile)
    session.commit()
    session.refresh(profile)
    STAGE_CACHE.clear()
    _sync_stage_profile(session, user_id)
    return {"ok": True}


@app.post("/users/{user_id}/personality/generate-summary")
def generate_personality_summary(user_id: int, session: Session = Depends(get_session)):
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if not profile:
        raise HTTPException(404, "Personality answers not found")
    answers = json.loads(profile.answers_json or "{}")
    if not answers:
        raise HTTPException(400, "No personality answers provided yet")
    content = "\n".join(f"{q}: {a}" for q, a in answers.items())
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        temperature=0.2,
        messages=[
            {"role": "system", "content": PERSONALITY_SUMMARY_PROMPT},
            {"role": "user", "content": content},
        ],
    )
    profile.profile_summary = resp.choices[0].message.content.strip()
    profile.updated_at = datetime.utcnow()
    session.add(profile)
    session.commit()
    STAGE_CACHE.clear()
    _sync_stage_profile(session, user_id)
    return {"summary": profile.profile_summary}


@app.post("/analyze-text", response_model=TextAnalysisResponse)
def analyze_text(payload: TextAnalysisRequest, session: Session = Depends(get_session)):
    pipeline_result = _run_stage_pipeline(session, payload.user_id, payload.text)
    spoken_answer = (
        pipeline_result.get("theni_tamil_text")
        or pipeline_result.get("tamil_text")
        or pipeline_result.get("remodeled_english")
        or payload.text
    )
    meta = _metadata_for_item(session, payload.user_id, payload.text, spoken_answer)

    item = Item(
        intent=str(meta.get("intent", "other")).lower(),
        category=normalize_category(str(meta.get("category", "Other"))),
        raw_text=payload.text,
        transcript=None,
        datetime_str=meta.get("datetime"),
        title=meta.get("title") or payload.text[:60],
        details=spoken_answer,
        source="text",
        user_id=payload.user_id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    session.add(item)
    session.commit()
    session.refresh(item)

    log_conversation(
        session,
        payload.user_id,
        "text",
        payload.text,
        None,
        {"pipeline": _normalized_pipeline_result(pipeline_result), "meta": meta},
    )
    upsert_qa_cache(
        session,
        payload.user_id,
        payload.text,
        {"pipeline": _normalized_pipeline_result(pipeline_result), "meta": meta},
    )
    return item_to_response(item)


@app.post("/transcribe-and-analyze", response_model=TextAnalysisResponse)
async def transcribe_and_analyze(
    user_id: Optional[int] = None,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    suffix = os.path.splitext(file.filename)[-1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        with open(tmp_path, "rb") as audio_file:
            transcript_obj = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="json",
                language="ta",
            )
        transcript_text = transcript_obj.text

        pipeline_result = _run_stage_pipeline(session, user_id, transcript_text)
        spoken_answer = (
            pipeline_result.get("theni_tamil_text")
            or pipeline_result.get("tamil_text")
            or pipeline_result.get("remodeled_english")
            or transcript_text
        )
        meta = _metadata_for_item(session, user_id, transcript_text, spoken_answer)

        item = Item(
            intent=str(meta.get("intent", "other")).lower(),
            category=normalize_category(str(meta.get("category", "Other"))),
            raw_text=transcript_text,
            transcript=transcript_text,
            datetime_str=meta.get("datetime"),
            title=meta.get("title") or transcript_text[:60],
            details=spoken_answer,
            source="voice",
            user_id=user_id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        session.add(item)
        session.commit()
        session.refresh(item)

        log_conversation(
            session,
            user_id,
            "voice",
            transcript_text,
            transcript_text,
            {"pipeline": _normalized_pipeline_result(pipeline_result), "meta": meta},
        )
        upsert_qa_cache(
            session,
            user_id,
            transcript_text,
            {"pipeline": _normalized_pipeline_result(pipeline_result), "meta": meta},
        )
        return item_to_response(item)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


@app.get("/items", response_model=List[TextAnalysisResponse])
def list_items(session: Session = Depends(get_session), user_id: Optional[int] = None):
    query = select(Item).order_by(Item.created_at.desc())
    if user_id is not None:
        query = query.where(Item.user_id == user_id)
    items = session.exec(query).all()
    return [item_to_response(i) for i in items]


@app.get("/items/{item_id}", response_model=TextAnalysisResponse)
def get_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return item_to_response(item)


DOCS_BASE_DIR = "generated_docs"
PDF_BASE_DIR = os.path.join(DOCS_BASE_DIR, "pdf")
EXCEL_BASE_DIR = os.path.join(DOCS_BASE_DIR, "excel")
PPT_BASE_DIR = os.path.join(DOCS_BASE_DIR, "ppt")
DOCX_BASE_DIR = os.path.join(DOCS_BASE_DIR, "docx")


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)


def generate_docx(item: Item) -> str:
    from docx import Document

    ensure_dir(DOCX_BASE_DIR)
    cat = os.path.join(DOCX_BASE_DIR, item.category or "Other")
    ensure_dir(cat)
    path = os.path.join(cat, f"item_{item.id}.docx")
    doc = Document()
    doc.add_heading(item.title or f"Item {item.id}", level=1)
    doc.add_paragraph(f"Intent: {item.intent}")
    doc.add_paragraph(f"Category: {item.category}")
    if item.datetime_str:
        doc.add_paragraph(f"When: {item.datetime_str}")
    doc.add_paragraph(item.details or item.raw_text)
    doc.save(path)
    return path


def generate_pdf(item: Item) -> str:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    ensure_dir(PDF_BASE_DIR)
    cat = os.path.join(PDF_BASE_DIR, item.category or "Other")
    ensure_dir(cat)
    path = os.path.join(cat, f"item_{item.id}.pdf")
    c = canvas.Canvas(path, pagesize=A4)
    _, h = A4
    y = h - 50
    c.setFont("Helvetica-Bold", 16)
    c.drawString(50, y, item.title or f"Item {item.id}")
    y -= 30
    c.setFont("Helvetica", 12)
    c.drawString(50, y, f"Intent: {item.intent}")
    y -= 18
    c.drawString(50, y, f"Category: {item.category}")
    y -= 18
    if item.datetime_str:
        c.drawString(50, y, f"When: {item.datetime_str}")
        y -= 18
    y -= 10
    for line in (item.details or item.raw_text).split("\n"):
        if y < 60:
            c.showPage()
            y = h - 50
        c.drawString(50, y, line[:120])
        y -= 16
    c.save()
    return path


def generate_excel(item: Item) -> str:
    from openpyxl import Workbook

    ensure_dir(EXCEL_BASE_DIR)
    cat = os.path.join(EXCEL_BASE_DIR, item.category or "Other")
    ensure_dir(cat)
    path = os.path.join(cat, f"item_{item.id}.xlsx")
    wb = Workbook()
    ws = wb.active
    ws["A1"] = "Title"
    ws["B1"] = item.title or ""
    ws["A2"] = "Intent"
    ws["B2"] = item.intent
    ws["A3"] = "Category"
    ws["B3"] = item.category
    ws["A4"] = "When"
    ws["B4"] = item.datetime_str or ""
    ws["A5"] = "Details"
    ws["B5"] = item.details or item.raw_text
    wb.save(path)
    return path


def generate_ppt(item: Item) -> str:
    from pptx import Presentation

    ensure_dir(PPT_BASE_DIR)
    cat = os.path.join(PPT_BASE_DIR, item.category or "Other")
    ensure_dir(cat)
    path = os.path.join(cat, f"item_{item.id}.pptx")
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = item.title or f"Item {item.id}"
    tf = slide.placeholders[1].text_frame
    tf.text = f"Intent: {item.intent}\nCategory: {item.category}"
    if item.datetime_str:
        tf.add_paragraph().text = f"When: {item.datetime_str}"
    tf.add_paragraph().text = item.details or item.raw_text
    prs.save(path)
    return path


@app.post("/items/{item_id}/generate-pdf")
def gen_pdf(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return {"item_id": item_id, "pdf_path": generate_pdf(item)}


@app.post("/items/{item_id}/generate-excel")
def gen_excel(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return {"item_id": item_id, "excel_path": generate_excel(item)}


@app.post("/items/{item_id}/generate-ppt")
def gen_ppt(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return {"item_id": item_id, "ppt_path": generate_ppt(item)}


@app.post("/items/{item_id}/generate-docx")
def gen_docx(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return {"item_id": item_id, "docx_path": generate_docx(item)}


@app.get("/files/pdf/{category}/{filename}")
def download_pdf(category: str, filename: str):
    path = os.path.join(PDF_BASE_DIR, category, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="application/pdf", filename=filename)


@app.get("/files/excel/{category}/{filename}")
def download_excel(category: str, filename: str):
    path = os.path.join(EXCEL_BASE_DIR, category, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "File not found")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=filename,
    )


@app.get("/files/ppt/{category}/{filename}")
def download_ppt(category: str, filename: str):
    path = os.path.join(PPT_BASE_DIR, category, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "File not found")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        filename=filename,
    )


@app.get("/files/docx/{category}/{filename}")
def download_docx(category: str, filename: str):
    path = os.path.join(DOCX_BASE_DIR, category, filename)
    if not os.path.exists(path):
        raise HTTPException(404, "File not found")
    return FileResponse(
        path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=filename,
    )


@app.get("/conversations")
def list_conversations(user_id: Optional[int] = None, limit: int = 50, session: Session = Depends(get_session)):
    query = select(Conversation).order_by(Conversation.created_at.desc()).limit(limit)
    if user_id is not None:
        query = query.where(Conversation.user_id == user_id)
    return session.exec(query).all()


@app.get("/qa/search")
def qa_search(q: str, user_id: Optional[int] = None, session: Session = Depends(get_session)):
    rows = session.exec(select(QACache).order_by(QACache.updated_at.desc()).limit(200)).all()
    ql = q.lower()
    out = []
    for row in rows:
        if user_id is not None and row.user_id != user_id:
            continue
        if ql in (row.question or "").lower() or ql in (row.answer or "").lower():
            out.append(row)
        if len(out) >= 10:
            break
    return out