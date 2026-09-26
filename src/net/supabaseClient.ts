/**
 * One shared Supabase client.
 *
 * Both the realtime transport and the persistence layer talk to the same
 * project, and creating a client per consumer makes supabase-js warn about
 * "multiple GoTrueClient instances" -- two auth clients racing over one
 * localStorage key. This game never signs anybody in, so session persistence
 * and token refresh are switched off outright and the single instance is
 * memoised per URL.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const clients = new Map<string, SupabaseClient>();

export function getSupabaseClient(url: string, anonKey: string): SupabaseClient {
  const key = `${url}::${anonKey}`;
  let client = clients.get(key);
  if (!client) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      realtime: {
        // Comfortably above the game's 10Hz broadcast rate, with headroom for
        // presence sync bursts when several people join at once.
        params: { eventsPerSecond: 20 },
      },
    });
    clients.set(key, client);
  }
  return client;
}
