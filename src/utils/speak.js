/**
 * Audio playback utility — routes each language to the best available engine.
 *
 * PROVIDER map:
 *   webspeech — free, client-side, works well for these languages
 *   google    — server-side Google Cloud TTS, used for languages where
 *               browser voices are absent or poor quality
 *
 * To add a new language: add one entry to TTS_PROVIDER and one to GOOGLE_LANG.
 * To switch an existing language between engines: change its TTS_PROVIDER value.
 */

// ---------------------------------------------------------------------------
// Config — one line per language to change engines
// ---------------------------------------------------------------------------
const TTS_PROVIDER = {
  en: 'webspeech',
  ja: 'webspeech',
  de: 'webspeech',
  fr: 'webspeech',
  ko: 'webspeech',
  zh: 'webspeech',
  es: 'google',
  pt: 'google',
  it: 'google',
  hi: 'google',
  ur: 'google',
};

// BCP-47 locale sent to the Web Speech API.
// To add: one entry here.
const WEBSPEECH_LANG = {
  en: 'en-US',
  ja: 'ja-JP',
  de: 'de-DE',
  fr: 'fr-FR',
  ko: 'ko-KR',
  zh: 'zh-CN',
};

// BCP-47 locale sent to Google Cloud TTS.
// To add: one entry here.
const GOOGLE_LANG = {
  es: 'es-ES',
  pt: 'pt-BR',
  it: 'it-IT',
  hi: 'hi-IN',
  ur: 'ur-PK',
};

// ---------------------------------------------------------------------------
// Web Speech — voice caching + selection
// ---------------------------------------------------------------------------

let cachedVoices = [];
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  cachedVoices = window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoices = window.speechSynthesis.getVoices();
  });
}

function findVoice(voices, locale) {
  const exact = voices.find(v => v.lang === locale);
  if (exact) return exact;
  const prefix = locale.split('-')[0].toLowerCase();
  return voices.find(
    v => v.lang.toLowerCase().startsWith(prefix + '-') || v.lang.toLowerCase() === prefix
  ) ?? null;
}

function speakWebSpeech(text, lang) {
  if (!('speechSynthesis' in window)) return;
  const locale = WEBSPEECH_LANG[lang] ?? lang;
  const voices = cachedVoices.length > 0 ? cachedVoices : window.speechSynthesis.getVoices();

  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);

  if (voices.length > 0) {
    const voice = findVoice(voices, locale);
    if (!voice) return; // no matching voice — fail silently
    utt.voice = voice;
    utt.lang = voice.lang;
  } else {
    // Voices not yet loaded — set lang only (rare, first render)
    utt.lang = locale;
  }

  window.speechSynthesis.speak(utt);
}

// ---------------------------------------------------------------------------
// Google Cloud TTS — session-scoped in-memory cache
// ---------------------------------------------------------------------------

// Cache key: "<word>_<lang>" — persists for the browser session
const ttsCache = new Map();

async function getAuthToken() {
  const { supabase } = await import('./supabase');
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function speakGoogle(text, lang) {
  const locale = GOOGLE_LANG[lang];
  if (!locale) return; // unknown language — fail silently

  const cacheKey = `${text}_${lang}`;

  // Cache hit — play immediately
  if (ttsCache.has(cacheKey)) {
    playBase64Mp3(ttsCache.get(cacheKey));
    return;
  }

  try {
    const token = await getAuthToken();
    if (!token) return;

    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ word: text, languageCode: locale }),
    });

    if (!res.ok) {
      // Server error — fall back to Web Speech silently
      speakWebSpeech(text, lang);
      return;
    }

    const { audioContent } = await res.json();
    if (!audioContent) return;

    ttsCache.set(cacheKey, audioContent);
    playBase64Mp3(audioContent);
  } catch {
    // Network error — fall back to Web Speech silently
    speakWebSpeech(text, lang);
  }
}

function playBase64Mp3(base64) {
  const audio = new Audio(`data:audio/mp3;base64,${base64}`);
  audio.play().catch(() => {}); // ignore autoplay policy errors
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Speak text in the given language.
 * Routes to Google Cloud TTS or Web Speech API based on TTS_PROVIDER config.
 * Falls back to Web Speech if Google TTS fails.
 * Fails silently if no suitable voice is available.
 *
 * @param {string} text - Text to speak
 * @param {string} lang - App language code (e.g. 'es', 'ja')
 */
export function speak(text, lang) {
  if (!text || !lang) return;

  const engine = TTS_PROVIDER[lang] ?? 'webspeech';

  if (engine === 'google') {
    speakGoogle(text, lang);
  } else {
    speakWebSpeech(text, lang);
  }
}
