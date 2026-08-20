export const WEB_REPLY_LANGUAGES = [
  'en', 'ta', 'tanglish', 'hi', 'bn', 'te', 'kn', 'ml', 'mr', 'gu', 'pa', 'od',
] as const

export type ReplyLanguage = typeof WEB_REPLY_LANGUAGES[number]

export const REPLY_LANGUAGE_NATIVE_LABELS: Record<ReplyLanguage, string> = {
  en:'English', ta:'தமிழ்', tanglish:'Tanglish', hi:'हिन्दी', bn:'বাংলা',
  te:'తెలుగు', kn:'ಕನ್ನಡ', ml:'മലയാളം', mr:'मराठी', gu:'ગુજરાતી',
  pa:'ਪੰਜਾਬੀ', od:'ଓଡ଼ିଆ',
}

const REPLY_LANGUAGE_DISPLAY_LABELS: Record<ReplyLanguage, string> = {
  en:'English', ta:'Tamil', tanglish:'Tanglish', hi:'Hindi', bn:'Bengali',
  te:'Telugu', kn:'Kannada', ml:'Malayalam', mr:'Marathi', gu:'Gujarati',
  pa:'Punjabi', od:'Odia',
}

export function isReplyLanguage(value: unknown): value is ReplyLanguage {
  return typeof value === 'string'
    && (WEB_REPLY_LANGUAGES as readonly string[]).includes(value)
}

export function replyLanguageLabel(value: unknown): string {
  return isReplyLanguage(value) ? REPLY_LANGUAGE_DISPLAY_LABELS[value] : 'English'
}
