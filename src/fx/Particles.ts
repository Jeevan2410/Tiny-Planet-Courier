/**
 * Confetti bursts for successful deliveries.
 *
 * One InstancedMesh holds the whole pool, so a burst costs no allocations and no
 * extra draw calls -- the pieces that are not alive are simply scaled to zero.
 * Gravity pulls each piece toward the planet's centre rather than "down", which
 * matters: a burst set off near the south pole should still fall onto the ground.
 */
import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import { PALETTE, toonMaterial } from './toon';

interface Piece {
  position: Vector3;
  velocity: Vector3;
  spin: Vector3;
  rotation: Quaternion;
  life: number;
  ttl: number;
  scale: number;
}

const _m = new Matrix4();
const _scale = new Vector3();
const _axis = new Vector3();
const _spinQ = new Quaternion();
const _gravity = new Vector3();

const CONFETTI_COLORS = [
  PALETTE.accent,
  PALETTE.roofRed,
  PALETTE.roofTeal,
  PALETTE.roofBlue,
  0xffffff,
  PALETTE.leafAlt,
] as const;

export class ConfettiField {
  readonly mesh: InstancedMesh;
  private readonly pieces: Piece[] = [];
  private next = 0;
  private live = 0;

  constructor(private readonly capacity = 220) {
    const geometry = new BoxGeometry(0.11, 0.11, 0.02);
    const material = toonMaterial({ vertexColors: true, tones: 2, name: 'confetti' });
    this.mesh = new InstancedMesh(geometry, material, capacity);
    this.mesh.name = 'confetti';
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // Per-instance colour, assigned once: a mixed-colour burst looks festive and
    // costs nothing to keep static.
    const color = new Color();
    for (let i = 0; i < capacity; i++) {
      color.setHex(CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
      this.mesh.setColorAt(i, color);
      this.pieces.push({
        position: new Vector3(),
        velocity: new Vector3(),
        spin: new Vector3(),
        rotation: new Quaternion(),
        life: 0,
        ttl: 1,
        scale: 1,
      });
      this.hide(i);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private hide(index: number): void {
    _m.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(index, _m);
  }

  /**
   * Fire a burst.
   * @param origin world position of the burst
   * @param up     local up at that position (the burst arcs along it)
   * @param count  number of pieces
   */
  burst(origin: Vector3, up: Vector3, count = 44): void {
    for (let i = 0; i < count; i++) {
      const index = this.next;
      this.next = (this.next + 1) % this.capacity;
      const piece = this.pieces[index];

      piece.position.copy(origin);
      // Cone of velocities around the local up.
      _axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
      if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
      _axis.normalize();
      piece.velocity
        .copy(up)
        .multiplyScalar(3.4 + Math.random() * 2.6)
        .addScaledVector(_axis, 1.6 + Math.random() * 2.2);

      piece.spin.set(
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 16,
      );
      piece.rotation.random();
      piece.ttl = 1.5 + Math.random() * 1.1;
      piece.life = piece.ttl;
      piece.scale = 0.7 + Math.random() * 0.8;
      this.live++;
    }
  }

  update(dt: number): void {
    if (this.live <= 0) return;
    let changed = false;

    for (let i = 0; i < this.capacity; i++) {
      const piece = this.pieces[i];
      if (piece.life <= 0) continue;

      piece.life -= dt;
      if (piece.life <= 0) {
        this.hide(i);
        this.live--;
        changed = true;
        continue;
      }

      // Gravity toward the planet's centre, plus a little drag so pieces flutter.
      _gravity.copy(piece.position).normalize().multiplyScalar(-16 * dt);
      piece.velocity.add(_gravity).multiplyScalar(1 - 1.9 * dt);
      piece.position.addScaledVector(piece.velocity, dt);

      _axis.copy(piece.spin);
      const spinLength = _axis.length();
      if (spinLength > 1e-4) {
        _axis.divideScalar(spinLength);
        _spinQ.setFromAxisAngle(_axis, spinLength * dt);
        piece.rotation.premultiply(_spinQ);
      }

      // Fade by shrinking: cheaper and more readable than per-instance alpha.
      const fade = Math.min(1, piece.life / 0.45);
      _scale.setScalar(piece.scale * fade);
      _m.compose(piece.position, piece.rotation, _scale);
      this.mesh.setMatrixAt(i, _m);
      changed = true;
    }

    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
