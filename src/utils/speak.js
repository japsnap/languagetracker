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
// Google Cloud TTS — three-tier cache: memory → Supabase Storage → API
// ---------------------------------------------------------------------------

// Tier 1: session-scoped base64 cache (API responses)
const ttsCache = new Map(); // key: `${text}_${lang}`, value: base64

// Tier 2: session-scoped URL cache (Supabase Storage URLs fetched this session)
const urlCache = new Map(); // key: `${text}_${lang}`, value: publicUrl

async function getAuthToken() {
  const { supabase } = await import('./supabase');
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

// ---------------------------------------------------------------------------
// Supabase Storage helpers
// ---------------------------------------------------------------------------

/**
 * Check word_cache.audio_urls for a stored public URL for this word + lang.
 * Searches by result_word OR input_word so corrected/translated words are found.
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

function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/mp3' });
}

/**
 * Upload base64 MP3 to Supabase Storage bucket 'audio' and write the public URL
 * back into word_cache.audio_urls JSONB (merged — other lang entries preserved).
 *
 * Storage path: {lang}/{sanitised_word}.mp3  (e.g. es/casa.mp3)
 * Bucket 'audio' must exist with public read access.
 * SQL required: ALTER TABLE word_cache ADD COLUMN IF NOT EXISTS audio_urls jsonb;
 *
 * Fire-and-forget — caller does not await.
 */
async function persistAudioToStorage(text, lang, base64) {
  try {
    const { supabase } = await import('./supabase');
    const normalized = text.toLowerCase().trim();
    // Unicode-safe filename: keep letters, digits, underscore, hyphen
    const safe = normalized.replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '');
    const path = `${lang}/${safe || 'word'}.mp3`;

    const { error: upErr } = await supabase.storage
      .from('audio')
      .upload(path, base64ToBlob(base64), { contentType: 'audio/mp3', upsert: true });
    if (upErr) {
      console.warn('[tts] storage upload failed:', upErr.message);
      return;
    }

    const { data: { publicUrl } } = supabase.storage.from('audio').getPublicUrl(path);

    // Merge into existing audio_urls: read row → merge → write (preserves other lang entries)
    const { data: rows } = await supabase
      .from('word_cache')
      .select('id, audio_urls')
      .or(`result_word.eq.${normalized},input_word.eq.${normalized}`)
      .eq('mode', 'single')
      .limit(1);
    if (!rows || rows.length === 0) {
      console.warn('[tts] persistAudioToStorage: no cache row to update for', normalized);
      return;
    }
    const merged = { ...(rows[0].audio_urls || {}), [lang]: publicUrl };
    await supabase.from('word_cache').update({ audio_urls: merged }).eq('id', rows[0].id);

    // Warm the session URL cache so subsequent in-session calls skip the DB query
    urlCache.set(`${text}_${lang}`, publicUrl);
    console.log('[tts] audio persisted to storage:', path);
  } catch (err) {
    console.warn('[tts] persistAudioToStorage failed:', err?.message);
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

  // Tier 1: memory base64 cache — populated by API responses this session
  if (ttsCache.has(cacheKey)) {
    playBase64Mp3(ttsCache.get(cacheKey));
    return;
  }

  // Tier 2: memory URL cache — populated by Storage lookups this session
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

  // Tier 4: Google TTS API — fetch, play, persist to Storage (fire-and-forget)
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

    // Persist to Supabase Storage for cross-session reuse (fire-and-forget)
    persistAudioToStorage(text, lang, audioContent);
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
 * Google TTS uses a three-tier cache: memory → Supabase Storage → API fetch.
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
