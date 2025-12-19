from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from dotenv import load_dotenv
import os
from openai import OpenAI
import tempfile
import json
from datetime import datetime, date
from sqlmodel import select, Session
from sqlalchemy import text as sql_text

from .database import get_session
from .models import Item, User, Questionnaire, Conversation, QACache

from docx import Document
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from openpyxl import Workbook
from pptx import Presentation

load_dotenv()

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

# ---------- Logging middleware (Render logs + request body sample) ----------
@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = datetime.utcnow()
    body_text = ""
    try:
        b = await request.body()
        if b:
            body_text = b.decode("utf-8", errors="ignore")[:2000]
    except Exception:
        pass

    response = await call_next(request)
    ms = int((datetime.utcnow() - start).total_seconds() * 1000)
    print(f"[REQ] {request.method} {request.url.path} {response.status_code} {ms}ms body={body_text[:400]}")
    return response

@app.on_event("startup")
def on_startup():
    print("🚀 Tamil Voice AI backend starting (Postgres + Alembic)")

@app.get("/")
def root():
    return {"ok": True, "message": "Tamil Voice AI backend. Use /health"}

@app.get("/health")
def health():
    return {"status": "ok", "message": "Tamil Voice AI backend is running 🚀"}

# ---------- Parse datetime ----------
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

class ParseDatetimeRequest(BaseModel):
    text: str
    timezone: str = "Asia/Kolkata"
    now_iso: Optional[str] = None

@app.post("/parse-datetime")
def parse_datetime(payload: ParseDatetimeRequest):
    now_iso = payload.now_iso or datetime.utcnow().isoformat()
    user_content = json.dumps(
        {"timezone": payload.timezone, "now": now_iso, "text": payload.text},
        ensure_ascii=False,
    )
    out = llm_json(PARSE_DT_PROMPT, user_content, temperature=0.0)
    return {
        "iso": out.get("iso"),
        "human": out.get("human") or "",
        "confidence": float(out.get("confidence") or 0.0),
    }

# ---------- Schemas ----------
class TextAnalysisRequest(BaseModel):
    text: str
    user_id: Optional[int] = None
    meta: Optional[Dict[str, Any]] = None

class TextAnalysisResponse(BaseModel):
    id: int
    intent: str
    category: str
    raw_text: str
    transcript: Optional[str] = None
    datetime: Optional[str] = None
    title: Optional[str] = None
    details: Optional[str] = None

class SearchRequest(BaseModel):
    query: str
    user_id: Optional[int] = None

class SearchResponse(BaseModel):
    items: list[TextAnalysisResponse]
    transcript: Optional[str] = None

class UserCreate(BaseModel):
    name: str
    place: Optional[str] = None
    timezone: Optional[str] = "Asia/Kolkata"
    assistant_name: Optional[str] = "Ellie"

class QuestionnaireIn(BaseModel):
    payload: Dict[str, Any]

# ---------- LLM prompts ----------
SYSTEM_PROMPT = """
You are an AI that reads Tamil and mixed Tamil-English (Tanglish) commands from users.

Return ONLY JSON:
{
  "intent": "reminder|note|task|document|other",
  "category": "Work|Home|Business|Other",
  "datetime": "... or null",
  "title": "...",
  "details": "..."
}
"""

SEARCH_SYSTEM_PROMPT = """
You are an AI assistant that searches through saved items.
Return ONLY JSON: {"ids":[...]}
"""

CHECKIN_PROMPT = """
You are a daily routine assistant. You will receive:
- user profile (name, place, timezone, assistant name)
- questionnaire answers (JSON)

Create 3-8 check-ins for today.
Each check-in:
- title
- when (HH:MM 24h)
- message (address user by name)

Return ONLY JSON:
{ "checkins": [ { "title":"...", "when":"08:00", "message":"..." } ] }
"""

# ---------- Helpers ----------
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
    if cr == "work": return "Work"
    if cr == "home": return "Home"
    if cr == "business": return "Business"
    return "Other"

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

def log_conversation(session: Session, user_id: Optional[int], channel: str, user_input: str, transcript: Optional[str], llm_json_out: Optional[dict]):
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
    """
    Avoid inserting duplicates forever.
    Very simple: if exact question exists for user -> increment hits + update answer.
    """
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

    session.add(QACache(
        user_id=user_id,
        question=question,
        answer=json.dumps(answer_json, ensure_ascii=False),
        hits=1,
        updated_at=datetime.utcnow(),
    ))
    session.commit()

# ---------- Users ----------
@app.post("/users")
def create_user(payload: UserCreate, session: Session = Depends(get_session)):
    u = User(
        name=payload.name,
        place=payload.place,
        timezone=payload.timezone,
        assistant_name=payload.assistant_name or "Ellie",
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u

@app.get("/users/{user_id}")
def get_user(user_id: int, session: Session = Depends(get_session)):
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    return u

@app.post("/users/{user_id}/questionnaire")
def save_questionnaire(user_id: int, payload: QuestionnaireIn, session: Session = Depends(get_session)):
    q = session.exec(
        select(Questionnaire)
        .where(Questionnaire.user_id == user_id)
        .order_by(Questionnaire.created_at.desc())
    ).first()

    if q:
        q.payload_json = json.dumps(payload.payload, ensure_ascii=False)
    else:
        q = Questionnaire(
            user_id=user_id,
            payload_json=json.dumps(payload.payload, ensure_ascii=False),
        )
        session.add(q)

    session.commit()
    return {"ok": True}


@app.post("/users/{user_id}/generate-daily-checkins")
def generate_daily_checkins(user_id: int, session: Session = Depends(get_session)):
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")

    q = session.exec(
        select(Questionnaire)
        .where(Questionnaire.user_id == user_id)
        .order_by(Questionnaire.created_at.desc())
    ).first()
    if not q:
        raise HTTPException(400, "No questionnaire found")

    q_json = json.loads(q.payload_json)

    user_content = json.dumps({
        "profile": {
            "name": u.name,
            "place": u.place,
            "timezone": u.timezone,
            "assistant_name": u.assistant_name
        },
        "questionnaire": q_json,
        "today": str(date.today()),
    }, ensure_ascii=False)

    out = llm_json(CHECKIN_PROMPT, user_content, temperature=0.2)
    log_conversation(session, user_id, "system", "generate-daily-checkins", None, out)
    return {"checkins": out.get("checkins", [])}

@app.get("/conversations")
def list_conversations(user_id: Optional[int] = None, limit: int = 50, session: Session = Depends(get_session)):
    q = select(Conversation).order_by(Conversation.created_at.desc()).limit(limit)
    if user_id:
        q = q.where(Conversation.user_id == user_id)
    return session.exec(q).all()

# ---------- Analyze Text ----------
@app.post("/analyze-text", response_model=TextAnalysisResponse)
def analyze_text(payload: TextAnalysisRequest, session: Session = Depends(get_session)):
    data = llm_json(SYSTEM_PROMPT, payload.text, temperature=0.2)

    intent = str(data.get("intent", "other")).lower()
    category = normalize_category(str(data.get("category", "Other")))

    item = Item(
        intent=intent,
        category=category,
        raw_text=payload.text,
        transcript=None,
        datetime_str=data.get("datetime"),
        title=data.get("title"),
        details=data.get("details"),
        source="text",
        user_id=payload.user_id,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )

    session.add(item)
    session.commit()
    session.refresh(item)

    log_conversation(session, payload.user_id, "text", payload.text, None, data)
    upsert_qa_cache(session, payload.user_id, payload.text, data)

    return item_to_response(item)

# ---------- Voice ----------
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

        data = llm_json(SYSTEM_PROMPT, transcript_text, temperature=0.2)
        intent = str(data.get("intent", "other")).lower()
        category = normalize_category(str(data.get("category", "Other")))

        item = Item(
            intent=intent,
            category=category,
            raw_text=transcript_text,
            transcript=transcript_text,
            datetime_str=data.get("datetime"),
            title=data.get("title"),
            details=data.get("details"),
            source="voice",
            user_id=user_id,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

        session.add(item)
        session.commit()
        session.refresh(item)

        log_conversation(session, user_id, "voice", transcript_text, transcript_text, data)
        upsert_qa_cache(session, user_id, transcript_text, data)

        return item_to_response(item)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

# ---------- Items ----------
@app.get("/items", response_model=List[TextAnalysisResponse])
def list_items(session: Session = Depends(get_session), user_id: Optional[int] = None):
    q = select(Item).order_by(Item.created_at.desc())
    if user_id is not None:
        # Safe even if migration didn't run for some reason:
        try:
            q = q.where(Item.user_id == user_id)
        except Exception:
            pass
    items = session.exec(q).all()
    return [item_to_response(i) for i in items]

@app.get("/items/{item_id}", response_model=TextAnalysisResponse)
def get_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return item_to_response(item)

# ---------- Document generation (server) ----------
DOCS_BASE_DIR = "generated_docs"
PDF_BASE_DIR = os.path.join(DOCS_BASE_DIR, "pdf")
EXCEL_BASE_DIR = os.path.join(DOCS_BASE_DIR, "excel")
PPT_BASE_DIR = os.path.join(DOCS_BASE_DIR, "ppt")
DOCX_BASE_DIR = os.path.join(DOCS_BASE_DIR, "docx")

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)

def generate_docx(item: Item) -> str:
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
    ensure_dir(PDF_BASE_DIR)
    cat = os.path.join(PDF_BASE_DIR, item.category or "Other")
    ensure_dir(cat)
    path = os.path.join(cat, f"item_{item.id}.pdf")
    c = canvas.Canvas(path, pagesize=A4)
    w, h = A4
    y = h - 50
    c.setFont("Helvetica-Bold", 16)
    c.drawString(50, y, item.title or f"Item {item.id}")
    y -= 30
    c.setFont("Helvetica", 12)
    c.drawString(50, y, f"Intent: {item.intent}"); y -= 18
    c.drawString(50, y, f"Category: {item.category}"); y -= 18
    if item.datetime_str:
        c.drawString(50, y, f"When: {item.datetime_str}"); y -= 18
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
    ensure_dir(EXCEL_BASE_DIR)
    cat = os.path.join(EXCEL_BASE_DIR, item.category or "Other")
    ensure_dir(cat)
    path = os.path.join(cat, f"item_{item.id}.xlsx")
    wb = Workbook()
    ws = wb.active
    ws["A1"] = "Title"; ws["B1"] = item.title or ""
    ws["A2"] = "Intent"; ws["B2"] = item.intent
    ws["A3"] = "Category"; ws["B3"] = item.category
    ws["A4"] = "When"; ws["B4"] = item.datetime_str or ""
    ws["A5"] = "Details"; ws["B5"] = item.details or item.raw_text
    wb.save(path)
    return path

def generate_ppt(item: Item) -> str:
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
    path = generate_pdf(item)
    return {"item_id": item_id, "pdf_path": path}

@app.post("/items/{item_id}/generate-excel")
def gen_excel(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    path = generate_excel(item)
    return {"item_id": item_id, "excel_path": path}

@app.post("/items/{item_id}/generate-ppt")
def gen_ppt(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    path = generate_ppt(item)
    return {"item_id": item_id, "ppt_path": path}

@app.post("/items/{item_id}/generate-docx")
def gen_docx(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    path = generate_docx(item)
    return {"item_id": item_id, "docx_path": path}

# ---------- Download endpoints ----------
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

# ---------- QA Cache endpoints ----------
@app.get("/qa/search")
def qa_search(q: str, user_id: Optional[int] = None, session: Session = Depends(get_session)):
    rows = session.exec(select(QACache).order_by(QACache.updated_at.desc()).limit(200)).all()
    ql = q.lower()
    out = []
    for r in rows:
        if user_id is not None and r.user_id != user_id:
            continue
        if ql in (r.question or "").lower() or ql in (r.answer or "").lower():
            out.append(r)
        if len(out) >= 10:
            break
    return out
