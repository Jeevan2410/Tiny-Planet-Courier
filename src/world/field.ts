/**
 * The terrain field: height, slope, roads and ground colour as pure functions
 * of direction.
 *
 * Deliberately free of any three.js import. Two very different callers need
 * this maths -- `Planet` on the main thread, which queries it every frame for
 * the character controller, and the world generation worker, which evaluates it
 * tens of thousands of times to build the mesh. Pulling three into the worker
 * bundle would cost a second copy of the library, which is more download than
 * the worker saves in main-thread time, so the shared code speaks in scalars.
 *
 * Everything here is deterministic given a seed plus the registered flat spots
 * and roads, which is what lets the worker rebuild an identical field from a
 * tiny message instead of being handed megabytes of geometry.
 */
import { PALETTE } from '../fx/palette';
import { SimplexNoise } from '../util/noise';
import { mulberry32 } from '../util/rng';
import { ZONES, zoneWeightsXYZ } from './zoneData';

const clamp = (v: number, min: number, max: number) => (v < min ? min : v > max ? max : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** sRGB hex -> linear RGB, matching three's colour management. */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

const linearCache = new Map<number, [number, number, number]>();

function linearOf(hex: number): [number, number, number] {
  let rgb = linearCache.get(hex);
  if (!rgb) {
    rgb = [
      srgbToLinear(((hex >> 16) & 255) / 255),
      srgbToLinear(((hex >> 8) & 255) / 255),
      srgbToLinear((hex & 255) / 255),
    ];
    linearCache.set(hex, rgb);
  }
  return rgb;
}

/** A levelled building site. */
export interface FlatSpec {
  center: [number, number, number];
  /** Angular radius in radians. */
  radius: number;
}

/** A road, as waypoints plus a half-width in world units. */
export interface PathSpec {
  points: [number, number, number][];
  width: number;
  spacing?: number;
}

/** Everything needed to rebuild an identical field, small enough to postMessage. */
export interface FieldConfig {
  seed: number;
  radius: number;
  amplitude: number;
  seaLevel: number;
  flats: FlatSpec[];
  paths: PathSpec[];
}

interface Flat {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  height: number;
}

interface Path {
  samples: Float32Array;
  count: number;
  width: number;
  cx: number;
  cy: number;
  cz: number;
  cullCos: number;
}

export class TerrainField {
  readonly radius: number;
  readonly amplitude: number;
  readonly seaLevel: number;
  readonly seed: number;

  private readonly broad: SimplexNoise;
  private readonly detail: SimplexNoise;
  private readonly ridge: SimplexNoise;
  private readonly patch: SimplexNoise;

  private readonly weights = new Float32Array(ZONES.length);
  private readonly flats: Flat[] = [];
  private readonly paths: Path[] = [];

  /** The registrations, kept verbatim so the worker can replay them. */
  private readonly flatSpecs: FlatSpec[] = [];
  private readonly pathSpecs: PathSpec[] = [];

  constructor(config: Pick<FieldConfig, 'seed' | 'radius' | 'amplitude' | 'seaLevel'>) {
    this.seed = config.seed;
    this.radius = config.radius;
    this.amplitude = config.amplitude;
    this.seaLevel = config.seaLevel;

    this.broad = new SimplexNoise(mulberry32(config.seed));
    this.detail = new SimplexNoise(mulberry32(config.seed + 8191));
    this.ridge = new SimplexNoise(mulberry32(config.seed + 104729));
    this.patch = new SimplexNoise(mulberry32(config.seed + 1299709));
  }

  /** Rebuild a field from a config produced by `toConfig()`. */
  static fromConfig(config: FieldConfig): TerrainField {
    const field = new TerrainField(config);
    for (const flat of config.flats) field.addFlat(flat.center, flat.radius);
    for (const path of config.paths) field.addPath(path.points, path.width, path.spacing);
    return field;
  }

  toConfig(): FieldConfig {
    return {
      seed: this.seed,
      radius: this.radius,
      amplitude: this.amplitude,
      seaLevel: this.seaLevel,
      flats: this.flatSpecs,
      paths: this.pathSpecs,
    };
  }

  // ------------------------------------------------------------------- height

  /** Terrain radius from noise and zone shaping alone, ignoring flattened spots. */
  rawHeight(x: number, y: number, z: number): number {
    const w = this.weights;
    zoneWeightsXYZ(x, y, z, w);

    let relief = 0;
    let ridgedMix = 0;
    let lift = 0;
    for (let i = 0; i < ZONES.length; i++) {
      const zone = ZONES[i];
      relief += w[i] * zone.relief;
      ridgedMix += w[i] * zone.ridged;
      lift += w[i] * zone.lift;
    }

    const broad = this.broad.fbm(x * 1.05, y * 1.05, z * 1.05, 4);
    const detail = this.detail.fbm(x * 3.3, y * 3.3, z * 3.3, 3) * 0.32;
    const ridged = this.ridge.ridged(x * 2.1, y * 2.1, z * 2.1, 4) * 2 - 1;

    let n = broad * 0.75 + detail + ridged * ridgedMix * 0.9;
    n = n * relief + lift;

    return this.radius + n * this.amplitude;
  }

  /** Terrain radius at a unit direction: the authoritative ground height. */
  heightAt(x: number, y: number, z: number): number {
    let h = this.rawHeight(x, y, z);

    // Settlements sit on deliberately levelled ground so buildings do not float
    // or bury themselves. Blended with a smoothstep so the edges read as a
    // gentle terrace rather than a cliff.
    for (let i = 0; i < this.flats.length; i++) {
      const flat = this.flats[i];
      const angle = Math.acos(clamp(x * flat.cx + y * flat.cy + z * flat.cz, -1, 1));
      if (angle >= flat.radius) continue;
      h = lerp(h, flat.height, smoothstep(flat.radius, flat.radius * 0.4, angle));
    }

    return h;
  }

  /** Normalised elevation above base radius: ~0 at the coast, ~1 at the peaks. */
  elevation(height: number): number {
    return (height - this.radius) / this.amplitude;
  }

  /**
   * Steepness as 1 - dot(surfaceNormal, radial): 0 on the flat, ~0.29 on a
   * 45-degree slope. Central differences over two arbitrary tangents.
   */
  slopeAt(x: number, y: number, z: number, epsilon = 0.012): number {
    const [ax, ay, az, bx, by, bz] = tangentBasis(x, y, z);
    const sample = (tx: number, ty: number, tz: number, sign: number) => {
      const px = x + tx * sign * epsilon;
      const py = y + ty * sign * epsilon;
      const pz = z + tz * sign * epsilon;
      const inv = 1 / Math.hypot(px, py, pz);
      return this.heightAt(px * inv, py * inv, pz * inv);
    };
    const dh1 = (sample(ax, ay, az, 1) - sample(ax, ay, az, -1)) / (2 * epsilon);
    const dh2 = (sample(bx, by, bz, 1) - sample(bx, by, bz, -1)) / (2 * epsilon);
    const gradient = Math.hypot(dh1, dh2) / this.radius;
    return 1 - 1 / Math.sqrt(1 + gradient * gradient);
  }

  // -------------------------------------------------------------------- flats

  /** Register a levelled area. Target height is sampled from the raw field. */
  addFlat(center: [number, number, number], angularRadius: number): void {
    const inv = 1 / Math.hypot(center[0], center[1], center[2]);
    const cx = center[0] * inv;
    const cy = center[1] * inv;
    const cz = center[2] * inv;
    this.flatSpecs.push({ center: [cx, cy, cz], radius: angularRadius });
    this.flats.push({ cx, cy, cz, radius: angularRadius, height: this.rawHeight(cx, cy, cz) });
  }

  // -------------------------------------------------------------------- roads

  /**
   * Register a road as a polyline of directions, densely sampled.
   *
   * Roads are painted into the terrain's vertex colours rather than laid down
   * as geometry: no extra draw calls, no z-fighting against a curved surface,
   * and no need to make a flat slab follow a hill.
   */
  addPath(points: [number, number, number][], width: number, spacing = 0.45): void {
    if (points.length < 2) return;
    this.pathSpecs.push({ points, width, spacing });

    const samples: number[] = [];
    const push = (x: number, y: number, z: number) => {
      const inv = 1 / Math.hypot(x, y, z);
      samples.push(x * inv, y * inv, z * inv);
    };

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const ia = 1 / Math.hypot(a[0], a[1], a[2]);
      const ib = 1 / Math.hypot(b[0], b[1], b[2]);
      const ax = a[0] * ia, ay = a[1] * ia, az = a[2] * ia;
      const bx = b[0] * ib, by = b[1] * ib, bz = b[2] * ib;

      const angle = Math.acos(clamp(ax * bx + ay * by + az * bz, -1, 1));
      const steps = Math.max(1, Math.ceil((angle * this.radius) / spacing));
      for (let step = 0; step < steps; step++) {
        // Straight lerp then renormalise: at this spacing it is
        // indistinguishable from a slerp and much cheaper.
        const t = step / steps;
        push(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
      }
    }
    const last = points[points.length - 1];
    push(last[0], last[1], last[2]);

    const count = samples.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < count; i++) {
      cx += samples[i * 3];
      cy += samples[i * 3 + 1];
      cz += samples[i * 3 + 2];
    }
    const inv = 1 / Math.hypot(cx, cy, cz);
    cx *= inv;
    cy *= inv;
    cz *= inv;

    // Widest angle from the centroid to any sample, plus the road's own width
    // and a margin, gives a cone that provably contains the whole road.
    let minDot = 1;
    for (let i = 0; i < count; i++) {
      const dot = cx * samples[i * 3] + cy * samples[i * 3 + 1] + cz * samples[i * 3 + 2];
      if (dot < minDot) minDot = dot;
    }
    const coneAngle = Math.acos(clamp(minDot, -1, 1)) + (width * 1.6) / this.radius + 0.01;

    this.paths.push({
      samples: new Float32Array(samples),
      count,
      width,
      cx,
      cy,
      cz,
      cullCos: Math.cos(Math.min(Math.PI, coneAngle)),
    });
  }

  /**
   * How much of a road covers this direction: 1 on the carriageway, falling to
   * 0 across the kerb. Shared by the terrain colouring and the prop scatterer,
   * so nothing grows in the middle of the street.
   */
  pathFactor(x: number, y: number, z: number): number {
    if (this.paths.length === 0) return 0;
    let best = 0;

    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      if (x * path.cx + y * path.cy + z * path.cz < path.cullCos) continue;

      // Track the largest dot product rather than the smallest distance: one
      // acos at the end instead of one per sample.
      let maxDot = -1;
      const { samples, count } = path;
      for (let i = 0; i < count; i++) {
        const dot = x * samples[i * 3] + y * samples[i * 3 + 1] + z * samples[i * 3 + 2];
        if (dot > maxDot) maxDot = dot;
      }
      const distance = Math.acos(clamp(maxDot, -1, 1)) * this.radius;
      const coverage = smoothstep(path.width * 1.22, path.width * 0.78, distance);
      if (coverage > best) best = coverage;
    }
    return best;
  }

  // ------------------------------------------------------------------- colour

  /**
   * Ground colour in LINEAR space, written into `out` at `offset`.
   * Zone blend first, then beach, cliff, snow and road rules on top.
   */
  colorAt(
    x: number,
    y: number,
    z: number,
    height: number,
    slope: number,
    out: Float32Array,
    offset: number,
  ): void {
    const w = this.weights;
    zoneWeightsXYZ(x, y, z, w);

    // Patchiness, so large flat areas are not a single dead colour.
    const patch = this.patch.fbm(x * 7.5, y * 7.5, z * 7.5, 2) * 0.5 + 0.5;
    const elev = this.elevation(height);

    let r = 0;
    let g = 0;
    let b = 0;
    let cliffR = 0;
    let cliffG = 0;
    let cliffB = 0;
    let snowWeight = 0;

    for (let i = 0; i < ZONES.length; i++) {
      const weight = w[i];
      if (weight < 0.002) continue;
      const zone = ZONES[i];

      const ground = linearOf(zone.ground);
      const alt = linearOf(zone.groundAlt);
      r += lerp(ground[0], alt[0], patch) * weight;
      g += lerp(ground[1], alt[1], patch) * weight;
      b += lerp(ground[2], alt[2], patch) * weight;

      const cliff = linearOf(zone.cliff);
      cliffR += cliff[0] * weight;
      cliffG += cliff[1] * weight;
      cliffB += cliff[2] * weight;

      if (zone.snowLine !== undefined) {
        snowWeight += weight * smoothstep(zone.snowLine, zone.snowLine + 0.22, elev);
      }
    }

    // Cliffs: rock shows through wherever the ground gets steep.
    const cliffMix = smoothstep(0.16, 0.44, slope);
    if (cliffMix > 0) {
      r = lerp(r, cliffR, cliffMix);
      g = lerp(g, cliffG, cliffMix);
      b = lerp(b, cliffB, cliffMix);
    }

    // Beaches: a sand band hugging the waterline, plus darker silt below it.
    const above = height - this.seaLevel;
    if (above < 0.42) {
      const sand = linearOf(PALETTE.sand);
      const beach = smoothstep(0.42, 0.04, above) * (1 - cliffMix * 0.7);
      r = lerp(r, sand[0], beach);
      g = lerp(g, sand[1], beach);
      b = lerp(b, sand[2], beach);
      if (above < 0) {
        const silt = linearOf(0x6d7f6a);
        const mix = smoothstep(0, -0.8, above) * 0.8;
        r = lerp(r, silt[0], mix);
        g = lerp(g, silt[1], mix);
        b = lerp(b, silt[2], mix);
      }
    }

    // Snow: zone-driven, plus a global dusting on the very highest ground.
    const dusting = smoothstep(1.02, 1.3, elev) * 0.85;
    const snowMix = Math.min(
      1,
      Math.max(snowWeight, dusting) * (1 - smoothstep(0.34, 0.6, slope) * 0.55),
    );
    if (snowMix > 0) {
      const snow = linearOf(PALETTE.snow);
      r = lerp(r, snow[0], snowMix);
      g = lerp(g, snow[1], snowMix);
      b = lerp(b, snow[2], snowMix);
    }

    // Roads last, so they sit on top of grass, snow and beach alike.
    const road = this.pathFactor(x, y, z);
    if (road > 0) {
      // A pale kerb band at the edge before the asphalt proper: without it the
      // road reads as a stain rather than a built surface.
      const kerb = linearOf(PALETTE.kerb);
      const kerbMix = Math.min(1, road * 1.9);
      r = lerp(r, kerb[0], kerbMix);
      g = lerp(g, kerb[1], kerbMix);
      b = lerp(b, kerb[2], kerbMix);

      const asphalt = linearOf(PALETTE.asphalt);
      const tarmac = smoothstep(0.45, 0.85, road);
      r = lerp(r, asphalt[0], tarmac);
      g = lerp(g, asphalt[1], tarmac);
      b = lerp(b, asphalt[2], tarmac);
    }

    out[offset] = r;
    out[offset + 1] = g;
    out[offset + 2] = b;
  }
}

/** Two orthonormal tangents at a unit direction, as a flat six-tuple. */
function tangentBasis(x: number, y: number, z: number): number[] {
  let hx = 0;
  let hy = 1;
  let hz = 0;
  if (Math.abs(y) >= 0.9) {
    hx = 1;
    hy = 0;
  }
  // a = normalize(helper x n)
  let ax = hy * z - hz * y;
  let ay = hz * x - hx * z;
  let az = hx * y - hy * x;
  const ia = 1 / Math.hypot(ax, ay, az);
  ax *= ia;
  ay *= ia;
  az *= ia;
  // b = n x a
  const bx = y * az - z * ay;
  const by = z * ax - x * az;
  const bz = x * ay - y * ax;
  return [ax, ay, az, bx, by, bz];
}
