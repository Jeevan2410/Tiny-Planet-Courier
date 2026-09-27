/**
 * The planet: a thin three.js layer over the terrain field.
 *
 * The field itself lives in `field.ts` and knows nothing about three, so the
 * same maths can run in the world generation worker. This class holds the
 * meshes, exposes a Vector3-shaped API to the rest of the game, and owns the
 * decision of whether generation happens on a worker or inline.
 *
 * The important design property is unchanged: terrain height is a pure function
 * of direction. Nothing in the game raycasts against the ground -- the character
 * controller, the villagers, the prop scatterer and the camera's floor check all
 * call `heightAt()` and get an exact answer in a couple of microseconds, and the
 * mesh is generated from that same function, so the visual surface and the
 * collision surface are the same surface by construction.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import { PALETTE, toonMaterial } from '../fx/toon';
import { TerrainField } from './field';
import { buildTerrain, type TerrainArrays } from './terrainMesh';
import type { BuildTerrainRequest, TerrainResult } from './worldWorker';
import { ZONES, zoneWeights, type Zone } from './zones';

const _dir = new Vector3();
const _n = new Vector3();
const _pa = new Vector3();
const _pb = new Vector3();
const _pc = new Vector3();
const _pd = new Vector3();
const _ax = new Vector3();
const _az = new Vector3();

export class Planet {
  readonly radius = CONFIG.planet.radius;
  readonly seaLevel = CONFIG.planet.seaLevel;
  readonly amplitude = CONFIG.planet.terrainAmplitude;

  readonly group = new Group();
  readonly field: TerrainField;
  terrain!: Mesh;
  ocean!: Mesh;

  /** How the last build ran, for the stats readout. */
  generatedOn: 'worker' | 'main' = 'main';
  generationMs = 0;

  private readonly weights = new Float32Array(ZONES.length);

  constructor(seed = CONFIG.planet.seed) {
    this.group.name = 'planet';
    this.field = new TerrainField({
      seed,
      radius: this.radius,
      amplitude: this.amplitude,
      seaLevel: this.seaLevel,
    });
  }

  // -------------------------------------------------------------- field access

  /** Terrain radius at a unit direction. */
  heightAt(d: Vector3): number {
    return this.field.heightAt(d.x, d.y, d.z);
  }

  /** Road coverage at a direction: 1 on the carriageway, 0 off it. */
  pathFactor(d: Vector3): number {
    return this.field.pathFactor(d.x, d.y, d.z);
  }

  /** Steepness at a direction, as 1 - dot(surfaceNormal, radial). */
  slopeAt(d: Vector3, epsilon = 0.012): number {
    return this.field.slopeAt(d.x, d.y, d.z, epsilon);
  }

  /** Normalised elevation above base radius: ~0 at the coast, ~1 at the peaks. */
  elevation(height: number): number {
    return this.field.elevation(height);
  }

  /**
   * Register a levelled building site. Must be called before `build()`, since
   * the terrain mesh is generated with the terraces already in it.
   */
  addFlatSpot(center: Vector3, angularRadius: number): void {
    this.field.addFlat([center.x, center.y, center.z], angularRadius);
  }

  /** Register a road. Must also be called before `build()`. */
  addPath(points: Vector3[], width: number, spacing = 0.45): void {
    this.field.addPath(
      points.map((p) => [p.x, p.y, p.z] as [number, number, number]),
      width,
      spacing,
    );
  }

  /** World-space point on the ground for a direction. */
  surfacePoint(d: Vector3, out = new Vector3()): Vector3 {
    _dir.copy(d).normalize();
    return out.copy(_dir).multiplyScalar(this.heightAt(_dir));
  }

  /** Surface normal, derived from the same field the mesh is built from. */
  normalAt(d: Vector3, out = new Vector3(), epsilon = 0.012): Vector3 {
    _n.copy(d).normalize();
    if (Math.abs(_n.y) < 0.9) _ax.set(0, 1, 0);
    else _ax.set(1, 0, 0);
    _ax.cross(_n).normalize();
    _az.copy(_n).cross(_ax).normalize();

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

  // -------------------------------------------------------------------- build

  /**
   * Generate the planet.
   *
   * Tries a worker first so the main thread stays responsive while ~41k
   * vertices are displaced and coloured; falls back to building inline if
   * workers are unavailable or the worker fails for any reason. The fallback is
   * not dead code -- it is the path taken in any environment without module
   * worker support, and it runs the exact same `buildTerrain`.
   */
  async build(onProgress?: (fraction: number) => void): Promise<void> {
    const started = performance.now();
    let arrays: TerrainArrays | null = null;

    try {
      arrays = await this.buildOnWorker(onProgress);
      this.generatedOn = 'worker';
    } catch (error) {
      console.warn('[planet] worker generation unavailable, building inline:', error);
      arrays = null;
    }

    if (!arrays) {
      arrays = buildTerrain(this.field, CONFIG.planet.subdivisions, onProgress);
      this.generatedOn = 'main';
    }

    this.generationMs = performance.now() - started;
    this.terrain = this.meshFromArrays(arrays);
    this.ocean = this.buildOcean();
    this.group.add(this.terrain, this.ocean);
  }

  private buildOnWorker(onProgress?: (fraction: number) => void): Promise<TerrainArrays> {
    return new Promise((resolve, reject) => {
      if (typeof Worker === 'undefined') {
        reject(new Error('Worker is not available'));
        return;
      }

      const worker = new Worker(new URL('./worldWorker.ts', import.meta.url), {
        type: 'module',
      });

      const finish = (fn: () => void) => {
        worker.terminate();
        fn();
      };

      worker.onmessage = (event: MessageEvent<TerrainResult | { type: string; fraction?: number; message?: string }>) => {
        const data = event.data;
        if (data.type === 'progress') {
          onProgress?.((data as { fraction: number }).fraction);
          return;
        }
        if (data.type === 'error') {
          finish(() => reject(new Error((data as { message: string }).message)));
          return;
        }
        if (data.type === 'terrain') {
          const result = data as TerrainResult;
          finish(() =>
            resolve({
              position: result.position,
              normal: result.normal,
              color: result.color,
              index: result.index,
              vertexCount: result.vertexCount,
            }),
          );
        }
      };

      worker.onerror = (event) => finish(() => reject(new Error(event.message || 'worker error')));
      worker.onmessageerror = () => finish(() => reject(new Error('worker message error')));

      worker.postMessage({
        type: 'terrain',
        config: this.field.toConfig(),
        subdivisions: CONFIG.planet.subdivisions,
      } satisfies BuildTerrainRequest);
    });
  }

  private meshFromArrays(arrays: TerrainArrays): Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
    geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
    geometry.setAttribute('color', new BufferAttribute(arrays.color, 3));
    geometry.setIndex(new BufferAttribute(arrays.index, 1));
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, toonMaterial({ vertexColors: true, tones: 3, name: 'terrain' }));
    mesh.name = 'terrain';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
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
