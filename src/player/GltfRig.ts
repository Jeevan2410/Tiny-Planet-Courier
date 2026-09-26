/**
 * Authored-model character rig.
 *
 * Loads a .glb produced by `npm run assets` and drives it with an
 * AnimationMixer, blending idle / walk / run by ground speed. It presents
 * exactly the same surface as the procedural `Courier`, so the rest of the game
 * cannot tell them apart.
 *
 * Conventions an exported model should follow (all optional -- anything missing
 * is simply skipped):
 *
 *   Animation clips   `idle`, `walk`, `run`, and optionally `handover`, `wave`
 *   Material names    `outfit`, `skin`, `hair` -- tinted by the player's chosen
 *                     cosmetics. Anything else keeps its authored colour.
 *   Node names        `head` -- used to anchor emoji and name tags.
 *
 * Skinned and node-animated rigs both work: `clone()` from three's SkeletonUtils
 * handles either, and a mixer is created per instance so remote players animate
 * independently.
 */
import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Color,
  Group,
  LoopOnce,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from '../config';
import { addOutline } from '../fx/outline';
import { PALETTE, toonMaterial } from '../fx/toon';
import type { Cosmetics } from '../state/store';
import { clamp, damp, lerp } from '../util/sphere';
import { parcel } from '../world/props';
import type { CourierRig, PoseInput } from './rig';

export interface LoadedCourier {
  scene: Object3D;
  clips: AnimationClip[];
}

const _v = new Vector3();

/**
 * Try to load the authored model. Returns null when there is no model to load,
 * which is the normal case for a fresh checkout -- the caller falls back to the
 * procedural rig.
 */
export async function loadCourierGltf(url: string): Promise<LoadedCourier | null> {
  try {
    // A HEAD request first: GLTFLoader's own failure path is noisy in the
    // console, and a missing model is an expected state, not an error.
    const probe = await fetch(url, { method: 'HEAD' });
    if (!probe.ok) return null;

    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('/draco/');
    loader.setDRACOLoader(draco);

    const gltf = await loader.loadAsync(url);
    draco.dispose();

    if (!gltf.scene) return null;
    return { scene: gltf.scene, clips: gltf.animations ?? [] };
  } catch (error) {
    console.warn('[rig] no authored model, using the procedural rig:', error);
    return null;
  }
}

/** Swap imported materials for the project's toon material, keeping colours. */
function toToon(root: Object3D): Map<string, MeshStandardMaterial> {
  const originals = new Map<string, MeshStandardMaterial>();

  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;

    const source = mesh.material as MeshStandardMaterial;
    const name = source?.name ?? '';
    if (source && !originals.has(name)) originals.set(name, source);

    const toon = toonMaterial({ tones: 3, name });
    if (source?.color) toon.color.copy(source.color);
    if (source?.map) {
      toon.map = source.map;
      toon.map.colorSpace = SRGBColorSpace;
    }
    mesh.material = toon;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
  });

  return originals;
}

export class GltfRig implements CourierRig {
  readonly root = new Group();
  onFootstep: ((speed: number) => void) | null = null;

  private readonly model: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<string, AnimationAction>();
  private readonly tinted: { material: MeshStandardMaterial; role: string }[] = [];

  private head: Object3D | null = null;
  private hands: Object3D;
  private parcelMesh: Mesh;

  private cosmetics: Cosmetics;
  private speedSmoothed = 0;
  private carrying = false;
  private carryBlend = 0;
  private lastPhase = 0;
  private gestureAction: AnimationAction | null = null;

  constructor(source: LoadedCourier, cosmetics: Cosmetics) {
    this.cosmetics = { ...cosmetics };
    this.root.name = 'courier';

    // Clone per instance so several couriers can animate independently.
    this.model = cloneSkinned(source.scene);
    this.root.add(this.model);

    toToon(this.model);

    // Collect first, THEN outline. addOutline parents a shell to the mesh, and
    // traverse walks children as it goes -- outlining inside the traversal
    // makes it recurse into the shells it just created, forever.
    const meshes: Mesh[] = [];
    this.model.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    for (const mesh of meshes) {
      const role = (mesh.material as MeshStandardMaterial).name ?? '';
      if (role === 'outfit' || role === 'skin' || role === 'hair') {
        this.tinted.push({ material: mesh.material as MeshStandardMaterial, role });
      }
      addOutline(mesh, { width: CONFIG.render.outlineWidth });
    }

    this.head = this.model.getObjectByName('head') ?? null;

    this.mixer = new AnimationMixer(this.model);
    for (const clip of source.clips) {
      const action = this.mixer.clipAction(clip);
      action.enabled = true;
      action.setLoop(LoopRepeat, Infinity);
      this.actions.set(clip.name.toLowerCase(), action);
    }
    // Locomotion actions all run at once; weights decide what you see.
    for (const name of ['idle', 'walk', 'run']) {
      const action = this.actions.get(name);
      if (action) action.play().setEffectiveWeight(name === 'idle' ? 1 : 0);
    }

    // The carried parcel rides in a group in front of the chest, exactly as in
    // the procedural rig, so gameplay code needs no special case.
    this.hands = new Group();
    this.hands.position.set(0, 1.0, 0.34);
    this.root.add(this.hands);

    this.parcelMesh = new Mesh(parcel(0.4), toonMaterial({ vertexColors: true, name: 'courier' }));
    this.parcelMesh.name = 'heldParcel';
    this.parcelMesh.castShadow = true;
    this.parcelMesh.visible = false;
    addOutline(this.parcelMesh);
    this.hands.add(this.parcelMesh);

    this.applyCosmetics();
  }

  private applyCosmetics(): void {
    const colour = new Color();
    for (const { material, role } of this.tinted) {
      if (role === 'outfit') {
        colour.setHex(PALETTE.outfit[this.cosmetics.outfit % PALETTE.outfit.length], SRGBColorSpace);
      } else if (role === 'skin') {
        colour.setHex(PALETTE.skin[this.cosmetics.skin % PALETTE.skin.length], SRGBColorSpace);
      } else {
        colour.setHex(PALETTE.hair[(this.cosmetics.outfit + 1) % PALETTE.hair.length], SRGBColorSpace);
      }
      material.color.copy(colour);
    }
  }

  setCosmetics(cosmetics: Cosmetics): void {
    const changed =
      cosmetics.outfit !== this.cosmetics.outfit ||
      cosmetics.skin !== this.cosmetics.skin ||
      cosmetics.hat !== this.cosmetics.hat;
    this.cosmetics = { ...cosmetics };
    if (changed) this.applyCosmetics();
  }

  setCarrying(carrying: boolean): void {
    this.carrying = carrying;
    this.parcelMesh.visible = carrying;
  }

  playGesture(kind: 'handover' | 'wave' = 'handover'): void {
    const action = this.actions.get(kind);
    if (!action) return;
    this.gestureAction?.fadeOut(0.15);
    action.reset().setLoop(LoopOnce, 1).setEffectiveWeight(1).fadeIn(0.1).play();
    action.clampWhenFinished = true;
    this.gestureAction = action;
  }

  setPose(dt: number, input: PoseInput): void {
    const speed01 = clamp(input.speed / CONFIG.player.runSpeed, 0, 1.2);
    this.speedSmoothed = lerp(this.speedSmoothed, speed01, damp(0.25, dt));
    this.carryBlend = lerp(this.carryBlend, this.carrying ? 1 : 0, damp(0.2, dt));

    // Blend the three locomotion clips by speed. Splitting the crossfade at the
    // walk/run boundary keeps the feet from sliding through the transition.
    const s = this.speedSmoothed;
    const walkWeight = s < 0.5 ? s / 0.5 : Math.max(0, 1 - (s - 0.5) / 0.5);
    const runWeight = s < 0.5 ? 0 : (s - 0.5) / 0.5;
    const idleWeight = Math.max(0, 1 - s / 0.5);

    this.actions.get('idle')?.setEffectiveWeight(idleWeight);
    this.actions.get('walk')?.setEffectiveWeight(walkWeight);
    this.actions.get('run')?.setEffectiveWeight(runWeight);

    // Drive the clips from distance travelled rather than wall time, so the
    // stride matches ground speed and the feet do not skate.
    const cadence = lerp(1, 1.9, s);
    this.mixer.update(dt * (input.speed > 0.05 ? cadence : 1));

    // Footstep events, taken from the locomotion phase.
    const walk = this.actions.get('walk') ?? this.actions.get('run');
    if (walk && input.speed > 0.05 && !input.airborne) {
      const clipLength = walk.getClip().duration || 1;
      const phase = (walk.time % clipLength) / clipLength;
      if (phase < this.lastPhase || (this.lastPhase < 0.5 && phase >= 0.5)) {
        this.onFootstep?.(this.speedSmoothed);
      }
      this.lastPhase = phase;
    }

    this.hands.visible = this.carryBlend > 0.02;
    this.hands.position.z = lerp(0.25, 0.4, this.carryBlend);
  }

  setLowDetail(low: boolean): void {
    this.root.traverse((child) => {
      if (child.name.endsWith(':outline')) child.visible = !low;
    });
  }

  headAnchor(target = new Vector3()): Vector3 {
    if (this.head) this.head.getWorldPosition(target);
    else this.root.getWorldPosition(target);
    _v.set(0, 1, 0).applyQuaternion(this.root.quaternion);
    return target.addScaledVector(_v, 0.62);
  }

  get headJoint(): Object3D {
    return this.head ?? this.root;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.parcelMesh.geometry.dispose();
    this.root.removeFromParent();
  }
}
