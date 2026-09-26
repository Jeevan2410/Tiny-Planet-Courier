/**
 * Persistence: courier profiles and the leaderboard, on Supabase Postgres.
 *
 * Writes go through a `SECURITY DEFINER` RPC (`upsert_courier`) rather than
 * direct table access. The anon key is public by definition in a browser game,
 * so the table itself grants anon nothing but SELECT; the function is the only
 * write path and it clamps and validates everything it is given. That is the
 * difference between "anonymous scores" and "anyone can DELETE the leaderboard".
 *
 * Every method degrades to a no-op when Supabase is not configured, so the game
 * runs identically with an empty .env.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cosmetics } from '../state/store';
import { getSupabaseClient } from './supabaseClient';

export interface LeaderboardRow {
  name: string;
  best_score: number;
  total_deliveries: number;
  best_streak: number;
}

export interface StoredProfile {
  name: string;
  outfit: number;
  hat: number;
  skin: number;
  best_score: number;
  total_deliveries: number;
  best_streak: number;
}

export class Backend {
  private client: SupabaseClient | null = null;
  private lastSubmit = 0;
  /** Set when a write fails, so we stop hammering a broken endpoint. */
  private writesDisabled = false;
  /** Newest un-written payload, replaced rather than queued. */
  private pending: {
    id: string;
    cosmetics: Cosmetics;
    score: number;
    deliveries: number;
    bestStreak: number;
  } | null = null;
  private flushTimer = 0;

  constructor(url: string | undefined, anonKey: string | undefined) {
    if (!url || !anonKey) return;
    this.client = getSupabaseClient(url, anonKey);
  }

  get available(): boolean {
    return this.client !== null;
  }

  /** Load a returning player's saved cosmetics and totals. */
  async loadProfile(id: string): Promise<StoredProfile | null> {
    if (!this.client) return null;
    try {
      const { data, error } = await this.client.rpc('get_courier', { p_id: id });
      if (error) throw error;
      const rows = (data ?? []) as StoredProfile[];
      return rows[0] ?? null;
    } catch (error) {
      console.warn('[backend] loadProfile failed:', describe(error));
      return null;
    }
  }

  /**
   * Record a run. Called after each delivery and on page hide.
   *
   * Throttled on a trailing edge rather than a leading one: a call inside the
   * quiet window is not dropped, it replaces the pending payload and is flushed
   * when the window opens. A leading-edge throttle silently loses whatever the
   * player did last, which is exactly the score they care about.
   *
   * The RPC keeps the best of each column rather than the latest, so firing
   * this as often as we like is safe and idempotent.
   */
  async submit(
    id: string,
    cosmetics: Cosmetics,
    score: number,
    deliveries: number,
    bestStreak: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!this.client || this.writesDisabled) return;

    this.pending = { id, cosmetics: { ...cosmetics }, score, deliveries, bestStreak };

    const wait = options.force ? 0 : Math.max(0, 4000 - (Date.now() - this.lastSubmit));
    if (wait === 0) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = 0;
      }
      await this.flush();
      return;
    }

    if (this.flushTimer) return; // a flush is already scheduled
    this.flushTimer = setTimeout(() => {
      this.flushTimer = 0;
      void this.flush();
    }, wait) as unknown as number;
  }

  private async flush(): Promise<void> {
    const payload = this.pending;
    if (!payload || !this.client || this.writesDisabled) return;
    this.pending = null;
    this.lastSubmit = Date.now();

    try {
      const { error } = await this.client.rpc('upsert_courier', {
        p_id: payload.id,
        p_name: (payload.cosmetics.name || 'Courier').slice(0, 24),
        p_outfit: payload.cosmetics.outfit,
        p_hat: payload.cosmetics.hat,
        p_skin: payload.cosmetics.skin,
        p_score: Math.max(0, Math.round(payload.score)),
        p_deliveries: Math.max(0, Math.round(payload.deliveries)),
        p_streak: Math.max(0, Math.round(payload.bestStreak)),
      });
      if (error) throw error;
    } catch (error) {
      console.warn('[backend] submit failed:', describe(error));
      this.writesDisabled = true;
    }
  }

  /** Save cosmetics without touching scores (used by the Customise panel). */
  async saveCosmetics(id: string, cosmetics: Cosmetics): Promise<void> {
    await this.submit(id, cosmetics, 0, 0, 0, { force: true });
  }

  async leaderboard(limit = 10): Promise<LeaderboardRow[]> {
    if (!this.client) return [];
    try {
      const { data, error } = await this.client.rpc('leaderboard', { p_limit: limit });
      if (error) throw error;
      return (data as LeaderboardRow[]) ?? [];
    } catch (error) {
      console.warn('[backend] leaderboard failed:', describe(error));
      return [];
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
