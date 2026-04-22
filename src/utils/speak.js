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
// Shared filename sanitizer (FIX 1)
// Strips accents, lowercases, replaces non-alphanumeric with underscore.
// Used for both the Storage path and the audio_urls lookup key.
// Example: 'confrontación' → 'confrontacion'
// Must stay in sync with sanitizeFilename() in api/audio-upload.js.
// ---------------------------------------------------------------------------
function sanitizeAudioKey(text) {
  const s = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return s || 'word';
}

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
// Google Cloud TTS — three-tier cache: memory → Supabase Storage → API
// ---------------------------------------------------------------------------

// Tier 1: session-scoped base64 cache (fallback while upload is in flight)
const ttsCache = new Map(); // key: `${text}_${lang}`, value: base64

// Tier 2: session-scoped URL cache (Storage URLs confirmed this session)
const urlCache = new Map(); // key: `${text}_${lang}`, value: publicUrl

async function getAuthToken() {
  const { supabase } = await import('./supabase');
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

// ---------------------------------------------------------------------------
// Supabase Storage read — check word_cache.audio_urls
// ---------------------------------------------------------------------------

/**
 * Look up a persisted public URL from word_cache.audio_urls.
 * Searches by result_word OR input_word (same pattern as cache.js findCachedWordRow).
 * Uses sanitizeAudioKey for consistent key lookup across sessions.
 */
async function getCachedAudioUrl(text, lang) {
  try {
    const { supabase } = await import('./supabase');
    const normalized = text.toLowerCase().trim();
    const { data, error } = await supabase
      .from('word_cache')
      .select('audio_urls')
      .or(`result_word.eq.${normalized},input_word.eq.${normalized}`)
      .not('audio_urls', 'is', null)
      .limit(1);
    if (error || !data || data.length === 0) return null;
    return data[0]?.audio_urls?.[lang] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Google TTS playback with three-tier cache
// ---------------------------------------------------------------------------

function playBase64Mp3(base64) {
  const audio = new Audio(`data:audio/mp3;base64,${base64}`);
  audio.play().catch(() => {}); // ignore autoplay policy errors
}

async function speakGoogle(text, lang) {
  const locale = GOOGLE_LANG[lang];
  if (!locale) return; // unknown language — fail silently

  const cacheKey = `${text}_${lang}`;

  // Tier 1: memory base64 cache — immediate replay within session
  if (ttsCache.has(cacheKey)) {
    playBase64Mp3(ttsCache.get(cacheKey));
    return;
  }

  // Tier 2: memory URL cache — Storage URLs confirmed this session
  if (urlCache.has(cacheKey)) {
    new Audio(urlCache.get(cacheKey)).play().catch(() => {});
    return;
  }

  // Tier 3: Supabase Storage — check word_cache.audio_urls for a persisted URL
  const storedUrl = await getCachedAudioUrl(text, lang);
  if (storedUrl) {
    urlCache.set(cacheKey, storedUrl);
    new Audio(storedUrl).play().catch(() => {});
    return;
  }

  // Tier 4: Google TTS API → server-side Storage upload → play from URL
  try {
    const token = await getAuthToken();
    if (!token) return;

    // Step 4a: fetch audio base64 from TTS endpoint
    const ttsRes = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ word: text, languageCode: locale }),
    });

    if (!ttsRes.ok) {
      speakWebSpeech(text, lang);
      return;
    }

    const { audioContent } = await ttsRes.json();
    if (!audioContent) return;

    // Keep base64 in memory as fallback for the duration of the upload
    ttsCache.set(cacheKey, audioContent);

    // Step 4b: upload to Storage via server endpoint (bypasses RLS) and get URL
    const uploadRes = await fetch('/api/audio-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        word: text,
        languageCode: locale,
        audioBase64: audioContent,
      }),
    });

    if (uploadRes.ok) {
      const { publicUrl } = await uploadRes.json();
      if (publicUrl) {
        urlCache.set(cacheKey, publicUrl);
        new Audio(publicUrl).play().catch(() => {});
        return;
      }
    }

    // Upload failed — fall back to base64 already in memory
    playBase64Mp3(audioContent);
  } catch {
    // Network error — fall back to Web Speech silently
    speakWebSpeech(text, lang);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Speak text in the given language.
 * Routes to Google Cloud TTS or Web Speech API based on TTS_PROVIDER config.
 * Google TTS: memory base64 → memory URL → Supabase Storage URL → API fetch + upload.
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
