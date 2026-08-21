from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import os
import re
from typing import Mapping

from ..ai.language import (
    WEB_REPLY_LANGUAGE_CODES,
    resolve_web_reply_language,
)


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

# Bounded deterministic answers for the expanded web language set. These are
# deliberately keyed by sub-intent so selecting Hindi, Bengali, etc. does not
# collapse a billing, voice, privacy, or leadership question into identity.
_LOCALIZED_SUBINTENT_RESPONSES: dict[str, dict[SwicoBrandSubintent, str]] = {
    "hi": {
        SwicoBrandSubintent.COMPANY: "Swico, Swivel Technologies द्वारा विकसित AI उत्पाद है।",
        SwicoBrandSubintent.LEADERSHIP: "Swico का निर्माण CEO Jeyanth के नेतृत्व में हुआ है।",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice और text बातचीत, बहुभाषी सहायता, दस्तावेज़ विश्लेषण, लेखन, योजना और शोध में मदद करता है।",
        SwicoBrandSubintent.DOCUMENTS: "Swico अपलोड की गई फ़ाइलों और समर्थित दस्तावेज़ों का विश्लेषण कर सकता है।",
        SwicoBrandSubintent.VOICE: "Swico प्राकृतिक voice बातचीत को support करता है और आपके बोलना पूरा करने के बाद जवाब देता है।",
        SwicoBrandSubintent.MULTILINGUAL: "Swico कई भाषाओं में voice और text बातचीत को support करता है।",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits और स्पष्ट usage tracking देता है।",
        SwicoBrandSubintent.PRIVACY: "Privacy, security और responsible AI Swico के विकास के महत्वपूर्ण सिद्धांत हैं।",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication और cloud infrastructure का उपयोग करता है, जिसमें security और privacy महत्वपूर्ण हैं।",
        SwicoBrandSubintent.PURPOSE: "Swico का उद्देश्य AI को व्यावहारिक, भरोसेमंद, सुलभ और किफायती बनाना है।",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "उपलब्ध सार्वजनिक जानकारी Swico को Swivel Technologies का उत्पाद बताती है और अलग legal ownership statement नहीं देती।",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis और contextual assistance वाला practical AI assistant है।",
    },
    "bn": {
        SwicoBrandSubintent.COMPANY: "Swico হলো Swivel Technologies-এর তৈরি AI পণ্য।",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanth-এর নেতৃত্বে Swico তৈরি হয়েছে।",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice ও text কথোপকথন, বহু-ভাষা সহায়তা, নথি বিশ্লেষণ, লেখা, পরিকল্পনা ও গবেষণায় সাহায্য করে।",
        SwicoBrandSubintent.DOCUMENTS: "Swico আপলোড করা ফাইল ও সমর্থিত নথি বিশ্লেষণ করতে পারে।",
        SwicoBrandSubintent.VOICE: "Swico স্বাভাবিক voice কথোপকথন সমর্থন করে এবং আপনার কথা শেষ হলে উত্তর দেয়।",
        SwicoBrandSubintent.MULTILINGUAL: "Swico বহু ভাষায় voice ও text কথোপকথন সমর্থন করে।",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits এবং স্বচ্ছ usage tracking দেয়।",
        SwicoBrandSubintent.PRIVACY: "Privacy, security এবং responsible AI Swico-র গুরুত্বপূর্ণ নীতি।",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication ও cloud infrastructure ব্যবহার করে; security এবং privacy গুরুত্বপূর্ণ।",
        SwicoBrandSubintent.PURPOSE: "Swico-র লক্ষ্য AI-কে ব্যবহারিক, বিশ্বাসযোগ্য, সহজলভ্য ও সাশ্রয়ী করা।",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "প্রকাশ্য তথ্য Swico-কে Swivel Technologies-এর পণ্য বলে; আলাদা legal ownership statement নেই।",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis ও contextual assistance-সহ একটি practical AI assistant।",
    },
    "te": {
        SwicoBrandSubintent.COMPANY: "Swico అనేది Swivel Technologies రూపొందించిన AI ఉత్పత్తి.",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanth నాయకత్వంలో Swico రూపొందించబడింది.",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice మరియు text సంభాషణలు, బహుభాషా సహాయం, డాక్యుమెంట్ విశ్లేషణ, రచన, ప్రణాళిక మరియు పరిశోధనలో సహాయపడుతుంది.",
        SwicoBrandSubintent.DOCUMENTS: "Swico అప్‌లోడ్ చేసిన ఫైళ్లు మరియు మద్దతు ఉన్న డాక్యుమెంట్లను విశ్లేషించగలదు.",
        SwicoBrandSubintent.VOICE: "Swico సహజమైన voice సంభాషణలను మద్దతు ఇస్తుంది మరియు మీరు మాట్లాడటం పూర్తయ్యాక సమాధానం ఇస్తుంది.",
        SwicoBrandSubintent.MULTILINGUAL: "Swico అనేక భాషల్లో voice మరియు text సంభాషణలను మద్దతు ఇస్తుంది.",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits మరియు స్పష్టమైన usage tracking అందిస్తుంది.",
        SwicoBrandSubintent.PRIVACY: "Privacy, security మరియు responsible AI Swico అభివృద్ధిలో ముఖ్యమైన సూత్రాలు.",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication మరియు cloud infrastructure ఉపయోగిస్తుంది; security మరియు privacy ముఖ్యమైనవి.",
        SwicoBrandSubintent.PURPOSE: "AIని ఆచరణాత్మకంగా, నమ్మదగినదిగా, అందుబాటులో మరియు సరసమైనదిగా చేయడం Swico లక్ష్యం.",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "బహిరంగ సమాచారం Swicoను Swivel Technologies ఉత్పత్తిగా చెబుతుంది; ప్రత్యేక legal ownership statement లేదు.",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis మరియు contextual assistance కలిగిన practical AI assistant.",
    },
    "kn": {
        SwicoBrandSubintent.COMPANY: "Swico, Swivel Technologies ಅಭಿವೃದ್ಧಿಪಡಿಸಿದ AI ಉತ್ಪನ್ನವಾಗಿದೆ.",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanth ಅವರ ನಾಯಕತ್ವದಲ್ಲಿ Swico ರೂಪುಗೊಂಡಿದೆ.",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice ಮತ್ತು text ಸಂಭಾಷಣೆ, ಬಹುಭಾಷಾ ಸಹಾಯ, ದಾಖಲೆ ವಿಶ್ಲೇಷಣೆ, ಬರವಣಿಗೆ, ಯೋಜನೆ ಮತ್ತು ಸಂಶೋಧನೆಯಲ್ಲಿ ಸಹಾಯ ಮಾಡುತ್ತದೆ.",
        SwicoBrandSubintent.DOCUMENTS: "Swico ಅಪ್‌ಲೋಡ್ ಮಾಡಿದ ಫೈಲ್‌ಗಳು ಮತ್ತು ಬೆಂಬಲಿತ ದಾಖಲೆಗಳನ್ನು ವಿಶ್ಲೇಷಿಸಬಹುದು.",
        SwicoBrandSubintent.VOICE: "Swico ಸಹಜ voice ಸಂಭಾಷಣೆಯನ್ನು ಬೆಂಬಲಿಸುತ್ತದೆ ಮತ್ತು ನೀವು ಮಾತನಾಡಿ ಮುಗಿಸಿದ ನಂತರ ಉತ್ತರಿಸುತ್ತದೆ.",
        SwicoBrandSubintent.MULTILINGUAL: "Swico ಹಲವು ಭಾಷೆಗಳಲ್ಲಿ voice ಮತ್ತು text ಸಂಭಾಷಣೆಯನ್ನು ಬೆಂಬಲಿಸುತ್ತದೆ.",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits ಮತ್ತು ಸ್ಪಷ್ಟ usage tracking ಒದಗಿಸುತ್ತದೆ.",
        SwicoBrandSubintent.PRIVACY: "Privacy, security ಮತ್ತು responsible AI Swico ಅಭಿವೃದ್ಧಿಯ ಪ್ರಮುಖ ತತ್ವಗಳು.",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication ಮತ್ತು cloud infrastructure ಬಳಸುತ್ತದೆ; security ಮತ್ತು privacy ಮುಖ್ಯ.",
        SwicoBrandSubintent.PURPOSE: "AIಯನ್ನು ಪ್ರಾಯೋಗಿಕ, ನಂಬಿಕಸ್ಥ, ಸುಲಭವಾಗಿ ಲಭ್ಯ ಮತ್ತು ಕೈಗೆಟುಕುವಂತೆ ಮಾಡುವುದು Swico ಉದ್ದೇಶ.",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "ಸಾರ್ವಜನಿಕ ಮಾಹಿತಿ Swico ಅನ್ನು Swivel Technologies ಉತ್ಪನ್ನವೆಂದು ಹೇಳುತ್ತದೆ; ಪ್ರತ್ಯೇಕ legal ownership statement ಇಲ್ಲ.",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis ಮತ್ತು contextual assistance ಹೊಂದಿರುವ practical AI assistant.",
    },
    "ml": {
        SwicoBrandSubintent.COMPANY: "Swico, Swivel Technologies വികസിപ്പിച്ച AI ഉൽപ്പന്നമാണ്.",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanth-ന്റെ നേതൃത്വത്തിലാണ് Swico രൂപപ്പെട്ടത്.",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice, text സംഭാഷണം, പലഭാഷാ സഹായം, document analysis, എഴുത്ത്, planning, research എന്നിവയിൽ സഹായിക്കുന്നു.",
        SwicoBrandSubintent.DOCUMENTS: "Swico upload ചെയ്യുന്ന files-ഉം supported documents-ഉം analyse ചെയ്യാം.",
        SwicoBrandSubintent.VOICE: "Swico സ്വാഭാവിക voice സംഭാഷണം support ചെയ്യുകയും നിങ്ങൾ സംസാരിച്ച് തീർന്ന ശേഷം മറുപടി നൽകുകയും ചെയ്യുന്നു.",
        SwicoBrandSubintent.MULTILINGUAL: "Swico പല ഭാഷകളിലെ voice, text സംഭാഷണങ്ങൾ support ചെയ്യുന്നു.",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits-ഉം വ്യക്തമായ usage tracking-ഉം നൽകുന്നു.",
        SwicoBrandSubintent.PRIVACY: "Privacy, security, responsible AI എന്നിവ Swico വികസനത്തിലെ പ്രധാന തത്വങ്ങളാണ്.",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication, cloud infrastructure എന്നിവ ഉപയോഗിക്കുന്നു; security-യും privacy-യും പ്രധാനമാണ്.",
        SwicoBrandSubintent.PURPOSE: "AI പ്രായോഗികവും വിശ്വസനീയവും എല്ലാവർക്കും ലഭ്യവും ചെലവുകുറഞ്ഞതുമാക്കുകയാണ് Swico-യുടെ ലക്ഷ്യം.",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "പൊതു വിവരമനുസരിച്ച് Swico, Swivel Technologies-ന്റെ ഉൽപ്പന്നമാണ്; വേറിട്ട legal ownership statement ഇല്ല.",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis, contextual assistance എന്നിവയുള്ള practical AI assistant ആണ്.",
    },
    "mr": {
        SwicoBrandSubintent.COMPANY: "Swico हे Swivel Technologies ने विकसित केलेले AI उत्पादन आहे.",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanth यांच्या नेतृत्वाखाली Swico तयार झाले आहे.",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice आणि text संभाषण, बहुभाषिक मदत, दस्तऐवज विश्लेषण, लेखन, नियोजन आणि संशोधनात मदत करते.",
        SwicoBrandSubintent.DOCUMENTS: "Swico अपलोड केलेल्या फाइल्स आणि समर्थित दस्तऐवजांचे विश्लेषण करू शकते.",
        SwicoBrandSubintent.VOICE: "Swico नैसर्गिक voice संभाषणाला support करते आणि तुम्ही बोलून झाल्यावर उत्तर देते.",
        SwicoBrandSubintent.MULTILINGUAL: "Swico अनेक भाषांमधील voice आणि text संभाषणांना support करते.",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits आणि पारदर्शक usage tracking देते.",
        SwicoBrandSubintent.PRIVACY: "Privacy, security आणि responsible AI ही Swico विकासाची महत्त्वाची तत्त्वे आहेत.",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication आणि cloud infrastructure वापरते; security आणि privacy महत्त्वाचे आहेत.",
        SwicoBrandSubintent.PURPOSE: "AI व्यावहारिक, विश्वासार्ह, सुलभ आणि परवडणारे बनवणे हे Swico चे उद्दिष्ट आहे.",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "सार्वजनिक माहितीनुसार Swico हे Swivel Technologies चे उत्पादन आहे; स्वतंत्र legal ownership statement नाही.",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis आणि contextual assistance असलेला practical AI assistant आहे.",
    },
    "gu": {
        SwicoBrandSubintent.COMPANY: "Swico એ Swivel Technologies દ્વારા વિકસિત AI પ્રોડક્ટ છે.",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanthના નેતૃત્વ હેઠળ Swico બનાવવામાં આવ્યું છે.",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice અને text વાતચીત, બહુભાષી મદદ, દસ્તાવેજ વિશ્લેષણ, લેખન, આયોજન અને સંશોધનમાં મદદ કરે છે.",
        SwicoBrandSubintent.DOCUMENTS: "Swico અપલોડ કરેલી ફાઇલો અને સપોર્ટેડ દસ્તાવેજોનું વિશ્લેષણ કરી શકે છે.",
        SwicoBrandSubintent.VOICE: "Swico કુદરતી voice વાતચીતને support કરે છે અને તમે બોલી પૂર્ણ કરો પછી જવાબ આપે છે.",
        SwicoBrandSubintent.MULTILINGUAL: "Swico ઘણી ભાષાઓમાં voice અને text વાતચીતને support કરે છે.",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits અને સ્પષ્ટ usage tracking આપે છે.",
        SwicoBrandSubintent.PRIVACY: "Privacy, security અને responsible AI Swicoના મહત્વના વિકાસ સિદ્ધાંતો છે.",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication અને cloud infrastructure વાપરે છે; security અને privacy મહત્વપૂર્ણ છે.",
        SwicoBrandSubintent.PURPOSE: "AIને વ્યવહારુ, વિશ્વસનીય, સુલભ અને સસ્તું બનાવવું Swicoનું ધ્યેય છે.",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "જાહેર માહિતી Swicoને Swivel Technologiesની પ્રોડક્ટ કહે છે; અલગ legal ownership statement નથી.",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis અને contextual assistance ધરાવતું practical AI assistant છે.",
    },
    "pa": {
        SwicoBrandSubintent.COMPANY: "Swico, Swivel Technologies ਵੱਲੋਂ ਵਿਕਸਿਤ AI ਉਤਪਾਦ ਹੈ।",
        SwicoBrandSubintent.LEADERSHIP: "Swico CEO Jeyanth ਦੀ ਅਗਵਾਈ ਹੇਠ ਬਣਾਇਆ ਗਿਆ ਹੈ।",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice ਅਤੇ text ਗੱਲਬਾਤ, ਬਹੁਭਾਸ਼ੀ ਮਦਦ, ਦਸਤਾਵੇਜ਼ ਵਿਸ਼ਲੇਸ਼ਣ, ਲਿਖਤ, ਯੋਜਨਾ ਅਤੇ ਖੋਜ ਵਿੱਚ ਮਦਦ ਕਰਦਾ ਹੈ।",
        SwicoBrandSubintent.DOCUMENTS: "Swico ਅਪਲੋਡ ਕੀਤੀਆਂ ਫਾਈਲਾਂ ਅਤੇ supported documents ਦਾ ਵਿਸ਼ਲੇਸ਼ਣ ਕਰ ਸਕਦਾ ਹੈ।",
        SwicoBrandSubintent.VOICE: "Swico ਕੁਦਰਤੀ voice ਗੱਲਬਾਤ ਨੂੰ support ਕਰਦਾ ਹੈ ਅਤੇ ਤੁਹਾਡੇ ਬੋਲਣਾ ਮੁਕਾਉਣ ਤੋਂ ਬਾਅਦ ਜਵਾਬ ਦਿੰਦਾ ਹੈ।",
        SwicoBrandSubintent.MULTILINGUAL: "Swico ਕਈ ਭਾਸ਼ਾਵਾਂ ਵਿੱਚ voice ਅਤੇ text ਗੱਲਬਾਤ ਨੂੰ support ਕਰਦਾ ਹੈ।",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits ਅਤੇ ਸਾਫ਼ usage tracking ਦਿੰਦਾ ਹੈ।",
        SwicoBrandSubintent.PRIVACY: "Privacy, security ਅਤੇ responsible AI Swico ਦੇ ਮਹੱਤਵਪੂਰਨ ਸਿਧਾਂਤ ਹਨ।",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication ਅਤੇ cloud infrastructure ਵਰਤਦਾ ਹੈ; security ਅਤੇ privacy ਮਹੱਤਵਪੂਰਨ ਹਨ।",
        SwicoBrandSubintent.PURPOSE: "AI ਨੂੰ ਵਿਹਾਰਕ, ਭਰੋਸੇਯੋਗ, ਪਹੁੰਚਯੋਗ ਅਤੇ ਕਿਫਾਇਤੀ ਬਣਾਉਣਾ Swico ਦਾ ਮਕਸਦ ਹੈ।",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "ਜਨਤਕ ਜਾਣਕਾਰੀ Swico ਨੂੰ Swivel Technologies ਦਾ ਉਤਪਾਦ ਦੱਸਦੀ ਹੈ; ਵੱਖਰਾ legal ownership statement ਨਹੀਂ ਹੈ।",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis ਅਤੇ contextual assistance ਵਾਲਾ practical AI assistant ਹੈ।",
    },
    "od": {
        SwicoBrandSubintent.COMPANY: "Swico ହେଉଛି Swivel Technologies ଦ୍ୱାରା ବିକଶିତ AI ଉତ୍ପାଦ।",
        SwicoBrandSubintent.LEADERSHIP: "CEO Jeyanth ଙ୍କ ନେତୃତ୍ୱରେ Swico ବିକଶିତ ହୋଇଛି।",
        SwicoBrandSubintent.CAPABILITIES: "Swico voice ଏବଂ text କଥାବାର୍ତ୍ତା, ବହୁଭାଷୀ ସହାୟତା, ଦଲିଲ ବିଶ୍ଳେଷଣ, ଲେଖା, ଯୋଜନା ଏବଂ ଗବେଷଣାରେ ସାହାଯ୍ୟ କରେ।",
        SwicoBrandSubintent.DOCUMENTS: "Swico ଅପଲୋଡ୍ କରାଯାଇଥିବା ଫାଇଲ୍ ଏବଂ ସମର୍ଥିତ ଦଲିଲଗୁଡ଼ିକୁ ବିଶ୍ଳେଷଣ କରିପାରେ।",
        SwicoBrandSubintent.VOICE: "Swico ସ୍ୱାଭାବିକ voice କଥାବାର୍ତ୍ତାକୁ ସମର୍ଥନ କରେ ଏବଂ ଆପଣ କଥା ଶେଷ କରିବା ପରେ ଉତ୍ତର ଦିଏ।",
        SwicoBrandSubintent.MULTILINGUAL: "Swico ଅନେକ ଭାଷାରେ voice ଏବଂ text କଥାବାର୍ତ୍ତାକୁ ସମର୍ଥନ କରେ।",
        SwicoBrandSubintent.BILLING: "Swico wallet-based AI usage credits ଏବଂ ସ୍ପଷ୍ଟ usage tracking ପ୍ରଦାନ କରେ।",
        SwicoBrandSubintent.PRIVACY: "Privacy, security ଏବଂ responsible AI Swico ବିକାଶର ମୁଖ୍ୟ ନୀତି।",
        SwicoBrandSubintent.SECURITY: "Swico secure authentication ଏବଂ cloud infrastructure ବ୍ୟବହାର କରେ; security ଏବଂ privacy ଗୁରୁତ୍ୱପୂର୍ଣ୍ଣ।",
        SwicoBrandSubintent.PURPOSE: "AIକୁ ବ୍ୟବହାରିକ, ବିଶ୍ୱସନୀୟ, ସୁଲଭ ଏବଂ ସାଧ୍ୟ କରିବା Swicoର ଉଦ୍ଦେଶ୍ୟ।",
        SwicoBrandSubintent.OWNERSHIP_UNKNOWN: "ସାର୍ବଜନୀନ ସୂଚନା Swicoକୁ Swivel Technologiesର ଉତ୍ପାଦ କହେ; ଅଲଗା legal ownership statement ନାହିଁ।",
        SwicoBrandSubintent.COMPARISON: "Swico voice, text, multilingual help, document analysis ଏବଂ contextual assistance ଥିବା practical AI assistant।",
    },
}


_LOCALIZED_SUBINTENT_COMPLETIONS: dict[str, dict[SwicoBrandSubintent, str]] = {
    "hi": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico, Swivel Technologies का AI सहायक है, जिसे CEO Jeyanth के नेतृत्व में बनाया गया है।",
        SwicoBrandSubintent.IDENTITY: "मैं Swico हूँ, Swivel Technologies का AI सहायक।",
        SwicoBrandSubintent.ABOUT: "Swico voice और text बातचीत, multilingual सहायता और document analysis वाला AI सहायक है।",
        SwicoBrandSubintent.CREATOR: "Swico को CEO Jeyanth के नेतृत्व में बनाया गया और Swivel Technologies ने विकसित किया।",
        SwicoBrandSubintent.TEXT: "Swico text बातचीत में सवालों, लेखन, summaries, planning और research में मदद करता है।",
        SwicoBrandSubintent.CONTEXT: "Swico बातचीत का context बनाए रखकर आगे के जवाबों को अधिक relevant बनाता है।",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context और intelligent routing का उपयोग करता है।",
        SwicoBrandSubintent.AGENTS: "Swico के agents relevant context चुनकर requests को व्यवस्थित ढंग से संभालते हैं।",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context और routing से अनावश्यक token usage कम करने की कोशिश करता है।",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language और speech processing, secure cloud infrastructure और agent-based processing को जोड़ता है।",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing और intelligent routing का उपयोग करता है; सार्वजनिक जवाबों में किसी internal provider का नाम आवश्यक नहीं है।",
        SwicoBrandSubintent.CREDITS: "Swico में AI usage credits खरीदे और उपयोग के अनुसार track किए जा सकते हैं।",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking से इस्तेमाल और उपलब्ध usage capacity को समझना आसान होता है।",
        SwicoBrandSubintent.SCALABILITY: "Swico scalable cloud deployment के लिए बनाया गया है ताकि बढ़ते उपयोग को संभाला जा सके।",
        SwicoBrandSubintent.UPDATES: "Swico को नई capabilities और improvements के साथ नियमित रूप से update किया जाता है।",
        SwicoBrandSubintent.GENERAL: "Swico Swivel Technologies का AI सहायक है, जिसका उद्देश्य उपयोगी AI को practical और accessible बनाना है।",
    },
    "bn": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico হলো Swivel Technologies-এর AI সহকারী, যা CEO Jeyanth-এর নেতৃত্বে তৈরি হয়েছে।",
        SwicoBrandSubintent.IDENTITY: "আমি Swico, Swivel Technologies-এর AI সহকারী।",
        SwicoBrandSubintent.ABOUT: "Swico voice ও text কথোপকথন, বহু-ভাষা সহায়তা এবং নথি বিশ্লেষণ করে।",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth-এর নেতৃত্বে Swico তৈরি হয়েছে এবং Swivel Technologies এটি বিকশিত করেছে।",
        SwicoBrandSubintent.TEXT: "Swico text কথোপকথনে প্রশ্ন, লেখা, summary, planning ও research-এ সাহায্য করে।",
        SwicoBrandSubintent.CONTEXT: "Swico কথোপকথনের context ধরে রেখে পরের উত্তরকে আরও প্রাসঙ্গিক করে।",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context এবং intelligent routing ব্যবহার করে।",
        SwicoBrandSubintent.AGENTS: "Swico-এর agents প্রয়োজনীয় context বেছে নিয়ে request গুছিয়ে পরিচালনা করে।",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context এবং routing ব্যবহার করে অপ্রয়োজনীয় token usage কমায়।",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language ও speech processing, secure cloud infrastructure এবং agent-based processing একত্র করে।",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing এবং intelligent routing ব্যবহার করে; public response-এ internal provider-এর নাম প্রকাশ করা হয় না।",
        SwicoBrandSubintent.CREDITS: "Swico-তে AI usage credits কেনা যায় এবং ব্যবহারের সঙ্গে তা track করা যায়।",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking ব্যবহার ও অবশিষ্ট usage capacity বোঝাতে সাহায্য করে।",
        SwicoBrandSubintent.SCALABILITY: "বাড়তে থাকা ব্যবহার নির্ভরযোগ্যভাবে সামলাতে Swico scalable cloud deployment-এর জন্য তৈরি।",
        SwicoBrandSubintent.UPDATES: "নতুন capability ও উন্নতির সঙ্গে Swico নিয়মিত update হয়।",
        SwicoBrandSubintent.GENERAL: "Swico হলো Swivel Technologies-এর AI সহকারী, যার লক্ষ্য ব্যবহারযোগ্য AI-কে practical ও accessible করা।",
    },
    "te": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico అనేది Swivel Technologies యొక్క AI సహాయకుడు; దీనిని CEO Jeyanth నాయకత్వంలో రూపొందించారు.",
        SwicoBrandSubintent.IDENTITY: "నేను Swico, Swivel Technologies రూపొందించిన AI సహాయకుడిని.",
        SwicoBrandSubintent.ABOUT: "Swico voice మరియు text సంభాషణలు, బహుభాషా సహాయం మరియు డాక్యుమెంట్ విశ్లేషణ అందిస్తుంది.",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth నాయకత్వంలో Swico రూపొందించబడింది మరియు Swivel Technologies అభివృద్ధి చేసింది.",
        SwicoBrandSubintent.TEXT: "Swico text సంభాషణల్లో ప్రశ్నలు, రచన, summaries, planning మరియు researchలో సహాయపడుతుంది.",
        SwicoBrandSubintent.CONTEXT: "Swico సంభాషణ contextను గుర్తుంచుకుని తదుపరి సమాధానాలను మరింత సందర్భోచితంగా చేస్తుంది.",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context మరియు intelligent routingను ఉపయోగిస్తుంది.",
        SwicoBrandSubintent.AGENTS: "Swico agents అవసరమైన contextను ఎంచుకుని requestsను క్రమబద్ధంగా నిర్వహిస్తారు.",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context మరియు routing ద్వారా అవసరం లేని token usageను తగ్గిస్తుంది.",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language మరియు speech processing, secure cloud infrastructure మరియు agent-based processingను కలుపుతుంది.",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing మరియు intelligent routingను ఉపయోగిస్తుంది; public responseలో internal provider పేర్లు చూపించబడవు.",
        SwicoBrandSubintent.CREDITS: "Swicoలో AI usage credits కొనుగోలు చేసి, వినియోగానికి అనుగుణంగా track చేయవచ్చు.",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking వినియోగం మరియు మిగిలిన usage capacityను అర్థం చేసుకోవడానికి సహాయపడుతుంది.",
        SwicoBrandSubintent.SCALABILITY: "పెరుగుతున్న వినియోగాన్ని నమ్మకంగా నిర్వహించేందుకు Swico scalable cloud deployment కోసం రూపొందించబడింది.",
        SwicoBrandSubintent.UPDATES: "కొత్త capabilities మరియు improvementsతో Swico క్రమం తప్పకుండా update అవుతుంది.",
        SwicoBrandSubintent.GENERAL: "Swico Swivel Technologies యొక్క AI సహాయకుడు; ఉపయోగకరమైన AIను practical మరియు accessible చేయడం దీని లక్ష్యం.",
    },
    "kn": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico, Swivel Technologies ಅಭಿವೃದ್ಧಿಪಡಿಸಿದ AI ಸಹಾಯಕ; CEO Jeyanth ಅವರ ನಾಯಕತ್ವದಲ್ಲಿ ಇದು ರೂಪುಗೊಂಡಿದೆ.",
        SwicoBrandSubintent.IDENTITY: "ನಾನು Swico, Swivel Technologies ಅಭಿವೃದ್ಧಿಪಡಿಸಿದ AI ಸಹಾಯಕ.",
        SwicoBrandSubintent.ABOUT: "Swico voice ಮತ್ತು text ಸಂಭಾಷಣೆ, ಬಹುಭಾಷಾ ಸಹಾಯ ಮತ್ತು ದಾಖಲೆ ವಿಶ್ಲೇಷಣೆಯನ್ನು ಒದಗಿಸುತ್ತದೆ.",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth ಅವರ ನಾಯಕತ್ವದಲ್ಲಿ Swico ರೂಪುಗೊಂಡಿದ್ದು, Swivel Technologies ಇದನ್ನು ಅಭಿವೃದ್ಧಿಪಡಿಸಿದೆ.",
        SwicoBrandSubintent.TEXT: "Swico text ಸಂಭಾಷಣೆಯಲ್ಲಿ ಪ್ರಶ್ನೆಗಳು, ಬರವಣಿಗೆ, summaries, planning ಮತ್ತು researchಗೆ ಸಹಾಯ ಮಾಡುತ್ತದೆ.",
        SwicoBrandSubintent.CONTEXT: "Swico ಸಂಭಾಷಣೆಯ context ಉಳಿಸಿಕೊಂಡು ಮುಂದಿನ ಉತ್ತರಗಳನ್ನು ಹೆಚ್ಚು ಸಂಬಂಧಿತವಾಗಿಸುತ್ತದೆ.",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context ಮತ್ತು intelligent routing ಬಳಸುತ್ತದೆ.",
        SwicoBrandSubintent.AGENTS: "Swico agents ಅಗತ್ಯವಾದ context ಆಯ್ಕೆ ಮಾಡಿ requests ಅನ್ನು ಕ್ರಮಬದ್ಧವಾಗಿ ನಿರ್ವಹಿಸುತ್ತಾರೆ.",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context ಮತ್ತು routing ಮೂಲಕ ಅನಗತ್ಯ token usage ಕಡಿಮೆ ಮಾಡುತ್ತದೆ.",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language ಮತ್ತು speech processing, secure cloud infrastructure ಮತ್ತು agent-based processing ಅನ್ನು ಜೋಡಿಸುತ್ತದೆ.",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing ಮತ್ತು intelligent routing ಬಳಸುತ್ತದೆ; public responseಗಳಲ್ಲಿ internal provider ಹೆಸರುಗಳನ್ನು ತೋರಿಸಲಾಗುವುದಿಲ್ಲ.",
        SwicoBrandSubintent.CREDITS: "Swicoನಲ್ಲಿ AI usage credits ಖರೀದಿಸಿ, ಬಳಕೆಯೊಂದಿಗೆ track ಮಾಡಬಹುದು.",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking ಬಳಕೆ ಮತ್ತು ಉಳಿದ usage capacity ಅರ್ಥಮಾಡಿಕೊಳ್ಳಲು ಸಹಾಯ ಮಾಡುತ್ತದೆ.",
        SwicoBrandSubintent.SCALABILITY: "ಹೆಚ್ಚುತ್ತಿರುವ ಬಳಕೆಯನ್ನು ನಂಬಿಕೆಯಿಂದ ನಿರ್ವಹಿಸಲು Swico scalable cloud deploymentಗಾಗಿ ರೂಪಿಸಲಾಗಿದೆ.",
        SwicoBrandSubintent.UPDATES: "ಹೊಸ capabilities ಮತ್ತು improvements ಜೊತೆಗೆ Swico ನಿಯಮಿತವಾಗಿ update ಆಗುತ್ತದೆ.",
        SwicoBrandSubintent.GENERAL: "Swico Swivel Technologies ಅಭಿವೃದ್ಧಿಪಡಿಸಿದ AI ಸಹಾಯಕ; ಉಪಯುಕ್ತ AIಯನ್ನು practical ಮತ್ತು accessible ಮಾಡುವುದು ಇದರ ಉದ್ದೇಶ.",
    },
    "ml": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico, Swivel Technologies വികസിപ്പിച്ച AI സഹായിയാണ്; CEO Jeyanth-ന്റെ നേതൃത്വത്തിലാണ് ഇത് രൂപപ്പെട്ടത്.",
        SwicoBrandSubintent.IDENTITY: "ഞാൻ Swico, Swivel Technologies വികസിപ്പിച്ച AI സഹായിയാണ്.",
        SwicoBrandSubintent.ABOUT: "Swico voice, text സംഭാഷണം, പലഭാഷാ സഹായം, document analysis എന്നിവ നൽകുന്നു.",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth-ന്റെ നേതൃത്വത്തിൽ Swico രൂപപ്പെട്ടു; Swivel Technologies ആണ് ഇത് വികസിപ്പിച്ചത്.",
        SwicoBrandSubintent.TEXT: "Swico text സംഭാഷണത്തിൽ ചോദ്യങ്ങൾ, എഴുത്ത്, summaries, planning, research എന്നിവയിൽ സഹായിക്കുന്നു.",
        SwicoBrandSubintent.CONTEXT: "Swico സംഭാഷണ context നിലനിർത്തി അടുത്ത മറുപടികൾ കൂടുതൽ പ്രസക്തമാക്കുന്നു.",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context, intelligent routing എന്നിവ ഉപയോഗിക്കുന്നു.",
        SwicoBrandSubintent.AGENTS: "Swico agents ആവശ്യമായ context തിരഞ്ഞെടുത്ത് requests ക്രമമായി കൈകാര്യം ചെയ്യുന്നു.",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context, routing എന്നിവ വഴി ആവശ്യമില്ലാത്ത token usage കുറയ്ക്കുന്നു.",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language, speech processing, secure cloud infrastructure, agent-based processing എന്നിവ ചേർക്കുന്നു.",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing, intelligent routing എന്നിവ ഉപയോഗിക്കുന്നു; public response-ൽ internal provider പേരുകൾ കാണിക്കില്ല.",
        SwicoBrandSubintent.CREDITS: "Swicoയിൽ AI usage credits വാങ്ങുകയും ഉപയോഗത്തിനനുസരിച്ച് track ചെയ്യുകയും ചെയ്യാം.",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking ഉപയോഗവും ശേഷിക്കുന്ന usage capacityയും മനസ്സിലാക്കാൻ സഹായിക്കുന്നു.",
        SwicoBrandSubintent.SCALABILITY: "വർധിക്കുന്ന ഉപയോഗം വിശ്വസനീയമായി കൈകാര്യം ചെയ്യാൻ Swico scalable cloud deploymentനായി രൂപകൽപ്പന ചെയ്തതാണ്.",
        SwicoBrandSubintent.UPDATES: "പുതിയ capabilities, improvements എന്നിവയോടെ Swico പതിവായി update ചെയ്യുന്നു.",
        SwicoBrandSubintent.GENERAL: "Swico, Swivel Technologies വികസിപ്പിച്ച AI സഹായിയാണ്; പ്രായോഗികവും ലഭ്യവുമായ AI നൽകുകയാണ് ലക്ഷ്യം.",
    },
    "mr": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico हे Swivel Technologies ने विकसित केलेले AI सहाय्यक आहे; CEO Jeyanth यांच्या नेतृत्वाखाली ते तयार झाले.",
        SwicoBrandSubintent.IDENTITY: "मी Swico, Swivel Technologies ने विकसित केलेला AI सहाय्यक आहे.",
        SwicoBrandSubintent.ABOUT: "Swico voice आणि text संभाषण, बहुभाषिक मदत आणि दस्तऐवज विश्लेषण देते.",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth यांच्या नेतृत्वाखाली Swico तयार झाले आणि Swivel Technologies ने ते विकसित केले.",
        SwicoBrandSubintent.TEXT: "Swico text संभाषणात प्रश्न, लेखन, summaries, planning आणि researchमध्ये मदत करते.",
        SwicoBrandSubintent.CONTEXT: "Swico संभाषणाचा context लक्षात ठेवून पुढील उत्तरे अधिक संबंधित बनवते.",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context आणि intelligent routing वापरते.",
        SwicoBrandSubintent.AGENTS: "Swico agents आवश्यक context निवडून requests शिस्तबद्धपणे हाताळतात.",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context आणि routingमुळे अनावश्यक token usage कमी करते.",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language आणि speech processing, secure cloud infrastructure आणि agent-based processing जोडते.",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing आणि intelligent routing वापरते; public responseमध्ये internal provider नावे दाखवली जात नाहीत.",
        SwicoBrandSubintent.CREDITS: "Swicoमध्ये AI usage credits खरेदी करून वापरानुसार track करता येतात.",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage trackingमुळे वापर आणि उरलेली usage capacity समजते.",
        SwicoBrandSubintent.SCALABILITY: "वाढता वापर विश्वासाने हाताळण्यासाठी Swico scalable cloud deploymentसाठी तयार केले आहे.",
        SwicoBrandSubintent.UPDATES: "नवीन capabilities आणि improvementsसह Swico नियमितपणे update होते.",
        SwicoBrandSubintent.GENERAL: "Swico हे Swivel Technologies चे AI सहाय्यक आहे; उपयुक्त AI practical आणि accessible करणे हे त्याचे उद्दिष्ट आहे.",
    },
    "gu": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico એ Swivel Technologies દ્વારા વિકસિત AI સહાયક છે; CEO Jeyanthના નેતૃત્વ હેઠળ તે બનાવવામાં આવ્યું છે.",
        SwicoBrandSubintent.IDENTITY: "હું Swico છું, Swivel Technologies દ્વારા વિકસિત AI સહાયક.",
        SwicoBrandSubintent.ABOUT: "Swico voice અને text વાતચીત, બહુભાષી મદદ અને દસ્તાવેજ વિશ્લેષણ આપે છે.",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanthના નેતૃત્વ હેઠળ Swico બનાવાયું અને Swivel Technologiesએ તેને વિકસાવ્યું.",
        SwicoBrandSubintent.TEXT: "Swico text વાતચીતમાં પ્રશ્નો, લેખન, summaries, planning અને researchમાં મદદ કરે છે.",
        SwicoBrandSubintent.CONTEXT: "Swico વાતચીતનો context જાળવીને આગળના જવાબોને વધુ સંબંધિત બનાવે છે.",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context અને intelligent routing વાપરે છે.",
        SwicoBrandSubintent.AGENTS: "Swico agents જરૂરી context પસંદ કરીને requestsને વ્યવસ્થિત રીતે સંભાળે છે.",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context અને routingથી બિનજરૂરી token usage ઘટાડે છે.",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language અને speech processing, secure cloud infrastructure અને agent-based processingને જોડે છે.",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing અને intelligent routing વાપરે છે; public responseમાં internal providerનાં નામ બતાવવામાં આવતાં નથી.",
        SwicoBrandSubintent.CREDITS: "Swicoમાં AI usage credits ખરીદી શકાય છે અને ઉપયોગ પ્રમાણે track કરી શકાય છે.",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking ઉપયોગ અને બાકી usage capacity સમજવામાં મદદ કરે છે.",
        SwicoBrandSubintent.SCALABILITY: "વધતા ઉપયોગને વિશ્વસનીય રીતે સંભાળવા Swico scalable cloud deployment માટે બનાવાયું છે.",
        SwicoBrandSubintent.UPDATES: "નવી capabilities અને improvements સાથે Swico નિયમિત રીતે update થાય છે.",
        SwicoBrandSubintent.GENERAL: "Swico Swivel Technologiesનું AI સહાયક છે; ઉપયોગી AIને practical અને accessible બનાવવાનું તેનું ધ્યેય છે.",
    },
    "pa": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico, Swivel Technologies ਵੱਲੋਂ ਵਿਕਸਿਤ AI ਸਹਾਇਕ ਹੈ, ਜੋ CEO Jeyanth ਦੀ ਅਗਵਾਈ ਹੇਠ ਬਣਾਇਆ ਗਿਆ।",
        SwicoBrandSubintent.IDENTITY: "ਮੈਂ Swico ਹਾਂ, Swivel Technologies ਵੱਲੋਂ ਵਿਕਸਿਤ AI ਸਹਾਇਕ।",
        SwicoBrandSubintent.ABOUT: "Swico voice ਅਤੇ text ਗੱਲਬਾਤ, ਬਹੁਭਾਸ਼ੀ ਮਦਦ ਅਤੇ ਦਸਤਾਵੇਜ਼ ਵਿਸ਼ਲੇਸ਼ਣ ਦਿੰਦਾ ਹੈ।",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth ਦੀ ਅਗਵਾਈ ਹੇਠ Swico ਬਣਾਇਆ ਗਿਆ ਅਤੇ Swivel Technologies ਨੇ ਇਸਨੂੰ ਵਿਕਸਿਤ ਕੀਤਾ।",
        SwicoBrandSubintent.TEXT: "Swico text ਗੱਲਬਾਤ ਵਿੱਚ ਸਵਾਲਾਂ, ਲਿਖਤ, summaries, planning ਅਤੇ research ਵਿੱਚ ਮਦਦ ਕਰਦਾ ਹੈ।",
        SwicoBrandSubintent.CONTEXT: "Swico ਗੱਲਬਾਤ ਦਾ context ਸੰਭਾਲ ਕੇ ਅਗਲੇ ਜਵਾਬਾਂ ਨੂੰ ਹੋਰ relevant ਬਣਾਉਂਦਾ ਹੈ।",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context ਅਤੇ intelligent routing ਵਰਤਦਾ ਹੈ।",
        SwicoBrandSubintent.AGENTS: "Swico agents ਲੋੜੀਂਦਾ context ਚੁਣ ਕੇ requests ਨੂੰ ਵਿਵਸਥਿਤ ਢੰਗ ਨਾਲ ਸੰਭਾਲਦੇ ਹਨ।",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context ਅਤੇ routing ਰਾਹੀਂ ਬੇਲੋੜੀ token usage ਘਟਾਉਂਦਾ ਹੈ।",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language ਅਤੇ speech processing, secure cloud infrastructure ਅਤੇ agent-based processing ਨੂੰ ਜੋੜਦਾ ਹੈ।",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing ਅਤੇ intelligent routing ਵਰਤਦਾ ਹੈ; public response ਵਿੱਚ internal provider ਦੇ ਨਾਂ ਨਹੀਂ ਦਿਖਾਏ ਜਾਂਦੇ।",
        SwicoBrandSubintent.CREDITS: "Swico ਵਿੱਚ AI usage credits ਖਰੀਦੇ ਜਾ ਸਕਦੇ ਹਨ ਅਤੇ ਵਰਤੋਂ ਮੁਤਾਬਕ track ਕੀਤੇ ਜਾ ਸਕਦੇ ਹਨ।",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking ਵਰਤੋਂ ਅਤੇ ਬਾਕੀ usage capacity ਸਮਝਣ ਵਿੱਚ ਮਦਦ ਕਰਦੀ ਹੈ।",
        SwicoBrandSubintent.SCALABILITY: "ਵਧਦੀ ਵਰਤੋਂ ਨੂੰ ਭਰੋਸੇਯੋਗ ਤਰੀਕੇ ਨਾਲ ਸੰਭਾਲਣ ਲਈ Swico scalable cloud deployment ਵਾਸਤੇ ਬਣਾਇਆ ਗਿਆ ਹੈ।",
        SwicoBrandSubintent.UPDATES: "ਨਵੀਆਂ capabilities ਅਤੇ improvements ਨਾਲ Swico ਨਿਯਮਿਤ ਤੌਰ 'ਤੇ update ਹੁੰਦਾ ਹੈ।",
        SwicoBrandSubintent.GENERAL: "Swico Swivel Technologies ਦਾ AI ਸਹਾਇਕ ਹੈ; ਲਾਭਦਾਇਕ AI ਨੂੰ practical ਅਤੇ accessible ਬਣਾਉਣਾ ਇਸਦਾ ਮਕਸਦ ਹੈ।",
    },
    "od": {
        SwicoBrandSubintent.PUBLIC_PROFILE: "Swico ହେଉଛି Swivel Technologies ଦ୍ୱାରା ବିକଶିତ AI ସହାୟକ; CEO Jeyanth ଙ୍କ ନେତୃତ୍ୱରେ ଏହା ତିଆରି ହୋଇଛି।",
        SwicoBrandSubintent.IDENTITY: "ମୁଁ Swico, Swivel Technologies ଦ୍ୱାରା ବିକଶିତ AI ସହାୟକ।",
        SwicoBrandSubintent.ABOUT: "Swico voice ଏବଂ text କଥାବାର୍ତ୍ତା, ବହୁଭାଷୀ ସହାୟତା ଏବଂ ଦଲିଲ ବିଶ୍ଳେଷଣ ଦିଏ।",
        SwicoBrandSubintent.CREATOR: "CEO Jeyanth ଙ୍କ ନେତୃତ୍ୱରେ Swico ତିଆରି ହୋଇଛି ଏବଂ Swivel Technologies ଏହାକୁ ବିକଶିତ କରିଛି।",
        SwicoBrandSubintent.TEXT: "Swico text କଥାବାର୍ତ୍ତାରେ ପ୍ରଶ୍ନ, ଲେଖା, summaries, planning ଏବଂ researchରେ ସାହାଯ୍ୟ କରେ।",
        SwicoBrandSubintent.CONTEXT: "Swico କଥାବାର୍ତ୍ତାର context ରଖି ପରବର୍ତ୍ତୀ ଉତ୍ତରକୁ ଅଧିକ ପ୍ରାସଙ୍ଗିକ କରେ।",
        SwicoBrandSubintent.ARCHITECTURE: "Swico agent-based architecture, selective context ଏବଂ intelligent routing ବ୍ୟବହାର କରେ।",
        SwicoBrandSubintent.AGENTS: "Swico agents ଆବଶ୍ୟକ context ବାଛି requestsକୁ ସୁସଂଗଠିତ ଭାବେ ପରିଚାଳନା କରନ୍ତି।",
        SwicoBrandSubintent.TOKEN_EFFICIENCY: "Swico selective context ଏବଂ routing ଦ୍ୱାରା ଅନାବଶ୍ୟକ token usage କମାଏ।",
        SwicoBrandSubintent.TECHNOLOGY: "Swico language ଏବଂ speech processing, secure cloud infrastructure ଏବଂ agent-based processingକୁ ଯୋଡ଼େ।",
        SwicoBrandSubintent.MODEL_OR_PROVIDER: "Swico advanced language processing ଏବଂ intelligent routing ବ୍ୟବହାର କରେ; public responseରେ internal provider ନାମ ଦେଖାଯାଏ ନାହିଁ।",
        SwicoBrandSubintent.CREDITS: "Swicoରେ AI usage credits କିଣି ବ୍ୟବହାର ଅନୁସାରେ track କରାଯାଇପାରେ।",
        SwicoBrandSubintent.USAGE_TRACKING: "Swico usage tracking ବ୍ୟବହାର ଏବଂ ବାକି usage capacity ବୁଝିବାରେ ସାହାଯ୍ୟ କରେ।",
        SwicoBrandSubintent.SCALABILITY: "ବଢୁଥିବା ବ୍ୟବହାରକୁ ଭରସାଯୋଗ୍ୟ ଭାବେ ସମ୍ଭାଳିବା ପାଇଁ Swico scalable cloud deployment ନିମନ୍ତେ ତିଆରି।",
        SwicoBrandSubintent.UPDATES: "ନୂଆ capabilities ଏବଂ improvements ସହିତ Swico ନିୟମିତ ଭାବେ update ହୁଏ।",
        SwicoBrandSubintent.GENERAL: "Swico Swivel Technologiesର AI ସହାୟକ; ଉପଯୋଗୀ AIକୁ practical ଏବଂ accessible କରିବା ଏହାର ଉଦ୍ଦେଶ୍ୟ।",
    },
}

for _language, _templates in _LOCALIZED_SUBINTENT_COMPLETIONS.items():
    _LOCALIZED_SUBINTENT_RESPONSES[_language].update(_templates)


def _assert_complete_brand_templates() -> None:
    expected = set(SwicoBrandSubintent)
    response_maps = {
        "en": _ENGLISH_RESPONSES,
        "ta": _TAMIL_RESPONSES,
        "tanglish": _TANGLISH_RESPONSES,
        **_LOCALIZED_SUBINTENT_RESPONSES,
    }
    missing = {
        language: sorted(item.value for item in expected - set(templates))
        for language, templates in response_maps.items()
        if expected - set(templates)
    }
    missing_languages = sorted(set(WEB_REPLY_LANGUAGE_CODES) - set(response_maps))
    if missing_languages or missing:
        raise RuntimeError(
            "Incomplete deterministic Swico brand templates: "
            + repr({"languages": missing_languages, "subintents": missing})
        )


_assert_complete_brand_templates()


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
_NATIVE_BRAND_QUESTION_RE = re.compile(
    r"(?:क्या\s+(?:है|होता\s+है)|क्यों|কী|কি|"
    r"అంటే\s+ఏమిటి|ఏమిటి|ఎవరు|"
    r"ಎಂದರೇನು|ಏನು|"
    r"എന്താണ്|എന്ത്|"
    r"म्हणजे\s+काय|काय\s+आहे|"
    r"શું\s+છે|શું|"
    r"ਕੀ\s+ਹੈ|ਕੀ|"
    r"କଣ|କଣ\s+ଅଟେ)",
    re.IGNORECASE,
)
_NATIVE_BRAND_SUBINTENT_PATTERNS: tuple[tuple[SwicoBrandSubintent, re.Pattern[str]], ...] = (
    (SwicoBrandSubintent.CREATOR, re.compile(
        r"किसने\s+(?:बनाया|बनाई)|किसने\s+तैयार|কে\s+(?:বানিয়েছে|তৈরি)|কে\s+তৈরি\s+করেছে|"
        r"ఎవరు\s+(?:రూపొందించారు|తయారు\s+చేశారు)|ಯಾರು\s+(?:ನಿರ್ಮಿಸಿದರು|ಮಾಡಿದರು)|"
        r"ആരാണ്\s+(?:നിർമ്മിച്ചത്|ഉണ്ടാക്കിയത്)|कोणी\s+(?:बनवले|तयार केले)|"
        r"કોણે\s+(?:બનાવ્યું|તૈયાર\s+કર્યું)|ਕਿਸਨੇ\s+(?:ਬਣਾਇਆ|ਤਿਆਰ\s+ਕੀਤਾ)|"
        r"କିଏ\s+(?:ତିଆରି\s+କଲା|ବନାଇଲା)", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.ARCHITECTURE, re.compile(
        r"\barchitecture\b|वास्तुकला|স্থাপত্য|ఆర్కిటెక్చర్|ವಾಸ್ತುಶಿಲ್ಪ|ആർക്കിടെക്ചർ|"
        r"वास्तुरचना|આર્કિટેક્ચર|ਆਰਕੀਟੈਕਚਰ|ଆର୍କିଟେକ୍ଚର", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.CREDITS, re.compile(
        r"\bcredits?\b|क्रेडिट्स?|ক্রেডিট|క్రెడిట్స్?|ಕ್ರೆಡಿಟ್ಸ್?|ക്രെഡിറ്റ്സ്?|"
        r"क्रेडिट्स?|ક્રેડિટ્સ?|ਕ੍ਰੈਡਿਟਸ?|କ୍ରେଡିଟ୍", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.USAGE_TRACKING, re.compile(
        r"\busage\s+tracking\b|\btracking\s+(?:usage|credits?)\b|"
        r"उपयोग\s+(?:ट्रैकिंग|निगरानी)|ব্যবহার\s+(?:ট্র্যাকিং|নজরদারি)|"
        r"వినియోగం\s+(?:ట్రాకింగ్|పర్యవేక్షణ)|ಬಳಕೆ\s+(?:ಟ್ರ್ಯಾಕಿಂಗ್|ಮೇಲ್ವಿಚಾರಣೆ)|"
        r"ഉപയോഗ\s+(?:ട്രാക്കിംഗ്|നിരീക്ഷണം)|वापर\s+(?:ट्रॅकिंग|निगराणी)|"
        r"ઉપયોગ\s+(?:ટ્રેકિંગ|નિરીક્ષણ)|ਵਰਤੋਂ\s+(?:ਟਰੈਕਿੰਗ|ਨਿਗਰਾਨੀ)|"
        r"ବ୍ୟବହାର\s+(?:ଟ୍ରାକିଂ|ନଜରଦାରୀ)", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.UPDATES, re.compile(
        r"\bupdates?\b|\bupdate\b|\brefresh\b|अपडेट|নতুন\s+(?:আপডেট|পরিবর্তন)|"
        r"నవీకరణ|ಅಪ್‌ಡೇಟ್|അപ്ഡേറ്റ്|अद्यतन|અપડેટ|ਅੱਪਡੇਟ|ଅପଡେଟ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.COMPANY, re.compile(
        r"कंपनी|संस्था|কোম্পানি|প্রতিষ্ঠান|కంపెనీ|సంస్థ|ಕಂಪನಿ|ಸಂಸ್ಥೆ|കമ്പനി|സ്ഥാപനം|"
        r"कंपनी|संस्था|કંપની|ਸੰਸਥਾ|କମ୍ପାନୀ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.LEADERSHIP, re.compile(
        r"नेतृत्व|नेता|নেতৃত্ব|నాయకత్వం|నాయకుడు|ನಾಯಕತ್ವ|നേതൃത്വം|नेतृत्व|નેતૃત્વ|ਨੇਤ੍ਰਿਤਵ|ନେତୃତ୍ୱ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.CAPABILITIES, re.compile(
        r"क्षमता|सुविधा|ক্ষমতা|সুবিধা|సామర్థ్య|సౌకర్య|ಸಾಮರ್ಥ್ಯ|ಸೌಲಭ್ಯ|കഴിവ്|സൗകര്യം|क्षमता|સુવિધા|ਸਮਰੱਥਾ|ସାମର୍ଥ୍ୟ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.DOCUMENTS, re.compile(
        r"दस्तावेज|फ़ाइल|নথি|ফাইল|పత్ర|ఫైల్|ದಾಖಲೆ|ಫೈಲ್|രേഖ|ഫയൽ|दस्तऐवज|ફાઇલ|ਦਸਤਾਵੇਜ਼|ଦଲିଲ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.VOICE, re.compile(
        r"आवाज़|वॉइस|ভয়েস|কণ্ঠ|వాయిస్|ధ్వని|ವಾಯ್ಸ್|ಧ್ವನಿ|ശബ്ദം|आवाज|आવाज़|ਆਵਾਜ਼|ସ୍ୱର", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.MULTILINGUAL, re.compile(
        r"बहुभाषी|भाषाओं|বহুভাষা|ভাষায়|బహుభాషా|భాషల్లో|ಬಹುಭಾಷಾ|ಭಾಷೆಗಳಲ್ಲಿ|പലഭാഷ|ഭാഷകളിൽ|बहुभाषिक|બહુભાષી|ਬਹੁਭਾਸ਼ੀ|ବହୁଭାଷୀ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.BILLING, re.compile(
        r"बिलिंग|क्रेडिट|भुगतान|বিলিং|ক্রেডিট|পেমেন্ট|బిల్లింగ్|క్రెడిట్|చెల్లింపు|ಬಿಲ್ಲಿಂಗ್|ಕ್ರೆಡಿಟ್|പണമടയ്ക്ക|ബില്ലിംഗ്|क्रेडिट|बिलिंग|ક્રેડિટ|ਬਿਲਿੰਗ|କ୍ରେଡିଟ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.PRIVACY, re.compile(
        r"गोपनीयता|निजता|গোপনীয়তা|গোপনীয়তা|గోప్యత|ಗೌಪ್ಯತೆ|സ്വകാര്യത|गोपनीयता|ગોપનીયતા|ਗੋਪਨੀਯਤਾ|ଗୋପନୀୟତା", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.SECURITY, re.compile(
        r"सुरक्षा|নিরাপত্তা|భద్రత|ಭದ್ರತೆ|സുരക്ഷ|सुरक्षित|સુરક્ષા|ਸੁਰੱਖਿਆ|ସୁରକ୍ଷା", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.PURPOSE, re.compile(
        r"उद्देश्य|मकसद|লক্ষ্য|উদ্দেশ্য|లక్ష్యం|ఉద్దేశ్యం|ಉದ್ದೇಶ|ലക്ഷ്യം|ध्येय|હેતુ|ਮਕਸਦ|ଉଦ୍ଦେଶ୍ୟ", re.IGNORECASE,
    )),
    (SwicoBrandSubintent.COMPARISON, re.compile(
        r"तुलना|বনাম|তুলনা|తులన|ಹೋಲಿಕೆ|താരതമ്യം|तुलना|સરખામણી|ਤੁਲਨਾ|ତୁଳନା", re.IGNORECASE,
    )),
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
    aboutness = bool(
        _BRAND_QUESTION_FRAME_RE.search(frame_text)
        or _NATIVE_BRAND_QUESTION_RE.search(frame_text)
        or any(pattern.search(frame_text) for _, pattern in _NATIVE_BRAND_SUBINTENT_PATTERNS)
    )
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
    if language in _LOCALIZED_SUBINTENT_RESPONSES:
        text = _LOCALIZED_SUBINTENT_RESPONSES[language].get(selected, text)
    return validate_swico_public_response(text)


def public_swico_response_templates() -> tuple[str, ...]:
    """Return the bounded public templates for repository regression checks."""
    localized = tuple(
        text
        for templates in _LOCALIZED_SUBINTENT_RESPONSES.values()
        for text in templates.values()
    )
    return (
        tuple(_ENGLISH_RESPONSES.values())
        + tuple(_TAMIL_RESPONSES.values())
        + tuple(_TANGLISH_RESPONSES.values())
        + localized
    )


def validate_swico_public_response(text: str) -> str:
    value = str(text or "").strip()
    if not value or _contains_restricted_public_term(value):
        return _ENGLISH_RESPONSES[SwicoBrandSubintent.IDENTITY]
    return value


def _select_subintent(text: str) -> SwicoBrandSubintent:
    lowered = text.casefold()
    for subintent, pattern in _NATIVE_BRAND_SUBINTENT_PATTERNS:
        if pattern.search(text):
            return subintent
    if _NATIVE_BRAND_QUESTION_RE.search(text):
        return SwicoBrandSubintent.ABOUT
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
