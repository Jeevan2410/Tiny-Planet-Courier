/**
 * Lighting and the day/night cycle.
 *
 * The sun orbits the planet on a tilted axis. Crucially, the sky palette is not
 * driven by the global clock but by the sun's elevation *above the player's own
 * horizon* -- because on a world this small, walking far enough is itself a
 * change of time of day. Two players on opposite sides of the planet see noon
 * and midnight simultaneously, and the terminator sweeps past you as you travel.
 */
import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Object3D,
  Scene,
  Vector3,
} from 'three';
import { CONFIG, type Quality } from '../config';
import { clamp, smoothstep } from '../util/sphere';
import type { Sky } from './Sky';

interface LightKey {
  /** Sun elevation above the local horizon, -1 .. 1. */
  elevation: number;
  zenith: number;
  horizon: number;
  ground: number;
  sun: number;
  sunIntensity: number;
  /** Sky/ground colours for the hemisphere fill. */
  ambientSky: number;
  ambientGround: number;
  ambientIntensity: number;
  fog: number;
  night: number;
}

/** Ordered by elevation; values between keys are interpolated. */
const KEYS: LightKey[] = [
  {
    elevation: -1,
    zenith: 0x0a1020,
    horizon: 0x16203a,
    ground: 0x070b14,
    sun: 0x93aede,
    sunIntensity: 0.16,
    ambientSky: 0x2a3a5e,
    ambientGround: 0x11182a,
    ambientIntensity: 0.42,
    fog: 0x131c30,
    night: 1,
  },
  {
    elevation: -0.16,
    zenith: 0x1b2a4c,
    horizon: 0x3d4a74,
    ground: 0x0e1526,
    sun: 0xa9bde6,
    sunIntensity: 0.22,
    ambientSky: 0x3b4d76,
    ambientGround: 0x181f33,
    ambientIntensity: 0.5,
    fog: 0x2a3554,
    night: 0.85,
  },
  {
    elevation: 0,
    zenith: 0x4a6ba8,
    horizon: 0xff9d68,
    ground: 0x2b3145,
    sun: 0xff9a5e,
    sunIntensity: 0.7,
    ambientSky: 0x7f8fc0,
    ambientGround: 0x4a3d3a,
    ambientIntensity: 0.62,
    fog: 0xe0916a,
    night: 0.35,
  },
  {
    elevation: 0.2,
    zenith: 0x4f8ed4,
    horizon: 0xffd2a4,
    ground: 0x35455c,
    sun: 0xffd9a0,
    sunIntensity: 1.05,
    ambientSky: 0xa8cdea,
    ambientGround: 0x6d7a5e,
    ambientIntensity: 0.68,
    fog: 0xf2d0ae,
    night: 0.08,
  },
  {
    elevation: 0.62,
    zenith: 0x3f96de,
    horizon: 0xc8e8f6,
    ground: 0x34485f,
    sun: 0xfff4da,
    sunIntensity: 1.22,
    ambientSky: 0xb6dcf2,
    ambientGround: 0x7d8a63,
    ambientIntensity: 0.72,
    fog: 0xcfe7f3,
    night: 0,
  },
  {
    elevation: 1,
    zenith: 0x3a90dc,
    horizon: 0xd6eef8,
    ground: 0x35495f,
    sun: 0xfffaea,
    sunIntensity: 1.3,
    ambientSky: 0xc0e2f5,
    ambientGround: 0x87946a,
    ambientIntensity: 0.74,
    fog: 0xd8eef9,
    night: 0,
  },
];

const _a = new Color();
const _b = new Color();

export class DayCycle {
  readonly sun: DirectionalLight;
  readonly fill: HemisphereLight;
  readonly target = new Object3D();

  /** 0 = start of the cycle, wraps at 1. */
  phase: number = CONFIG.dayCycle.startPhase;
  /** Unit vector pointing from the planet toward the sun. */
  readonly sunDirection = new Vector3(0, 1, 0);
  /** 0 in daylight, 1 at local midnight. Drives lamps and stars. */
  nightAmount = 0;

  private readonly orbitAxis = new Vector3(0.28, 1, 0.12).normalize();
  private readonly orbitBase = new Vector3();
  private readonly zenith = new Color();
  private readonly horizon = new Color();
  private readonly ground = new Color();
  private readonly sunColor = new Color();
  private readonly fogColor = new Color();

  constructor() {
    // A vector perpendicular to the orbit axis: the sun's position at phase 0.
    this.orbitBase.set(0, 0, 1).cross(this.orbitAxis).normalize();
    if (this.orbitBase.lengthSq() < 1e-6) this.orbitBase.set(1, 0, 0);

    this.sun = new DirectionalLight(0xfff4da, 1.2);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    // The shadow camera follows the player and covers only their neighbourhood.
    // A frustum wide enough for the whole planet would waste almost all of its
    // resolution on ground you cannot see.
    const cam = this.sun.shadow.camera;
    cam.near = 1;
    cam.far = 120;
    cam.left = -17;
    cam.right = 17;
    cam.top = 17;
    cam.bottom = -17;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.02;
    this.sun.target = this.target;

    this.fill = new HemisphereLight(0xb6dcf2, 0x7d8a63, 0.72);
    this.fill.name = 'fill';
  }

  addTo(scene: Scene): void {
    scene.add(this.sun, this.sun.target, this.fill);
    scene.fog = new Fog(0xcfe7f3, 34, 96);
  }

  setQuality(quality: Quality): void {
    this.sun.castShadow = quality === 'high';
    this.sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
    // Force the shadow map to be rebuilt at the new resolution.
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as never;
  }

  /** Interpolate the keyframe table at a given sun elevation. */
  private sample(elevation: number): LightKey {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].elevation < elevation) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const span = b.elevation - a.elevation;
    const t = span <= 0 ? 0 : clamp((elevation - a.elevation) / span, 0, 1);

    _a.setHex(a.zenith);
    _b.setHex(b.zenith);
    this.zenith.copy(_a).lerp(_b, t);

    _a.setHex(a.horizon);
    _b.setHex(b.horizon);
    this.horizon.copy(_a).lerp(_b, t);

    _a.setHex(a.ground);
    _b.setHex(b.ground);
    this.ground.copy(_a).lerp(_b, t);

    _a.setHex(a.sun);
    _b.setHex(b.sun);
    this.sunColor.copy(_a).lerp(_b, t);

    _a.setHex(a.fog);
    _b.setHex(b.fog);
    this.fogColor.copy(_a).lerp(_b, t);

    _a.setHex(a.ambientSky);
    _b.setHex(b.ambientSky);
    this.fill.color.copy(_a).lerp(_b, t);

    _a.setHex(a.ambientGround);
    _b.setHex(b.ambientGround);
    this.fill.groundColor.copy(_a).lerp(_b, t);

    return {
      ...a,
      sunIntensity: a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t,
      ambientIntensity: a.ambientIntensity + (b.ambientIntensity - a.ambientIntensity) * t,
      night: a.night + (b.night - a.night) * t,
    };
  }

  update(dt: number, scene: Scene, sky: Sky, playerPosition: Vector3, playerUp: Vector3): void {
    this.phase = (this.phase + dt / CONFIG.dayCycle.lengthSeconds) % 1;

    this.sunDirection
      .copy(this.orbitBase)
      .applyAxisAngle(this.orbitAxis, this.phase * Math.PI * 2)
      .normalize();

    // Keep the sun and its shadow frustum parked over the player.
    this.target.position.copy(playerPosition);
    this.sun.position.copy(playerPosition).addScaledVector(this.sunDirection, 60);

    const elevation = this.sunDirection.dot(playerUp);
    const key = this.sample(elevation);

    this.sun.color.copy(this.sunColor);
    this.sun.intensity = key.sunIntensity;
    this.fill.intensity = key.ambientIntensity;
    this.nightAmount = key.night;

    sky.setPalette(this.zenith, this.horizon, this.ground);
    // Hide the sun disc once it is below the local horizon.
    sky.setSun(this.sunDirection, this.sunColor, smoothstep(-0.06, 0.06, elevation));
    sky.setStarOpacity(smoothstep(0.1, 0.85, this.nightAmount) * 0.95);

    if (scene.fog instanceof Fog) scene.fog.color.copy(this.fogColor);
  }
}
