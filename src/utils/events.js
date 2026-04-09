import { supabase } from './supabase';

export function logEvent(eventType, metadata = {}) {
  supabase.auth.getUser().then(({ data: { user } }) => {
    if (!user) return;
    return supabase.from('user_events').insert({
      user_id: user.id,
      event_type: eventType,
      metadata,
    });
  }).catch(() => {});
}
