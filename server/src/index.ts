/**
 * Optional Socket.io relay for self-hosted play.
 *
 * The default deployment uses Supabase Realtime and needs no server at all --
 * this exists for local development (no network round trip to a hosted service)
 * and for anyone who would rather own the realtime layer.
 *
 * It is a pure relay: it holds identity and last-known state so a joining client
 * can be told who is already here, but it does not simulate anything. The
 * clients are authoritative over their own position, which is fine for a
 * co-operative toy with nothing to cheat at.
 *
 * Run with:  npm run server      (Node 22.6+ strips the TypeScript natively)
 */
import { createServer } from 'node:http';
import { Server, type Socket } from 'socket.io';

const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = process.env.CORS_ORIGIN ?? '*';
/** Drop a player this long after their last packet. */
const TIMEOUT_MS = 20_000;

interface PlayerIdentity {
  name: string;
  outfit: number;
  hat: number;
  skin: number;
}

interface PlayerState {
  d: [number, number, number];
  f: [number, number, number];
  h: number;
  s: number;
  c: 0 | 1;
}

interface Player {
  id: string;
  socketId: string;
  identity: PlayerIdentity;
  state: PlayerState | null;
  lastSeen: number;
}

const players = new Map<string, Player>();
/** socket.id -> player id, so a disconnect can find its player. */
const bySocket = new Map<string, string>();

const http = createServer((req, res) => {
  // A tiny health endpoint, which is all a platform like Fly or Railway needs.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, players: players.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(http, {
  cors: { origin: ORIGIN, methods: ['GET', 'POST'] },
  // The client connects with websocket only; skipping the polling upgrade
  // removes a round trip on join.
  transports: ['websocket'],
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

function sanitiseIdentity(raw: unknown): PlayerIdentity {
  const value = (raw ?? {}) as Partial<PlayerIdentity>;
  const clampIndex = (n: unknown, max: number) => {
    const number = Number(n);
    return Number.isFinite(number) ? Math.min(max, Math.max(0, Math.floor(number))) : 0;
  };
  return {
    name: String(value.name ?? 'Courier').slice(0, 18),
    outfit: clampIndex(value.outfit, 15),
    hat: clampIndex(value.hat, 15),
    skin: clampIndex(value.skin, 15),
  };
}

/** Reject malformed state rather than relaying it to every other client. */
function sanitiseState(raw: unknown): PlayerState | null {
  const value = raw as Partial<PlayerState> | null;
  if (!value) return null;
  const vec = (v: unknown): [number, number, number] | null => {
    if (!Array.isArray(v) || v.length !== 3) return null;
    const out = v.map(Number);
    if (out.some((n) => !Number.isFinite(n))) return null;
    return [out[0], out[1], out[2]];
  };
  const d = vec(value.d);
  const f = vec(value.f);
  if (!d || !f) return null;
  const h = Number(value.h);
  const s = Number(value.s);
  return {
    d,
    f,
    h: Number.isFinite(h) ? Math.max(-2, Math.min(40, h)) : 0,
    s: Number.isFinite(s) ? Math.max(0, Math.min(40, s)) : 0,
    c: value.c === 1 ? 1 : 0,
  };
}

function broadcastPresence(): void {
  io.emit('presence', { count: players.size });
}

io.on('connection', (socket: Socket) => {
  socket.on('hello', (payload: { id?: string; identity?: unknown }) => {
    const id = String(payload?.id ?? socket.id).slice(0, 64);
    const identity = sanitiseIdentity(payload?.identity);

    players.set(id, {
      id,
      socketId: socket.id,
      identity,
      state: players.get(id)?.state ?? null,
      lastSeen: Date.now(),
    });
    bySocket.set(socket.id, id);

    // Tell the newcomer about everyone already here, then announce them.
    for (const player of players.values()) {
      if (player.id === id) continue;
      socket.emit('identity', { id: player.id, identity: player.identity });
      if (player.state) socket.emit('state', { id: player.id, t: Date.now(), ...player.state });
    }
    socket.broadcast.emit('identity', { id, identity });
    broadcastPresence();
  });

  socket.on('identity', (payload: { id?: string; identity?: unknown }) => {
    const id = bySocket.get(socket.id);
    if (!id || (payload?.id && payload.id !== id)) return;
    const player = players.get(id);
    if (!player) return;
    player.identity = sanitiseIdentity(payload?.identity);
    player.lastSeen = Date.now();
    socket.broadcast.emit('identity', { id, identity: player.identity });
  });

  socket.on('state', (payload: unknown) => {
    const id = bySocket.get(socket.id);
    if (!id) return;
    const player = players.get(id);
    if (!player) return;

    const state = sanitiseState(payload);
    if (!state) return;
    player.state = state;
    player.lastSeen = Date.now();

    // Relay with the server's clock so clients never depend on a peer's.
    socket.broadcast.volatile.emit('state', { id, t: Date.now(), ...state });
  });

  socket.on('emoji', (payload: { slot?: unknown }) => {
    const id = bySocket.get(socket.id);
    if (!id) return;
    const slot = Number(payload?.slot);
    if (!Number.isFinite(slot) || slot < 0 || slot > 11) return;
    socket.broadcast.emit('emoji', { id, slot: Math.floor(slot) });
  });

  socket.on('disconnect', () => {
    const id = bySocket.get(socket.id);
    bySocket.delete(socket.id);
    if (!id) return;
    // Only drop the player if this socket is still the one that owns them
    // (a quick reconnect can arrive before the old disconnect).
    if (players.get(id)?.socketId === socket.id) {
      players.delete(id);
      io.emit('leave', { id });
      broadcastPresence();
    }
  });
});

// Sweep players whose sockets vanished without a disconnect event.
setInterval(() => {
  const now = Date.now();
  for (const [id, player] of players) {
    if (now - player.lastSeen <= TIMEOUT_MS) continue;
    players.delete(id);
    bySocket.delete(player.socketId);
    io.emit('leave', { id });
  }
  broadcastPresence();
}, 5000).unref?.();

http.listen(PORT, () => {
  console.log(`[tiny-planet-courier] realtime relay listening on :${PORT}`);
  console.log(`  health: http://localhost:${PORT}/health`);
});
