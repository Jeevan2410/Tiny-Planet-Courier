/**
 * Prop scattering and instance-level LOD.
 *
 * Placement walks a Fibonacci-spiral sampling of the sphere (far more even than
 * random directions) and accepts points according to the local zone's density
 * for that prop type, rejecting water, steep ground and settlement footprints.
 *
 * Drawing uses one InstancedMesh per prop variant. Every ~150ms the visible
 * instances are repacked to the front of the instance buffer and `count` is
 * lowered to match, so the GPU only ever transforms props near the camera.
 * On a tiny planet the horizon does a lot of culling for free, but small
 * detail props (grass, pebbles) are numerous enough that this still matters --
 * it is the difference between 40fps and 60fps on a phone.
 */
import {
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { CONFIG, type Quality } from '../config';
import { addInstancedOutline } from '../fx/outline';
import { toonMaterial } from '../fx/toon';
import { anyTangent, fibonacciSphere, surfaceQuaternion } from '../util/sphere';
import { mulberry32, randRange, type Rng } from '../util/rng';
import * as propModule from './props';
import type { Planet } from './Planet';
import { ZONES, zoneWeights, type Zone } from './zones';

type DensityKey = keyof Zone['density'];

export interface ScatterSpec {
  id: string;
  /** Density key looked up on each zone. */
  key: DensityKey;
  /** Builds one geometry variant. Called `variants` times with the shared rng. */
  make: (rng: Rng) => BufferGeometry;
  variants: number;
  /** Hard cap on instances per variant, sizing the instance buffer. */
  capacity: number;
  scale: [number, number];
  /** 0 = stands straight up, 1 = lies flush with the slope. */
  normalAlign: number;
  /** Reject placement where slope exceeds this (see Planet.slopeAt). */
  maxSlope: number;
  /** Sink the prop slightly into the ground to hide its base. */
  sink: number;
  outline: boolean;
  castShadow: boolean;
  /** Draw radius in world units; small props get a short one. */
  drawDistance: number;
  /** Minimum height above sea level. */
  minAboveSea: number;
  /** Large props are kept out of 'large'-scoped exclusion zones too. */
  large: boolean;
}

interface VariantBucket {
  mesh: InstancedMesh;
  outline: InstancedMesh | null;
  /** Every placement for this variant, in planet space. */
  matrices: Matrix4[];
  /** Cached world position per placement, for the distance test. */
  positions: Vector3[];
  drawDistance: number;
}

export interface ExclusionZone {
  center: Vector3;
  /** Angular radius in radians. */
  radius: number;
  /**
   * 'all' clears everything (a building footprint); 'large' clears only trees,
   * rocks and crates, so grass still grows across a village green.
   */
  scope: 'all' | 'large';
}

const _up = new Vector3();
const _normal = new Vector3();
const _tangent = new Vector3();
const _pos = new Vector3();
const _q = new Quaternion();
const _qNormal = new Quaternion();
const _scale = new Vector3();

export const SCATTER_SPECS: ScatterSpec[] = [
  {
    id: 'pine',
    key: 'pine',
    make: (rng) => propModule.pineTree(rng),
    variants: 4,
    capacity: 620,
    scale: [0.85, 1.25],
    normalAlign: 0.25,
    maxSlope: 0.4,
    sink: 0.15,
    outline: true,
    castShadow: true,
    drawDistance: 60,
    minAboveSea: 0.25,
    large: true,
  },
  {
    id: 'broadleaf',
    key: 'broadleaf',
    make: (rng) => propModule.broadleafTree(rng),
    variants: 4,
    capacity: 420,
    scale: [0.85, 1.3],
    normalAlign: 0.25,
    maxSlope: 0.36,
    sink: 0.15,
    outline: true,
    castShadow: true,
    drawDistance: 60,
    minAboveSea: 0.25,
    large: true,
  },
  {
    id: 'bush',
    key: 'broadleaf',
    make: (rng) => propModule.bush(rng),
    variants: 3,
    capacity: 380,
    scale: [0.8, 1.4],
    normalAlign: 0.6,
    maxSlope: 0.45,
    sink: 0.12,
    outline: true,
    castShadow: false,
    drawDistance: 42,
    minAboveSea: 0.2,
    large: false,
  },
  {
    id: 'rock',
    key: 'rock',
    make: (rng) => propModule.rock(rng),
    variants: 5,
    capacity: 520,
    scale: [0.7, 1.6],
    normalAlign: 0.95,
    maxSlope: 0.75,
    sink: 0.18,
    outline: true,
    castShadow: true,
    drawDistance: 52,
    minAboveSea: -0.6,
    large: true,
  },
  {
    id: 'pebbles',
    key: 'rock',
    make: (rng) => propModule.pebbles(rng),
    variants: 3,
    capacity: 420,
    scale: [0.8, 1.5],
    normalAlign: 1,
    maxSlope: 0.6,
    sink: 0.04,
    outline: false,
    castShadow: false,
    drawDistance: 26,
    minAboveSea: -0.2,
    large: false,
  },
  {
    id: 'grass',
    key: 'grass',
    make: (rng) => propModule.grassTuft(rng),
    variants: 4,
    capacity: 1600,
    scale: [0.7, 1.5],
    normalAlign: 0.8,
    maxSlope: 0.55,
    sink: 0.06,
    outline: false,
    castShadow: false,
    drawDistance: 30,
    minAboveSea: 0.14,
    large: false,
  },
  {
    id: 'reed',
    key: 'reed',
    make: (rng) => propModule.reed(rng),
    variants: 3,
    capacity: 320,
    scale: [0.8, 1.4],
    normalAlign: 0.5,
    maxSlope: 0.4,
    sink: 0.08,
    outline: false,
    castShadow: false,
    drawDistance: 32,
    minAboveSea: -0.05,
    large: false,
  },
  {
    id: 'cactus',
    key: 'cactus',
    make: (rng) => propModule.cactus(rng),
    variants: 3,
    capacity: 240,
    scale: [0.8, 1.3],
    normalAlign: 0.2,
    maxSlope: 0.4,
    sink: 0.12,
    outline: true,
    castShadow: true,
    drawDistance: 52,
    minAboveSea: 0.3,
    large: true,
  },
  {
    id: 'crate',
    key: 'crate',
    make: (rng) => propModule.crate(rng),
    variants: 3,
    capacity: 220,
    scale: [0.8, 1.25],
    normalAlign: 0.85,
    maxSlope: 0.3,
    sink: 0.05,
    outline: true,
    castShadow: true,
    drawDistance: 42,
    minAboveSea: 0.25,
    large: true,
  },
  {
    id: 'barrel',
    key: 'crate',
    make: (rng) => propModule.barrel(rng),
    variants: 3,
    capacity: 160,
    scale: [0.85, 1.2],
    normalAlign: 0.85,
    maxSlope: 0.28,
    sink: 0.04,
    outline: true,
    castShadow: true,
    drawDistance: 42,
    minAboveSea: 0.25,
    large: true,
  },
  {
    id: 'pipe',
    key: 'pipe',
    make: (rng) => propModule.pipeSegment(rng),
    variants: 3,
    capacity: 180,
    scale: [0.85, 1.25],
    normalAlign: 0.9,
    maxSlope: 0.26,
    sink: 0.03,
    outline: true,
    castShadow: true,
    drawDistance: 46,
    minAboveSea: 0.25,
    large: true,
  },
];

export class ScatterField {
  readonly group = new Group();
  private buckets: VariantBucket[] = [];
  private repackTimer = 0;
  private quality: Quality = 'high';
  private distanceScale = 1;

  constructor(
    private readonly planet: Planet,
    private readonly exclusions: ExclusionZone[],
    private readonly seed = CONFIG.planet.seed + 777,
  ) {
    this.group.name = 'scatter';
  }

  /**
   * @param samples how many candidate surface points to test. Higher = denser
   *                and slower to generate; 14k is a good balance for a radius-22
   *                planet (roughly one candidate every 0.45 world units).
   */
  build(samples = 14000): void {
    const rng = mulberry32(this.seed);
    const points = fibonacciSphere(samples);
    const weights = new Float32Array(ZONES.length);

    // Pre-compute per-sample terrain facts once, shared across all prop types.
    interface Candidate {
      dir: Vector3;
      height: number;
      slope: number;
      weights: Float32Array;
      /** Inside a building footprint: nothing at all grows here. */
      blockedAll: boolean;
      /** Inside a village green: only small ground cover is allowed. */
      blockedLarge: boolean;
    }
    const candidates: Candidate[] = [];
    for (const dir of points) {
      // Nothing grows in the middle of the street.
      const blockedAll = this.isExcluded(dir, false) || this.planet.pathFactor(dir) > 0.3;
      const blockedLarge = blockedAll || this.isExcluded(dir, true);
      if (blockedAll && blockedLarge) continue;
      const height = this.planet.heightAt(dir);
      const aboveSea = height - this.planet.seaLevel;
      if (aboveSea < -0.7) continue; // deep water: nothing grows here
      const slope = this.planet.slopeAt(dir);
      zoneWeights(dir, weights);
      candidates.push({ dir, height, slope, weights: weights.slice(), blockedAll, blockedLarge });
    }

    const material = toonMaterial({ vertexColors: true, tones: 3, name: 'scatter' });

    for (const spec of SCATTER_SPECS) {
      // Bake the geometry variants up front.
      const variantGeos: BufferGeometry[] = [];
      for (let v = 0; v < spec.variants; v++) variantGeos.push(spec.make(rng));

      const perVariant: { matrices: Matrix4[]; positions: Vector3[] }[] = variantGeos.map(() => ({
        matrices: [],
        positions: [],
      }));

      for (const candidate of candidates) {
        if (candidate.blockedAll) continue;
        if (spec.large && candidate.blockedLarge) continue;
        const aboveSea = candidate.height - this.planet.seaLevel;
        if (aboveSea < spec.minAboveSea) continue;
        if (candidate.slope > spec.maxSlope) continue;

        // Blend the density of every zone this point belongs to.
        let density = 0;
        for (let i = 0; i < ZONES.length; i++) {
          const w = candidate.weights[i];
          if (w > 0.002) density += w * ZONES[i].density[spec.key];
        }
        if (density <= 0) continue;

        // Thin out placement on slopes so hillsides look wind-swept.
        const slopeFalloff = 1 - Math.min(1, candidate.slope / Math.max(0.05, spec.maxSlope)) * 0.5;
        if (rng() > (density / 1000) * slopeFalloff) continue;

        const variant = Math.min(variantGeos.length - 1, Math.floor(rng() * variantGeos.length));
        const bucket = perVariant[variant];
        if (bucket.matrices.length >= spec.capacity) continue;

        const matrix = this.makePlacement(candidate.dir, spec, rng);
        bucket.matrices.push(matrix);
        bucket.positions.push(new Vector3().setFromMatrixPosition(matrix));
      }

      // Create one InstancedMesh per variant that actually got placements.
      for (let v = 0; v < variantGeos.length; v++) {
        const { matrices, positions } = perVariant[v];
        if (matrices.length === 0) {
          variantGeos[v].dispose();
          continue;
        }
        const mesh = new InstancedMesh(variantGeos[v], material, matrices.length);
        mesh.name = `${spec.id}.${v}`;
        mesh.castShadow = spec.castShadow;
        mesh.receiveShadow = false;
        mesh.instanceMatrix.setUsage(DynamicDrawUsage);
        // Bounding volumes are meaningless once we repack instances by distance,
        // and the planet is small enough that per-mesh frustum culling would
        // only ever produce false negatives.
        mesh.frustumCulled = false;

        for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
        mesh.instanceMatrix.needsUpdate = true;

        const outline = spec.outline ? addInstancedOutline(mesh) : null;
        this.group.add(mesh);
        if (outline) this.group.add(outline);

        this.buckets.push({
          mesh,
          outline,
          matrices,
          positions,
          drawDistance: spec.drawDistance,
        });
      }
    }
  }

  private isExcluded(dir: Vector3, large: boolean): boolean {
    for (const zone of this.exclusions) {
      if (zone.scope === 'large' && !large) continue;
      if (dir.dot(zone.center) > Math.cos(zone.radius)) return true;
    }
    return false;
  }

  /** Build the instance transform for one accepted placement. */
  private makePlacement(dir: Vector3, spec: ScatterSpec, rng: Rng): Matrix4 {
    _up.copy(dir).normalize();
    this.planet.normalAt(_up, _normal);

    // Blend between "grows straight up" and "lies flush with the slope".
    _qNormal.setFromUnitVectors(_up, _normal);
    _q.identity().slerp(_qNormal, spec.normalAlign);
    const blendedUp = _up.clone().applyQuaternion(_q).normalize();

    anyTangent(blendedUp, _tangent).applyAxisAngle(blendedUp, rng() * Math.PI * 2);
    surfaceQuaternion(blendedUp, _tangent, _q);

    const scale = randRange(rng, spec.scale[0], spec.scale[1]);
    this.planet.surfacePoint(_up, _pos).addScaledVector(blendedUp, -spec.sink * scale);
    _scale.setScalar(scale);

    return new Matrix4().compose(_pos, _q, _scale);
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    const high = CONFIG.render.scatterDrawDistanceHigh;
    const low = CONFIG.render.scatterDrawDistanceLow;
    this.distanceScale = (quality === 'high' ? high : low) / high;
    this.repackTimer = 0;
    for (const bucket of this.buckets) {
      if (bucket.outline) bucket.outline.visible = quality === 'high';
      if (this.quality === 'low') bucket.mesh.castShadow = false;
    }
  }

  /**
   * Repack instance buffers so only props within their draw distance of the
   * viewer are submitted. Runs on a timer rather than every frame: the popping
   * threshold is well beyond the visible horizon, so a 150ms cadence is
   * invisible and costs a fraction of the work.
   */
  update(dt: number, viewer: Vector3): void {
    this.repackTimer -= dt;
    if (this.repackTimer > 0) return;
    this.repackTimer = 0.15;

    for (const bucket of this.buckets) {
      const limit = bucket.drawDistance * this.distanceScale;
      const limitSq = limit * limit;
      const { positions, matrices, mesh } = bucket;
      let visible = 0;

      for (let i = 0; i < positions.length; i++) {
        if (positions[i].distanceToSquared(viewer) > limitSq) continue;
        mesh.setMatrixAt(visible, matrices[i]);
        visible++;
      }

      mesh.count = visible;
      mesh.instanceMatrix.needsUpdate = true;
      if (bucket.outline) bucket.outline.count = visible;
    }
  }

  /** Total placements, for the debug/stats readout. */
  get instanceCount(): number {
    return this.buckets.reduce((sum, b) => sum + b.matrices.length, 0);
  }

  dispose(): void {
    for (const bucket of this.buckets) {
      bucket.mesh.geometry.dispose();
      bucket.mesh.dispose();
      bucket.outline?.dispose();
    }
    this.buckets = [];
    this.group.clear();
  }
}

/** Placement helper shared with Settlements: orient an object on the surface. */
export function orientOnSurface(
  planet: Planet,
  dir: Vector3,
  facing: Vector3,
  target: Object3D,
  lift = 0,
): void {
  _up.copy(dir).normalize();
  planet.surfacePoint(_up, _pos).addScaledVector(_up, lift);
  target.position.copy(_pos);
  surfaceQuaternion(_up, facing, _q);
  target.quaternion.copy(_q);
}
