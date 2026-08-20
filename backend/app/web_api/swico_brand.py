from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import os
import re
from typing import Mapping

from ..ai.language import localized_web_deterministic_text, resolve_web_reply_language


SWICO_PUBLIC_PROFILE_VERSION = "2026-07-v1"


class SwicoBrandSubintent(str, Enum):
    PUBLIC_PROFILE = "public_profile"
    IDENTITY = "identity"
    ABOUT = "about"
    CREATOR = "creator"
    LEADERSHIP = "leadership"
    COMPANY = "company"
    OWNERSHIP_UNKNOWN = "ownership_unknown"
    PURPOSE = "purpose"
    CAPABILITIES = "capabilities"
    VOICE = "voice"
    TEXT = "text"
    MULTILINGUAL = "multilingual"
    DOCUMENTS = "documents"
    CONTEXT = "context"
    ARCHITECTURE = "architecture"
    AGENTS = "agents"
    TOKEN_EFFICIENCY = "token_efficiency"
    TECHNOLOGY = "technology"
    MODEL_OR_PROVIDER = "model_or_provider"
    BILLING = "billing"
    CREDITS = "credits"
    USAGE_TRACKING = "usage_tracking"
    SECURITY = "security"
    PRIVACY = "privacy"
    SCALABILITY = "scalability"
    UPDATES = "updates"
    COMPARISON = "comparison"
    GENERAL = "general"


@dataclass(frozen=True)
class SwicoPublicProfile:
    identity: str
    company: str
    creator_leadership: str
    purpose: str
    interactions: tuple[str, ...]
    capabilities: tuple[str, ...]
    architecture: tuple[str, ...]
    billing: tuple[str, ...]
    principles: tuple[str, ...]


@dataclass(frozen=True)
class SwicoBrandMatch:
    subintent: SwicoBrandSubintent
    contextual: bool = False


# Canonical structured source for the approved public facts. Public responses
# below deliberately select only the facts relevant to the detected sub-intent.
SWICO_PUBLIC_PROFILE = SwicoPublicProfile(
    identity="Swico is an AI-powered assistant and the flagship product of Swivel Technologies.",
    company="Swico is developed by Swivel Technologies.",
    creator_leadership=(
        "Swico was envisioned and created under the leadership of CEO Jeyanth."
    ),
    purpose=(
        "Swico makes advanced artificial intelligence practical, trustworthy, accessible, "
        "and affordable for individuals and businesses."
    ),
    interactions=(
        "natural voice and text conversations",
        "multilingual communication",
        "conversational context over time",
    ),
    capabilities=(
        "question answering and detailed explanations",
        "content generation and summarisation",
        "document and supported-file analysis",
        "planning, research, learning, organisation, and everyday problem-solving",
    ),
    architecture=(
        "advanced large language models with intelligent routing",
        "an agent-based architecture",
        "selective context that minimises unnecessary token usage",
        "secure authentication, cloud infrastructure, and modern web technologies",
    ),
    billing=(
        "wallet-based AI usage credits",
        "transparent usage tracking",
    ),
    principles=(
        "security, privacy, and responsible AI",
        "scalability and reliability",
        "regular capability and quality updates",
    ),
)


_ENGLISH_RESPONSES: Mapping[SwicoBrandSubintent, str] = {
    SwicoBrandSubintent.PUBLIC_PROFILE: (
        "Swico is the flagship AI assistant developed by Swivel Technologies. "
        "It was envisioned and created under the leadership of CEO Jeyanth."
    ),
    SwicoBrandSubintent.IDENTITY: "I’m Swico, an AI-powered assistant developed by Swivel Technologies.",
    SwicoBrandSubintent.ABOUT: (
        "Swico is an AI-powered personal assistant and the flagship product of Swivel Technologies. "
        "It supports natural voice and text conversations, multilingual assistance, contextual help, "
        "and document analysis."
    ),
    SwicoBrandSubintent.CREATOR: (
        "Swico was envisioned and created under the leadership of CEO Jeyanth and developed as the "
        "flagship AI product of Swivel Technologies."
    ),
    SwicoBrandSubintent.LEADERSHIP: (
        "Swico was envisioned and created under the leadership of CEO Jeyanth as the flagship AI "
        "product of Swivel Technologies."
    ),
    SwicoBrandSubintent.COMPANY: "Swico is a flagship AI product developed by Swivel Technologies.",
    SwicoBrandSubintent.OWNERSHIP_UNKNOWN: (
        "The approved public information identifies Swico as a flagship product of Swivel Technologies "
        "and says it was envisioned and created under CEO Jeyanth’s leadership. It does not provide a "
        "separate founder or legal ownership statement beyond that."
    ),
    SwicoBrandSubintent.PURPOSE: (
        "Swico aims to make advanced AI practical, trustworthy, accessible, and affordable, helping "
        "individuals and businesses learn, create, organise, research, and solve problems efficiently."
    ),
    SwicoBrandSubintent.CAPABILITIES: (
        "Swico supports voice and text conversations, multilingual assistance, document analysis, "
        "content generation, summarisation, explanations, planning, research, and everyday problem-solving."
    ),
    SwicoBrandSubintent.VOICE: (
        "Swico supports natural voice conversations and is designed to listen until the user finishes "
        "speaking before responding intelligently."
    ),
    SwicoBrandSubintent.TEXT: (
        "Swico supports natural text conversations for questions, writing, summaries, explanations, "
        "planning, research, and everyday assistance."
    ),
    SwicoBrandSubintent.MULTILINGUAL: (
        "Swico supports multilingual communication, including natural voice and text interaction in "
        "multiple languages."
    ),
    SwicoBrandSubintent.DOCUMENTS: (
        "Swico can analyse uploaded files and extract useful insights from documents and other supported formats."
    ),
    SwicoBrandSubintent.CONTEXT: (
        "Swico maintains conversational context to provide accurate, personalised, and meaningful assistance over time."
    ),
    SwicoBrandSubintent.ARCHITECTURE: (
        "Swico uses an agent-based architecture that selects relevant context, minimises unnecessary "
        "token usage, and routes requests efficiently for quality and cost."
    ),
    SwicoBrandSubintent.AGENTS: (
        "Swico uses an agent-based architecture to select relevant context, avoid unnecessary work, "
        "and route requests efficiently."
    ),
    SwicoBrandSubintent.TOKEN_EFFICIENCY: (
        "Swico reduces unnecessary token usage through an agent-based architecture, selective context, "
        "and intelligent request routing for efficient responses."
    ),
    SwicoBrandSubintent.TECHNOLOGY: (
        "Swico combines managed large language and speech models, intelligent routing, agent-based "
        "processing, contextual memory, secure authentication, cloud infrastructure, and modern web technologies."
    ),
    SwicoBrandSubintent.MODEL_OR_PROVIDER: (
        "Swico uses advanced large language models with intelligent routing to balance quality, speed, "
        "and cost. The assistant you interact with is Swico."
    ),
    SwicoBrandSubintent.BILLING: (
        "Swico uses wallet-based AI usage credits and provides usage tracking so users can understand "
        "and manage their available credits."
    ),
    SwicoBrandSubintent.CREDITS: (
        "Swico lets users purchase wallet-based AI usage credits and track their available credits transparently."
    ),
    SwicoBrandSubintent.USAGE_TRACKING: (
        "Swico provides transparent AI usage tracking so users can understand and manage their available credits."
    ),
    SwicoBrandSubintent.SECURITY: (
        "Swico integrates secure authentication and cloud infrastructure, with security, privacy, and "
        "responsible AI as fundamental development principles."
    ),
    SwicoBrandSubintent.PRIVACY: (
        "Privacy, security, and responsible AI are fundamental principles guiding Swico’s development."
    ),
    SwicoBrandSubintent.SCALABILITY: (
        "Swico is engineered for scalable cloud deployment and is intended to support large numbers of users reliably."
    ),
    SwicoBrandSubintent.UPDATES: (
        "Swico evolves through regular updates that introduce new capabilities and improve existing features."
    ),
    SwicoBrandSubintent.COMPARISON: (
        "Swico is designed as a practical and affordable personal assistant with voice and text interaction, "
        "multilingual support, document analysis, contextual assistance, and wallet-based usage tracking."
    ),
    SwicoBrandSubintent.GENERAL: (
        "Swico is the flagship AI assistant from Swivel Technologies, created under the leadership of CEO Jeyanth "
        "to make useful AI practical, accessible, and affordable."
    ),
}


_TAMIL_RESPONSES: Mapping[SwicoBrandSubintent, str] = {
    SwicoBrandSubintent.PUBLIC_PROFILE: (
        "Swico என்பது Swivel Technologies உருவாக்கிய முக்கிய AI உதவியாளர். "
        "அதன் உருவாக்கத்தை CEO Jeyanth வழிநடத்தினார்."
    ),
    SwicoBrandSubintent.IDENTITY: "நான் Swico — Swivel Technologies உருவாக்கிய AI உதவியாளர்.",
    SwicoBrandSubintent.CREATOR: (
        "CEO Jeyanth தலைமையில் Swico திட்டமிட்டு உருவாக்கப்பட்டது; இது Swivel Technologies-ன் முக்கிய AI தயாரிப்பு."
    ),
    SwicoBrandSubintent.LEADERSHIP: (
        "Swico உருவாக்கத்தை CEO Jeyanth வழிநடத்தினார்; இது Swivel Technologies-ன் முக்கிய AI தயாரிப்பு."
    ),
    SwicoBrandSubintent.COMPANY: "Swico, Swivel Technologies உருவாக்கிய முக்கிய AI தயாரிப்பு.",
    SwicoBrandSubintent.OWNERSHIP_UNKNOWN: (
        "அங்கீகரிக்கப்பட்ட தகவலில் Swico, Swivel Technologies-ன் முக்கிய தயாரிப்பு என்றும் CEO Jeyanth தலைமையில் "
        "திட்டமிட்டு உருவாக்கப்பட்டது என்றும் உள்ளது. இதைத் தாண்டி தனி நிறுவனர் அல்லது சட்டபூர்வ உரிமையாளர் தகவல் இல்லை."
    ),
    SwicoBrandSubintent.CAPABILITIES: (
        "Swico voice மற்றும் text உரையாடல், பல மொழி உதவி, document analysis, content உருவாக்கம், summary, "
        "விளக்கம், planning, research மற்றும் தினசரி problem-solving ஆகியவற்றில் உதவும்."
    ),
    SwicoBrandSubintent.MODEL_OR_PROVIDER: (
        "Swico தரம், வேகம், செலவு ஆகியவற்றை சமநிலைப்படுத்த advanced language models மற்றும் intelligent routing-ஐ "
        "பயன்படுத்துகிறது. நீங்கள் பேசும் உதவியாளர் Swico தான்."
    ),
    SwicoBrandSubintent.ARCHITECTURE: (
        "Swico agent-based architecture மூலம் தேவையான context-ஐ மட்டும் தேர்வு செய்து, தேவையற்ற token usage-ஐ "
        "குறைத்து, தரம் மற்றும் செலவுக்காக requests-ஐ திறமையாக route செய்கிறது."
    ),
    SwicoBrandSubintent.AGENTS: (
        "Swico agent-based architecture மூலம் தேவையான context-ஐ தேர்வு செய்து, தேவையற்ற வேலையைத் தவிர்த்து, "
        "requests-ஐ திறமையாக route செய்கிறது."
    ),
    SwicoBrandSubintent.TOKEN_EFFICIENCY: (
        "Swico agent-based architecture, selective context மற்றும் intelligent routing மூலம் தேவையற்ற token usage-ஐ குறைக்கிறது."
    ),
    SwicoBrandSubintent.MULTILINGUAL: "Swico பல மொழிகளில் இயல்பான voice மற்றும் text உரையாடலை ஆதரிக்கிறது.",
    SwicoBrandSubintent.DOCUMENTS: "Swico upload செய்த documents மற்றும் ஆதரிக்கப்படும் files-ஐ analyse செய்து பயனுள்ள தகவலை எடுக்க முடியும்.",
    SwicoBrandSubintent.VOICE: "Swico இயல்பான voice உரையாடலை ஆதரித்து, பயனர் பேசி முடித்த பின் பதிலளிக்க வடிவமைக்கப்பட்டுள்ளது.",
    SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits மற்றும் வெளிப்படையான usage tracking-ஐ வழங்குகிறது.",
    SwicoBrandSubintent.CREDITS: "Swico-வில் wallet-based AI usage credits வாங்கி, மீதமுள்ள credits-ஐ கண்காணிக்கலாம்.",
    SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking மூலம் பயன்படுத்திய அளவும் கிடைக்கும் credits-மும் தெளிவாக தெரியும்.",
    SwicoBrandSubintent.SECURITY: "Swico secure authentication மற்றும் cloud infrastructure-ஐ பயன்படுத்துகிறது; security, privacy, responsible AI முக்கிய கொள்கைகள்.",
    SwicoBrandSubintent.PRIVACY: "Privacy, security மற்றும் responsible AI ஆகியவை Swico உருவாக்கத்தின் அடிப்படை கொள்கைகள்.",
    SwicoBrandSubintent.CONTEXT: "Swico உரையாடல் context-ஐ பராமரித்து, காலப்போக்கில் பொருத்தமான மற்றும் தனிப்பயன் உதவியை வழங்குகிறது.",
    SwicoBrandSubintent.COMPARISON: "Swico voice, text, பல மொழி உதவி, document analysis, contextual assistance மற்றும் wallet usage tracking கொண்ட நடைமுறை personal assistant.",
    SwicoBrandSubintent.PURPOSE: "Swico AI-ஐ நடைமுறை, நம்பகமான, அனைவரும் அணுகக்கூடிய மற்றும் மலிவான உதவியாக மாற்றுவதை நோக்கமாகக் கொண்டுள்ளது.",
    SwicoBrandSubintent.TEXT: "Swico text மூலம் கேள்விகள், writing, summary, விளக்கம், planning மற்றும் research-க்கு உதவுகிறது.",
    SwicoBrandSubintent.TECHNOLOGY: "Swico language மற்றும் speech models, intelligent routing, agent-based processing, contextual memory, secure cloud technologies ஆகியவற்றை இணைக்கிறது.",
    SwicoBrandSubintent.SCALABILITY: "Swico நம்பகமாக அதிக பயனர்களை ஆதரிக்க scalable cloud deployment-க்காக வடிவமைக்கப்பட்டுள்ளது.",
    SwicoBrandSubintent.UPDATES: "Swico புதிய திறன்களையும் மேம்பாடுகளையும் வழங்கும் regular updates மூலம் தொடர்ந்து வளர்கிறது.",
    SwicoBrandSubintent.ABOUT: "Swico, Swivel Technologies உருவாக்கிய AI personal assistant; voice, text, பல மொழி உதவி, context மற்றும் document analysis-ஐ ஆதரிக்கிறது.",
    SwicoBrandSubintent.GENERAL: "Swico, CEO Jeyanth தலைமையில் உருவாக்கப்பட்ட Swivel Technologies-ன் முக்கிய AI உதவியாளர்.",
}

# Deterministic brand replies need the same distinction as provider prompts:
# Tanglish is Tamil expressed in Roman characters, not Tamil Unicode and not
# the Tamil-script response set.
_TANGLISH_RESPONSES: Mapping[SwicoBrandSubintent, str] = {
    SwicoBrandSubintent.PUBLIC_PROFILE: "Swico, Swivel Technologies uruvaakkiya mukkiya AI assistant. CEO Jeyanth athan uruvaakkathai lead panninaar.",
    SwicoBrandSubintent.IDENTITY: "Naan Swico — Swivel Technologies uruvaakkiya AI assistant.",
    SwicoBrandSubintent.CREATOR: "Swico-va CEO Jeyanth leadership-la plan panni uruvaakkinaanga; idhu Swivel Technologies-oda mukkiya AI product.",
    SwicoBrandSubintent.LEADERSHIP: "Swico uruvaakkathai CEO Jeyanth lead panninaar; idhu Swivel Technologies-oda mukkiya AI product.",
    SwicoBrandSubintent.COMPANY: "Swico, Swivel Technologies uruvaakkiya mukkiya AI product.",
    SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "Approved information padi Swico, Swivel Technologies-oda mukkiya product; CEO Jeyanth leadership-la uruvaakkappattadhu. Idharku mela separate founder illa legal owner details available illa.",
    SwicoBrandSubintent.CAPABILITIES: "Swico voice, text, pala mozhi support, document analysis, content creation, summary, explanation, planning, research matrum daily problem-solving-la help pannum.",
    SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico quality, speed, cost-ai balance panna advanced language models matrum intelligent routing use pannum. Neenga pesura assistant Swico dhaan.",
    SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture moolama thevaiyana context mattum select panni, unnecessary token usage-ai kuraichu requests-ai efficient-aa route pannum.",
    SwicoBrandSubintent.AGENTS: "Swico agent-based architecture moolama thevaiyana context-ai select panni requests-ai efficient-aa route pannum.",
    SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico agent-based architecture, selective context matrum intelligent routing moolama unnecessary token usage-ai kuraikkum.",
    SwicoBrandSubintent.MULTILINGUAL: "Swico pala mozhigalil natural voice matrum text conversations-ai support pannum.",
    SwicoBrandSubintent.DOCUMENTS: "Swico upload panna documents matrum supported files-ai analyse panni useful information edukkum.",
    SwicoBrandSubintent.VOICE: "Swico natural voice conversations-ai support panni, user pesi mudichadhukku piragu reply panna design pannappattadhu.",
    SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits matrum transparent usage tracking-ai provide pannum.",
    SwicoBrandSubintent.CREDITS: "Swico-la wallet-based AI usage credits vaangi, remaining credits-ai track pannalaam.",
    SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking moolama use pannina alavum available credits-um clear-aa theriyum.",
    SwicoBrandSubintent.SECURITY: "Swico secure authentication matrum cloud infrastructure use pannum; security, privacy, responsible AI mukkiya principles.",
    SwicoBrandSubintent.PRIVACY: "Privacy, security matrum responsible AI Swico development-oda mukkiya principles.",
    SwicoBrandSubintent.CONTEXT: "Swico conversation context-ai maintain panni, time pogapoga relevant personal assistance provide pannum.",
    SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis, contextual assistance matrum wallet usage tracking ulla practical personal assistant.",
    SwicoBrandSubintent.PURPOSE: "Swico AI-ai practical, trustworthy, accessible matrum affordable assistant-aa maatha aim pannum.",
    SwicoBrandSubintent.TEXT: "Swico text moolama questions, writing, summary, explanation, planning matrum research-ku help pannum.",
    SwicoBrandSubintent.TECHNOLOGY: "Swico language matrum speech models, intelligent routing, agent-based processing, contextual memory matrum secure cloud technologies-ai combine pannum.",
    SwicoBrandSubintent.SCALABILITY: "Swico reliable-aa pala users-ai support panna scalable cloud deployment-kaga design pannappattadhu.",
    SwicoBrandSubintent.UPDATES: "Swico pudhu capabilities matrum improvements-ai regular updates moolama continue-aa develop pannum.",
    SwicoBrandSubintent.ABOUT: "Swico, Swivel Technologies uruvaakkiya AI personal assistant; voice, text, multilingual help, context matrum document analysis-ai support pannum.",
    SwicoBrandSubintent.GENERAL: "Swico, CEO Jeyanth leadership-la uruvaakkappatta Swivel Technologies-oda mukkiya AI assistant.",
}


_PRODUCT_REFERENCE_RE = re.compile(
    r"(?:\bswico\b|\bswivel\s+technologies\b|\bjeyanth\b|ஸ்விகோ|சுவிகோ|ஸ்விவல்)", re.I
)
_VOCATIVE_ADDRESS_RE = re.compile(
    r"^\s*(?:(?:hi|hey|hello|yo|ok|okay|vanakkam|வணக்கம்)\s+)?"
    r"(?:swico|swaiko|ஸ்விகோ|சுவிகோ)"
    r"(?=\s|$|[,.:;!?،।\-–—])[,.:;!?،।\-–—\s]*",
    re.I,
)
_SELF_REFERENCE_RE = re.compile(
    r"(?:\bwho\s+are\s+you\b|\bwhat\s+are\s+you\b|\bwhat(?:'s|\s+is)\s+your\s+name\b|"
    r"\bwhat\s+ai\s+are\s+you\b|\bwho\s+(?:created|made|developed|built)\s+you\b|"
    r"\b(?:your|the\s+assistant(?:'s)?)\s+(?:creator|developer|company|architecture|agents?|"
    r"token\s+optimi[sz]ation|voice\s+functionality|document\s+support|billing|credits?|security|privacy|model|provider)\b|"
    r"\bwhich\s+company\s+(?:created|made|developed|built)\s+you\b|"
    r"\bwhich\s+model\s+(?:powers|runs|drives)\s+you\b|\bwhat\s+model\s+do\s+you\s+use\b|"
    r"\bare\s+you\s+(?:an?\s+)?(?:ai|assistant|chatgpt|sarvam(?:\s+ai)?)\b|"
    r"நீ(?:ங்கள்)?\s+யார்|உன்(?:ங்கள்)?\s+பெயர்\s+என்ன)",
    re.I,
)
_CONTEXTUAL_REFERENCE_RE = re.compile(
    r"^(?:who\s+(?:created|made|developed|built)\s+it|which\s+company|what\s+can\s+it\s+do|"
    r"what\s+company(?:\s+(?:created|made|developed|built)\s+it)?|"
    r"how\s+does\s+it\s+work|what\s+model\s+does\s+it\s+use|is\s+it\s+secure|"
    r"does\s+it\s+support\s+(?:tamil|multiple\s+languages)|can\s+it\s+analy[sz]e\s+documents|"
    r"what\s+about\s+(?:billing|credits|security|privacy)|tell\s+me\s+more|who\s+is\s+the\s+ceo|"
    r"what\s+is\s+(?:its|the)\s+architecture|who\s+leads\s+it)\s*[?.!]*$",
    re.I,
)
_BRAND_QUESTION_FRAME_RE = re.compile(
    r"(?:"
    r"\bwhat\s+is\s+(?:swico|swaiko)\b|"
    r"\bwhat\s+(?:swico|swaiko)\s+is\b|"
    r"\bwho\s+(?:created|made|developed|built|owns|leads)\b|"
    r"\bwho\s+(?:is\s+the\s+)?founder\b|"
    r"\btell\s+me\s+about\s+(?:swico|swaiko)\b|"
    r"\bwhat\s+can\s+(?:swico|swaiko)\s+do\b|"
    r"\bwhat\s+can\s+you\s+do\b|"
    r"\bwhich\s+company\b|\babout\s+(?:swico|swaiko)\b|"
    r"\b(?:swico|swaiko)['’]s\s+(?:architecture|pricing|plans?|credits?|billing|privacy|security|model|provider|ceo|founder)\b|"
    r"\bis\s+(?:swico|swaiko)\b|\bdoes\s+(?:swico|swaiko)\b|"
    r"\bhow\s+does\s+(?:swico|swaiko)\s+work\b|"
    r"\b(?:swico|swaiko)\s+vs\.?\s+\S+\b|"
    r"\b\S+\s+vs\.?\s+(?:swico|swaiko)\b|"
    r"\bcompare\s+(?:swico|swaiko)\b|"
    r"\bwhat\s+(?:model|provider|ai)\s+(?:powers|runs|drives)\s+(?:swico|swaiko)\b|"
    r"\b(?:what\s+can\s+you\s+do|how\s+does\s+it\s+work|is\s+it\s+secure)\b|"
    r"(?:என்றால் என்ன|எந்த நிறுவனம்|யார்.*(?:உருவாக்க|செய்த|வழிநடத்த))"
    r")",
    re.I,
)


def swico_brand_guard_enabled() -> bool:
    raw = os.getenv("WEB_SWICO_BRAND_GUARD_ENABLED")
    if raw is None:
        return True
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def classify_swico_brand_query(
    message: str, *, previous_topic: str | None = None
) -> SwicoBrandMatch | None:
    text = " ".join(str(message or "").split()).strip()
    if not text or not swico_brand_guard_enabled():
        return None
    vocative = _VOCATIVE_ADDRESS_RE.match(text)
    classified_text = text[vocative.end():].strip() if vocative else text
    # Product names inside validation payloads, code, JSON keys/values, or code
    # fences are data rather than a request for the public Swico profile.
    payload_free = re.sub(r"```.*?```", " ", classified_text, flags=re.DOTALL)
    payload_free = re.sub(r"\{.*\}|\[.*\]", " ", payload_free, flags=re.DOTALL)
    payload_free = re.sub(
        r"""(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')""", " ", payload_free
    )
    validation_payload = bool(
        re.search(
            r"\b(?:validate|validation|valid|check|format|pretty[- ]?print)\b"
            r".*\b(?:json|code|data|payload)\b|"
            r"\b(?:json|code|data|payload)\b.*"
            r"\b(?:validate|validation|valid|check|format|pretty[- ]?print)\b",
            classified_text,
            re.IGNORECASE,
        )
    )
    self_reference = bool(_SELF_REFERENCE_RE.search(classified_text))
    product_reference = bool(_PRODUCT_REFERENCE_RE.search(payload_free) or vocative)
    frame_text = f"swico {payload_free}" if vocative else payload_free
    aboutness = bool(_BRAND_QUESTION_FRAME_RE.search(frame_text))
    explicit = bool(self_reference or (product_reference and aboutness))
    if validation_payload and not product_reference and not self_reference:
        explicit = False
    contextual = bool(
        not explicit
        and previous_topic == "swico"
        and _CONTEXTUAL_REFERENCE_RE.fullmatch(text)
    )
    if not explicit and not contextual:
        return None
    return SwicoBrandMatch(_select_subintent(classified_text), contextual=contextual)


def swico_brand_response(
    subintent: SwicoBrandSubintent | str, *, reply_language: str | None, message: str = ""
) -> str:
    try:
        selected = SwicoBrandSubintent(str(getattr(subintent, "value", subintent)))
    except ValueError:
        selected = SwicoBrandSubintent.GENERAL
    language = resolve_web_reply_language(reply_language, message)
    templates = {
        "ta": _TAMIL_RESPONSES,
        "tanglish": _TANGLISH_RESPONSES,
    }.get(language, _ENGLISH_RESPONSES)
    text = templates.get(selected) or templates[SwicoBrandSubintent.GENERAL]
    if language not in {"en", "ta", "tanglish"}:
        text = localized_web_deterministic_text(language, "swico_brand", text)
    return validate_swico_public_response(text)


def public_swico_response_templates() -> tuple[str, ...]:
    """Return the bounded public templates for repository regression checks."""
    return tuple(_ENGLISH_RESPONSES.values()) + tuple(_TAMIL_RESPONSES.values()) + tuple(_TANGLISH_RESPONSES.values())


def validate_swico_public_response(text: str) -> str:
    value = str(text or "").strip()
    if not value or _contains_restricted_public_term(value):
        return _ENGLISH_RESPONSES[SwicoBrandSubintent.IDENTITY]
    return value


def _select_subintent(text: str) -> SwicoBrandSubintent:
    lowered = text.casefold()
    public_profile_parts = sum((
        bool(
            re.search(r"\b(?:what is|who are you|what are you|identity)\b", lowered)
            or re.search(r"(?:என்றால் என்ன|என்ன உதவியாளர்|நீ(?:ங்கள்)?\s+யார்)", text)
        ),
        bool(
            re.search(r"\b(?:which|what)\s+company\b|\b(?:company|developer)\b", lowered)
            or "நிறுவனம்" in text
        ),
        bool(
            re.search(r"\b(?:who led|who leads|leadership|leader|ceo|created|creation)\b", lowered)
            or re.search(r"(?:வழிநடத்த|தலைமை|உருவாக்க)", text)
        ),
    ))
    if public_profile_parts >= 2:
        return SwicoBrandSubintent.PUBLIC_PROFILE
    if re.search(r"\b(founder|owner|ownership|investor|shareholder)\b", lowered) or (
        "swivel technologies" in lowered
        and "swico" not in lowered
        and re.search(r"\b(created|creator|made|developed|developer|built|founded)\b", lowered)
    ):
        return SwicoBrandSubintent.OWNERSHIP_UNKNOWN
    if re.search(r"\b(compare|comparison|versus|vs\.?|better than|difference)\b", lowered):
        return SwicoBrandSubintent.COMPARISON
    if re.search(r"\b(model|provider|powers?|underlying ai|which ai|what ai|chatgpt|sarvam)\b", lowered) or re.search(
        r"\bare\s+you\s+(?:an?\s+)?(?:ai|assistant|chatgpt|sarvam)", lowered
    ):
        return SwicoBrandSubintent.MODEL_OR_PROVIDER
    if re.search(r"\bwhich\s+company\b|\bwhat\s+company\b", lowered):
        return SwicoBrandSubintent.COMPANY
    if re.search(r"\b(created|creator|made|developed|developer|built|envisioned)\b", lowered) or re.search(
        r"யார்.*(?:உருவாக்க|செய்த)|உருவாக்கியவர்|யாரால்", text
    ):
        return SwicoBrandSubintent.CREATOR
    if re.search(r"\b(ceo|leader|leadership|leads)\b", lowered) or "தலைமை" in text:
        return SwicoBrandSubintent.LEADERSHIP
    if re.search(r"\b(company|organisation|organization|business)\b", lowered) or "நிறுவனம்" in text:
        return SwicoBrandSubintent.COMPANY
    if "swivel technologies" in lowered and "swico" not in lowered:
        return SwicoBrandSubintent.COMPANY
    if re.search(r"\b(reduce|reduces|saving|save|efficient|efficiency|optimi[sz])\w*\b.*\btokens?\b|\btokens?\b.*\b(reduce|saving|efficient|optimi[sz])", lowered):
        return SwicoBrandSubintent.TOKEN_EFFICIENCY
    if re.search(r"\bagents?\b|agent[- ]based", lowered):
        return SwicoBrandSubintent.AGENTS
    if re.search(r"\barchitecture\b|how\s+does\s+it\s+work", lowered):
        return SwicoBrandSubintent.ARCHITECTURE
    if re.search(r"\b(technology|tech stack|infrastructure|how does swico work)\b", lowered):
        return SwicoBrandSubintent.TECHNOLOGY
    if re.search(r"\b(what can|capabilit|features?|do for me|help with)\b", lowered):
        return SwicoBrandSubintent.CAPABILITIES
    if re.search(r"\b(documents?|files?|pdf|upload|analyse|analyze)\b", lowered):
        return SwicoBrandSubintent.DOCUMENTS
    if re.search(r"\b(multilingual|languages?|tamil|tanglish)\b", lowered):
        return SwicoBrandSubintent.MULTILINGUAL
    if re.search(r"\b(voice|speak|speech|listen)\b", lowered):
        return SwicoBrandSubintent.VOICE
    if re.search(r"\b(text|chat|typing)\b", lowered):
        return SwicoBrandSubintent.TEXT
    if re.search(r"\b(context|remember|memory|personalised|personalized)\b", lowered):
        return SwicoBrandSubintent.CONTEXT
    if re.search(r"\busage\s+track|track(?:ing)?\s+usage|usage history\b", lowered):
        return SwicoBrandSubintent.USAGE_TRACKING
    if re.search(r"\bcredits?\b", lowered):
        return SwicoBrandSubintent.CREDITS
    if re.search(r"\b(billing|wallet|payment|cost|price|pricing)\b", lowered):
        return SwicoBrandSubintent.BILLING
    if re.search(r"\bprivacy\b", lowered):
        return SwicoBrandSubintent.PRIVACY
    if re.search(r"\b(secure|security|safe|safety|authentication)\b", lowered):
        return SwicoBrandSubintent.SECURITY
    if re.search(r"\b(scale|scalable|scalability|large numbers? of users|cloud deployment)\b", lowered):
        return SwicoBrandSubintent.SCALABILITY
    if re.search(r"\b(update|updates|evolve|roadmap|new capabilities)\b", lowered):
        return SwicoBrandSubintent.UPDATES
    if re.search(r"\b(purpose|mission|aim|vision|why)\b", lowered):
        return SwicoBrandSubintent.PURPOSE
    if re.search(r"\b(who are you|what are you|your name)\b", lowered) or re.search(
        r"நீ(?:ங்கள்)?\s+யார்|பெயர்\s+என்ன", text
    ):
        return SwicoBrandSubintent.IDENTITY
    if re.search(r"\b(what is|tell me about|about)\b", lowered):
        return SwicoBrandSubintent.ABOUT
    return SwicoBrandSubintent.GENERAL


def _contains_restricted_public_term(text: str) -> bool:
    lowered = text.casefold()
    fixed = ("chat" + "gpt", "open" + "ai", "sar" + "vam")
    if any(term in lowered for term in fixed) or re.search(r"\bgpt-[a-z0-9][a-z0-9._:-]*", lowered):
        return True
    for name in _configured_upstream_model_names():
        if name.casefold() in lowered:
            return True
    return False


def _configured_upstream_model_names() -> set[str]:
    names: set[str] = set()
    for key, raw in os.environ.items():
        upper = key.upper()
        if "MODEL" not in upper:
            continue
        for item in str(raw or "").split(","):
            value = item.strip()
            if (
                len(value) >= 3
                and re.search(r"[a-z]", value, re.I)
                and value.casefold() not in {"auto", "true", "false", "none", "disabled"}
            ):
                names.add(value)
    return names


def _wants_tamil(reply_language: str | None, message: str) -> bool:
    return resolve_web_reply_language(reply_language, message) == "ta"


def _wants_tanglish(reply_language: str | None, message: str) -> bool:
    return resolve_web_reply_language(reply_language, message) == "tanglish"
