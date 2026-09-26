/**
 * Multiplayer transport abstraction.
 *
 * Two implementations ship: Supabase Realtime (no server to run or host -- the
 * default) and Socket.io (for local development or self-hosting). The game only
 * ever talks to this interface, so which one is in use is a single env var.
 *
 * The wire format is deliberately tiny and uses a direction + height rather than
 * a world position: a unit vector plus a scalar is both smaller and more
 * meaningful on a sphere, and it lets the receiver re-derive the exact ground
 * height locally instead of trusting a number that may have been sampled on a
 * different frame.
 */

/** What each client broadcasts about itself. Keys are short: this goes out 10x/s. */
export interface PlayerState {
  /** Unit direction on the planet. */
  d: [number, number, number];
  /** Tangent facing vector. */
  f: [number, number, number];
  /** Height of the feet above the ground. */
  h: number;
  /** Horizontal speed, so remote rigs animate at the right cadence. */
  s: number;
  /** Carrying a parcel. */
  c: 0 | 1;
}

/** Identity and cosmetics, sent on join and whenever they change. */
export interface PlayerIdentity {
  name: string;
  outfit: number;
  hat: number;
  skin: number;
}

export interface PeerUpdate extends PlayerState {
  id: string;
  /** Sender's clock, in ms. Used only for ordering and interpolation. */
  t: number;
}

export type NetStatusCallback = (
  status: 'connecting' | 'online' | 'offline' | 'error',
  detail?: string,
) => void;

export interface TransportHandlers {
  onState: (update: PeerUpdate) => void;
  onIdentity: (id: string, identity: PlayerIdentity) => void;
  onEmoji: (id: string, slot: number) => void;
  onLeave: (id: string) => void;
  onStatus: NetStatusCallback;
  /** Total players present, including this client. */
  onPresence: (count: number) => void;
}

export interface NetTransport {
  /** This client's session id. */
  readonly id: string;
  /** Broadcast rate this transport is comfortable with, in Hz. */
  readonly tickRate: number;
  readonly label: string;

  connect(identity: PlayerIdentity): Promise<void>;
  disconnect(): void;
  sendState(state: PlayerState): void;
  sendIdentity(identity: PlayerIdentity): void;
  sendEmoji(slot: number): void;
}

/**
 * Network identity: one per browser TAB, surviving a refresh.
 *
 * Deliberately not the same id as the saved profile. Two tabs of the same
 * browser are two couriers in the world and must not collide in presence --
 * but they are still the same person, and should share one leaderboard row.
 */
export function sessionId(): string {
  const key = 'tpc.session.v1';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return randomId();
  }
}

/** Persistent identity: one per browser, used for the saved profile and score. */
export function profileId(): string {
  const key = 'tpc.profile.v1';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = randomId();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return randomId();
  }
}

export function randomId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `c${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** A transport that does nothing, used when multiplayer is switched off. */
export class OfflineTransport implements NetTransport {
  readonly id = sessionId();
  readonly tickRate = 10;
  readonly label = 'offline';

  constructor(private readonly handlers: TransportHandlers) {}

  async connect(): Promise<void> {
    this.handlers.onStatus('offline');
    this.handlers.onPresence(1);
  }

  disconnect(): void {}
  sendState(): void {}
  sendIdentity(): void {}
  sendEmoji(): void {}
}
