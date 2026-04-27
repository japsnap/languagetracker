import { supabase } from './supabase';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English',    flag: '🇺🇸' },
  { code: 'es', label: 'Spanish',    flag: '🇪🇸' },
  { code: 'ja', label: 'Japanese',   flag: '🇯🇵' },
  { code: 'de', label: 'German',     flag: '🇩🇪' },
  { code: 'ko', label: 'Korean',     flag: '🇰🇷' },
  { code: 'zh', label: 'Chinese',    flag: '🇨🇳' },
  { code: 'ur', label: 'Urdu',       flag: '🇵🇰' },
  { code: 'hi', label: 'Hindi',      flag: '🇮🇳' },
  { code: 'pt', label: 'Portuguese', flag: '🇵🇹' },
  { code: 'fr', label: 'French',     flag: '🇫🇷' },
  { code: 'it', label: 'Italian',    flag: '🇮🇹' },
];

// Supabase migration (run once):
// ALTER TABLE user_preferences ADD COLUMN learning_language text DEFAULT 'es';

const DEFAULT_PREFERENCES = {
  primary_language: 'en',
  learning_language: 'es',
  secondary_languages: [],
  desired_retention: 0.80,
};

export async function getPreferences(userId) {
  const { data } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (data) return data;

  const { data: newRow } = await supabase
    .from('user_preferences')
    .insert({ user_id: userId, ...DEFAULT_PREFERENCES })
    .select()
    .single();

  return newRow ?? { user_id: userId, ...DEFAULT_PREFERENCES };
}

export async function updatePreferences(userId, changes) {
  const { error } = await supabase
    .from('user_preferences')
    .update({ ...changes, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  if (error) throw new Error(error.message);
}
