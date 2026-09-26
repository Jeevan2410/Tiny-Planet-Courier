/**
 * Everything built by hand(-ish) on the planet: the depot, the town, three
 * hamlets and the industrial works, plus the mailboxes that are the delivery
 * loop's destinations.
 *
 * Two performance decisions shape this file:
 *
 *  - Static scenery (houses, towers, lamp posts, fences) is merged into ONE
 *    geometry per settlement. A settlement is therefore 2 draw calls (fill +
 *    outline) no matter how many buildings it contains, and because each merged
 *    mesh has a tight bounding sphere, settlements on the far side of the planet
 *    are frustum-culled for free.
 *
 *  - Mailboxes share a single InstancedMesh, so the ~26 of them cost 2 draw
 *    calls while still being individually animatable by rewriting one instance
 *    matrix.
 */
import {
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshToonMaterial,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { PALETTE, toonMaterial } from '../fx/toon';
import { addInstancedOutline, addOutline } from '../fx/outline';
import { houseName } from '../gameplay/dialogue';
import { mulberry32, pick, randRange, type Rng } from '../util/rng';
import { anyTangent, projectOnTangent, surfaceQuaternion } from '../util/sphere';
import type { Planet } from './Planet';
import * as props from './props';
import type { ExclusionZone } from './Scatter';
import { ZONE_BY_ID } from './zones';

export interface DeliveryPoint {
  id: string;
  name: string;
  /** Unit direction on the planet. */
  dir: Vector3;
  /** World-space point on the ground. */
  position: Vector3;
  zoneId: string;
  zoneName: string;
  /** Index into the shared mailbox InstancedMesh. */
  index: number;
}

/**
 * A solid building, approximated as a disc on the surface. Boxy low-poly houses
 * are close enough to round at walking scale that a per-face collider would be
 * a lot of work for no visible gain.
 */
export interface Blocker {
  /** Unit direction of the building's centre. */
  center: Vector3;
  /** Footprint radius in world units. */
  radius: number;
}

/**
 * What a villager is doing with their day.
 *
 * "wander" is the old aimless drift. The others exist because a town full of
 * people milling about at random reads as a screensaver -- somebody kneeling
 * over a planter or walking a fixed route with purpose is what makes a place
 * look inhabited.
 */
export type NpcActivity = 'wander' | 'commute' | 'tend' | 'sit' | 'chat';

export interface NpcSpawn {
  dir: Vector3;
  /** Radius in world units the NPC will wander inside. */
  roam: number;
  activity?: NpcActivity;
  /** Waypoints for a 'commute' villager, walked as a loop. */
  route?: Vector3[];
  /** Who a 'chat' villager is turned toward. */
  facingPoint?: Vector3;
}

/**
 * A tangent-plane coordinate system at a point on the sphere, so settlements can
 * be laid out in familiar "x metres east, y metres north" terms. Offsets are
 * projected back onto the sphere, which is exact enough at settlement scale
 * (a 10-unit offset on a radius-22 planet bends by a few centimetres).
 */
export class LocalFrame {
  readonly center: Vector3;
  readonly east = new Vector3();
  readonly north = new Vector3();

  constructor(center: Vector3, private readonly radius: number) {
    this.center = center.clone().normalize();
    anyTangent(this.center, this.north);
    this.east.copy(this.north).cross(this.center).normalize();
  }

  /** Direction for a local offset in world units. */
  at(x: number, y: number, target = new Vector3()): Vector3 {
    return target
      .copy(this.center)
      .addScaledVector(this.east, x / this.radius)
      .addScaledVector(this.north, y / this.radius)
      .normalize();
  }

  /** Same as `at`, in polar terms. */
  ring(angle: number, distance: number, target = new Vector3()): Vector3 {
    return this.at(Math.cos(angle) * distance, Math.sin(angle) * distance, target);
  }
}

interface SettlementSpec {
  id: string;
  zoneId: string;
  /** Local offset from the zone centre, in world units. */
  offset: [number, number];
  /** Angular radius of the levelled terrace. */
  terrace: number;
  kind: 'town' | 'hamlet' | 'works';
}

const SETTLEMENTS: SettlementSpec[] = [
  { id: 'harborlight', zoneId: 'meadow', offset: [0, 0], terrace: 0.46, kind: 'town' },
  { id: 'cogford', zoneId: 'works', offset: [0, 0], terrace: 0.22, kind: 'works' },
  { id: 'pinewood', zoneId: 'forest', offset: [3, -4], terrace: 0.14, kind: 'hamlet' },
  { id: 'sunbell', zoneId: 'dunes', offset: [-2, 3], terrace: 0.13, kind: 'hamlet' },
  { id: 'frostcap', zoneId: 'frost', offset: [2, -3], terrace: 0.13, kind: 'hamlet' },
];

/** Radius of the town's ring road, in world units from the village green. */
const RING_RADIUS = 6.8;
const TOWN_HOUSES = 10;
/** Half the depth of a standard house, so wall-mounted props land on the wall. */
const HOUSE_HALF_DEPTH = 1.1;
/** Fixed so the roads laid in reserve() line up with the houses built later. */
const houseAngle = (i: number) => (i / TOWN_HOUSES) * Math.PI * 2 + 0.22;

const _up = new Vector3();
const _pos = new Vector3();
const _q = new Quaternion();
const _scale = new Vector3(1, 1, 1);
const _m = new Matrix4();

interface Pulse {
  index: number;
  elapsed: number;
}

export class Settlements {
  readonly group = new Group();

  depotDir = new Vector3(0, 0, 1);
  depotPosition = new Vector3();
  /** Where the player is dropped in at the start. */
  spawnDir = new Vector3(0, 0, 1);

  readonly deliveryPoints: DeliveryPoint[] = [];
  readonly npcSpawns: NpcSpawn[] = [];
  readonly exclusions: ExclusionZone[] = [];
  readonly blockers: Blocker[] = [];

  private readonly rng: Rng;
  private readonly sites = new Map<string, LocalFrame>();

  /** Merged static scenery, one entry per settlement. */
  private readonly staticParts = new Map<string, BufferGeometry[]>();
  private mailboxMatrices: Matrix4[] = [];
  private mailboxMesh: InstancedMesh | null = null;
  private lampParts: BufferGeometry[] = [];
  private lampMaterial: MeshToonMaterial | null = null;
  private windmillBlades: Object3D | null = null;
  private readonly pulses: Pulse[] = [];

  constructor(
    private readonly planet: Planet,
    seed = CONFIG.planet.seed + 4242,
  ) {
    this.group.name = 'settlements';
    this.rng = mulberry32(seed);
  }

  // ------------------------------------------------------------------- reserve

  /**
   * Pick sites and level the ground under them. Must run before `Planet.build()`
   * so the terrain mesh is generated with the terraces already in it.
   */
  reserve(): void {
    for (const spec of SETTLEMENTS) {
      const zone = ZONE_BY_ID[spec.zoneId];
      const zoneFrame = new LocalFrame(zone.center, this.planet.radius);
      const wanted = zoneFrame.at(spec.offset[0], spec.offset[1]);
      const site = this.findBuildableSite(wanted);
      this.planet.addFlatSpot(site, spec.terrace);
      this.sites.set(spec.id, new LocalFrame(site, this.planet.radius));
    }

    const town = this.sites.get('harborlight')!;
    this.depotDir.copy(town.at(0, 3.4));
    this.spawnDir.copy(town.at(0, 0.4));
    this.layStreets(town);
  }

  /**
   * Lay the town's roads. These are painted into the terrain's vertex colours,
   * so they have to be registered before the planet mesh is generated.
   *
   * House angles are fixed rather than random precisely so this can run before
   * `buildTown` and still line the driveways up with the houses.
   */
  private layStreets(town: LocalFrame): void {
    // The ring road: sits between the village green and the houses.
    const ring: Vector3[] = [];
    const segments = 30;
    for (let i = 0; i <= segments; i++) {
      ring.push(town.ring((i / segments) * Math.PI * 2, RING_RADIUS));
    }
    this.planet.addPath(ring, 1.15);

    // Spur from the ring up to the depot forecourt.
    this.planet.addPath([town.at(0, RING_RADIUS), town.at(0, 4.5)], 0.95);

    // A driveway out to each house plot.
    for (let i = 0; i < TOWN_HOUSES; i++) {
      const angle = houseAngle(i);
      this.planet.addPath(
        [town.ring(angle, RING_RADIUS - 0.3), town.ring(angle, 8.5)],
        0.5,
        0.35,
      );
    }
  }

  /**
   * Spiral outward from a wanted direction until the ground is dry, gentle and
   * high enough to build on. Without this, a zone whose noise happens to dip
   * could put a village in the sea.
   */
  private findBuildableSite(wanted: Vector3): Vector3 {
    const candidate = wanted.clone().normalize();
    if (this.isBuildable(candidate)) return candidate;

    const frame = new LocalFrame(candidate, this.planet.radius);
    const probe = new Vector3();
    for (let ring = 1; ring <= 8; ring++) {
      const distance = ring * 2.2;
      const steps = 6 + ring * 3;
      for (let i = 0; i < steps; i++) {
        frame.ring((i / steps) * Math.PI * 2, distance, probe);
        if (this.isBuildable(probe)) return probe.clone();
      }
    }
    // Nothing better nearby: build anyway rather than fail to generate a world.
    return candidate;
  }

  private isBuildable(dir: Vector3): boolean {
    const height = this.planet.heightAt(dir);
    if (height - this.planet.seaLevel < 0.7) return false;
    return this.planet.slopeAt(dir) < 0.2;
  }

  // --------------------------------------------------------------------- build

  build(): void {
    for (const spec of SETTLEMENTS) {
      const frame = this.sites.get(spec.id)!;
      const zone = ZONE_BY_ID[spec.zoneId];
      if (spec.kind === 'town') this.buildTown(spec, frame, zone.id, zone.name);
      else if (spec.kind === 'works') this.buildWorks(spec, frame, zone.id, zone.name);
      else this.buildHamlet(spec, frame, zone.id, zone.name);
    }

    this.buildDepot();
    this.finishStatics();
    this.finishLamps();
    this.finishMailboxes();
  }

  // ---------------------------------------------------------------- placement

  /** Tangent direction at `from` pointing along the surface toward `to`. */
  private facingToward(from: Vector3, to: Vector3, target = new Vector3()): Vector3 {
    _up.copy(from).normalize();
    target.copy(to).normalize().sub(_up);
    projectOnTangent(target, _up, target);
    if (target.lengthSq() < 1e-8) return anyTangent(_up, target);
    return target.normalize();
  }

  /** Compose the world matrix for a prop standing on the surface. */
  private surfaceMatrix(dir: Vector3, facing: Vector3, lift = 0, scale = 1): Matrix4 {
    _up.copy(dir).normalize();
    this.planet.surfacePoint(_up, _pos).addScaledVector(_up, lift);
    surfaceQuaternion(_up, facing, _q);
    _scale.setScalar(scale);
    return new Matrix4().compose(_pos, _q, _scale);
  }

  /** Queue a prop into a settlement's merged static geometry. */
  private addStatic(
    settlementId: string,
    geometry: BufferGeometry,
    dir: Vector3,
    facing: Vector3,
    lift = 0,
    scale = 1,
  ): void {
    const clone = geometry.clone();
    clone.applyMatrix4(this.surfaceMatrix(dir, facing, lift, scale));
    let bucket = this.staticParts.get(settlementId);
    if (!bucket) this.staticParts.set(settlementId, (bucket = []));
    bucket.push(clone);
  }

  /** Mark a building solid so the player cannot walk through it. */
  private addBlocker(dir: Vector3, radius: number): void {
    this.blockers.push({ center: dir.clone().normalize(), radius });
  }

  private exclude(dir: Vector3, worldRadius: number, scope: 'all' | 'large' = 'all'): void {
    this.exclusions.push({
      center: dir.clone().normalize(),
      radius: worldRadius / this.planet.radius,
      scope,
    });
  }

  private addMailbox(dir: Vector3, facing: Vector3, zoneId: string, zoneName: string): void {
    const index = this.mailboxMatrices.length;
    this.mailboxMatrices.push(this.surfaceMatrix(dir, facing, -0.05));
    const position = this.planet.surfacePoint(dir);
    this.deliveryPoints.push({
      id: `mb${index}`,
      name: houseName(this.rng),
      dir: dir.clone().normalize(),
      position,
      zoneId,
      zoneName,
      index,
    });
    this.exclude(dir, 1.1);
  }

  private addLamp(dir: Vector3, facing: Vector3): void {
    this.addStatic('lampposts', props.lamp(), dir, facing, -0.05);
    // Bulb goes in its own batch so it can glow at night.
    const bulb = props.beacon();
    bulb.scale(0.45, 0.45, 0.45);
    bulb.applyMatrix4(this.surfaceMatrix(dir, facing, 2.42));
    this.lampParts.push(bulb);
    this.exclude(dir, 0.9);
  }

  // --------------------------------------------------------------- settlements

  private buildTown(spec: SettlementSpec, frame: LocalFrame, zoneId: string, zoneName: string): void {
    const rng = this.rng;
    const plaza = frame.center;
    const dir = new Vector3();

    // Ring of houses facing the plaza, one per driveway.
    const houseCount = TOWN_HOUSES;
    for (let i = 0; i < houseCount; i++) {
      const angle = houseAngle(i);
      const distance = randRange(rng, 8.4, 10.4);
      frame.ring(angle, distance, dir);
      if (!this.isBuildable(dir)) continue;

      const facing = this.facingToward(dir, plaza);
      this.addStatic(spec.id, props.house(rng, { storeys: rng() < 0.35 ? 2 : 1 }), dir, facing, -0.1);
      this.exclude(dir, 2.6);
      this.addBlocker(dir, 1.65);

      // Mailbox at the end of the garden path, turned to face the road.
      const boxDir = frame.ring(angle, distance - 2.9, new Vector3());
      this.addMailbox(boxDir, this.facingToward(boxDir, plaza, new Vector3()), zoneId, zoneName);

      if (rng() < 0.5) {
        const fenceDir = frame.ring(angle + 0.055, distance - 1.6, new Vector3());
        this.addStatic(spec.id, props.fence(), fenceDir, this.facingToward(fenceDir, plaza), -0.05);
      }

      // Doorstep dressing. This has to live here, where the plot's actual
      // distance is known: placing it at a fixed radius left wall-mounted props
      // hanging in mid-air in front of the houses set further back.
      const frontWall = distance - HOUSE_HALF_DEPTH;

      if (rng() < 0.62) {
        const potDir = frame.ring(angle + 0.04, frontWall - 0.5, new Vector3());
        this.addStatic(spec.id, props.planter(rng), potDir, this.facingToward(potDir, plaza), -0.03);
      }
      if (rng() < 0.4) {
        const binDir = frame.ring(angle - 0.05, frontWall - 0.45, new Vector3());
        this.addStatic(spec.id, props.wheelieBin(rng), binDir, this.facingToward(binDir, plaza), -0.03);
      }
      if (rng() < 0.35) {
        // Bolted to the front wall, just above the door.
        const acDir = frame.ring(angle + 0.06, frontWall - 0.06, new Vector3());
        this.addStatic(spec.id, props.airConditioner(), acDir, this.facingToward(acDir, plaza), 1.55);
      }
      if (rng() < 0.28) {
        const shopDir = frame.ring(angle, frontWall - 0.04, new Vector3());
        this.addStatic(spec.id, props.shopFront(rng), shopDir, this.facingToward(shopDir, plaza), -0.05);
      }
    }

    // Keep the village green free of trees and boulders, but let the grass and
    // pebbles through so it still reads as a lawn rather than a bald patch.
    this.exclude(plaza, 8.2, 'large');

    // Plaza furniture.
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      this.addLamp(frame.ring(angle, 3.6, dir), this.facingToward(dir, plaza));
    }
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + 0.4;
      frame.ring(angle, 2.1, dir);
      this.addStatic(spec.id, props.bench(), dir, this.facingToward(dir, plaza), -0.04);
      this.exclude(dir, 1.1);
    }

    // Landmarks: readable from anywhere on this side of the planet, which is how
    // you navigate a world with no map.
    const towerDir = frame.at(12.5, -7.5, new Vector3());
    if (this.isBuildable(towerDir)) {
      this.addStatic(spec.id, props.waterTower(), towerDir, this.facingToward(towerDir, plaza), -0.15);
      this.exclude(towerDir, 2.4);
      this.addBlocker(towerDir, 1.0);
    }

    const millDir = frame.at(-12.5, -6, new Vector3());
    if (this.isBuildable(millDir)) {
      const { tower, blades } = props.windmill();
      this.addStatic(spec.id, tower, millDir, this.facingToward(millDir, plaza), -0.15);
      this.exclude(millDir, 2.6);
      this.addBlocker(millDir, 0.95);

      // Blades live outside the merged batch so they can turn.
      const hub = new Group();
      hub.name = 'windmill.hub';
      hub.applyMatrix4(this.surfaceMatrix(millDir, this.facingToward(millDir, plaza)));
      const bladeMesh = new Mesh(blades, toonMaterial({ vertexColors: true, name: 'windmillBlades' }));
      bladeMesh.name = 'windmillBlades';
      bladeMesh.castShadow = true;
      bladeMesh.position.set(0, 2.95, 0.72);
      addOutline(bladeMesh);
      hub.add(bladeMesh);
      this.group.add(hub);
      this.windmillBlades = bladeMesh;
    }

    // A handful of signposts pointing outward.
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2 + 1.1;
      frame.ring(angle, 5.2, dir);
      this.addStatic(spec.id, props.signpost(rng), dir, this.facingToward(dir, plaza), -0.05);
    }

    this.dressStreets(spec, frame, rng);
    this.populateTown(frame, rng);
  }

  /**
   * Give the town a population that is visibly doing something.
   *
   * A crowd of aimless wanderers reads as a screensaver. A few commuters
   * walking a fixed loop, somebody kneeling over a verge, a pair talking on the
   * green and two people sat on benches is a far smaller number of villagers
   * doing far more work.
   */
  private populateTown(frame: LocalFrame, rng: Rng): void {
    const plaza = frame.center;

    // Commuters walking the ring road. They share one loop of waypoints but
    // start at different points around it, so they spread out naturally.
    const route: Vector3[] = [];
    const stops = 8;
    for (let i = 0; i < stops; i++) {
      route.push(frame.ring((i / stops) * Math.PI * 2, RING_RADIUS).clone());
    }
    for (let i = 0; i < 3; i++) {
      const start = Math.floor((i / 3) * stops);
      this.npcSpawns.push({
        dir: route[start].clone(),
        roam: 0,
        activity: 'commute',
        route: route.map((w) => w.clone()),
      });
    }

    // Somebody tending the verge outside a couple of the plots.
    for (const plot of [2, 6]) {
      const dir = frame.ring(houseAngle(plot) + 0.08, RING_RADIUS + 1.1, new Vector3());
      if (!this.isBuildable(dir)) continue;
      this.npcSpawns.push({
        dir,
        roam: 0,
        activity: 'tend',
        facingPoint: frame.ring(houseAngle(plot) + 0.08, RING_RADIUS + 2.2, new Vector3()),
      });
    }

    // Two people talking on the green, turned toward each other.
    const a = frame.at(-1.4, -2.2, new Vector3());
    const b = frame.at(-0.35, -2.5, new Vector3());
    this.npcSpawns.push({ dir: a.clone(), roam: 0, activity: 'chat', facingPoint: b.clone() });
    this.npcSpawns.push({ dir: b.clone(), roam: 0, activity: 'chat', facingPoint: a.clone() });

    // Sitting on the plaza benches, facing out across the green.
    for (const i of [0, 2]) {
      const angle = (i / 4) * Math.PI * 2 + 0.4;
      const dir = frame.ring(angle, 2.1, new Vector3());
      this.npcSpawns.push({
        dir,
        roam: 0,
        activity: 'sit',
        facingPoint: plaza.clone(),
      });
    }

    // A couple of genuine wanderers, so the town is not entirely choreographed.
    for (let i = 0; i < 2; i++) {
      this.npcSpawns.push({
        dir: frame.ring(i * 2.7 + 0.9, randRange(rng, 3.2, 5.2)).clone(),
        roam: 3.0,
      });
    }
  }

  /**
   * Incidental street detail along the ring road.
   *
   * This is the difference between "houses on a lawn" and somewhere people
   * live: poles and wires overhead, bins and planters by the doors, a vending
   * machine humming on a corner. All of it merges into the settlement's single
   * static batch, so the whole pass costs zero extra draw calls.
   */
  private dressStreets(spec: SettlementSpec, frame: LocalFrame, rng: Rng): void {
    const plaza = frame.center;
    const dir = new Vector3();
    const outward = new Vector3();

    // Utility poles just outside the kerb, spaced around the ring.
    const poleCount = 7;
    for (let i = 0; i < poleCount; i++) {
      const angle = (i / poleCount) * Math.PI * 2 + 0.15;
      frame.ring(angle, RING_RADIUS + 1.5, dir);
      if (!this.isBuildable(dir)) continue;
      this.addStatic(spec.id, props.utilityPole(rng), dir, this.facingToward(dir, plaza), -0.2);
      this.addBlocker(dir, 0.35);
    }

    // Manhole covers down the middle of the carriageway.
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + 0.55;
      frame.ring(angle, RING_RADIUS, dir);
      this.addStatic(spec.id, props.manhole(), dir, this.facingToward(dir, plaza), -0.01);
    }

    // A corner with a vending machine, a postbox and a couple of cones.
    const corner = frame.ring(1.9, RING_RADIUS + 1.0, new Vector3());
    if (this.isBuildable(corner)) {
      outward.copy(this.facingToward(corner, plaza)).negate();
      this.addStatic(spec.id, props.vendingMachine(rng), corner, outward, -0.05);
      this.addBlocker(corner, 0.6);
    }

    const boxDir = frame.at(2.1, 4.6, new Vector3());
    if (this.isBuildable(boxDir)) {
      this.addStatic(spec.id, props.postbox(), boxDir, this.facingToward(boxDir, plaza), -0.05);
      this.addBlocker(boxDir, 0.4);
    }

    for (const [x, y] of [[-2.6, 5.3], [-2.2, 5.9]] as const) {
      const coneDir = frame.at(x, y, new Vector3());
      this.addStatic(spec.id, props.trafficCone(), coneDir, this.facingToward(coneDir, plaza), -0.02);
    }

    // Low walls edging the depot forecourt.
    for (const [x, y] of [[-3.4, 4.6], [3.4, 4.6]] as const) {
      const wallDir = frame.at(x, y, new Vector3());
      if (!this.isBuildable(wallDir)) continue;
      this.addStatic(spec.id, props.lowWall(rng), wallDir, this.facingToward(wallDir, this.depotDir), -0.05);
    }
  }

  private buildHamlet(spec: SettlementSpec, frame: LocalFrame, zoneId: string, zoneName: string): void {
    const rng = this.rng;
    const centre = frame.center;
    const dir = new Vector3();
    const houseCount = 4;

    const roof =
      zoneId === 'frost'
        ? PALETTE.roofBlue
        : zoneId === 'dunes'
          ? PALETTE.roofOrange
          : PALETTE.roofTeal;

    for (let i = 0; i < houseCount; i++) {
      const angle = (i / houseCount) * Math.PI * 2 + 0.5;
      const distance = randRange(rng, 4.2, 5.6);
      frame.ring(angle, distance, dir);
      if (!this.isBuildable(dir)) continue;

      const facing = this.facingToward(dir, centre);
      this.addStatic(spec.id, props.house(rng, { roof, chimney: true }), dir, facing, -0.1);
      this.exclude(dir, 2.4);
      this.addBlocker(dir, 1.6);

      const boxDir = frame.ring(angle, distance - 2.0, new Vector3());
      this.addMailbox(boxDir, this.facingToward(boxDir, centre, new Vector3()), zoneId, zoneName);
    }

    // Clear the middle of the hamlet of trees so the houses face open ground.
    this.exclude(centre, 4.5, 'large');

    this.addLamp(frame.at(0, 0, dir), this.facingToward(dir, frame.at(0, 3)));
    this.addStatic(spec.id, props.bench(), frame.at(1.4, -0.9, dir), this.facingToward(dir, centre), -0.04);
    this.addStatic(spec.id, props.signpost(rng), frame.at(-1.6, 1.2, dir), this.facingToward(dir, centre), -0.05);

    for (let i = 0; i < 2; i++) {
      this.npcSpawns.push({
        dir: frame.ring(i * 2.4, randRange(rng, 1.6, 3.2)).clone(),
        roam: 2.6,
      });
    }
  }

  private buildWorks(spec: SettlementSpec, frame: LocalFrame, zoneId: string, zoneName: string): void {
    const rng = this.rng;
    const centre = frame.center;
    const dir = new Vector3();

    // Two cooling towers and two stacks make the skyline unmistakable.
    for (const [x, y] of [[-4.2, 3.0], [3.6, 3.6]] as const) {
      frame.at(x, y, dir);
      if (!this.isBuildable(dir)) continue;
      this.addStatic(spec.id, props.coolingTower(rng), dir, this.facingToward(dir, centre), -0.2);
      this.exclude(dir, 3.2);
      this.addBlocker(dir, 1.35);
    }
    for (const [x, y] of [[-1.0, 5.4], [6.4, 0.4]] as const) {
      frame.at(x, y, dir);
      if (!this.isBuildable(dir)) continue;
      this.addStatic(spec.id, props.smokestack(rng), dir, this.facingToward(dir, centre), -0.2);
      this.exclude(dir, 2.0);
      this.addBlocker(dir, 0.55);
    }

    // Sheds: wide, low, metal-roofed.
    for (const [x, y] of [[-5.0, -3.2], [0.4, -5.0], [5.2, -3.4]] as const) {
      frame.at(x, y, dir);
      if (!this.isBuildable(dir)) continue;
      const facing = this.facingToward(dir, centre);
      this.addStatic(
        spec.id,
        props.house(rng, {
          width: randRange(rng, 3.4, 4.4),
          depth: randRange(rng, 2.8, 3.4),
          storeys: 1,
          roof: PALETTE.metalDark,
          wall: PALETTE.wallAlt,
          roofStyle: 'pyramid',
          chimney: false,
        }),
        dir,
        facing,
        -0.12,
      );
      this.exclude(dir, 3.0);
      this.addBlocker(dir, 2.0);

      const boxDir = frame.at(x * 0.62, y * 0.62, new Vector3());
      this.addMailbox(boxDir, this.facingToward(boxDir, centre, new Vector3()), zoneId, zoneName);
    }

    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + 0.3;
      this.addLamp(frame.ring(angle, 2.6, dir), this.facingToward(dir, centre));
    }

    for (let i = 0; i < 2; i++) {
      this.npcSpawns.push({ dir: frame.ring(i * 3.1 + 0.5, 2.2).clone(), roam: 2.2 });
    }
  }

  private buildDepot(): void {
    const town = this.sites.get('harborlight')!;
    const facing = this.facingToward(this.depotDir, town.center, new Vector3());
    const mesh = new Mesh(props.depot(), toonMaterial({ vertexColors: true, name: 'depot' }));
    mesh.name = 'depot';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.applyMatrix4(this.surfaceMatrix(this.depotDir, facing, -0.12));
    addOutline(mesh, { width: CONFIG.render.outlineWidth * 1.3 });
    this.group.add(mesh);

    this.depotPosition.copy(this.planet.surfacePoint(this.depotDir));
    this.exclude(this.depotDir, 4.6);
    this.addBlocker(this.depotDir, 2.5);
    this.exclude(this.depotDir, 7.5, 'large');

    // Lamps flanking the entrance.
    const frame = new LocalFrame(this.depotDir, this.planet.radius);
    for (const x of [-3.0, 3.0]) {
      const dir = frame.at(x, -2.2, new Vector3());
      this.addLamp(dir, this.facingToward(dir, this.depotDir, new Vector3()));
    }
  }

  // -------------------------------------------------------------------- finish

  private finishStatics(): void {
    const material = toonMaterial({ vertexColors: true, tones: 3, name: 'settlement' });
    for (const [id, parts] of this.staticParts) {
      if (parts.length === 0) continue;
      const merged = mergeGeometries(parts, false);
      for (const part of parts) part.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();

      const mesh = new Mesh(merged, material);
      mesh.name = `settlement.${id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      addOutline(mesh);
      this.group.add(mesh);
    }
    this.staticParts.clear();
  }

  private finishLamps(): void {
    if (this.lampParts.length === 0) return;
    const merged = mergeGeometries(this.lampParts, false);
    for (const part of this.lampParts) part.dispose();
    this.lampParts = [];
    if (!merged) return;

    this.lampMaterial = toonMaterial({
      vertexColors: true,
      tones: 2,
      emissive: PALETTE.lamp,
      emissiveIntensity: 0,
      name: 'lampGlow',
    });
    const mesh = new Mesh(merged, this.lampMaterial);
    mesh.name = 'lampGlow';
    this.group.add(mesh);
  }

  private finishMailboxes(): void {
    if (this.mailboxMatrices.length === 0) return;
    const geometry = props.mailbox();
    const mesh = new InstancedMesh(
      geometry,
      toonMaterial({ vertexColors: true, name: 'mailboxes' }),
      this.mailboxMatrices.length,
    );
    mesh.name = 'mailboxes';
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    for (let i = 0; i < this.mailboxMatrices.length; i++) mesh.setMatrixAt(i, this.mailboxMatrices[i]);
    mesh.instanceMatrix.needsUpdate = true;

    const outline = addInstancedOutline(mesh);
    this.group.add(mesh, outline);
    this.mailboxMesh = mesh;
  }

  // -------------------------------------------------------------------- runtime

  /** Kick off the little "delivered!" bounce on one mailbox. */
  pulse(index: number): void {
    if (!this.mailboxMesh) return;
    if (this.pulses.some((p) => p.index === index)) return;
    this.pulses.push({ index, elapsed: 0 });
  }

  /** Fade the lamp glow in as night falls. `night` is 0..1. */
  setNight(night: number): void {
    if (this.lampMaterial) this.lampMaterial.emissiveIntensity = night * 1.5;
  }

  update(dt: number): void {
    if (this.windmillBlades) this.windmillBlades.rotation.z += dt * 0.55;

    if (this.mailboxMesh && this.pulses.length > 0) {
      const mesh = this.mailboxMesh;
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const pulse = this.pulses[i];
        pulse.elapsed += dt;
        const duration = 0.7;
        const t = Math.min(1, pulse.elapsed / duration);
        // Decaying bounce along the mailbox's own up axis.
        const bounce = Math.sin(t * Math.PI * 3) * (1 - t) * 0.28;
        const base = this.mailboxMatrices[pulse.index];
        _m.copy(base);
        _pos.set(0, bounce, 0).applyQuaternion(_q.setFromRotationMatrix(base));
        _m.setPosition(
          base.elements[12] + _pos.x,
          base.elements[13] + _pos.y,
          base.elements[14] + _pos.z,
        );
        mesh.setMatrixAt(pulse.index, _m);
        if (t >= 1) {
          mesh.setMatrixAt(pulse.index, base);
          this.pulses.splice(i, 1);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Solid geometry for camera collision: the merged settlement batches and the
   * depot. Outline shells are excluded -- they are back-face hulls and would
   * report a hit the moment the camera was inside their own silhouette.
   */
  get colliders(): Object3D[] {
    return this.group.children.filter(
      (child) =>
        (child as Mesh).isMesh &&
        !child.name.endsWith(':outline') &&
        (child.name.startsWith('settlement.') || child.name === 'depot') &&
        // Lamp posts are thin: having the camera slam in every time one crossed
        // the view would be far more disruptive than a pole clipping the frame.
        child.name !== 'settlement.lampposts',
    );
  }

  /** Pick a random delivery point at least `minDistance` from `fromDir`. */
  pickDeliveryPoint(fromDir: Vector3, minDistance: number, excludeId?: string): DeliveryPoint {
    const radius = this.planet.radius;
    const candidates = this.deliveryPoints.filter((point) => {
      if (point.id === excludeId) return false;
      const angle = Math.acos(Math.min(1, Math.max(-1, point.dir.dot(fromDir))));
      return angle * radius >= minDistance;
    });
    const pool = candidates.length > 0 ? candidates : this.deliveryPoints;
    return pick(this.rng, pool);
  }
}
