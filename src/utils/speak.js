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

/**
 * Speak text in the given language using the Web Speech API.
 * Silently no-ops if the browser does not support speechSynthesis.
 * @param {string} text  - Text to speak
 * @param {string} lang  - App language code (e.g. 'es', 'ja')
 */
export function speak(text, lang) {
  if (!text || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = VOICE_LANG[lang] ?? lang;
  window.speechSynthesis.speak(utt);
}
