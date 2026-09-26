/**
 * Cel-shading setup.
 *
 * MeshToonMaterial banded with a hand-built gradient ramp gives the flat,
 * hand-illustrated look without writing a bespoke shader. The ramp is a 1xN
 * texture sampled with NEAREST filtering, so lighting quantises to N tones
 * instead of falling off smoothly.
 */
import {
  Color,
  DataTexture,
  MeshToonMaterial,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three';

/** Warm, saturated storybook palette. Every colour in the game comes from here. */
export const PALETTE = {
  // Terrain
  meadow: 0x8ccb5e,
  meadowDark: 0x63a848,
  grass: 0x7abf55,
  forestFloor: 0x4f8f4a,
  pine: 0x2f7f58,
  pineDark: 0x246349,
  leaf: 0x66b84a,
  leafAlt: 0x8fc74f,
  sand: 0xe6d3a3,
  rock: 0x9b9189,
  rockDark: 0x7c736c,
  soot: 0x6f6862,
  snow: 0xf4f7fb,
  water: 0x3fa3da,
  waterDeep: 0x2b74b0,

  // Built things
  wall: 0xf6e8cf,
  wallAlt: 0xe9d5b3,
  roofRed: 0xdf5a49,
  roofOrange: 0xe08a3c,
  roofBlue: 0x5c79cf,
  roofTeal: 0x45a49b,
  roofPurple: 0x8a6fc9,
  wood: 0x8b5b3c,
  woodDark: 0x6b452e,
  metal: 0xa9b2bb,
  metalDark: 0x7a838c,
  pipe: 0xc2723f,
  window: 0x9fdcf0,
  lamp: 0xffd98a,

  // Characters + props
  skin: [0xf2c9a0, 0xe0a87b, 0xb97d52, 0x8a5a3b, 0xf7dcc0] as number[],
  outfit: [0x3f7fd6, 0xe0574a, 0x37a86c, 0xefb13c, 0x8a5ed6, 0x2bb3ad, 0xf07ab0, 0x2f3c52] as number[],
  hair: [0x2b2118, 0x6b3a20, 0xd8a24a, 0xc45a3a, 0x8c8c94] as number[],
  parcel: 0xd9a066,
  parcelTape: 0xc07a3f,
  mailbox: 0xe8503f,
  accent: 0xffcf5c,
  shadow: 0x1d2530,
} as const;

/**
 * Build a banded gradient ramp.
 * @param tones how many lighting bands
 * @param floor darkest band (0..1) -- kept above zero so shadows stay coloured
 *              rather than crushing to black, which reads as "toon" not "unlit".
 */
export function makeGradientRamp(tones: number, floor = 0.42): Texture {
  const width = Math.max(2, tones);
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const t = width === 1 ? 1 : i / (width - 1);
    // Slight ease so the mid tones sit closer to the lit end: flatters round shapes.
    const eased = floor + (1 - floor) * Math.pow(t, 0.82);
    const v = Math.round(eased * 255);
    data[i * 4 + 0] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  const tex = new DataTexture(data, width, 1, RGBAFormat, UnsignedByteType);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

let ramp3: Texture | null = null;
let ramp4: Texture | null = null;
let ramp2: Texture | null = null;

/** Shared ramps. Three bands is the default look; two is used for flat props. */
export function ramp(tones: 2 | 3 | 4 = 3): Texture {
  if (tones === 2) return (ramp2 ??= makeGradientRamp(2, 0.5));
  if (tones === 4) return (ramp4 ??= makeGradientRamp(4, 0.38));
  return (ramp3 ??= makeGradientRamp(3, 0.44));
}

export interface ToonOptions {
  color?: number;
  tones?: 2 | 3 | 4;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  emissive?: number;
  emissiveIntensity?: number;
  depthWrite?: boolean;
  name?: string;
}

/** A cel-shaded material with the project's ramp already attached. */
export function toonMaterial(options: ToonOptions = {}): MeshToonMaterial {
  const mat = new MeshToonMaterial({
    color: options.color ?? 0xffffff,
    gradientMap: ramp(options.tones ?? 3),
    vertexColors: options.vertexColors ?? false,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
  });
  if (options.emissive !== undefined) {
    mat.emissive = new Color(options.emissive);
    mat.emissiveIntensity = options.emissiveIntensity ?? 1;
  }
  if (options.depthWrite !== undefined) mat.depthWrite = options.depthWrite;
  if (options.name) mat.name = options.name;
  return mat;
}

/** Helper for authoring vertex colours in the right colour space. */
export function srgb(hex: number, target = new Color()): Color {
  target.setHex(hex, SRGBColorSpace);
  return target;
}
