// Map of app language code → BCP-47 locale for the Web Speech API.
// To add a new language: add one entry here — no other changes needed.
const VOICE_LANG = {
  es: 'es-ES',
  ja: 'ja-JP',
  de: 'de-DE',
  ko: 'ko-KR',
  zh: 'zh-CN',
  ur: 'ur-PK',
  hi: 'hi-IN',
  pt: 'pt-BR',
  fr: 'fr-FR',
  it: 'it-IT',
  en: 'en-US',
};

// When the primary locale has no available voice, try these fallbacks before giving up.
// To add a new fallback: add one entry here.
const VOICE_FALLBACKS = {
  'ur-PK': 'hi-IN',
};

// Voices are loaded asynchronously in Chrome. Cache them as soon as they are available.
let cachedVoices = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoices = window.speechSynthesis.getVoices();
  });
}

/**
 * Find the best available voice for a given BCP-47 locale.
 * Prefers exact match (e.g. 'es-ES'), then partial match (e.g. 'es-MX' for 'es').
 * Returns null if no voice is found.
 */
function findVoice(voices, locale) {
  const exact = voices.find(v => v.lang === locale);
  if (exact) return exact;
  const prefix = locale.split('-')[0].toLowerCase();
  return voices.find(v => v.lang.toLowerCase().startsWith(prefix + '-') || v.lang.toLowerCase() === prefix) ?? null;
}

/**
 * Speak text in the given language using the Web Speech API.
 * Selects the best matching voice from the browser's voice list.
 * Falls back per VOICE_FALLBACKS before giving up silently.
 * No-ops if the browser does not support speechSynthesis.
 *
 * @param {string} text  - Text to speak
 * @param {string} lang  - App language code (e.g. 'es', 'ja')
 */
export function speak(text, lang) {
  if (!text || !('speechSynthesis' in window)) return;

  const targetLocale = VOICE_LANG[lang] ?? lang;

  // Always try getVoices() fresh in case cache is still empty on first call
  const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();

  if (voices.length > 0) {
    // Voice list available — require a matching voice; try fallback if needed.
    let voice = findVoice(voices, targetLocale);
    if (!voice && VOICE_FALLBACKS[targetLocale]) {
      voice = findVoice(voices, VOICE_FALLBACKS[targetLocale]);
    }
    if (!voice) return; // no suitable voice — fail silently

    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = voice.lang;
    utt.voice = voice;
    window.speechSynthesis.speak(utt);
  } else {
    // Voices not yet loaded (Chrome first render) — set lang only and let browser decide.
    // This path is rare; voices should be cached on subsequent calls.
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = targetLocale;
    window.speechSynthesis.speak(utt);
  }
}
