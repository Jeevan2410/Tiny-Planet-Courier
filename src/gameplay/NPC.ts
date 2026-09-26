/**
 * Villagers: the ambient population, and sometimes the person you are delivering to.
 *
 * Each villager is an instance in one of three InstancedMeshes, so the entire
 * crowd costs six draw calls (three fills, three outlines) however many people
 * are milling about. They are animated by rewriting their instance matrix every
 * frame -- position, orientation, a walk bob and a squash-and-stretch hop -- which
 * is why they get away with having no skeleton.
 *
 * They wander on great circles inside a roaming radius of where they spawned,
 * and freeze politely when they are the active delivery target.
 */
import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { addInstancedOutline } from '../fx/outline';
import { PALETTE, toonMaterial } from '../fx/toon';
import { mulberry32, pick, randRange, type Rng } from '../util/rng';
import {
  anyTangent,
  damp,
  moveOnSphere,
  surfaceDistance,
  surfaceQuaternion,
  transportTangent,
} from '../util/sphere';
import type { Planet } from '../world/Planet';
import { Assembly } from '../world/props';
import type { NpcActivity, NpcSpawn } from '../world/Settlements';
import { idleLine, RECIPIENT_NAMES } from './dialogue';

interface Villager {
  variant: number;
  /** Instance index within its variant's mesh. */
  index: number;
  name: string;
  line: string;

  dir: Vector3;
  home: Vector3;
  facing: Vector3;
  roam: number;

  state: 'idle' | 'walk';
  timer: number;
  target: Vector3;
  speed: number;

  /** Distance-based phase for the walk bob. */
  stride: number;
  /** Set while this villager is the delivery target. */
  waiting: boolean;

  activity: NpcActivity;
  /** Waypoints for a commuter, walked as a loop. */
  route: Vector3[] | null;
  routeIndex: number;
  /** Where a stationary villager is turned to look. */
  facingPoint: Vector3 | null;
  /**
   * 0..1 blend into the activity's pose. Eased rather than snapped so a
   * villager lowers into a crouch instead of popping into one.
   */
  pose: number;
  /** Per-villager phase offset so a crowd does not breathe in unison. */
  phase: number;
}

const WALK_SPEED = 1.35;

const _up = new Vector3();
const _pos = new Vector3();
const _q = new Quaternion();
const _scale = new Vector3();
const _m = new Matrix4();
const _toTarget = new Vector3();
const _poseQ = new Quaternion();
/** Local +X: the model faces +Z, so rotating about X pitches it forward. */
const _pitchAxis = new Vector3(1, 0, 0);

export class Villagers {
  readonly group = new Group();
  private readonly villagers: Villager[] = [];
  private readonly meshes: InstancedMesh[] = [];
  private readonly rng: Rng;

  constructor(
    private readonly planet: Planet,
    seed = 8080,
  ) {
    this.group.name = 'villagers';
    this.rng = mulberry32(seed);
  }

  build(spawns: NpcSpawn[]): void {
    const rng = this.rng;
    const variantCount = 3;
    const geometries: BufferGeometry[] = [];
    for (let v = 0; v < variantCount; v++) geometries.push(buildVillager(rng, v));

    // Assign villagers to variants first, so each mesh can be sized exactly.
    const buckets: Villager[][] = geometries.map(() => []);
    for (const spawn of spawns) {
      const variant = Math.floor(rng() * variantCount) % variantCount;
      const dir = spawn.dir.clone().normalize();
      const facing = anyTangent(dir).applyAxisAngle(dir, rng() * Math.PI * 2);
      const villager: Villager = {
        variant,
        index: buckets[variant].length,
        name: pick(rng, RECIPIENT_NAMES),
        line: idleLine(rng),
        dir,
        home: dir.clone(),
        facing,
        roam: spawn.roam,
        state: 'idle',
        timer: randRange(rng, 0.5, 4),
        target: dir.clone(),
        speed: 0,
        stride: rng() * Math.PI * 2,
        waiting: false,
        activity: spawn.activity ?? 'wander',
        route: spawn.route ? spawn.route.map((w) => w.clone().normalize()) : null,
        routeIndex: 0,
        facingPoint: spawn.facingPoint ? spawn.facingPoint.clone().normalize() : null,
        pose: 0,
        phase: rng() * Math.PI * 2,
      };
      buckets[variant].push(villager);
      this.villagers.push(villager);
    }

    const material = toonMaterial({ vertexColors: true, tones: 3, name: 'villager' });
    const tint = new Color();

    for (let v = 0; v < variantCount; v++) {
      const count = buckets[v].length;
      if (count === 0) {
        geometries[v].dispose();
        this.meshes.push(null as never);
        continue;
      }
      const mesh = new InstancedMesh(geometries[v], material, count);
      mesh.name = `villager.${v}`;
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false;

      // A gentle per-instance tint multiplies the baked vertex colours, so the
      // crowd is not three identical clones repeated.
      for (let i = 0; i < count; i++) {
        const shade = randRange(rng, 0.82, 1.14);
        tint.setRGB(shade, shade * randRange(rng, 0.96, 1.04), shade * randRange(rng, 0.94, 1.06));
        mesh.setColorAt(i, tint);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

      this.meshes.push(mesh);
      this.group.add(mesh, addInstancedOutline(mesh));
    }

    // Seed the transforms so nobody appears at the origin on frame one.
    for (const villager of this.villagers) this.writeMatrix(villager);
    this.flush();
  }

  private writeMatrix(villager: Villager): void {
    const mesh = this.meshes[villager.variant];
    if (!mesh) return;

    _up.copy(villager.dir);
    this.planet.surfacePoint(_up, _pos);

    const moving = villager.speed > 0.05;
    const bob = moving ? Math.abs(Math.sin(villager.stride)) * 0.075 : 0;
    const breathe = moving ? 0 : Math.sin(villager.stride * 0.6 + villager.phase) * 0.012;

    surfaceQuaternion(_up, villager.facing, _q);

    // Squash and stretch: compresses on landing, stretches at the top of the hop.
    const squash = moving ? Math.cos(villager.stride * 2) * 0.05 : 0;
    let scaleY = 1 - squash;
    let lift = bob + breathe - 0.04;
    let pitch = 0;

    // Activity poses. Villagers are instanced, so the only channel available is
    // the instance matrix -- which turns out to be enough: a crouch is a drop,
    // a squash and a forward tilt, and at this scale that reads clearly as
    // somebody kneeling over their planter.
    const pose = villager.pose;
    if (pose > 0.001) {
      const working = Math.sin(villager.stride * 1.6 + villager.phase);
      switch (villager.activity) {
        // The instance matrix scales about the villager's feet, so shrinking Y
        // already lowers the head without moving the origin. An extra downward
        // lift on top of that just buries them to the knees.
        case 'tend':
          lift -= 0.04 * pose;
          scaleY *= 1 - 0.28 * pose;
          pitch += (0.62 + working * 0.09) * pose;
          break;
        case 'sit':
          // Raised onto the bench seat rather than dropped into the ground.
          lift += 0.3 * pose;
          scaleY *= 1 - 0.3 * pose;
          pitch -= 0.08 * pose;
          break;
        default:
          // Chatting: a slow nod and a little weight shift.
          pitch += working * 0.05 * pose;
          lift += Math.sin(villager.stride * 0.9 + villager.phase) * 0.015 * pose;
          break;
      }
      if (pitch !== 0) _q.multiply(_poseQ.setFromAxisAngle(_pitchAxis, pitch));
    }

    _pos.addScaledVector(_up, lift);
    _scale.set(1 + squash, scaleY, 1 + squash);

    _m.compose(_pos, _q, _scale);
    mesh.setMatrixAt(villager.index, _m);
  }

  /**
   * Walk a fixed loop of waypoints. Commuters are what sell a street as a
   * thoroughfare rather than a diorama: somebody is always going somewhere.
   */
  private followRoute(villager: Villager, dt: number): void {
    const route = villager.route;
    if (!route || route.length === 0) return;

    const waypoint = route[villager.routeIndex % route.length];
    const remaining = surfaceDistance(villager.dir, waypoint, this.planet.radius);

    if (remaining < 0.6) {
      villager.routeIndex = (villager.routeIndex + 1) % route.length;
      // A brief pause at each waypoint stops the loop looking mechanical.
      villager.timer = randRange(this.rng, 0.2, 1.6);
    }

    if (villager.timer > 0 && remaining < 1.2) {
      villager.speed += (0 - villager.speed) * damp(0.25, dt);
      return;
    }

    villager.speed += (WALK_SPEED * 1.15 - villager.speed) * damp(0.16, dt);
    _toTarget.copy(waypoint).sub(villager.dir);
    transportTangent(_toTarget, villager.dir, _toTarget);
    moveOnSphere(villager.dir, _toTarget, villager.speed * dt, this.planet.radius);
    villager.dir.normalize();
    transportTangent(_toTarget, villager.dir, villager.facing);
  }

  private flush(): void {
    for (const mesh of this.meshes) {
      if (mesh) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt: number): void {
    for (const villager of this.villagers) {
      villager.timer -= dt;

      // A villager who becomes the delivery target stands up out of whatever
      // they were doing and waits, which reads as being interrupted politely.
      const stationary =
        !villager.waiting &&
        (villager.activity === 'tend' ||
          villager.activity === 'sit' ||
          villager.activity === 'chat');
      villager.pose += (Number(stationary) - villager.pose) * damp(0.09, dt);

      if (villager.waiting || stationary) {
        villager.state = 'idle';
        villager.speed += (0 - villager.speed) * damp(0.3, dt);
        if (villager.facingPoint) {
          _toTarget.copy(villager.facingPoint).sub(villager.dir);
          if (_toTarget.lengthSq() > 1e-9) {
            transportTangent(_toTarget, villager.dir, villager.facing);
          }
        }
      } else if (villager.activity === 'commute' && villager.route) {
        this.followRoute(villager, dt);
      } else if (villager.state === 'idle') {
        villager.speed += (0 - villager.speed) * damp(0.25, dt);
        if (villager.timer <= 0) {
          // Pick a spot inside the roaming radius and walk there.
          const angle = this.rng() * Math.PI * 2;
          const distance = randRange(this.rng, 0.6, villager.roam);
          const tangent = anyTangent(villager.home).applyAxisAngle(villager.home, angle);
          villager.target.copy(villager.home);
          moveOnSphere(villager.target, tangent, distance, this.planet.radius);
          villager.target.normalize();

          // Do not wander into the sea.
          if (this.planet.heightAt(villager.target) > this.planet.seaLevel + 0.2) {
            villager.state = 'walk';
            villager.timer = 6;
          } else {
            villager.timer = randRange(this.rng, 1, 3);
          }
        }
      } else {
        const remaining = surfaceDistance(villager.dir, villager.target, this.planet.radius);
        if (remaining < 0.25 || villager.timer <= 0) {
          villager.state = 'idle';
          villager.timer = randRange(this.rng, 2.5, 7);
        } else {
          villager.speed += (WALK_SPEED - villager.speed) * damp(0.2, dt);

          // Heading: the tangent at our position pointing toward the target.
          _toTarget.copy(villager.target).sub(villager.dir);
          transportTangent(_toTarget, villager.dir, _toTarget);
          moveOnSphere(villager.dir, _toTarget, villager.speed * dt, this.planet.radius);
          villager.dir.normalize();
          transportTangent(_toTarget, villager.dir, villager.facing);
        }
      }

      if (villager.speed > 0.05) villager.stride += villager.speed * dt * 2.4;
      else villager.stride += dt;

      // Keep the facing tangent valid even while standing still.
      transportTangent(villager.facing, villager.dir, villager.facing);
      this.writeMatrix(villager);
    }
    this.flush();
  }

  // --------------------------------------------------------------- queries

  get count(): number {
    return this.villagers.length;
  }

  position(index: number, target = new Vector3()): Vector3 {
    const villager = this.villagers[index];
    return this.planet.surfacePoint(villager.dir, target);
  }

  direction(index: number): Vector3 {
    return this.villagers[index].dir;
  }

  name(index: number): string {
    return this.villagers[index].name;
  }

  line(index: number): string {
    return this.villagers[index].line;
  }

  /** Freeze a villager in place (they are the current delivery target). */
  setWaiting(index: number, waiting: boolean): void {
    const villager = this.villagers[index];
    if (villager) villager.waiting = waiting;
  }

  /** Index of the closest villager within `maxDistance`, or -1. */
  nearest(dir: Vector3, maxDistance: number): number {
    let best = -1;
    let bestDistance = maxDistance;
    for (let i = 0; i < this.villagers.length; i++) {
      const distance = surfaceDistance(dir, this.villagers[i].dir, this.planet.radius);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  /** Pick a villager at least `minDistance` away, for a new objective. */
  pickRecipient(fromDir: Vector3, minDistance: number): number {
    const eligible: number[] = [];
    for (let i = 0; i < this.villagers.length; i++) {
      if (surfaceDistance(fromDir, this.villagers[i].dir, this.planet.radius) >= minDistance) {
        eligible.push(i);
      }
    }
    if (eligible.length === 0) return -1;
    return eligible[Math.floor(this.rng() * eligible.length)];
  }
}

// ------------------------------------------------------------ villager geometry

function buildVillager(rng: Rng, variant: number): BufferGeometry {
  const a = new Assembly();
  const outfit = pick(rng, PALETTE.outfit);
  const skin = pick(rng, PALETTE.skin);
  const hair = pick(rng, PALETTE.hair);
  const height = variant === 2 ? 1.35 : variant === 1 ? 1.62 : 1.5;

  const legH = height * 0.3;
  const bodyH = height * 0.4;

  // Legs, planted slightly apart.
  for (const sx of [-1, 1]) {
    a.add(
      new CylinderGeometry(height * 0.045, height * 0.05, legH, 5),
      shadeHex(outfit, 0.5),
      new Matrix4().makeTranslation(sx * height * 0.07, legH / 2, 0),
    );
    a.block(height * 0.1, height * 0.05, height * 0.13, sx * height * 0.07, height * 0.02, height * 0.02, PALETTE.woodDark);
  }

  // Torso: a slight cone so villagers read as rounder than the player.
  a.add(
    new ConeGeometry(height * 0.19, bodyH, 8),
    outfit,
    new Matrix4().makeTranslation(0, legH + bodyH * 0.44, 0),
  );
  a.block(height * 0.26, height * 0.045, height * 0.2, 0, legH + bodyH * 0.86, 0, shadeHex(outfit, 0.3));

  // Arms held at the sides.
  for (const sx of [-1, 1]) {
    const arm = new CylinderGeometry(height * 0.035, height * 0.032, bodyH * 0.72, 5);
    const m = new Matrix4()
      .makeTranslation(sx * height * 0.17, legH + bodyH * 0.5, 0)
      .multiply(new Matrix4().makeRotationZ(sx * -0.16));
    a.add(arm, outfit, m);
    a.add(
      new SphereGeometry(height * 0.042, 6, 4),
      skin,
      new Matrix4().makeTranslation(sx * height * 0.2, legH + bodyH * 0.16, 0),
    );
  }

  // Head.
  const headY = legH + bodyH + height * 0.1;
  const skull = new SphereGeometry(height * 0.125, 9, 7);
  a.add(skull, skin, new Matrix4().makeTranslation(0, headY, 0));
  for (const sx of [-1, 1]) {
    a.block(height * 0.026, height * 0.036, height * 0.02, sx * height * 0.045, headY + height * 0.012, height * 0.118, 0x2a2b33);
  }

  // Headgear, one per variant so the crowd has silhouette variety.
  if (variant === 0) {
    const cap = new SphereGeometry(height * 0.132, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.55);
    a.add(cap, hair, new Matrix4().makeTranslation(0, headY + height * 0.005, 0));
  } else if (variant === 1) {
    a.add(new CylinderGeometry(height * 0.2, height * 0.21, height * 0.016, 10), pick(rng, [PALETTE.sand, PALETTE.wallAlt]), new Matrix4().makeTranslation(0, headY + height * 0.1, 0));
    a.add(new CylinderGeometry(height * 0.1, height * 0.11, height * 0.08, 8), pick(rng, [PALETTE.sand, PALETTE.wallAlt]), new Matrix4().makeTranslation(0, headY + height * 0.14, 0));
  } else {
    const hood = new SphereGeometry(height * 0.145, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.62);
    a.add(hood, pick(rng, [PALETTE.roofTeal, PALETTE.roofOrange, PALETTE.roofPurple]), new Matrix4().makeTranslation(0, headY - height * 0.01, 0));
  }

  return a.build(`villager.${variant}`);
}

function shadeHex(hex: number, amount: number): number {
  const r = Math.round(((hex >> 16) & 255) * (1 - amount));
  const g = Math.round(((hex >> 8) & 255) * (1 - amount));
  const b = Math.round((hex & 255) * (1 - amount));
  return (r << 16) | (g << 8) | b;
}
