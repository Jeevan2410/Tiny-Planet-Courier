/**
 * The delivery loop.
 *
 * Pick up a parcel at the depot, carry it to a mailbox or a villager, hand it
 * over, repeat. Two things make this work on a sphere:
 *
 *  - A floating beacon over the target, always drawn, so it is visible over the
 *    horizon-line of a small planet.
 *  - A HUD compass fed from a screen-space bearing computed here, because on a
 *    curved world "which way is it" is genuinely hard to answer by eye.
 */
import { Camera, Group, Mesh, Object3D, Vector3 } from 'three';
import { CONFIG } from '../config';
import { addOutline } from '../fx/outline';
import { toonMaterial } from '../fx/toon';
import type { ConfettiField } from '../fx/Particles';
import { getState, type Objective } from '../state/store';
import { mulberry32, type Rng } from '../util/rng';
import { clamp, surfaceDistance } from '../util/sphere';
import type { Planet } from '../world/Planet';
import { beacon } from '../world/props';
import type { DeliveryPoint, Settlements } from '../world/Settlements';
import { ZONE_BY_ID } from '../world/zones';
import { deliveryLine, pickupLine, ZONE_HINTS } from './dialogue';
import type { Villagers } from './NPC';

export type TargetKind = 'depot' | 'mailbox' | 'villager';

interface Target {
  kind: TargetKind;
  name: string;
  zoneName: string;
  /** For mailbox targets. */
  point?: DeliveryPoint;
  /** For villager targets. */
  villager?: number;
}

export interface DeliveryEvents {
  /** A parcel was collected at the depot. */
  onPickup?: (line: string) => void;
  /** A parcel was handed over. `points` includes the streak bonus. */
  onDeliver?: (line: string, points: number, streak: number) => void;
  /** The bonus timer ran out. */
  onExpire?: () => void;
  /** Called when the player is close enough to interact. */
  onPromptChange?: (text: string | null) => void;
}

const _worldPos = new Vector3();
const _screen = new Vector3();
const _right = new Vector3();
const _toTarget = new Vector3();
const _up = new Vector3();

export class Delivery {
  readonly group = new Group();

  private target: Target;
  private carrying = false;
  private timeLeft = 0;
  private streak = 0;
  private readonly rng: Rng;

  private readonly beaconMesh: Mesh;
  private beaconTime = 0;

  constructor(
    private readonly planet: Planet,
    private readonly settlements: Settlements,
    private readonly villagers: Villagers,
    private readonly confetti: ConfettiField,
    private readonly events: DeliveryEvents = {},
    seed = 5150,
  ) {
    this.group.name = 'delivery';
    this.rng = mulberry32(seed);

    this.beaconMesh = new Mesh(beacon(), toonMaterial({ vertexColors: true, tones: 2, name: 'beacon' }));
    this.beaconMesh.name = 'beacon';
    // Always drawn: the whole point is to be findable from across the planet.
    this.beaconMesh.frustumCulled = false;
    this.beaconMesh.renderOrder = 5;
    this.beaconMesh.castShadow = false;
    addOutline(this.beaconMesh, { width: 0.03 });
    this.group.add(this.beaconMesh);

    this.target = { kind: 'depot', name: 'Harborlight Depot', zoneName: 'Harborlight Meadow' };
  }

  // ------------------------------------------------------------------ objective

  /** Begin (or restart) the loop with a trip to the depot. */
  start(): void {
    this.carrying = false;
    this.streak = 0;
    this.setDepotObjective();
  }

  private setDepotObjective(): void {
    this.clearVillagerHold();
    this.target = {
      kind: 'depot',
      name: 'Harborlight Depot',
      zoneName: ZONE_BY_ID.meadow.name,
    };
    this.publishObjective({
      kind: 'pickup',
      text: 'Collect a parcel from the depot',
      target: this.target.name,
      zone: this.target.zoneName,
    });
  }

  private setDeliveryObjective(fromDir: Vector3): void {
    this.clearVillagerHold();

    // Roughly one delivery in three goes to a person rather than a mailbox --
    // enough that the world feels inhabited, rare enough that a moving target
    // stays a novelty.
    const wantsVillager = this.rng() < 0.34 && this.villagers.count > 0;

    if (wantsVillager) {
      const index = this.villagers.pickRecipient(fromDir, CONFIG.gameplay.minTargetSpread);
      if (index >= 0) {
        this.villagers.setWaiting(index, true);
        const zone = this.planet.zoneAt(this.villagers.direction(index));
        this.target = {
          kind: 'villager',
          name: this.villagers.name(index),
          zoneName: zone.name,
          villager: index,
        };
        this.publishObjective({
          kind: 'deliver',
          text: `Hand the parcel to ${this.target.name}`,
          target: this.target.name,
          zone: this.target.zoneName,
        });
        this.timeLeft = CONFIG.gameplay.parcelTimer;
        return;
      }
    }

    const point = this.settlements.pickDeliveryPoint(
      fromDir,
      CONFIG.gameplay.minTargetSpread,
      this.target.point?.id,
    );
    this.target = {
      kind: 'mailbox',
      name: point.name,
      zoneName: point.zoneName,
      point,
    };
    this.publishObjective({
      kind: 'deliver',
      text: `Deliver to ${point.name}`,
      target: point.name,
      zone: point.zoneName,
    });
    this.timeLeft = CONFIG.gameplay.parcelTimer;
  }

  private clearVillagerHold(): void {
    if (this.target?.kind === 'villager' && this.target.villager !== undefined) {
      this.villagers.setWaiting(this.target.villager, false);
    }
  }

  private publishObjective(objective: Objective): void {
    getState().setObjective(objective);
  }

  /** Where the current target is, in world space. */
  targetPosition(out = new Vector3()): Vector3 {
    switch (this.target.kind) {
      case 'depot':
        return out.copy(this.settlements.depotPosition);
      case 'mailbox':
        return out.copy(this.target.point!.position);
      default:
        return this.villagers.position(this.target.villager!, out);
    }
  }

  /** Unit direction of the current target on the planet. */
  targetDirection(out = new Vector3()): Vector3 {
    switch (this.target.kind) {
      case 'depot':
        return out.copy(this.settlements.depotDir);
      case 'mailbox':
        return out.copy(this.target.point!.dir);
      default:
        return out.copy(this.villagers.direction(this.target.villager!));
    }
  }

  get isCarrying(): boolean {
    return this.carrying;
  }

  get currentStreak(): number {
    return this.streak;
  }

  // ---------------------------------------------------------------- interaction

  /**
   * Attempt the context action at the player's position.
   * @returns true when something happened.
   */
  interact(playerDir: Vector3, playerPosition: Vector3, playerUp: Vector3): boolean {
    const distance = surfaceDistance(playerDir, this.targetDirection(_toTarget), this.planet.radius);
    if (distance > CONFIG.gameplay.interactRadius) return false;

    if (!this.carrying) {
      if (this.target.kind !== 'depot') return false;
      this.carrying = true;
      getState().setCarrying(true);
      this.events.onPickup?.(pickupLine(this.rng));
      this.setDeliveryObjective(playerDir);
      return true;
    }

    // Handing over.
    this.carrying = false;
    getState().setCarrying(false);
    this.streak += 1;

    const points = CONFIG.gameplay.scorePerDelivery + (this.streak - 1) * CONFIG.gameplay.streakBonus;
    // A time bonus rewards running rather than strolling.
    const promptness = clamp(this.timeLeft / CONFIG.gameplay.parcelTimer, 0, 1);
    const total = Math.round(points * (1 + promptness * 0.5));

    if (this.target.kind === 'mailbox') this.settlements.pulse(this.target.point!.index);
    this.confetti.burst(_worldPos.copy(playerPosition).addScaledVector(playerUp, 1.2), playerUp, 46);

    // Commit the score BEFORE notifying. The handler persists the run to the
    // backend by reading the store, so notifying first would submit the
    // previous delivery's total.
    getState().addDelivery(total, this.streak);
    this.events.onDeliver?.(deliveryLine(this.rng), total, this.streak);

    this.timeLeft = 0;
    getState().setTimeLeft(0);
    this.setDepotObjective();
    return true;
  }

  /** Human-readable hint about where the target is, for the objective card. */
  targetHint(): string {
    if (this.target.kind === 'depot') return 'in the meadow';
    const zoneId =
      this.target.kind === 'mailbox'
        ? this.target.point!.zoneId
        : this.planet.zoneAt(this.villagers.direction(this.target.villager!)).id;
    return ZONE_HINTS[zoneId] ?? 'somewhere out there';
  }

  // -------------------------------------------------------------------- runtime

  update(
    dt: number,
    playerDir: Vector3,
    camera: Camera,
    cameraForward: Vector3,
    playerUp: Vector3,
  ): void {
    // ---- bonus timer
    if (this.carrying && this.timeLeft > 0) {
      this.timeLeft = Math.max(0, this.timeLeft - dt);
      getState().setTimeLeft(this.timeLeft);
      if (this.timeLeft === 0) {
        // Losing the bonus breaks the streak but never the parcel: being slow
        // should cost points, not force a walk back to the depot empty-handed.
        this.streak = 0;
        getState().resetStreak();
        this.events.onExpire?.();
      }
    }

    // ---- beacon
    this.beaconTime += dt;
    this.targetPosition(_worldPos);
    _up.copy(_worldPos).normalize();
    const hover = 2.3 + Math.sin(this.beaconTime * 2.2) * 0.16;
    this.beaconMesh.position.copy(_worldPos).addScaledVector(_up, hover);
    this.beaconMesh.up.copy(_up);
    // Spin about the local up, staying upright relative to the ground below it.
    this.beaconMesh.quaternion.setFromAxisAngle(_up, this.beaconTime * 1.1);
    const pop = 1 + Math.sin(this.beaconTime * 3.4) * 0.05;
    this.beaconMesh.scale.setScalar(pop);

    // ---- distance, bearing and prompt
    const distance = surfaceDistance(playerDir, this.targetDirection(_toTarget), this.planet.radius);
    const bearing = this.screenBearing(camera, cameraForward, playerUp, _worldPos);
    const offscreen = !this.isOnScreen(camera, _worldPos);
    getState().setTargeting(distance, bearing, offscreen);

    const inRange = distance <= CONFIG.gameplay.interactRadius;
    const promptText = !inRange
      ? null
      : this.carrying
        ? this.target.kind === 'villager'
          ? `Hand over to ${this.target.name}`
          : `Deliver to ${this.target.name}`
        : 'Collect a parcel';
    this.events.onPromptChange?.(promptText);
  }

  /**
   * Angle from the camera's forward to the target, measured in the player's
   * tangent plane. 0 is dead ahead, positive is clockwise on screen.
   */
  private screenBearing(
    _camera: Camera,
    cameraForward: Vector3,
    playerUp: Vector3,
    targetWorld: Vector3,
  ): number {
    _toTarget.copy(targetWorld).sub(_camera.position);
    // Flatten both vectors into the player's tangent plane before comparing.
    _toTarget.addScaledVector(playerUp, -_toTarget.dot(playerUp));
    if (_toTarget.lengthSq() < 1e-8) return 0;
    _toTarget.normalize();

    _right.copy(cameraForward).cross(playerUp).normalize();
    const forwardDot = clamp(_toTarget.dot(cameraForward), -1, 1);
    const rightDot = _toTarget.dot(_right);
    return Math.atan2(rightDot, forwardDot);
  }

  private isOnScreen(camera: Camera, worldPosition: Vector3): boolean {
    _screen.copy(worldPosition).project(camera);
    if (_screen.z > 1) return false;
    return Math.abs(_screen.x) < 0.92 && Math.abs(_screen.y) < 0.92;
  }

  /** Attach point for anything that should ride along with the beacon. */
  get beaconObject(): Object3D {
    return this.beaconMesh;
  }
}
