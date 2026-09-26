/**
 * The planet itself: an analytic terrain field plus the meshes that draw it.
 *
 * The important design choice here is that terrain height is a pure function of
 * direction. Nothing in the game ever raycasts against the ground -- the
 * character controller, the NPCs and the prop scatterer all call `heightAt()`
 * and get an exact answer in a few microseconds. That keeps movement perfectly
 * stable on a curved surface where raycasts would be both slower and jittery.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  Vector3,
} from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { PALETTE, srgb, toonMaterial } from '../fx/toon';
import { SimplexNoise } from '../util/noise';
import { mulberry32 } from '../util/rng';
import { clamp, lerp, smoothstep } from '../util/sphere';
import { ZONES, zoneWeights, type Zone } from './zones';

interface FlatSpot {
  center: Vector3;
  /** Angular radius in radians. */
  radius: number;
  /** Absolute target radius the ground is pulled toward. */
  height: number;
}

/**
 * A road, stored as a densely-sampled polyline of unit directions.
 *
 * Roads are painted into the terrain's vertex colours rather than laid down as
 * separate geometry: no extra draw calls, no z-fighting against a curved
 * surface, and no need to make a flat slab follow a hill. The bounding cone
 * lets the per-vertex lookup reject the ~99% of the planet a given road is
 * nowhere near before it touches a single sample.
 */
interface Path {
  samples: Float32Array;
  count: number;
  /** Half-width of the carriageway in world units. */
  width: number;
  center: Vector3;
  /** Cosine of (cone half-angle + width), precomputed for the early-out. */
  cullCos: number;
}

const _dir = new Vector3();
const _n = new Vector3();
const _ax = new Vector3();
const _az = new Vector3();
const _pa = new Vector3();
const _pb = new Vector3();
const _pc = new Vector3();
const _pd = new Vector3();
const _c1 = new Color();
const _c2 = new Color();
const _c3 = new Color();

export class Planet {
  readonly radius = CONFIG.planet.radius;
  readonly seaLevel = CONFIG.planet.seaLevel;
  readonly amplitude = CONFIG.planet.terrainAmplitude;

  readonly group = new Group();
  terrain!: Mesh;
  ocean!: Mesh;

  private readonly broad: SimplexNoise;
  private readonly detail: SimplexNoise;
  private readonly ridge: SimplexNoise;
  private readonly patch: SimplexNoise;

  private readonly weights = new Float32Array(ZONES.length);
  private readonly flats: FlatSpot[] = [];
  private readonly paths: Path[] = [];

  constructor(seed = CONFIG.planet.seed) {
    this.group.name = 'planet';
    this.broad = new SimplexNoise(mulberry32(seed));
    this.detail = new SimplexNoise(mulberry32(seed + 8191));
    this.ridge = new SimplexNoise(mulberry32(seed + 104729));
    this.patch = new SimplexNoise(mulberry32(seed + 1299709));
  }

  // -------------------------------------------------------------- terrain field

  /** Terrain radius from noise and zone shaping alone, ignoring flattened spots. */
  private rawHeight(d: Vector3): number {
    const w = this.weights;
    zoneWeights(d, w);

    let relief = 0;
    let ridgedMix = 0;
    let lift = 0;
    for (let i = 0; i < ZONES.length; i++) {
      const z = ZONES[i];
      relief += w[i] * z.relief;
      ridgedMix += w[i] * z.ridged;
      lift += w[i] * z.lift;
    }

    const broad = this.broad.fbm(d.x * 1.05, d.y * 1.05, d.z * 1.05, 4);
    const detail = this.detail.fbm(d.x * 3.3, d.y * 3.3, d.z * 3.3, 3) * 0.32;
    const ridged = this.ridge.ridged(d.x * 2.1, d.y * 2.1, d.z * 2.1, 4) * 2 - 1;

    let n = broad * 0.75 + detail + ridged * ridgedMix * 0.9;
    n = n * relief + lift;

    return this.radius + n * this.amplitude;
  }

  /**
   * Terrain radius at a unit direction. This is the authoritative ground height
   * for both rendering and gameplay.
   */
  heightAt(d: Vector3): number {
    let h = this.rawHeight(d);

    // Settlements sit on deliberately levelled ground so buildings do not float
    // or bury themselves. Blended with a smoothstep so the edges read as a
    // gentle terrace rather than a cliff.
    for (let i = 0; i < this.flats.length; i++) {
      const flat = this.flats[i];
      const angle = Math.acos(clamp(d.dot(flat.center), -1, 1));
      if (angle >= flat.radius) continue;
      h = lerp(h, flat.height, smoothstep(flat.radius, flat.radius * 0.4, angle));
    }

    return h;
  }

  /**
   * Register a levelled area. Must be called before `build()`; the target height
   * is sampled from the raw field so terraces always match their surroundings.
   */
  addFlatSpot(center: Vector3, angularRadius: number): void {
    const dir = center.clone().normalize();
    this.flats.push({ center: dir, radius: angularRadius, height: this.rawHeight(dir) });
  }

  /**
   * Register a road. Must be called before `build()`, since roads are baked
   * into the terrain's vertex colours.
   *
   * @param points  waypoints as directions (need not be normalised)
   * @param width   half-width of the carriageway in world units
   * @param spacing distance between generated samples; smaller is smoother but
   *                costs more per-vertex work during generation
   */
  addPath(points: Vector3[], width: number, spacing = 0.45): void {
    if (points.length < 2) return;

    const samples: number[] = [];
    const a = new Vector3();
    const b = new Vector3();
    const s = new Vector3();

    for (let i = 0; i < points.length - 1; i++) {
      a.copy(points[i]).normalize();
      b.copy(points[i + 1]).normalize();
      const angle = Math.acos(clamp(a.dot(b), -1, 1));
      const arc = angle * this.radius;
      const steps = Math.max(1, Math.ceil(arc / spacing));
      for (let step = 0; step < steps; step++) {
        // Straight lerp then renormalise: at this spacing it is
        // indistinguishable from a slerp and much cheaper.
        s.copy(a).lerp(b, step / steps).normalize();
        samples.push(s.x, s.y, s.z);
      }
    }
    const last = points[points.length - 1].clone().normalize();
    samples.push(last.x, last.y, last.z);

    const count = samples.length / 3;
    const center = new Vector3();
    for (let i = 0; i < count; i++) {
      center.x += samples[i * 3];
      center.y += samples[i * 3 + 1];
      center.z += samples[i * 3 + 2];
    }
    center.normalize();

    // Widest angle from the centroid to any sample, plus the road's own width
    // and a margin, gives a cone that provably contains the whole road.
    let minDot = 1;
    for (let i = 0; i < count; i++) {
      const dot = center.x * samples[i * 3] + center.y * samples[i * 3 + 1] + center.z * samples[i * 3 + 2];
      if (dot < minDot) minDot = dot;
    }
    const coneAngle = Math.acos(clamp(minDot, -1, 1)) + (width * 1.6) / this.radius + 0.01;

    this.paths.push({
      samples: new Float32Array(samples),
      count,
      width,
      center,
      cullCos: Math.cos(Math.min(Math.PI, coneAngle)),
    });
  }

  /**
   * How much of a road covers this direction: 1 on the carriageway, falling to
   * 0 across the kerb. Shared by the terrain colouring and the prop scatterer,
   * so nothing grows in the middle of the street.
   */
  pathFactor(d: Vector3): number {
    if (this.paths.length === 0) return 0;
    let best = 0;

    for (let p = 0; p < this.paths.length; p++) {
      const path = this.paths[p];
      if (d.dot(path.center) < path.cullCos) continue;

      // Track the largest dot product rather than the smallest distance: one
      // acos at the end instead of one per sample.
      let maxDot = -1;
      const { samples, count } = path;
      for (let i = 0; i < count; i++) {
        const dot = d.x * samples[i * 3] + d.y * samples[i * 3 + 1] + d.z * samples[i * 3 + 2];
        if (dot > maxDot) maxDot = dot;
      }
      const distance = Math.acos(clamp(maxDot, -1, 1)) * this.radius;
      const coverage = smoothstep(path.width * 1.22, path.width * 0.78, distance);
      if (coverage > best) best = coverage;
    }
    return best;
  }

  /** World-space point on the ground for a direction. */
  surfacePoint(d: Vector3, out = new Vector3()): Vector3 {
    _dir.copy(d).normalize();
    return out.copy(_dir).multiplyScalar(this.heightAt(_dir));
  }

  /** Build two orthonormal tangents at a direction into the scratch vectors. */
  private tangents(d: Vector3): void {
    _n.copy(d).normalize();
    if (Math.abs(_n.y) < 0.9) _ax.set(0, 1, 0);
    else _ax.set(1, 0, 0);
    _ax.cross(_n).normalize();
    _az.copy(_n).cross(_ax).normalize();
  }

  /**
   * Steepness at a direction as 1 - dot(surfaceNormal, radial): 0 on the flat,
   * ~0.29 on a 45-degree slope. Estimated with central differences, which is
   * cheaper than building a normal and accurate enough for placement rules.
   */
  slopeAt(d: Vector3, epsilon = 0.012): number {
    this.tangents(d);
    const h = (t: Vector3, sign: number) => {
      _pa.copy(_n).addScaledVector(t, sign * epsilon).normalize();
      return this.heightAt(_pa);
    };
    const dh1 = (h(_ax, 1) - h(_ax, -1)) / (2 * epsilon);
    const dh2 = (h(_az, 1) - h(_az, -1)) / (2 * epsilon);
    const gradient = Math.hypot(dh1, dh2) / this.radius;
    return 1 - 1 / Math.sqrt(1 + gradient * gradient);
  }

  /** Surface normal, derived from the same field the mesh is built from. */
  normalAt(d: Vector3, out = new Vector3(), epsilon = 0.012): Vector3 {
    this.tangents(d);
    const point = (t: Vector3, sign: number, target: Vector3) => {
      target.copy(_n).addScaledVector(t, sign * epsilon).normalize();
      return target.multiplyScalar(this.heightAt(target));
    };
    point(_ax, 1, _pa);
    point(_ax, -1, _pb);
    point(_az, 1, _pc);
    point(_az, -1, _pd);
    out.copy(_pa).sub(_pb).cross(_pc.sub(_pd)).normalize();
    if (out.dot(_n) < 0) out.negate();
    return out;
  }

  isWater(d: Vector3): boolean {
    return this.heightAt(d) < this.seaLevel;
  }

  zoneAt(d: Vector3): Zone {
    return ZONES[zoneWeights(_dir.copy(d).normalize(), this.weights)];
  }

  /** Normalised elevation above base radius: ~0 at the coast, ~1 at the peaks. */
  elevation(height: number): number {
    return (height - this.radius) / this.amplitude;
  }

  // -------------------------------------------------------------------- meshes

  build(): void {
    this.terrain = this.buildTerrain();
    this.ocean = this.buildOcean();
    this.group.add(this.terrain, this.ocean);
  }

  private buildTerrain(): Mesh {
    // Build on a unit sphere so vertex positions double as directions, then
    // weld the duplicated vertices PolyhedronGeometry emits. Welding drops the
    // vertex count ~6x and lets us use smooth normals, which the toon ramp
    // bands into clean terraces.
    let geometry: BufferGeometry = new IcosahedronGeometry(1, CONFIG.planet.detail);
    geometry = mergeVertices(geometry, 1e-5);
    geometry.deleteAttribute('uv');

    const position = geometry.getAttribute('position') as BufferAttribute;
    const count = position.count;
    const directions = new Float32Array(count * 3);
    const heights = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      _dir.set(position.getX(i), position.getY(i), position.getZ(i)).normalize();
      directions[i * 3 + 0] = _dir.x;
      directions[i * 3 + 1] = _dir.y;
      directions[i * 3 + 2] = _dir.z;

      const h = this.heightAt(_dir);
      heights[i] = h;
      position.setXYZ(i, _dir.x * h, _dir.y * h, _dir.z * h);
    }
    position.needsUpdate = true;
    geometry.computeVertexNormals();

    // Colour pass, after normals exist so cliff shading can use them.
    const normal = geometry.getAttribute('normal') as BufferAttribute;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      _dir.set(directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2]);
      const slope =
        1 - (normal.getX(i) * _dir.x + normal.getY(i) * _dir.y + normal.getZ(i) * _dir.z);
      this.colorAt(_dir, heights[i], slope, _c3);
      colors[i * 3 + 0] = _c3.r;
      colors[i * 3 + 1] = _c3.g;
      colors[i * 3 + 2] = _c3.b;
    }
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, toonMaterial({ vertexColors: true, tones: 3, name: 'terrain' }));
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  /** Ground colour: zone blend first, then beach, cliff and snow rules on top. */
  private colorAt(d: Vector3, height: number, slope: number, out: Color): Color {
    const w = this.weights;
    zoneWeights(d, w);

    // Patchiness, so large flat areas are not a single dead colour.
    const patch = this.patch.fbm(d.x * 7.5, d.y * 7.5, d.z * 7.5, 2) * 0.5 + 0.5;
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

      srgb(zone.ground, _c1);
      srgb(zone.groundAlt, _c2);
      _c1.lerp(_c2, patch);
      r += _c1.r * weight;
      g += _c1.g * weight;
      b += _c1.b * weight;

      srgb(zone.cliff, _c2);
      cliffR += _c2.r * weight;
      cliffG += _c2.g * weight;
      cliffB += _c2.b * weight;

      if (zone.snowLine !== undefined) {
        snowWeight += weight * smoothstep(zone.snowLine, zone.snowLine + 0.22, elev);
      }
    }

    out.setRGB(r, g, b);

    // Cliffs: rock shows through wherever the ground gets steep.
    const cliffMix = smoothstep(0.16, 0.44, slope);
    if (cliffMix > 0) out.lerp(_c1.setRGB(cliffR, cliffG, cliffB), cliffMix);

    // Beaches: a sand band hugging the waterline, plus darker silt below it.
    const above = height - this.seaLevel;
    if (above < 0.42) {
      out.lerp(srgb(PALETTE.sand, _c1), smoothstep(0.42, 0.04, above) * (1 - cliffMix * 0.7));
      if (above < 0) out.lerp(srgb(0x6d7f6a, _c1), smoothstep(0, -0.8, above) * 0.8);
    }

    // Snow: zone-driven, plus a global dusting on the very highest ground.
    const dusting = smoothstep(1.02, 1.3, elev) * 0.85;
    const snow = Math.max(snowWeight, dusting) * (1 - smoothstep(0.34, 0.6, slope) * 0.55);
    if (snow > 0) out.lerp(srgb(PALETTE.snow, _c1), Math.min(1, snow));

    // Roads last, so they sit on top of grass, snow and beach alike.
    const road = this.pathFactor(d);
    if (road > 0) {
      // A pale kerb band at the edge before the asphalt proper: without it the
      // road reads as a stain rather than a built surface.
      out.lerp(srgb(PALETTE.kerb, _c1), Math.min(1, road * 1.9));
      out.lerp(srgb(PALETTE.asphalt, _c1), smoothstep(0.45, 0.85, road));
    }

    return out;
  }

  private buildOcean(): Mesh {
    // Coarser than the terrain -- water has no detail to lose -- but fine enough
    // that the shoreline does not cut across the land in straight chords.
    const geometry = new IcosahedronGeometry(this.seaLevel, 24);
    geometry.deleteAttribute('uv');

    const material = toonMaterial({
      color: PALETTE.water,
      tones: 2,
      transparent: true,
      opacity: 0.84,
      name: 'ocean',
    });

    // A slow multi-frequency swell. Cheap, and it stops the water reading as a
    // dead plastic shell on an otherwise moving world.
    const store: { shader?: { uniforms: Record<string, { value: number }> } } = {};
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            'vec3 oceanRadial = normalize( transformed );',
            'float swell = sin( transformed.x * 1.6 + uTime * 0.7 ) * 0.5',
            '  + sin( transformed.z * 2.1 - uTime * 0.9 ) * 0.5',
            '  + sin( transformed.y * 1.3 + uTime * 0.55 ) * 0.4;',
            'transformed += oceanRadial * swell * 0.035;',
          ].join('\n'),
        );
      store.shader = shader as unknown as { uniforms: Record<string, { value: number }> };
    };
    this.oceanShader = store;

    const mesh = new Mesh(geometry, material);
    mesh.name = 'ocean';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.renderOrder = 1;
    return mesh;
  }

  private oceanShader: { shader?: { uniforms: Record<string, { value: number }> } } = {};

  /** Advance the water animation. */
  update(elapsed: number): void {
    const uniforms = this.oceanShader.shader?.uniforms;
    if (uniforms?.uTime) uniforms.uTime.value = elapsed;
  }
}
