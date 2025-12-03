from fastapi import FastAPI, UploadFile, File, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
from dotenv import load_dotenv
import os
from openai import OpenAI
import tempfile
import json
from datetime import datetime
from sqlmodel import select, Session
from .database import create_db_and_tables, get_session
from .models import Item

# Load environment variables
load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set in .env")

client = OpenAI(api_key=OPENAI_API_KEY)


class TextAnalysisRequest(BaseModel):
    text: str


class TextAnalysisResponse(BaseModel):
    id: int
    intent: str              # reminder | note | task | document | other
    category: str            # Work | Home | Business | Other
    raw_text: str            # original text / transcript
    transcript: Optional[str] = None
    datetime: Optional[str] = None
    title: Optional[str] = None
    details: Optional[str] = None


app = FastAPI(title="Tamil Voice AI Backend")

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    create_db_and_tables()


@app.get("/health")
def health_check():
    return {"status": "ok", "message": "Tamil Voice AI backend is running 🚀"}


# --- LLM classification helper ---

SYSTEM_PROMPT = """
You are an AI that reads Tamil and mixed Tamil-English (Tanglish) commands from users.

Your job:
1. Understand what the user wants.
2. Classify the message into:
   - intent: one of ["reminder", "note", "task", "document", "other"]
   - category: one of ["Work", "Home", "Business", "Other"]
3. Extract:
   - datetime: when it should happen (if any). Use either an ISO-like string
     (e.g. "2025-02-12 08:00") or a natural description (e.g. "tomorrow 8am").
   - title: a short 3-10 word title for this item.
   - details: a slightly longer description (1–2 sentences).

Rules:
- If it's clearly about office, job, meetings, projects → category: "Work".
- If it's about personal life, house, family, bills, shopping → "Home".
- If it's about business, shop, customers, leads, invoices → "Business".
- If you are unsure → category: "Other" and intent: "other".

Output:
Return ONLY JSON with this exact structure, no extra text:

{
  "intent": "...",
  "category": "...",
  "datetime": "... or null",
  "title": "...",
  "details": "..."
}
"""


def llm_classify(text: str) -> dict:
    """
    Send Tamil / Tanglish text to the LLM and get structured JSON back.
    """
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            temperature=0.2,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
        )
        content = response.choices[0].message.content
        data = json.loads(content)

        intent = str(data.get("intent", "other")).lower()
        category_raw = str(data.get("category", "Other"))

        # Normalize category
        cr = category_raw.lower()
        if cr == "work":
            category = "Work"
        elif cr == "home":
            category = "Home"
        elif cr == "business":
            category = "Business"
            # else:
        else:
            category = "Other"

        return {
            "intent": intent,
            "category": category,
            "datetime": data.get("datetime"),
            "title": data.get("title"),
            "details": data.get("details"),
        }
    except Exception as e:
        print("Error in llm_classify:", e)
        raise HTTPException(status_code=500, detail="LLM classification failed")


def create_item_in_db(
    session: Session,
    classification: dict,
    raw_text: str,
    source: str,
    transcript: Optional[str] = None,
) -> Item:
    now = datetime.utcnow()
    item = Item(
        intent=classification["intent"],
        category=classification["category"],
        raw_text=raw_text,
        transcript=transcript,
        datetime_str=classification.get("datetime"),
        title=classification.get("title"),
        details=classification.get("details"),
        source=source,
        created_at=now,
        updated_at=now,
    )
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


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


# --- Text endpoint using LLM + DB ---

@app.post("/analyze-text", response_model=TextAnalysisResponse)
def analyze_text(
    payload: TextAnalysisRequest,
    session: Session = Depends(get_session),
):
    classification = llm_classify(payload.text)
    item = create_item_in_db(
        session=session,
        classification=classification,
        raw_text=payload.text,
        source="text",
        transcript=None,
    )
    return item_to_response(item)


# --- Voice: Whisper + LLM + DB ---

@app.post("/transcribe-and-analyze", response_model=TextAnalysisResponse)
async def transcribe_and_analyze(
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    """
    1. Receive audio file (Tamil speech)
    2. Send to Whisper for transcription
    3. Send transcript to LLM for classification
    4. Save in DB
    """
    suffix = os.path.splitext(file.filename)[-1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Whisper transcription
        with open(tmp_path, "rb") as audio_file:
            transcript_obj = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="json",
                language="ta",  # Tamil
            )

        transcript_text = transcript_obj.text

        # LLM classification on transcript
        classification = llm_classify(transcript_text)

        item = create_item_in_db(
            session=session,
            classification=classification,
            raw_text=transcript_text,
            source="voice",
            transcript=transcript_text,
        )

        return item_to_response(item)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


# --- List & get items (retrieval v1) ---

@app.get("/items", response_model=List[TextAnalysisResponse])
def list_items(
    session: Session = Depends(get_session),
    category: Optional[str] = None,
    intent: Optional[str] = None,
):
    query = select(Item)

    if category:
        query = query.where(Item.category == category)
    if intent:
        query = query.where(Item.intent == intent)

    items = session.exec(query.order_by(Item.created_at.desc())).all()
    return [item_to_response(i) for i in items]


@app.get("/items/{item_id}", response_model=TextAnalysisResponse)
def get_item(
    item_id: int,
    session: Session = Depends(get_session),
):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item_to_response(item)


# --- Document generation: Word (.docx) ---

from docx import Document  # type: ignore


DOCS_BASE_DIR = "generated_docs"


def generate_docx_for_item(item: Item) -> str:
    """
    Create a Word document for an item and return the file path.
    """
    os.makedirs(DOCS_BASE_DIR, exist_ok=True)
    # folder by category
    category_folder = os.path.join(DOCS_BASE_DIR, item.category or "Other")
    os.makedirs(category_folder, exist_ok=True)

    safe_title = item.title or f"{item.intent.capitalize()} Item {item.id}"
    # Make a simple safe filename
    filename = f"item_{item.id}.docx"
    path = os.path.join(category_folder, filename)

    doc = Document()
    doc.add_heading(safe_title, level=1)

    if item.datetime_str:
        doc.add_paragraph(f"When: {item.datetime_str}")
    doc.add_paragraph(f"Category: {item.category}")
    doc.add_paragraph(f"Intent: {item.intent}")
    doc.add_paragraph("")

    if item.details:
        doc.add_paragraph(item.details)
    else:
        doc.add_paragraph(item.raw_text)

    doc.save(path)
    return path


@app.post("/items/{item_id}/generate-docx")
def generate_docx_endpoint(
    item_id: int,
    session: Session = Depends(get_session),
):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    path = generate_docx_for_item(item)
    return {
        "item_id": item_id,
        "docx_path": path,
        "category": item.category,
    }
