/**
 * Supabase Realtime transport.
 *
 * Uses one channel with two features:
 *  - `broadcast` for position updates and emoji, with `self: false` so a client
 *    never receives its own packets.
 *  - `presence` for the roster, which also gives us reliable leave events --
 *    broadcast alone cannot tell you that someone closed their tab.
 *
 * Tick rate is deliberately 10Hz rather than the 15Hz the config allows: hosted
 * Realtime meters messages per channel, and 10Hz plus interpolation is
 * indistinguishable in motion while leaving plenty of headroom for a full lobby.
 */
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './supabaseClient';
import type {
  NetTransport,
  PlayerIdentity,
  PlayerState,
  TransportHandlers,
  PeerUpdate,
} from './transport';
import { sessionId } from './transport';

const CHANNEL = 'tiny-planet-courier:lobby';

interface PresenceMeta {
  id: string;
  name: string;
  outfit: number;
  hat: number;
  skin: number;
}

export class SupabaseTransport implements NetTransport {
  readonly id = sessionId();
  readonly tickRate = 10;
  readonly label = 'supabase';

  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private identity: PlayerIdentity = { name: 'Courier', outfit: 0, hat: 0, skin: 1 };
  private joined = false;

  constructor(
    private readonly url: string,
    private readonly anonKey: string,
    private readonly handlers: TransportHandlers,
  ) {}

  async connect(identity: PlayerIdentity): Promise<void> {
    this.identity = identity;
    this.handlers.onStatus('connecting');

    this.client = getSupabaseClient(this.url, this.anonKey);

    const channel = this.client.channel(CHANNEL, {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: this.id },
      },
    });
    this.channel = channel;

    channel.on('broadcast', { event: 'state' }, ({ payload }) => {
      const update = payload as PeerUpdate;
      if (!update?.id || update.id === this.id) return;
      this.handlers.onState(update);
    });

    channel.on('broadcast', { event: 'emoji' }, ({ payload }) => {
      const data = payload as { id: string; slot: number };
      if (!data?.id || data.id === this.id) return;
      this.handlers.onEmoji(data.id, data.slot);
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<PresenceMeta>();
      let count = 0;
      for (const key of Object.keys(state)) {
        count++;
        const meta = state[key]?.[0];
        if (!meta || key === this.id) continue;
        this.handlers.onIdentity(key, {
          name: meta.name ?? 'Courier',
          outfit: meta.outfit ?? 0,
          hat: meta.hat ?? 0,
          skin: meta.skin ?? 1,
        });
      }
      this.handlers.onPresence(Math.max(1, count));
    });

    channel.on('presence', { event: 'leave' }, ({ key }) => {
      if (key === this.id) return;
      this.handlers.onLeave(key);
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      channel.subscribe((status, error) => {
        if (status === 'SUBSCRIBED') {
          this.joined = true;
          this.handlers.onStatus('online');
          void channel.track(this.presencePayload());
          settle();
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          this.joined = false;
          // Not fatal: the game keeps running single-player and Realtime will
          // retry on its own.
          this.handlers.onStatus(status === 'CLOSED' ? 'offline' : 'error', error?.message);
          settle();
        }
      });

      // Never let a slow handshake hold up the game starting.
      setTimeout(settle, 6000);
    });
  }

  private presencePayload(): PresenceMeta {
    return {
      id: this.id,
      name: this.identity.name,
      outfit: this.identity.outfit,
      hat: this.identity.hat,
      skin: this.identity.skin,
    };
  }

  sendState(state: PlayerState): void {
    if (!this.joined || !this.channel) return;
    void this.channel.send({
      type: 'broadcast',
      event: 'state',
      payload: { id: this.id, t: Date.now(), ...state } satisfies PeerUpdate,
    });
  }

  sendIdentity(identity: PlayerIdentity): void {
    this.identity = identity;
    if (!this.joined || !this.channel) return;
    void this.channel.track(this.presencePayload());
  }

  sendEmoji(slot: number): void {
    if (!this.joined || !this.channel) return;
    void this.channel.send({
      type: 'broadcast',
      event: 'emoji',
      payload: { id: this.id, slot },
    });
  }

  disconnect(): void {
    this.joined = false;
    if (this.channel) {
      void this.channel.untrack();
      void this.client?.removeChannel(this.channel);
      this.channel = null;
    }
    this.handlers.onStatus('offline');
  }
}
