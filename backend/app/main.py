from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv
import os
from openai import OpenAI
import tempfile
import json

# Load environment variables
load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set in .env")

client = OpenAI(api_key=OPENAI_API_KEY)


class TextAnalysisRequest(BaseModel):
    text: str


class TextAnalysisResponse(BaseModel):
    intent: str              # reminder | note | task | document | other
    category: str            # Work | Home | Business | Other
    raw_text: str            # original text / transcript
    transcript: Optional[str] = None  # populated only for voice endpoint
    datetime: Optional[str] = None    # ISO-ish datetime string or natural text
    title: Optional[str] = None       # short title/summary
    details: Optional[str] = None     # extra description


app = FastAPI(title="Tamil Voice AI Backend")

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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

        # Basic safety defaults
        intent = data.get("intent", "other")
        category = data.get("category", "Other")
        datetime_str = data.get("datetime")
        title = data.get("title")
        details = data.get("details")

        # Normalize capitalization a bit
        intent = intent.lower()
        if category.lower() == "work":
            category = "Work"
        elif category.lower() == "home":
            category = "Home"
        elif category.lower() == "business":
            category = "Business"
        else:
            category = "Other"

        return {
            "intent": intent,
            "category": category,
            "datetime": datetime_str,
            "title": title,
            "details": details,
        }
    except Exception as e:
        # In production you'd log this properly
        print("Error in llm_classify:", e)
        raise HTTPException(status_code=500, detail="LLM classification failed")


# --- Text endpoint using LLM ---

@app.post("/analyze-text", response_model=TextAnalysisResponse)
def analyze_text(payload: TextAnalysisRequest):
    classification = llm_classify(payload.text)

    return TextAnalysisResponse(
        intent=classification["intent"],
        category=classification["category"],
        raw_text=payload.text,
        datetime=classification.get("datetime"),
        title=classification.get("title"),
        details=classification.get("details"),
    )


# --- Voice: Whisper + LLM ---

@app.post("/transcribe-and-analyze", response_model=TextAnalysisResponse)
async def transcribe_and_analyze(file: UploadFile = File(...)):
    """
    1. Receive audio file (Tamil speech)
    2. Send to Whisper for transcription
    3. Send transcript to LLM for classification
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

        return TextAnalysisResponse(
            intent=classification["intent"],
            category=classification["category"],
            raw_text=transcript_text,
            transcript=transcript_text,
            datetime=classification.get("datetime"),
            title=classification.get("title"),
            details=classification.get("details"),
        )
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass
