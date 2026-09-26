/**
 * The courier character: a procedural low-poly rig with hand-authored animation.
 *
 * There is no skeletal skinning here. The body is a hierarchy of Groups acting
 * as joints, and the animation states (idle / walk / run / air / gesture) are
 * driven by sine curves against a stride phase. For a character this size that
 * is both cheaper and more controllable than blending imported clips -- the walk
 * cycle stays locked to actual ground speed, so the feet never skate.
 *
 * Cosmetics are baked into vertex colours, which means every courier in the
 * scene -- local and remote -- shares ONE material. Changing an outfit rebuilds
 * a few hundred vertices, which is free at UI-interaction rates.
 *
 * Swapping in a rigged Blender GLB later means implementing this same public
 * surface (`root`, `setCosmetics`, `setPose`, `playGesture`, `setCarrying`)
 * against an AnimationMixer; nothing outside this file knows how the rig works.
 */
import {
  BoxGeometry,
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshToonMaterial,
  Object3D,
  SphereGeometry,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import { addOutline } from '../fx/outline';
import { PALETTE, toonMaterial } from '../fx/toon';
import type { Cosmetics } from '../state/store';
import { clamp, damp, lerp } from '../util/sphere';
import { Assembly, parcel } from '../world/props';

export const HAT_NAMES = ['None', 'Courier cap', 'Beanie', 'Sun hat', 'Helmet'] as const;

/** One material shared by every courier in the scene. */
let sharedMaterial: MeshToonMaterial | null = null;
function courierMaterial(): MeshToonMaterial {
  return (sharedMaterial ??= toonMaterial({ vertexColors: true, tones: 3, name: 'courier' }));
}

/** Movement facts the rig needs in order to choose and drive a pose. */
export interface PoseInput {
  /** Ground speed in world units per second. */
  speed: number;
  /** True while off the ground. */
  airborne: boolean;
  /** Vertical velocity, for leaning into a jump or a fall. */
  verticalVelocity: number;
}

interface Part {
  group: Group;
  mesh: Mesh;
  /** Rebuilds this part's geometry from the current cosmetics. */
  rebuild: (cosmetics: Cosmetics) => BufferGeometry;
  restY: number;
}

const _v = new Vector3();

export class Courier {
  /** Attach this to the scene; the controller sets its transform. */
  readonly root = new Group();

  /** Everything below the root, so the rig can bob without moving the origin. */
  private readonly body = new Group();
  private readonly hips = new Group();
  private readonly head = new Group();
  private readonly armL = new Group();
  private readonly armR = new Group();
  private readonly legL = new Group();
  private readonly legR = new Group();
  private readonly hands = new Group();

  private readonly parts: Part[] = [];
  private parcelMesh!: Mesh;

  private cosmetics: Cosmetics;

  /** Distance-based stride phase, so footfalls match ground speed exactly. */
  private stride = 0;
  private idleTime = 0;
  private speedSmoothed = 0;
  private airBlend = 0;
  private gestureTime = -1;
  private gestureDuration = 0;
  private carrying = false;
  private carryBlend = 0;

  /** Fires once per footfall, for footstep audio. */
  onFootstep: ((speed: number) => void) | null = null;
  private lastStrideSide = 0;

  constructor(cosmetics: Cosmetics, options: { outlines?: boolean } = {}) {
    this.cosmetics = { ...cosmetics };
    this.root.name = 'courier';
    this.root.add(this.body);
    this.body.add(this.hips);

    const hipHeight = 0.66;
    this.hips.position.y = hipHeight;
    this.head.position.y = 0.6;
    this.armL.position.set(0.245, 0.47, 0);
    this.armR.position.set(-0.245, 0.47, 0);
    this.legL.position.set(0.115, 0, 0);
    this.legR.position.set(-0.115, 0, 0);
    this.hands.position.set(0, 0.3, 0.34);

    this.hips.add(this.head, this.armL, this.armR, this.legL, this.legR, this.hands);

    this.definePart(this.hips, buildTorso, 0);
    this.definePart(this.head, buildHead, 0);
    this.definePart(this.armL, (c) => buildArm(c, 1), 0);
    this.definePart(this.armR, (c) => buildArm(c, -1), 0);
    this.definePart(this.legL, (c) => buildLeg(c), 0);
    this.definePart(this.legR, (c) => buildLeg(c), 0);

    // The carried parcel rides in a dedicated group in front of the chest.
    this.parcelMesh = new Mesh(parcel(0.4), courierMaterial());
    this.parcelMesh.name = 'heldParcel';
    this.parcelMesh.castShadow = true;
    this.parcelMesh.visible = false;
    if (options.outlines !== false) addOutline(this.parcelMesh);
    this.hands.add(this.parcelMesh);

    if (options.outlines !== false) {
      for (const part of this.parts) addOutline(part.mesh);
    }
    this.applyCosmetics();
  }

  private definePart(group: Group, rebuild: (c: Cosmetics) => BufferGeometry, restY: number): void {
    const mesh = new Mesh(rebuild(this.cosmetics), courierMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    group.add(mesh);
    this.parts.push({ group, mesh, rebuild, restY });
  }

  private applyCosmetics(): void {
    for (const part of this.parts) {
      const next = part.rebuild(this.cosmetics);
      part.mesh.geometry.dispose();
      part.mesh.geometry = next;
      // Outline shells share the fill geometry, so point them at the new one.
      for (const child of part.mesh.children) {
        if (child instanceof Mesh) child.geometry = next;
      }
    }
  }

  setCosmetics(cosmetics: Cosmetics): void {
    const changed =
      cosmetics.outfit !== this.cosmetics.outfit ||
      cosmetics.hat !== this.cosmetics.hat ||
      cosmetics.skin !== this.cosmetics.skin;
    this.cosmetics = { ...cosmetics };
    if (changed) this.applyCosmetics();
  }

  setCarrying(carrying: boolean): void {
    this.carrying = carrying;
    this.parcelMesh.visible = carrying;
  }

  /** Play a one-shot gesture: 0 = hand over parcel, 1 = wave. */
  playGesture(kind: 'handover' | 'wave' = 'handover'): void {
    this.gestureTime = 0;
    this.gestureDuration = kind === 'wave' ? 1.5 : 0.85;
    this.gestureKind = kind;
  }

  private gestureKind: 'handover' | 'wave' = 'handover';

  /** World position just above the head, used to anchor emoji and name tags. */
  headAnchor(target = new Vector3()): Vector3 {
    this.head.getWorldPosition(target);
    this.root.getWorldDirection(_v);
    // Nudge up along the character's own up axis.
    _v.set(0, 1, 0).applyQuaternion(this.root.quaternion);
    return target.addScaledVector(_v, 0.62);
  }

  /**
   * Advance the animation.
   * @param dt      seconds
   * @param input   current movement state
   */
  setPose(dt: number, input: PoseInput): void {
    const runSpeed = CONFIG.player.runSpeed;
    const speed01 = clamp(input.speed / runSpeed, 0, 1.2);
    this.speedSmoothed = lerp(this.speedSmoothed, speed01, damp(0.25, dt));
    this.airBlend = lerp(this.airBlend, input.airborne ? 1 : 0, damp(0.3, dt));
    this.carryBlend = lerp(this.carryBlend, this.carrying ? 1 : 0, damp(0.2, dt));
    this.idleTime += dt;

    // Stride advances with distance travelled, not time, so the legs cannot
    // out-run the character. 1.55 rad per world unit gives a ~4-unit stride.
    const grounded = 1 - this.airBlend;
    this.stride += input.speed * dt * 1.55 * grounded;

    const moving = this.speedSmoothed > 0.02;
    const swing = Math.sin(this.stride);
    const swingB = Math.cos(this.stride);

    // ---- footstep events
    if (moving && grounded > 0.5) {
      const side = swing >= 0 ? 1 : -1;
      if (side !== this.lastStrideSide) {
        this.lastStrideSide = side;
        this.onFootstep?.(this.speedSmoothed);
      }
    }

    // ---- legs
    const legAmp = lerp(0.12, 0.82, this.speedSmoothed);
    const tuck = this.airBlend;
    this.legL.rotation.x = swing * legAmp * grounded - tuck * 0.7;
    this.legR.rotation.x = -swing * legAmp * grounded - tuck * 0.35;
    // Knees lift slightly on the forward swing.
    this.legL.rotation.z = -swingB * 0.05 * this.speedSmoothed;
    this.legR.rotation.z = swingB * 0.05 * this.speedSmoothed;

    // ---- arms
    const armAmp = lerp(0.1, 0.62, this.speedSmoothed);
    const carry = this.carryBlend;
    // When carrying, the arms come forward and stop swinging much.
    const carriedPose = -1.15;
    const armSwingL = -swing * armAmp * grounded * (1 - carry * 0.8);
    const armSwingR = swing * armAmp * grounded * (1 - carry * 0.8);
    this.armL.rotation.x = lerp(armSwingL, carriedPose, carry) - this.airBlend * 0.9;
    this.armR.rotation.x = lerp(armSwingR, carriedPose, carry) - this.airBlend * 0.9;
    this.armL.rotation.z = lerp(-0.08, -0.34, carry) - this.airBlend * 0.25;
    this.armR.rotation.z = lerp(0.08, 0.34, carry) + this.airBlend * 0.25;

    // ---- body bob and lean
    const bob = moving ? Math.abs(Math.sin(this.stride)) * 0.055 * this.speedSmoothed : 0;
    const breathe = Math.sin(this.idleTime * 1.7) * 0.012 * (1 - this.speedSmoothed);
    this.hips.position.y = 0.66 + bob + breathe;
    this.body.rotation.x = lerp(0, -0.2, this.speedSmoothed) + clamp(input.verticalVelocity * 0.012, -0.12, 0.12);
    this.body.rotation.z = -swingB * 0.03 * this.speedSmoothed;

    // ---- head: looks slightly into the turn, and bobs when idle
    this.head.rotation.x = lerp(Math.sin(this.idleTime * 1.2) * 0.05, 0.1, this.speedSmoothed);
    this.head.rotation.y = Math.sin(this.idleTime * 0.5) * 0.18 * (1 - this.speedSmoothed);

    // ---- one-shot gesture, layered on top of everything above
    if (this.gestureTime >= 0) {
      this.gestureTime += dt;
      const t = this.gestureTime / this.gestureDuration;
      if (t >= 1) {
        this.gestureTime = -1;
      } else if (this.gestureKind === 'wave') {
        const wave = Math.sin(t * Math.PI * 6) * (1 - t);
        this.armR.rotation.x = -2.3;
        this.armR.rotation.z = 0.5 + wave * 0.5;
      } else {
        // Hand-over: both arms push forward and out, then settle.
        const push = Math.sin(Math.min(1, t * 1.4) * Math.PI);
        this.armL.rotation.x -= push * 0.9;
        this.armR.rotation.x -= push * 0.9;
        this.hands.position.z = 0.34 + push * 0.22;
        this.body.rotation.x -= push * 0.12;
      }
    } else {
      this.hands.position.z = 0.34;
    }

    // The carried parcel settles into the hands and jiggles slightly when running.
    this.hands.position.y = 0.3 + bob * 0.4;
    this.parcelMesh.rotation.z = Math.sin(this.stride * 0.5) * 0.06 * this.speedSmoothed;
  }

  /** Cheap variant used for distant remote players. */
  setLowDetail(low: boolean): void {
    for (const part of this.parts) {
      for (const child of part.mesh.children) {
        if (child.name.endsWith(':outline')) child.visible = !low;
      }
    }
  }

  dispose(): void {
    for (const part of this.parts) part.mesh.geometry.dispose();
    this.parcelMesh.geometry.dispose();
    this.root.removeFromParent();
  }

  /** Exposed so callers can parent name tags / emoji to the rig. */
  get headJoint(): Object3D {
    return this.head;
  }
}

// --------------------------------------------------------------- part builders

const outfitColor = (c: Cosmetics) => PALETTE.outfit[c.outfit % PALETTE.outfit.length];
const skinColor = (c: Cosmetics) => PALETTE.skin[c.skin % PALETTE.skin.length];
const hairColor = (c: Cosmetics) => PALETTE.hair[(c.outfit + 1) % PALETTE.hair.length];

/** Slightly darkened version of a colour, for trousers and boots. */
function shade(hex: number, amount: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((hex >> 16) & 255) * (1 - amount))));
  const g = Math.max(0, Math.min(255, Math.round(((hex >> 8) & 255) * (1 - amount))));
  const b = Math.max(0, Math.min(255, Math.round((hex & 255) * (1 - amount))));
  return (r << 16) | (g << 8) | b;
}

function buildTorso(c: Cosmetics): BufferGeometry {
  const a = new Assembly();
  const outfit = outfitColor(c);

  // Chest: a tapered box reads as a jacket.
  const chest = new BoxGeometry(0.46, 0.56, 0.3);
  a.add(chest, outfit, new Matrix4().makeTranslation(0, 0.28, 0));
  // Collar + shoulder yoke.
  a.block(0.5, 0.08, 0.34, 0, 0.54, 0, shade(outfit, 0.25));
  a.block(0.2, 0.1, 0.24, 0, 0.58, 0, skinColor(c));
  // Hips / belt.
  a.block(0.42, 0.12, 0.28, 0, 0.02, 0, shade(outfit, 0.45));
  // Satchel on the left hip, strap across the chest: the courier read.
  a.block(0.3, 0.26, 0.16, 0.26, 0.12, -0.02, PALETTE.wood);
  a.block(0.32, 0.08, 0.18, 0.26, 0.24, -0.02, PALETTE.woodDark);
  const strap = new BoxGeometry(0.1, 0.62, 0.02);
  a.add(strap, PALETTE.woodDark, new Matrix4().makeTranslation(0.04, 0.3, 0.155).multiply(new Matrix4().makeRotationZ(0.42)));
  return a.build('courier.torso');
}

function buildHead(c: Cosmetics): BufferGeometry {
  const a = new Assembly();
  const skin = skinColor(c);
  const hair = hairColor(c);

  const skull = new SphereGeometry(0.21, 10, 8);
  skull.scale(1, 1.06, 0.96);
  a.add(skull, skin, new Matrix4().makeTranslation(0, 0.2, 0));

  // Eyes: two small dark blocks, placed on the +Z face.
  for (const sx of [-1, 1]) {
    a.block(0.045, 0.06, 0.03, sx * 0.075, 0.22, 0.2, 0x2a2b33);
  }
  // Nose.
  a.block(0.04, 0.04, 0.04, 0, 0.17, 0.205, shade(skin, 0.12));

  switch (c.hat % 5) {
    case 0: {
      // Hair only.
      const cap = new SphereGeometry(0.215, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
      a.add(cap, hair, new Matrix4().makeTranslation(0, 0.205, 0));
      a.block(0.2, 0.09, 0.12, 0, 0.29, 0.16, hair);
      break;
    }
    case 1: {
      // Courier cap with a peak.
      const crown = new SphereGeometry(0.225, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
      a.add(crown, PALETTE.mailbox, new Matrix4().makeTranslation(0, 0.215, 0));
      a.block(0.3, 0.035, 0.18, 0, 0.245, 0.19, shade(PALETTE.mailbox, 0.3));
      a.block(0.09, 0.06, 0.05, 0, 0.3, 0.14, PALETTE.accent);
      break;
    }
    case 2: {
      // Beanie with a bobble.
      const beanie = new SphereGeometry(0.228, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62);
      a.add(beanie, PALETTE.roofTeal, new Matrix4().makeTranslation(0, 0.2, 0));
      a.add(new CylinderGeometry(0.232, 0.232, 0.06, 10), shade(PALETTE.roofTeal, 0.25), new Matrix4().makeTranslation(0, 0.23, 0));
      a.add(new SphereGeometry(0.055, 7, 5), 0xfdf6e8, new Matrix4().makeTranslation(0, 0.42, 0));
      break;
    }
    case 3: {
      // Wide sun hat.
      a.add(new CylinderGeometry(0.4, 0.42, 0.03, 12), PALETTE.sand, new Matrix4().makeTranslation(0, 0.3, 0));
      a.add(new CylinderGeometry(0.17, 0.2, 0.14, 10), shade(PALETTE.sand, 0.12), new Matrix4().makeTranslation(0, 0.36, 0));
      a.add(new CylinderGeometry(0.205, 0.205, 0.04, 10), PALETTE.roofTeal, new Matrix4().makeTranslation(0, 0.32, 0));
      break;
    }
    default: {
      // Helmet with goggles.
      const shell = new SphereGeometry(0.235, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.58);
      a.add(shell, PALETTE.accent, new Matrix4().makeTranslation(0, 0.2, 0));
      a.block(0.42, 0.07, 0.06, 0, 0.26, 0.19, 0x3a3f4a);
      for (const sx of [-1, 1]) {
        a.add(new CylinderGeometry(0.06, 0.06, 0.04, 8), PALETTE.window, new Matrix4().makeTranslation(sx * 0.1, 0.26, 0.21).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
      }
      break;
    }
  }

  return a.build('courier.head');
}

/** Arm hangs downward from the shoulder joint at the local origin. */
function buildArm(c: Cosmetics, side: number): BufferGeometry {
  const a = new Assembly();
  const outfit = outfitColor(c);
  const sleeve = new CylinderGeometry(0.058, 0.066, 0.34, 6);
  a.add(sleeve, outfit, new Matrix4().makeTranslation(0, -0.17, 0));
  a.add(new CylinderGeometry(0.052, 0.058, 0.14, 6), shade(outfit, 0.2), new Matrix4().makeTranslation(0, -0.4, 0));
  const hand = new SphereGeometry(0.068, 7, 5);
  hand.scale(1, 0.9, 1.05);
  a.add(hand, skinColor(c), new Matrix4().makeTranslation(0, -0.49, 0.01));
  // A tiny shoulder cap hides the joint seam when the arm swings.
  a.add(new SphereGeometry(0.075, 7, 5), outfit, new Matrix4().makeTranslation(side * 0.005, 0, 0));
  return a.build('courier.arm');
}

/** Leg hangs downward from the hip joint at the local origin. */
function buildLeg(c: Cosmetics): BufferGeometry {
  const a = new Assembly();
  const trousers = shade(outfitColor(c), 0.52);
  a.add(new CylinderGeometry(0.072, 0.08, 0.44, 6), trousers, new Matrix4().makeTranslation(0, -0.22, 0));
  // Boot: a box with a rounded toe pointing +Z.
  a.block(0.15, 0.1, 0.2, 0, -0.5, 0.03, PALETTE.woodDark);
  a.add(new ConeGeometry(0.075, 0.1, 6), PALETTE.woodDark, new Matrix4().makeTranslation(0, -0.47, 0.11).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
  a.add(new SphereGeometry(0.085, 7, 5), trousers, new Matrix4().makeTranslation(0, 0, 0));
  return a.build('courier.leg');
}
