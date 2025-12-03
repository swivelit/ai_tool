from fastapi import FastAPI
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware


class TextAnalysisRequest(BaseModel):
    text: str


class TextAnalysisResponse(BaseModel):
    intent: str
    category: str
    raw_text: str


app = FastAPI(title="Tamil Voice AI Backend")

# --- CORS (allow frontend to call this API) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # in production, restrict this
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
    # You can expand this with more Tamil patterns later
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
