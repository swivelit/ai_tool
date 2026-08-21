from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


INDIC_REPLY_LANGUAGE_ALIASES = {"ta", "tamil", "mixed", "tanglish"}
WEB_REPLY_LANGUAGE_CODES: tuple[str, ...] = (
    "en", "ta", "tanglish", "hi", "bn", "te", "kn", "ml", "mr", "gu", "pa", "od",
)
WEB_REPLY_LANGUAGES = frozenset(WEB_REPLY_LANGUAGE_CODES)
WEB_REPLY_LANGUAGE_ALIASES = {
    "english": "en", "tamil": "ta", "mixed": "ta", "tanglish": "tanglish",
    "hindi": "hi", "bengali": "bn", "telugu": "te", "kannada": "kn",
    "malayalam": "ml", "marathi": "mr", "gujarati": "gu", "punjabi": "pa",
    "odia": "od", "oriya": "od", "or": "od",
}
WEB_REPLY_LANGUAGE_NAMES = {
    "en": "English", "ta": "Tamil", "tanglish": "Tanglish", "hi": "Hindi",
    "bn": "Bengali", "te": "Telugu", "kn": "Kannada", "ml": "Malayalam",
    "mr": "Marathi", "gu": "Gujarati", "pa": "Punjabi", "od": "Odia",
}
WEB_REPLY_LANGUAGE_NATIVE_LABELS = {
    "en": "English", "ta": "தமிழ்", "tanglish": "Tanglish", "hi": "हिन्दी",
    "bn": "বাংলা", "te": "తెలుగు", "kn": "ಕನ್ನಡ", "ml": "മലയാളം",
    "mr": "मराठी", "gu": "ગુજરાતી", "pa": "ਪੰਜਾਬੀ", "od": "ଓଡ଼ିଆ",
}
WEB_REPLY_LANGUAGE_SCRIPT_LABELS = {
    "en": "English", "ta": "Tamil Unicode script", "tanglish": "Roman/Latin characters",
    "hi": "Devanagari script", "bn": "Bengali script", "te": "Telugu script",
    "kn": "Kannada script", "ml": "Malayalam script", "mr": "Devanagari script",
    "gu": "Gujarati script", "pa": "Gurmukhi script", "od": "Odia script",
}


def resolve_web_stt_mode(reply_language: Optional[str], configured_mode: Optional[str] = None) -> str:
    """Choose the website STT representation without locking input language.

    The reply preference controls output.  Only Tanglish asks Sarvam for a
    Romanized transcript; every native-script reply language keeps the
    provider's normal transcription output.  The configured mode is retained
    only as a compatibility fallback when no valid reply preference exists.
    """
    language = normalize_web_reply_language(reply_language)
    if language == "tanglish":
        return "translit"
    if language in WEB_REPLY_LANGUAGES:
        return "transcribe"
    configured = str(configured_mode or "transcribe").strip().lower()
    return configured if configured in {"transcribe", "translit"} else "transcribe"

# Provider failures are deterministic product copy, not translation jobs. Keep
# one safe message per supported web reply language so an outage never causes a
# provider call or an unrelated Tamil fallback.
WEB_PROVIDER_UNAVAILABLE_RESPONSES = {
    "en": "The selected AI service is temporarily unavailable. Please try again shortly.",
    "ta": "மன்னிக்கவும், இப்போது பதில் உருவாக்க முடியவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும்.",
    "tanglish": "Mannikkavum, ippodhu reply create panna mudiyala. Konjam neram kazhichu try pannunga.",
    "hi": "चयनित AI सेवा अभी अस्थायी रूप से उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर प्रयास करें।",
    "bn": "নির্বাচিত AI পরিষেবাটি এখন সাময়িকভাবে unavailable। অনুগ্রহ করে কিছুক্ষণ পরে আবার চেষ্টা করুন।",
    "te": "ఎంచుకున్న AI సేవ ప్రస్తుతం తాత్కాలికంగా అందుబాటులో లేదు. కొద్దిసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.",
    "kn": "ಆಯ್ಕೆ ಮಾಡಿದ AI ಸೇವೆ ಈಗ ತಾತ್ಕಾಲಿಕವಾಗಿ ಲಭ್ಯವಿಲ್ಲ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ.",
    "ml": "തിരഞ്ഞെടുത്ത AI സേവനം ഇപ്പോൾ താൽക്കാലികമായി ലഭ്യമല്ല. കുറച്ച് കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക.",
    "mr": "निवडलेली AI सेवा सध्या तात्पुरती उपलब्ध नाही. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.",
    "gu": "પસંદ કરેલી AI સેવા હાલમાં અસ્થાયી રીતે ઉપલબ્ધ નથી. કૃપા કરીને થોડી વાર પછી ફરી પ્રયાસ કરો.",
    "pa": "ਚੁਣੀ ਹੋਈ AI ਸੇਵਾ ਇਸ ਵੇਲੇ ਅਸਥਾਈ ਤੌਰ 'ਤੇ ਉਪਲਬਧ ਨਹੀਂ ਹੈ। ਕੁਝ ਦੇਰ ਬਾਅਦ ਮੁੜ ਕੋਸ਼ਿਸ਼ ਕਰੋ।",
    "od": "ଚୟନ କରାଯାଇଥିବା AI ସେବା ବର୍ତ୍ତମାନ ସାମୟିକ ଭାବେ ଉପଲବ୍ଧ ନାହିଁ। କିଛି ସମୟ ପରେ ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ।",
}

WEB_DETERMINISTIC_RESPONSES: dict[str, dict[str, str]] = {
    "en": {
        "greeting": "Hi! How can I help you today?",
        "thanks": "You’re welcome.",
        "capabilities": "I can help with questions, explanations, writing, planning, and coding.",
        "live_data_disabled": "Swico does not have live data access on the web yet, so it cannot give current weather, scores or prices, and will not guess.",
        "unsupported": "That capability is not available on the web yet.",
        "blocked": "I can’t help with that request, but I can help with a safer alternative.",
        "private_source": "The attached sources do not provide this information, so I cannot determine it from the available evidence.",
    },
    "ta": {
        "urgent_medical_emergency": "இந்த அறிகுறிகள் மருத்துவ அவசரநிலையாக இருக்கலாம். உடனடியாக உங்கள் உள்ளூர் அவசர சேவையைத் தொடர்புகொண்டு, உதவி வரும் வரை அந்த நபருடன் இருங்கள்.",
        "harmful_credential_abuse": "கடவுச்சொல் திருட்டு அல்லது பிறரின் கணக்கில் அங்கீகரிக்கப்படாத நுழைவுக்கு நான் உதவ முடியாது. அதிகாரப்பூர்வ கணக்கு மீட்பு முறையைப் பயன்படுத்துங்கள்.",
        "greeting": "வணக்கம்! இன்று நான் எப்படி உதவலாம்?",
        "thanks": "வரவேற்கிறேன்.",
        "capabilities": "கேள்விகள், விளக்கங்கள், எழுதுதல், திட்டமிடல் மற்றும் நிரலாக்கத்தில் நான் உதவ முடியும்.",
        "live_data_disabled": "Swico இன்னும் இணையத்தில் நேரடி தரவு அணுகலை வழங்கவில்லை; எனவே தற்போதைய வானிலை, மதிப்பெண்கள் அல்லது விலைகளை நான் கூற முடியாது, ஊகிக்கவும் மாட்டேன்.",
        "unsupported": "அந்த வசதி இன்னும் இணையத்தில் கிடைக்கவில்லை.",
        "blocked": "அந்தக் கோரிக்கைக்கு என்னால் உதவ முடியாது; அதற்குப் பதிலாக பாதுகாப்பான வழியில் உதவ முடியும்.",
        "private_source": "பதிவேற்றிய ஆவணங்கள் இந்தத் தகவலை வழங்கவில்லை; எனவே கிடைத்த ஆதாரத்திலிருந்து இதைத் தீர்மானிக்க முடியாது.",
    },
    "tanglish": {
        "urgent_medical_emergency": "Indha symptoms medical emergency-a irukkalaam. Udane local emergency service-a contact panni, help varum varaikkum andha person-oda irunga.",
        "harmful_credential_abuse": "Password thirudavo allathu vera oruthar account-la unauthorized access pannavo naan help panna mudiyadhu. Official account recovery process-a use pannunga.",
        "greeting": "Vanakkam! Innaikku naan eppadi help pannalaam?",
        "thanks": "Parava illa.",
        "capabilities": "Questions, explanations, writing, planning, coding ellathulayum naan help panna mudiyum.",
        "live_data_disabled": "Swico-ku web-la innum live data access illa; athanala current weather, scores illa prices-a solla mudiyadhu, guess-um panna maatten.",
        "unsupported": "Andha capability innum web-la available illa.",
        "blocked": "Indha request-ku naan help panna mudiyadhu; safer alternative-la help panna mudiyum.",
        "private_source": "Upload panna sources-la indha information illa; available evidence-la irundhu idhai determine panna mudiyadhu.",
    },
    "hi": {
        "swico_brand": "Swico, Swivel Technologies द्वारा विकसित एक AI सहायक है।",
        "urgent_medical_emergency": "ये लक्षण मेडिकल आपातस्थिति हो सकते हैं। तुरंत स्थानीय आपातकालीन सेवा से संपर्क करें और मदद आने तक व्यक्ति के साथ रहें।",
        "harmful_credential_abuse": "मैं पासवर्ड चुराने या किसी खाते में अनधिकृत प्रवेश में मदद नहीं कर सकता। आधिकारिक रिकवरी प्रक्रिया और सुरक्षा सहायता का उपयोग करें।",
        "greeting": "नमस्ते! आज मैं आपकी कैसे मदद कर सकता हूँ?",
        "thanks": "आपका स्वागत है।",
        "capabilities": "मैं सवालों के जवाब, समझाने, लिखने, योजना बनाने और प्रोग्रामिंग में मदद कर सकता हूँ।",
        "live_data_disabled": "Swico के पास अभी वेब पर लाइव डेटा की सुविधा नहीं है, इसलिए यह वर्तमान मौसम, स्कोर या कीमतें नहीं बता सकता और अनुमान नहीं लगाएगा।",
        "unsupported": "यह सुविधा अभी वेब पर उपलब्ध नहीं है।",
        "blocked": "मैं इस अनुरोध में मदद नहीं कर सकता, लेकिन सुरक्षित विकल्प में सहायता कर सकता हूँ।",
        "private_source": "संलग्न स्रोतों में यह जानकारी नहीं है, इसलिए उपलब्ध प्रमाण से इसका निर्धारण नहीं कर सकता।",
    },
    "bn": {
        "swico_brand": "Swico হলো Swivel Technologies-এর তৈরি একটি AI সহকারী।",
        "urgent_medical_emergency": "এই লক্ষণগুলি জরুরি চিকিৎসা পরিস্থিতির ইঙ্গিত হতে পারে। এখনই স্থানীয় জরুরি পরিষেবায় যোগাযোগ করুন এবং সাহায্য আসা পর্যন্ত ব্যক্তির পাশে থাকুন।",
        "harmful_credential_abuse": "আমি পাসওয়ার্ড চুরি বা অন্যের অ্যাকাউন্টে অননুমোদিত প্রবেশে সাহায্য করতে পারি না। অফিসিয়াল অ্যাকাউন্ট পুনরুদ্ধার প্রক্রিয়া ব্যবহার করুন।",
        "greeting": "নমস্কার! আজ আমি কীভাবে সাহায্য করতে পারি?",
        "thanks": "আপনাকে স্বাগতম।",
        "capabilities": "আমি প্রশ্নের উত্তর, ব্যাখ্যা, লেখা, পরিকল্পনা এবং প্রোগ্রামিংয়ে সাহায্য করতে পারি।",
        "live_data_disabled": "Swico-এর ওয়েবে এখনও লাইভ ডেটা অ্যাক্সেস নেই, তাই এটি বর্তমান আবহাওয়া, স্কোর বা দাম জানাতে পারে না এবং অনুমান করবে না।",
        "unsupported": "এই সুবিধাটি এখনও ওয়েবে উপলব্ধ নয়।",
        "blocked": "আমি এই অনুরোধে সাহায্য করতে পারি না, তবে নিরাপদ বিকল্পে সাহায্য করতে পারি।",
        "private_source": "সংযুক্ত উৎসগুলিতে এই তথ্য নেই, তাই উপলব্ধ প্রমাণ থেকে এটি নির্ধারণ করতে পারি না।",
    },
    "te": {
        "swico_brand": "Swico అనేది Swivel Technologies రూపొందించిన AI సహాయకుడు.",
        "urgent_medical_emergency": "ఈ లక్షణాలు వైద్య అత్యవసర పరిస్థితి కావచ్చు. వెంటనే స్థానిక అత్యవసర సేవలను సంప్రదించి, సహాయం వచ్చే వరకు ఆ వ్యక్తితో ఉండండి.",
        "harmful_credential_abuse": "పాస్‌వర్డ్ దొంగతనం లేదా ఇతరుల ఖాతాలో అనధికార ప్రవేశానికి నేను సహాయం చేయలేను. అధికారిక ఖాతా రికవరీ ప్రక్రియను ఉపయోగించండి.",
        "greeting": "నమస్కారం! ఈ రోజు నేను మీకు ఎలా సహాయం చేయగలను?",
        "thanks": "మీకు స్వాగతం.",
        "capabilities": "నేను ప్రశ్నలకు సమాధానాలు, వివరణలు, రచన, ప్రణాళిక మరియు ప్రోగ్రామింగ్‌లో సహాయం చేయగలను.",
        "live_data_disabled": "Swicoకు వెబ్‌లో ఇంకా ప్రత్యక్ష డేటా సౌకర్యం లేదు; కాబట్టి ప్రస్తుత వాతావరణం, స్కోర్లు లేదా ధరలను చెప్పదు, ఊహించదు.",
        "unsupported": "ఈ సౌకర్యం ఇంకా వెబ్‌లో అందుబాటులో లేదు.",
        "blocked": "ఈ అభ్యర్థనలో నేను సహాయం చేయలేను, కానీ సురక్షితమైన ప్రత్యామ్నాయంలో సహాయం చేయగలను.",
        "private_source": "జత చేసిన మూలాల్లో ఈ సమాచారం లేదు, కాబట్టి అందుబాటులో ఉన్న ఆధారాలతో దీన్ని నిర్ణయించలేను.",
    },
    "kn": {
        "swico_brand": "Swico ಎಂಬುದು Swivel Technologies ಅಭಿವೃದ್ಧಿಪಡಿಸಿದ AI ಸಹಾಯಕ.",
        "urgent_medical_emergency": "ಈ ಲಕ್ಷಣಗಳು ವೈದ್ಯಕೀಯ ತುರ್ತು ಪರಿಸ್ಥಿತಿಯಾಗಿರಬಹುದು. ತಕ್ಷಣ ಸ್ಥಳೀಯ ತುರ್ತು ಸೇವೆಗಳನ್ನು ಸಂಪರ್ಕಿಸಿ ಮತ್ತು ಸಹಾಯ ಬರುವವರೆಗೆ ವ್ಯಕ್ತಿಯೊಂದಿಗಿರಿ.",
        "harmful_credential_abuse": "ಪಾಸ್‌ವರ್ಡ್ ಕದಿಯಲು ಅಥವಾ ಬೇರೆಯವರ ಖಾತೆಗೆ ಅನಧಿಕೃತ ಪ್ರವೇಶಿಸಲು ನಾನು ಸಹಾಯ ಮಾಡಲಾರೆ. ಅಧಿಕೃತ ಖಾತೆ ಮರುಪಡೆಯುವಿಕೆ ಬಳಸಿ.",
        "greeting": "ನಮಸ್ಕಾರ! ಇಂದು ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
        "thanks": "ಸ್ವಾಗತ.",
        "capabilities": "ನಾನು ಪ್ರಶ್ನೆಗಳು, ವಿವರಣೆಗಳು, ಬರವಣಿಗೆ, ಯೋಜನೆ ಮತ್ತು ಪ್ರೋಗ್ರಾಮಿಂಗ್‌ನಲ್ಲಿ ಸಹಾಯ ಮಾಡಬಹುದು.",
        "live_data_disabled": "Swicoಗೆ ವೆಬ್‌ನಲ್ಲಿ ಇನ್ನೂ ಲೈವ್ ಡೇಟಾ ಸೌಲಭ್ಯವಿಲ್ಲ; ಆದ್ದರಿಂದ ಪ್ರಸ್ತುತ ಹವಾಮಾನ, ಸ್ಕೋರ್ ಅಥವಾ ಬೆಲೆಗಳನ್ನು ಹೇಳುವುದಿಲ್ಲ ಮತ್ತು ಊಹಿಸುವುದಿಲ್ಲ.",
        "unsupported": "ಈ ಸೌಲಭ್ಯ ಇನ್ನೂ ವೆಬ್‌ನಲ್ಲಿ ಲಭ್ಯವಿಲ್ಲ.",
        "blocked": "ಈ ವಿನಂತಿಯಲ್ಲಿ ಸಹಾಯ ಮಾಡಲು ಸಾಧ್ಯವಿಲ್ಲ, ಆದರೆ ಸುರಕ್ಷಿತ ಪರ್ಯಾಯದಲ್ಲಿ ಸಹಾಯ ಮಾಡಬಹುದು.",
        "private_source": "ಲಗತ್ತಿಸಿದ ಮೂಲಗಳಲ್ಲಿ ಈ ಮಾಹಿತಿ ಇಲ್ಲ, ಆದ್ದರಿಂದ ಲಭ್ಯವಿರುವ ಸಾಕ್ಷ್ಯದಿಂದ ಇದನ್ನು ನಿರ್ಧರಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ.",
    },
    "ml": {
        "swico_brand": "Swico, Swivel Technologies വികസിപ്പിച്ച AI സഹായിയാണ്.",
        "urgent_medical_emergency": "ഈ ലക്ഷണങ്ങൾ ഒരു മെഡിക്കൽ അടിയന്തരാവസ്ഥയായിരിക്കാം. ഉടൻ പ്രാദേശിക അടിയന്തര സേവനങ്ങളെ ബന്ധപ്പെടുകയും സഹായം വരുംവരെ ആ വ്യക്തിയോടൊപ്പം തുടരുകയും ചെയ്യുക.",
        "harmful_credential_abuse": "പാസ്‌വേഡ് മോഷ്ടിക്കാനോ മറ്റൊരാളുടെ അക്കൗണ്ടിൽ അനധികൃതമായി പ്രവേശിക്കാനോ സഹായിക്കാനാകില്ല. ഔദ്യോഗിക അക്കൗണ്ട് വീണ്ടെടുക്കൽ പ്രക്രിയ ഉപയോഗിക്കുക.",
        "greeting": "നമസ്കാരം! ഇന്ന് എങ്ങനെ സഹായിക്കാം?",
        "thanks": "സ്വാഗതം.",
        "capabilities": "ചോദ്യങ്ങൾ, വിശദീകരണങ്ങൾ, എഴുത്ത്, ആസൂത്രണം, പ്രോഗ്രാമിംഗ് എന്നിവയിൽ സഹായിക്കാം.",
        "live_data_disabled": "Swicoയ്ക്ക് വെബിൽ ഇപ്പോഴും ലൈവ് ഡാറ്റ ലഭ്യമല്ല; അതിനാൽ നിലവിലെ കാലാവസ്ഥ, സ്കോറുകൾ, വിലകൾ എന്നിവ പറയുകയോ ഊഹിക്കുകയോ ചെയ്യില്ല.",
        "unsupported": "ഈ സൗകര്യം വെബിൽ ഇപ്പോഴും ലഭ്യമല്ല.",
        "blocked": "ഈ അഭ്യർത്ഥനയിൽ സഹായിക്കാനാകില്ല, പക്ഷേ സുരക്ഷിതമായൊരു മാർഗത്തിൽ സഹായിക്കാം.",
        "private_source": "ചേർത്ത ഉറവിടങ്ങളിൽ ഈ വിവരം ഇല്ല; ലഭ്യമായ തെളിവുകളിൽ നിന്ന് ഇത് നിർണ്ണയിക്കാനാകില്ല.",
    },
    "mr": {
        "swico_brand": "Swico हा Swivel Technologies ने विकसित केलेला AI सहाय्यक आहे.",
        "urgent_medical_emergency": "ही लक्षणे वैद्यकीय आणीबाणी असू शकतात. त्वरित स्थानिक आपत्कालीन सेवांशी संपर्क साधा आणि मदत येईपर्यंत त्या व्यक्तीसोबत रहा.",
        "harmful_credential_abuse": "पासवर्ड चोरणे किंवा दुसऱ्याच्या खात्यात अनधिकृत प्रवेश करण्यास मी मदत करू शकत नाही. अधिकृत खाते-पुनर्प्राप्ती प्रक्रिया वापरा.",
        "greeting": "नमस्कार! आज मी तुमची कशी मदत करू शकतो?",
        "thanks": "तुमचे स्वागत आहे.",
        "capabilities": "मी प्रश्नांची उत्तरे, स्पष्टीकरणे, लेखन, नियोजन आणि प्रोग्रामिंगमध्ये मदत करू शकतो.",
        "live_data_disabled": "Swico कडे वेबवर अद्याप लाइव्ह डेटा सुविधा नाही, त्यामुळे ते सध्याचे हवामान, स्कोअर किंवा किंमती सांगणार नाही आणि अंदाज लावणार नाही.",
        "unsupported": "ही सुविधा अद्याप वेबवर उपलब्ध नाही.",
        "blocked": "या विनंतीत मदत करू शकत नाही, पण सुरक्षित पर्यायात मदत करू शकतो.",
        "private_source": "जोडलेल्या स्रोतांमध्ये ही माहिती नाही, त्यामुळे उपलब्ध पुराव्यावरून हे ठरवता येत नाही.",
    },
    "gu": {
        "swico_brand": "Swico એ Swivel Technologies દ્વારા વિકસાવવામાં આવેલ AI સહાયક છે.",
        "urgent_medical_emergency": "આ લક્ષણો તબીબી કટોકટી હોઈ શકે છે. તરત સ્થાનિક ઇમરજન્સી સેવાઓનો સંપર્ક કરો અને મદદ આવે ત્યાં સુધી વ્યક્તિ સાથે રહો.",
        "harmful_credential_abuse": "હું પાસવર્ડ ચોરી અથવા બીજા ખાતામાં અનધિકૃત પ્રવેશમાં મદદ કરી શકતો નથી. સત્તાવાર એકાઉન્ટ રિકવરી પ્રક્રિયાનો ઉપયોગ કરો.",
        "greeting": "નમસ્તે! આજે હું તમારી કેવી રીતે મદદ કરી શકું?",
        "thanks": "આપનું સ્વાગત છે.",
        "capabilities": "હું પ્રશ્નો, સમજૂતીઓ, લેખન, આયોજન અને પ્રોગ્રામિંગમાં મદદ કરી શકું છું.",
        "live_data_disabled": "Swico પાસે વેબ પર હજુ લાઇવ ડેટાની સુવિધા નથી, તેથી તે વર્તમાન હવામાન, સ્કોર અથવા કિંમતો કહી શકતું નથી અને અનુમાન નહીં કરે.",
        "unsupported": "આ સુવિધા હજી વેબ પર ઉપલબ્ધ નથી.",
        "blocked": "હું આ વિનંતીમાં મદદ કરી શકતો નથી, પરંતુ સુરક્ષિત વિકલ્પમાં મદદ કરી શકું છું.",
        "private_source": "જોડાયેલા સ્ત્રોતોમાં આ માહિતી નથી, તેથી ઉપલબ્ધ પુરાવાથી તે નક્કી કરી શકાતું નથી.",
    },
    "pa": {
        "swico_brand": "Swico, Swivel Technologies ਵੱਲੋਂ ਬਣਾਇਆ ਗਿਆ AI ਸਹਾਇਕ ਹੈ।",
        "urgent_medical_emergency": "ਇਹ ਲੱਛਣ ਮੈਡੀਕਲ ਐਮਰਜੈਂਸੀ ਹੋ ਸਕਦੇ ਹਨ। ਤੁਰੰਤ ਸਥਾਨਕ ਐਮਰਜੈਂਸੀ ਸੇਵਾਵਾਂ ਨਾਲ ਸੰਪਰਕ ਕਰੋ ਅਤੇ ਮਦਦ ਆਉਣ ਤੱਕ ਵਿਅਕਤੀ ਦੇ ਨਾਲ ਰਹੋ।",
        "harmful_credential_abuse": "ਮੈਂ ਪਾਸਵਰਡ ਚੋਰੀ ਜਾਂ ਕਿਸੇ ਹੋਰ ਦੇ ਖਾਤੇ ਵਿੱਚ ਗੈਰ-ਅਧਿਕਾਰਤ ਦਾਖਲੇ ਵਿੱਚ ਮਦਦ ਨਹੀਂ ਕਰ ਸਕਦਾ। ਅਧਿਕਾਰਤ ਖਾਤਾ ਰਿਕਵਰੀ ਵਰਤੋ।",
        "greeting": "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਅੱਜ ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?",
        "thanks": "ਜੀ ਆਇਆਂ ਨੂੰ।",
        "capabilities": "ਮੈਂ ਸਵਾਲਾਂ, ਵਿਆਖਿਆਵਾਂ, ਲਿਖਤ, ਯੋਜਨਾ ਅਤੇ ਪ੍ਰੋਗਰਾਮਿੰਗ ਵਿੱਚ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ।",
        "live_data_disabled": "Swico ਕੋਲ ਵੈੱਬ ਉੱਤੇ ਹਾਲੇ ਲਾਈਵ ਡੇਟਾ ਦੀ ਸਹੂਲਤ ਨਹੀਂ ਹੈ, ਇਸ ਲਈ ਇਹ ਮੌਜੂਦਾ ਮੌਸਮ, ਸਕੋਰ ਜਾਂ ਕੀਮਤਾਂ ਨਹੀਂ ਦੱਸੇਗਾ ਅਤੇ ਅਨੁਮਾਨ ਨਹੀਂ ਲਗਾਏਗਾ।",
        "unsupported": "ਇਹ ਸਹੂਲਤ ਹਾਲੇ ਵੈੱਬ ਉੱਤੇ ਉਪਲਬਧ ਨਹੀਂ ਹੈ।",
        "blocked": "ਮੈਂ ਇਸ ਬੇਨਤੀ ਵਿੱਚ ਮਦਦ ਨਹੀਂ ਕਰ ਸਕਦਾ, ਪਰ ਸੁਰੱਖਿਅਤ ਵਿਕਲਪ ਵਿੱਚ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ।",
        "private_source": "ਜੁੜੇ ਸਰੋਤਾਂ ਵਿੱਚ ਇਹ ਜਾਣਕਾਰੀ ਨਹੀਂ ਹੈ, ਇਸ ਲਈ ਉਪਲਬਧ ਸਬੂਤਾਂ ਤੋਂ ਇਸ ਨੂੰ ਨਿਰਧਾਰਤ ਨਹੀਂ ਕਰ ਸਕਦਾ।",
    },
    "od": {
        "swico_brand": "Swico ହେଉଛି Swivel Technologies ଦ୍ୱାରା ବିକଶିତ AI ସହାୟକ।",
        "urgent_medical_emergency": "ଏହି ଲକ୍ଷଣଗୁଡ଼ିକ ଏକ ଚିକିତ୍ସା ଜରୁରୀସ୍ଥିତି ହୋଇପାରେ। ତୁରନ୍ତ ସ୍ଥାନୀୟ ଜରୁରୀ ସେବା ସହିତ ଯୋଗାଯୋଗ କରନ୍ତୁ ଏବଂ ସାହାଯ୍ୟ ଆସିବା ପର୍ଯ୍ୟନ୍ତ ବ୍ୟକ୍ତିଙ୍କ ସହିତ ରୁହନ୍ତୁ।",
        "harmful_credential_abuse": "ମୁଁ ପାସୱାର୍ଡ ଚୋରି କିମ୍ବା ଅନ୍ୟର ଆକାଉଣ୍ଟରେ ଅନଧିକୃତ ପ୍ରବେଶରେ ସାହାଯ୍ୟ କରିପାରିବି ନାହିଁ। ଅଧିକୃତ ଆକାଉଣ୍ଟ ପୁନରୁଦ୍ଧାର ପ୍ରକ୍ରିୟା ବ୍ୟବହାର କରନ୍ତୁ।",
        "greeting": "ନମସ୍କାର! ଆଜି ମୁଁ କିପରି ସାହାଯ୍ୟ କରିପାରିବି?",
        "thanks": "ଆପଣଙ୍କୁ ସ୍ୱାଗତ।",
        "capabilities": "ମୁଁ ପ୍ରଶ୍ନ, ବ୍ୟାଖ୍ୟା, ଲେଖା, ଯୋଜନା ଏବଂ ପ୍ରୋଗ୍ରାମିଂରେ ସାହାଯ୍ୟ କରିପାରିବି।",
        "live_data_disabled": "Swico ପାଖରେ ୱେବରେ ଏପର୍ଯ୍ୟନ୍ତ ଲାଇଭ୍ ଡାଟା ସୁବିଧା ନାହିଁ, ତେଣୁ ଏହା ବର୍ତ୍ତମାନର ପାଣିପାଗ, ସ୍କୋର କିମ୍ବା ଦାମ କହିବ ନାହିଁ ଏବଂ ଅନୁମାନ କରିବ ନାହିଁ।",
        "unsupported": "ଏହି ସୁବିଧା ଏପର୍ଯ୍ୟନ୍ତ ୱେବରେ ଉପଲବ୍ଧ ନାହିଁ।",
        "blocked": "ମୁଁ ଏହି ଅନୁରୋଧରେ ସାହାଯ୍ୟ କରିପାରିବି ନାହିଁ, କିନ୍ତୁ ଏକ ସୁରକ୍ଷିତ ବିକଳ୍ପରେ ସାହାଯ୍ୟ କରିପାରିବି।",
        "private_source": "ସଂଲଗ୍ନ ଉତ୍ସଗୁଡ଼ିକରେ ଏହି ସୂଚନା ନାହିଁ, ତେଣୁ ଉପଲବ୍ଧ ପ୍ରମାଣରୁ ଏହା ନିର୍ଣ୍ଣୟ କରିପାରିବି ନାହିଁ।",
    },
}


def localized_web_deterministic_text(language: Optional[str], key: str, fallback: str = "") -> str:
    normalized = normalize_web_reply_language(language) or "en"
    if key == "provider_unavailable":
        return WEB_PROVIDER_UNAVAILABLE_RESPONSES.get(normalized, WEB_PROVIDER_UNAVAILABLE_RESPONSES["en"])
    return WEB_DETERMINISTIC_RESPONSES.get(normalized, {}).get(key, fallback)

_SCRIPT_RANGES: tuple[tuple[str, str, str], ...] = (
    ("ta", "\u0b80", "\u0bff"),
    ("hi", "\u0900", "\u097f"),
    ("te", "\u0c00", "\u0c7f"),
    ("ml", "\u0d00", "\u0d7f"),
    ("kn", "\u0c80", "\u0cff"),
    ("bn", "\u0980", "\u09ff"),
    ("mr", "\u0900", "\u097f"),
    ("gu", "\u0a80", "\u0aff"),
    ("pa", "\u0a00", "\u0a7f"),
    ("od", "\u0b00", "\u0b7f"),
)

_ROMANIZED_INDIC_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "ta",
        re.compile(
            r"\b("
            r"tamil|tanglish|vanakkam|nandri|enna|eppadi|sapadu|saapadu|"
            r"sollu|sollunga|pannu|pannunga|venum|irukku|illa|seri|romba|"
            r"naan|unga|ungal|namma|thambi|akka|anna|theni|kovai|madurai|"
            r"naethu|nethu|inniku|naalaikku|nalai|kaalai|maalai|veedu|"
            r"office|meeting|client|lead|business|folder\s+la|save\s+pannu"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "hi",
        re.compile(
            r"\b("
            r"hindi|hinglish|namaste|kaise|kya|kyun|nahi|nahin|haan|hai|"
            r"mujhe|aap|tum|kal|aaj|batao|samjhao|karna|karo|chahiye"
            r")\b",
            re.IGNORECASE,
        ),
    ),
    (
        "indic",
        re.compile(
            r"\b("
            r"telugu|malayalam|kannada|bengali|marathi|gujarati|punjabi|"
            r"odia|transliterate|transliteration|bharat|desi"
            r")\b",
            re.IGNORECASE,
        ),
    ),
)


@dataclass(frozen=True)
class LanguageDecision:
    language: str
    is_indic: bool
    code_mixed: bool
    prefer_provider: str
    reason: str
    input_language: str = "en"
    reply_language: Optional[str] = None
    provider_preference: str = ""


def _normalized_reply_language(reply_language: Optional[str]) -> str:
    return str(reply_language or "").strip().lower()


def normalize_web_reply_language(value: Optional[str]) -> str | None:
    normalized = _normalized_reply_language(value)
    if normalized in WEB_REPLY_LANGUAGES:
        return normalized
    return WEB_REPLY_LANGUAGE_ALIASES.get(normalized)


def is_supported_web_reply_language(value: Optional[str]) -> bool:
    return _normalized_reply_language(value) in WEB_REPLY_LANGUAGES


def web_reply_language_name(value: Optional[str]) -> str:
    return WEB_REPLY_LANGUAGE_NAMES.get(normalize_web_reply_language(value) or "", "English")


def web_reply_language_script(value: Optional[str]) -> str:
    return WEB_REPLY_LANGUAGE_SCRIPT_LABELS.get(normalize_web_reply_language(value) or "en", "English")


def resolve_web_reply_language(
    reply_language: Optional[str], message: str = ""
) -> str:
    """Resolve website reply style, preferring a valid saved preference."""

    normalized = normalize_web_reply_language(reply_language)
    if normalized in WEB_REPLY_LANGUAGES:
        return normalized
    # Keep legacy/shared aliases compatible without exposing them as new web
    # profile values.
    if _script_language(message) == "ta":
        return "ta"
    if _romanized_language(message) == "ta":
        return "tanglish"
    return "en"


def _script_language(message: str) -> Optional[str]:
    for char in str(message or ""):
        for language, start, end in _SCRIPT_RANGES:
            if start <= char <= end:
                return language
    return None


def _romanized_language(message: str) -> Optional[str]:
    text = str(message or "")
    for language, pattern in _ROMANIZED_INDIC_PATTERNS:
        if pattern.search(text):
            return language
    return None


def detect_language(message: str, reply_language: Optional[str] = None) -> LanguageDecision:
    reply = _normalized_reply_language(reply_language)
    script_language = _script_language(message)
    romanized_language = _romanized_language(message) if not script_language else None
    input_language = script_language or romanized_language or "en"
    input_is_indic = bool(script_language or romanized_language)

    normalized_reply = normalize_web_reply_language(reply)
    if normalized_reply in WEB_REPLY_LANGUAGES:
        reply = normalized_reply
    if reply == "en":
        provider = "sarvam" if input_is_indic else "openai"
        return LanguageDecision(
            language="en",
            is_indic=input_is_indic,
            code_mixed=bool(romanized_language),
            prefer_provider=provider,
            reason="reply_language_english_preserved",
            input_language=input_language,
            reply_language="en",
            provider_preference=provider,
        )

    if reply in WEB_REPLY_LANGUAGES and reply != "en":
        language = reply
        return LanguageDecision(
            language=language,
            is_indic=True,
            code_mixed=reply == "tanglish",
            prefer_provider="sarvam",
            reason="reply_language_prefers_indic",
            input_language=input_language,
            reply_language=reply,
            provider_preference="sarvam",
        )

    if script_language:
        return LanguageDecision(
            language=script_language,
            is_indic=True,
            code_mixed=False,
            prefer_provider="sarvam",
            reason="indic_unicode_script",
            input_language=script_language,
            reply_language=None,
            provider_preference="sarvam",
        )

    if romanized_language:
        return LanguageDecision(
            language=romanized_language,
            is_indic=True,
            code_mixed=True,
            prefer_provider="sarvam",
            reason="romanized_or_code_mixed_indic",
            input_language=romanized_language,
            reply_language=None,
            provider_preference="sarvam",
        )

    return LanguageDecision(
        language="en",
        is_indic=False,
        code_mixed=False,
        prefer_provider="openai",
        reason="default_english",
        input_language="en",
        reply_language=None,
        provider_preference="openai",
    )


def should_prefer_sarvam(message: str, reply_language: Optional[str] = None) -> bool:
    return detect_language(message, reply_language).prefer_provider == "sarvam"
