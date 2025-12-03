from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv
import os
from openai import OpenAI
import tempfile

# Load env vars (OPENAI_API_KEY, etc.)
load_dotenv()

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))


class TextAnalysisRequest(BaseModel):
    text: str


class TextAnalysisResponse(BaseModel):
    intent: str
    category: str
    raw_text: str
    transcript: Optional[str] = None  # for voice endpoint


app = FastAPI(title="Tamil Voice AI Backend")

# --- CORS (allow frontend to call this API) ---
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


# --- Very simple rule-based classifier (placeholder for LLM) ---
def detect_intent(text: str) -> str:
    t = text.lower()
    # Expand with more Tamil patterns later
    if "remind" in t or "reminder" in t or "நினைவூட்டு" in t:
        return "reminder"
    if "note" in t or "குறிப்பு" in t:
        return "note"
    if "task" in t or "செய்யணும்" in t:
        return "task"
    if "pdf" in t or "word" in t or "excel" in t or "ppt" in t:
        return "document"
    return "note"  # default


def detect_category(text: str) -> str:
    t = text.lower()
    # Very naive keyword based – we will replace with LLM later
    work_keywords = ["office", "meeting", "project", "client"]
    home_keywords = ["home", "veedu", "சொந்த வீடு", "family", "amma", "appa"]
    business_keywords = ["business", "customer", "lead", "invoice", "bill"]

    if any(k in t for k in work_keywords):
        return "Work"
    if any(k in t for k in home_keywords):
        return "Home"
    if any(k in t for k in business_keywords):
        return "Business"
    return "Home"  # safe-ish default


@app.post("/analyze-text", response_model=TextAnalysisResponse)
def analyze_text(payload: TextAnalysisRequest):
    intent = detect_intent(payload.text)
    category = detect_category(payload.text)

    return TextAnalysisResponse(
        intent=intent,
        category=category,
        raw_text=payload.text,
    )


@app.post("/transcribe-and-analyze", response_model=TextAnalysisResponse)
async def transcribe_and_analyze(file: UploadFile = File(...)):
    """
    1. Receive audio file (Tamil speech)
    2. Send to Whisper for transcription
    3. Run our detect_intent / detect_category on the transcript
    """
    # Save uploaded file to a temp file for the OpenAI client
    suffix = os.path.splitext(file.filename)[-1] or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        # Call Whisper transcription (Tamil is supported)
        with open(tmp_path, "rb") as audio_file:
            transcript_obj = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="json",
                language="ta",  # Tamil
            )

        transcript_text = transcript_obj.text

        intent = detect_intent(transcript_text)
        category = detect_category(transcript_text)

        return TextAnalysisResponse(
            intent=intent,
            category=category,
            raw_text=transcript_text,
            transcript=transcript_text,
        )
    finally:
        # Clean up temp file
        try:
            os.remove(tmp_path)
        except OSError:
            pass
