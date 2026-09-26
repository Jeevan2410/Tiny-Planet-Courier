/**
 * Remote player avatars, with interpolation.
 *
 * Updates arrive ~10 times a second, so avatars are rendered a fixed
 * `interpolationDelayMs` in the past and their transform is interpolated between
 * the two buffered snapshots that straddle that render time. Rendering slightly
 * behind is what buys smoothness: it means there is almost always a *later*
 * snapshot to interpolate toward, so remote couriers glide instead of
 * extrapolating into walls and snapping back.
 *
 * Directions are interpolated as unit vectors and renormalised (the angular step
 * between two 100ms samples is small enough that a slerp would be
 * indistinguishable), and the ground height is re-derived locally from the
 * planet, so remote players always stand exactly on the terrain.
 */
import { CanvasTexture, Group, LinearFilter, Sprite, SpriteMaterial, Vector3 } from 'three';
import { CONFIG } from '../config';
import { Courier } from '../player/Courier';
import type { Cosmetics } from '../state/store';
import { surfaceQuaternion, transportTangent } from '../util/sphere';
import type { Planet } from '../world/Planet';
import type { PeerUpdate, PlayerIdentity } from './transport';

interface Snapshot {
  /** Local receive time in ms; we never trust a remote clock for timing. */
  at: number;
  dir: Vector3;
  facing: Vector3;
  height: number;
  speed: number;
  carrying: boolean;
}

interface Peer {
  id: string;
  identity: PlayerIdentity;
  courier: Courier;
  tag: Sprite | null;
  buffer: Snapshot[];
  lastSeen: number;
  /** Rendered state, so the rig can be posed even between snapshots. */
  dir: Vector3;
  facing: Vector3;
  height: number;
  speed: number;
  spawned: boolean;
}

const _dir = new Vector3();
const _facing = new Vector3();
const _up = new Vector3();
const _position = new Vector3();

function nameTag(text: string): Sprite {
  const padding = 16;
  const font = '600 34px "Inter", "Segoe UI", system-ui, sans-serif';
  const measure = document.createElement('canvas').getContext('2d');
  if (measure) measure.font = font;
  const width = Math.ceil((measure?.measureText(text).width ?? 120) + padding * 2);
  const height = 62;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    // Rounded pill with a soft dark fill: legible against sky, snow and grass.
    const radius = height / 2;
    ctx.fillStyle = 'rgba(24, 30, 42, 0.72)';
    ctx.beginPath();
    ctx.roundRect(0, 8, width, height - 20, radius);
    ctx.fill();

    ctx.font = font;
    ctx.fillStyle = '#f6f1e6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2 - 1);
  }

  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }),
  );
  // Scale to keep the text at a constant aspect ratio.
  const worldHeight = 0.34;
  sprite.scale.set((width / height) * worldHeight, worldHeight, 1);
  sprite.renderOrder = 15;
  return sprite;
}

export class RemotePlayers {
  readonly group = new Group();
  private readonly peers = new Map<string, Peer>();

  constructor(private readonly planet: Planet) {
    this.group.name = 'remotePlayers';
  }

  get count(): number {
    return this.peers.size;
  }

  /** The courier rig for a peer, so emoji can be anchored to them. */
  rigFor(id: string): Group | null {
    return this.peers.get(id)?.courier.root ?? null;
  }

  private ensure(id: string, identity?: PlayerIdentity): Peer {
    const existing = this.peers.get(id);
    if (existing) {
      if (identity) this.applyIdentity(existing, identity);
      return existing;
    }

    const resolved: PlayerIdentity = identity ?? {
      name: 'Courier',
      outfit: 0,
      hat: 0,
      skin: 1,
    };

    const cosmetics: Cosmetics = {
      name: resolved.name,
      outfit: resolved.outfit,
      hat: resolved.hat,
      skin: resolved.skin,
    };

    const courier = new Courier(cosmetics);
    courier.root.visible = false; // until the first snapshot places them
    this.group.add(courier.root);

    const peer: Peer = {
      id,
      identity: resolved,
      courier,
      tag: null,
      buffer: [],
      lastSeen: performance.now(),
      dir: new Vector3(0, 0, 1),
      facing: new Vector3(1, 0, 0),
      height: 0,
      speed: 0,
      spawned: false,
    };
    this.peers.set(id, peer);
    this.setTag(peer, resolved.name);
    return peer;
  }

  private setTag(peer: Peer, name: string): void {
    if (peer.tag) {
      peer.tag.material.map?.dispose();
      peer.tag.material.dispose();
      peer.tag.removeFromParent();
      peer.tag = null;
    }
    const label = (name || 'Courier').slice(0, 18);
    const tag = nameTag(label);
    tag.position.set(0, 2.15, 0);
    peer.courier.root.add(tag);
    peer.tag = tag;
  }

  private applyIdentity(peer: Peer, identity: PlayerIdentity): void {
    const nameChanged = peer.identity.name !== identity.name;
    peer.identity = identity;
    peer.courier.setCosmetics({
      name: identity.name,
      outfit: identity.outfit,
      hat: identity.hat,
      skin: identity.skin,
    });
    if (nameChanged) this.setTag(peer, identity.name);
  }

  onIdentity(id: string, identity: PlayerIdentity): void {
    this.ensure(id, identity);
  }

  onState(update: PeerUpdate): void {
    const peer = this.ensure(update.id);
    peer.lastSeen = performance.now();

    const snapshot: Snapshot = {
      at: performance.now(),
      dir: new Vector3(update.d[0], update.d[1], update.d[2]).normalize(),
      facing: new Vector3(update.f[0], update.f[1], update.f[2]),
      height: update.h,
      speed: update.s,
      carrying: update.c === 1,
    };

    peer.buffer.push(snapshot);
    // Two seconds of history is far more than the interpolation window needs and
    // bounds memory if a peer's packets bunch up.
    while (peer.buffer.length > 24) peer.buffer.shift();

    if (!peer.spawned) {
      peer.spawned = true;
      peer.dir.copy(snapshot.dir);
      peer.facing.copy(snapshot.facing);
      peer.height = snapshot.height;
      peer.courier.root.visible = true;
    }
  }

  onLeave(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.tag?.material.map?.dispose();
    peer.tag?.material.dispose();
    peer.courier.dispose();
    this.peers.delete(id);
  }

  /** Drop peers that have gone quiet (a crashed tab sends no leave event). */
  private prune(now: number): void {
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > CONFIG.net.timeoutMs) this.onLeave(id);
    }
  }

  update(dt: number, cameraPosition: Vector3): void {
    const now = performance.now();
    this.prune(now);

    const renderTime = now - CONFIG.net.interpolationDelayMs;

    for (const peer of this.peers.values()) {
      if (!peer.spawned) continue;
      this.sample(peer, renderTime);

      _dir.copy(peer.dir).normalize();
      _up.copy(_dir);
      const ground = Math.max(this.planet.heightAt(_dir), this.planet.seaLevel - 0.42);
      _position.copy(_dir).multiplyScalar(ground + Math.max(0, peer.height));

      transportTangent(peer.facing, _up, _facing);
      peer.courier.root.position.copy(_position);
      surfaceQuaternion(_up, _facing, peer.courier.root.quaternion);

      peer.courier.setPose(dt, {
        speed: peer.speed,
        airborne: peer.height > 0.08,
        verticalVelocity: 0,
      });

      // Name tags always face the viewer (Sprite does that for us) but should
      // fade out when far away so a crowd does not turn into a wall of labels.
      if (peer.tag) {
        const distance = _position.distanceTo(cameraPosition);
        const opacity = distance > 55 ? 0 : distance > 30 ? 1 - (distance - 30) / 25 : 1;
        peer.tag.material.opacity = opacity;
        peer.tag.visible = opacity > 0.02;
        peer.courier.setLowDetail(distance > 34);
      }
    }
  }

  /** Interpolate a peer's rendered state at `renderTime`. */
  private sample(peer: Peer, renderTime: number): void {
    const buffer = peer.buffer;
    if (buffer.length === 0) return;

    if (buffer.length === 1 || renderTime <= buffer[0].at) {
      const only = buffer[0];
      peer.dir.copy(only.dir);
      peer.facing.copy(only.facing);
      peer.height = only.height;
      peer.speed = only.speed;
      peer.courier.setCarrying(only.carrying);
      return;
    }

    const last = buffer[buffer.length - 1];
    if (renderTime >= last.at) {
      // Ahead of the newest snapshot: hold the last known pose rather than
      // extrapolating. A brief stall reads far better than a rubber-band.
      peer.dir.copy(last.dir);
      peer.facing.copy(last.facing);
      peer.height = last.height;
      peer.speed = last.speed;
      peer.courier.setCarrying(last.carrying);
      return;
    }

    for (let i = buffer.length - 1; i > 0; i--) {
      const b = buffer[i];
      const a = buffer[i - 1];
      if (renderTime < a.at || renderTime > b.at) continue;

      const span = b.at - a.at;
      const t = span <= 0 ? 1 : (renderTime - a.at) / span;
      peer.dir.copy(a.dir).lerp(b.dir, t).normalize();
      peer.facing.copy(a.facing).lerp(b.facing, t);
      peer.height = a.height + (b.height - a.height) * t;
      peer.speed = a.speed + (b.speed - a.speed) * t;
      peer.courier.setCarrying(t < 0.5 ? a.carrying : b.carrying);

      // Drop snapshots we have already interpolated past.
      if (i - 1 > 0) peer.buffer = buffer.slice(i - 1);
      return;
    }
  }

  dispose(): void {
    for (const id of [...this.peers.keys()]) this.onLeave(id);
    this.group.clear();
  }
}
