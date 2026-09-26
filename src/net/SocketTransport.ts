/**
 * Socket.io transport, for local development and self-hosting.
 *
 * The matching server lives in `server/src/index.ts`. Compared to the Supabase
 * path this trades "nothing to deploy" for a higher tick rate and a server that
 * can hold authoritative state later if the game ever needs it.
 */
import { io, type Socket } from 'socket.io-client';
import { CONFIG } from '../config';
import type {
  NetTransport,
  PeerUpdate,
  PlayerIdentity,
  PlayerState,
  TransportHandlers,
} from './transport';
import { sessionId } from './transport';

export class SocketTransport implements NetTransport {
  readonly id = sessionId();
  readonly tickRate = CONFIG.net.tickRate;
  readonly label = 'socket.io';

  private socket: Socket | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: TransportHandlers,
  ) {}

  async connect(identity: PlayerIdentity): Promise<void> {
    this.handlers.onStatus('connecting');

    const socket = io(this.url, {
      transports: ['websocket'],
      reconnectionDelay: 1200,
      reconnectionDelayMax: 6000,
      timeout: 5000,
      query: { id: this.id },
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.handlers.onStatus('online');
      socket.emit('hello', { id: this.id, identity });
    });

    socket.on('disconnect', () => this.handlers.onStatus('offline'));
    socket.on('connect_error', (error: Error) => this.handlers.onStatus('error', error.message));

    socket.on('state', (update: PeerUpdate) => {
      if (!update?.id || update.id === this.id) return;
      this.handlers.onState(update);
    });

    socket.on('identity', (data: { id: string; identity: PlayerIdentity }) => {
      if (!data?.id || data.id === this.id) return;
      this.handlers.onIdentity(data.id, data.identity);
    });

    socket.on('emoji', (data: { id: string; slot: number }) => {
      if (!data?.id || data.id === this.id) return;
      this.handlers.onEmoji(data.id, data.slot);
    });

    socket.on('leave', (data: { id: string }) => {
      if (data?.id) this.handlers.onLeave(data.id);
    });

    socket.on('presence', (data: { count: number }) => {
      this.handlers.onPresence(Math.max(1, data?.count ?? 1));
    });

    // Resolve as soon as we are connected, or give up waiting after a moment --
    // a missing dev server should never block the game from starting.
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      socket.once('connect', settle);
      socket.once('connect_error', settle);
      setTimeout(settle, 3500);
    });
  }

  sendState(state: PlayerState): void {
    this.socket?.connected &&
      this.socket.emit('state', { id: this.id, t: Date.now(), ...state } satisfies PeerUpdate);
  }

  sendIdentity(identity: PlayerIdentity): void {
    if (this.socket?.connected) this.socket.emit('identity', { id: this.id, identity });
  }

  sendEmoji(slot: number): void {
    if (this.socket?.connected) this.socket.emit('emoji', { id: this.id, slot });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.handlers.onStatus('offline');
  }
}
