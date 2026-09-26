/**
 * Sphere-relative character controller.
 *
 * State is stored as (direction, heightAboveGround) rather than a world
 * position. Walking is a rotation of `dir` about the axis perpendicular to both
 * the local up and the heading -- a great-circle arc -- so the character can
 * never drift off its shell or accumulate error, no matter how far it walks.
 * Jumping and gravity act only on `heightAboveGround`, entirely decoupled from
 * horizontal motion.
 *
 * The world position is then simply `dir * (terrainHeight(dir) + height)`, which
 * means the character tracks the terrain exactly with no raycasting and no
 * penetration to resolve.
 */
import { Quaternion, Vector3 } from 'three';
import { CONFIG } from '../config';
import type { Planet } from '../world/Planet';
import {
  clamp,
  damp,
  moveOnSphere,
  projectOnTangent,
  surfaceQuaternion,
  transportTangent,
} from '../util/sphere';
import type { Input } from './Input';

const _moveDir = new Vector3();
const _camFwd = new Vector3();
const _camRight = new Vector3();
const _nextDir = new Vector3();
const _away = new Vector3();
const _q = new Quaternion();

/** How wet you can get before the game slows you to a wade. */
const WADE_DEPTH = 0.42;

export class CharacterController {
  /** Unit direction of the character on the planet. */
  readonly dir = new Vector3(0, 0, 1);
  /** Local up (identical to `dir`, kept separate for readability). */
  readonly up = new Vector3(0, 0, 1);
  /** Tangent vector the character is facing. */
  readonly facing = new Vector3(1, 0, 0);
  /** World-space position of the character's feet. */
  readonly position = new Vector3();
  /** Orientation that stands the model on the surface, facing `facing`. */
  readonly quaternion = new Quaternion();

  /** Current horizontal speed in world units/second. */
  speed = 0;
  /** Height of the feet above the ground. 0 while grounded. */
  heightAboveGround = 0;
  verticalVelocity = 0;
  airborne = false;
  /** True when standing in water. */
  inWater = false;

  /** Set when the character lands, so audio can play a thud. */
  justLanded = false;

  private blockers: readonly { center: Vector3; radius: number }[] = [];

  constructor(private readonly planet: Planet) {}

  /** Drop the character onto the surface at a direction, facing a tangent. */
  spawn(dir: Vector3, facing?: Vector3): void {
    this.dir.copy(dir).normalize();
    this.up.copy(this.dir);
    this.heightAboveGround = 0;
    this.verticalVelocity = 0;
    this.airborne = false;
    this.speed = 0;

    if (facing) transportTangent(facing, this.up, this.facing);
    else transportTangent(new Vector3(0, 1, 0), this.up, this.facing);

    this.syncTransform();
    surfaceQuaternion(this.up, this.facing, this.quaternion);
  }

  /** Ground radius under the character, accounting for wading in shallow water. */
  private groundHeight(dir: Vector3): number {
    const terrain = this.planet.heightAt(dir);
    const waterFloor = this.planet.seaLevel - WADE_DEPTH;
    return terrain < waterFloor ? waterFloor : terrain;
  }

  /**
   * @param cameraForward the camera's tangent heading, which defines what
   *                      "forward" means for the player's input this frame.
   */
  update(dt: number, input: Input, cameraForward: Vector3): void {
    this.up.copy(this.dir);
    this.justLanded = false;

    // ---- build a movement direction in the tangent plane
    transportTangent(cameraForward, this.up, _camFwd);
    _camRight.copy(_camFwd).cross(this.up).normalize();

    _moveDir.set(0, 0, 0);
    const intent = input.move;
    if (intent.lengthSq() > 1e-5) {
      _moveDir.addScaledVector(_camFwd, intent.y).addScaledVector(_camRight, intent.x);
      projectOnTangent(_moveDir, this.up, _moveDir);
      if (_moveDir.lengthSq() > 1e-8) _moveDir.normalize();
      else _moveDir.set(0, 0, 0);
    }

    const wants = _moveDir.lengthSq() > 1e-8;

    // ---- target speed, modified by terrain and water
    const base = input.run ? CONFIG.player.runSpeed : CONFIG.player.walkSpeed;
    let target = wants ? base * Math.min(1, intent.length()) : 0;

    if (wants) {
      // Uphill costs speed, downhill gives a little back. Sampling the height a
      // short step ahead is a cheap stand-in for a real slope dot product.
      const probeDistance = 0.55;
      _nextDir.copy(this.dir);
      moveOnSphere(_nextDir, _moveDir, probeDistance, this.planet.radius);
      const gradient = (this.groundHeight(_nextDir) - this.groundHeight(this.dir)) / probeDistance;
      target *= clamp(1 - gradient * 0.85, 0.35, 1.18);
    }

    this.inWater = this.planet.heightAt(this.dir) < this.planet.seaLevel;
    if (this.inWater) target *= 0.55;

    // Accelerate toward the target. Deceleration is snappier than acceleration,
    // which reads as responsive without feeling twitchy.
    const rate = target > this.speed ? 0.22 : 0.3;
    this.speed += (target - this.speed) * damp(rate, dt);
    if (this.speed < 0.02) this.speed = 0;

    // ---- advance along a great circle
    if (this.speed > 0 && wants) {
      // dir is a unit vector, so the planet's radius has to be supplied:
      // without it the arc would be measured against a unit sphere.
      moveOnSphere(this.dir, _moveDir, this.speed * dt, this.planet.radius);
      this.dir.normalize();
      this.up.copy(this.dir);
      // The heading must be re-projected into the new tangent plane.
      transportTangent(_moveDir, this.up, this.facing);
    } else {
      transportTangent(this.facing, this.up, this.facing);
    }

    // ---- jump and gravity, purely radial
    if (input.jump && !this.airborne) {
      this.verticalVelocity = CONFIG.player.jumpSpeed * (this.inWater ? 0.7 : 1);
      this.airborne = true;
    }

    if (this.airborne) {
      this.verticalVelocity -= CONFIG.player.gravity * dt;
      this.heightAboveGround += this.verticalVelocity * dt;
      if (this.heightAboveGround <= 0) {
        this.heightAboveGround = 0;
        this.verticalVelocity = 0;
        this.airborne = false;
        this.justLanded = true;
      }
    } else {
      // Glue to the ground, but ease over bumps so small steps do not jolt the
      // camera. Anything sharper than this is a cliff and should be felt.
      this.heightAboveGround *= 1 - damp(0.5, dt);
      if (this.heightAboveGround < 0.001) this.heightAboveGround = 0;
      this.verticalVelocity = 0;
    }

    this.resolveBlockers();
    this.syncTransform();
    this.updateOrientation(dt);
  }

  /**
   * Push the character out of any building they have walked into.
   *
   * Buildings are approximated as discs on the surface and resolved by sliding
   * the character back out along the great circle from the building's centre.
   * That is enough for boxy low-poly houses at walking scale, and it costs a
   * dot product per building instead of a mesh sweep.
   */
  private resolveBlockers(): void {
    if (this.blockers.length === 0) return;
    const radius = this.planet.radius;

    for (let i = 0; i < this.blockers.length; i++) {
      const blocker = this.blockers[i];
      const cos = clamp(this.dir.dot(blocker.center), -1, 1);
      const distance = Math.acos(cos) * radius;
      if (distance >= blocker.radius) continue;

      // Tangent at the building pointing toward us. Degenerate only if we are
      // exactly at the centre, in which case any direction will do.
      _away.copy(this.dir).sub(blocker.center);
      projectOnTangent(_away, blocker.center, _away);
      if (_away.lengthSq() < 1e-10) {
        _away.copy(this.facing);
        projectOnTangent(_away, blocker.center, _away);
        if (_away.lengthSq() < 1e-10) continue;
      }
      _away.normalize();

      this.dir.copy(blocker.center);
      moveOnSphere(this.dir, _away, blocker.radius, radius);
      this.dir.normalize();
      this.up.copy(this.dir);
      transportTangent(this.facing, this.up, this.facing);
      // Bleed off speed so running into a wall does not feel like ice.
      this.speed *= 0.4;
    }
  }

  /** Buildings the character cannot walk through. */
  setBlockers(blockers: readonly { center: Vector3; radius: number }[]): void {
    this.blockers = blockers;
  }

  private syncTransform(): void {
    const ground = this.groundHeight(this.dir);
    this.position.copy(this.dir).multiplyScalar(ground + this.heightAboveGround);
  }

  /**
   * Ease the model's orientation toward the heading. Turning is deliberately
   * not instant: a courier that pivots in zero frames looks like a cursor, not
   * a character.
   */
  private updateOrientation(dt: number): void {
    surfaceQuaternion(this.up, this.facing, _q);
    this.quaternion.slerp(_q, damp(CONFIG.player.turnSpeed / 12, dt));
  }

  /** Look-at point for the camera: roughly the character's head. */
  eyePoint(target = new Vector3()): Vector3 {
    return target.copy(this.position).addScaledVector(this.up, CONFIG.player.headHeight);
  }
}
