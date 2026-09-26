/**
 * Floating emoji reactions.
 *
 * Each reaction is a billboard sprite drawn from a canvas-rendered glyph, so the
 * game ships no image assets for them. Sprites are pooled and follow the
 * character that sent them, which keeps a reaction attached to its author even
 * if they keep running -- the alternative (spawn and forget) looks like a bug
 * when the sender walks out from under their own emoji.
 */
import {
  CanvasTexture,
  Group,
  LinearFilter,
  Object3D,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import { clamp } from '../util/sphere';

/** The reaction wheel. Index is what travels over the network. */
export const EMOJI = ['👋', '❤️', '✨', '😄', '📦', '🎉'] as const;
export type EmojiSlot = number;

interface Active {
  sprite: Sprite;
  life: number;
  ttl: number;
  /** Object to hover above, if the sender is still present. */
  follow: Object3D | null;
  /** Fallback anchor when there is nothing to follow. */
  anchor: Vector3;
  /** Local up at the spawn point, so the emoji rises away from the planet. */
  up: Vector3;
  rise: number;
}

function glyphTexture(glyph: string): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    // A soft disc behind the glyph keeps it readable against bright sky or snow.
    const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5);
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,0.82)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    ctx.font = `${Math.round(size * 0.62)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, size / 2, size * 0.54);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class EmojiField {
  readonly group = new Group();
  private readonly materials: SpriteMaterial[] = [];
  private readonly pool: Sprite[] = [];
  private readonly active: Active[] = [];

  constructor(private readonly capacity = 24) {
    this.group.name = 'emoji';
    for (const glyph of EMOJI) {
      this.materials.push(
        new SpriteMaterial({
          map: glyphTexture(glyph),
          transparent: true,
          depthWrite: false,
          // Reactions should be visible even through a hill: they are social
          // signals, not world objects.
          depthTest: false,
          fog: false,
        }),
      );
    }
  }

  private take(): Sprite | null {
    const sprite = this.pool.pop();
    if (sprite) return sprite;
    if (this.active.length >= this.capacity) return null;
    const created = new Sprite();
    created.renderOrder = 20;
    return created;
  }

  /**
   * Spawn a reaction.
   * @param slot   index into EMOJI
   * @param anchor world position to rise from
   * @param up     local up at that position
   * @param follow object to stay above (usually a character's root)
   */
  spawn(slot: EmojiSlot, anchor: Vector3, up: Vector3, follow: Object3D | null = null): void {
    const material = this.materials[clamp(slot, 0, this.materials.length - 1)];
    const sprite = this.take();
    if (!sprite) return;

    sprite.material = material;
    sprite.scale.setScalar(0.01);
    sprite.position.copy(anchor);
    this.group.add(sprite);

    const ttl = CONFIG.net.emojiLifetimeMs / 1000;
    this.active.push({
      sprite,
      life: ttl,
      ttl,
      follow,
      anchor: anchor.clone(),
      up: up.clone().normalize(),
      rise: 0,
    });
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i];
      entry.life -= dt;

      if (entry.life <= 0) {
        this.group.remove(entry.sprite);
        this.pool.push(entry.sprite);
        this.active.splice(i, 1);
        continue;
      }

      const age = entry.ttl - entry.life;
      entry.rise += dt * 0.45;

      if (entry.follow) {
        entry.follow.getWorldPosition(entry.anchor);
        // Re-derive up from the follow target so the emoji stays overhead as the
        // sender walks around the curve of the planet.
        entry.up.copy(entry.anchor).normalize();
        entry.anchor.addScaledVector(entry.up, 2.05);
      }

      entry.sprite.position.copy(entry.anchor).addScaledVector(entry.up, entry.rise);

      // Pop in with a slight overshoot, hold, then shrink away.
      const popIn = Math.min(1, age / 0.16);
      const overshoot = 1 + Math.sin(popIn * Math.PI) * 0.28;
      const fadeOut = Math.min(1, entry.life / 0.32);
      entry.sprite.scale.setScalar(0.85 * popIn * overshoot * fadeOut);
      entry.sprite.material.opacity = Math.min(1, entry.life / 0.4);
    }
  }

  /** Drop every reaction belonging to a departing player. */
  clearFollowing(target: Object3D): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i].follow !== target) continue;
      this.group.remove(this.active[i].sprite);
      this.pool.push(this.active[i].sprite);
      this.active.splice(i, 1);
    }
  }

  dispose(): void {
    for (const material of this.materials) {
      material.map?.dispose();
      material.dispose();
    }
    this.group.clear();
  }
}
