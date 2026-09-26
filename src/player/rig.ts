/**
 * The character rig seam.
 *
 * `Courier` builds a rig procedurally from primitives; `GltfRig` drives an
 * authored .glb through an AnimationMixer. Both satisfy `CourierRig`, and
 * nothing outside this folder knows which one it has.
 *
 * `createCourierRig()` prefers the authored model and silently falls back to
 * the procedural one, so the game runs identically whether or not anyone has
 * put art in `assets/source/` yet.
 */
import { Group, Object3D, Vector3 } from 'three';
import { Courier, type PoseInput } from './Courier';
import type { Cosmetics } from '../state/store';

export type { PoseInput };

export interface CourierRig {
  /** Attach this to the scene; the controller sets its transform. */
  readonly root: Group;
  /** Fires once per footfall, for footstep audio. */
  onFootstep: ((speed: number) => void) | null;

  setCosmetics(cosmetics: Cosmetics): void;
  setCarrying(carrying: boolean): void;
  playGesture(kind: 'handover' | 'wave'): void;
  setPose(dt: number, input: PoseInput): void;
  setLowDetail(low: boolean): void;
  headAnchor(target?: Vector3): Vector3;
  dispose(): void;
  readonly headJoint: Object3D;
}

/** Where the pipeline writes the optimised character model. */
const MODEL_URL = '/models/courier.glb';

type RigFactory = (cosmetics: Cosmetics) => CourierRig;

let factory: RigFactory | null = null;

/** Is there an authored model to load? A HEAD request, so it costs nothing. */
async function modelExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve which rig implementation to use. Call once during world generation;
 * every rig created afterwards (including remote players) uses the result.
 *
 * GltfRig is imported dynamically on purpose. It pulls in GLTFLoader,
 * DRACOLoader and SkeletonUtils, which together add ~35KB gzipped -- real money
 * for a game whose whole download is under 300KB, and pure waste when no
 * authored model is present. Probing with HEAD first means that code only ever
 * reaches a browser that is actually going to use it.
 */
export async function initCourierRigs(): Promise<'gltf' | 'procedural'> {
  if (factory) return factory === proceduralFactory ? 'procedural' : 'gltf';

  if (await modelExists(MODEL_URL)) {
    try {
      const { loadCourierGltf, GltfRig } = await import('./GltfRig');
      const loaded = await loadCourierGltf(MODEL_URL);
      if (loaded) {
        factory = (cosmetics) => new GltfRig(loaded, cosmetics);
        return 'gltf';
      }
    } catch (error) {
      console.warn('[rig] authored model failed to load, using the procedural rig:', error);
    }
  }

  factory = proceduralFactory;
  return 'procedural';
}

const proceduralFactory: RigFactory = (cosmetics) => new Courier(cosmetics);

export function createCourierRig(cosmetics: Cosmetics): CourierRig {
  return (factory ?? proceduralFactory)(cosmetics);
}
