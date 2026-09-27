/**
 * Cel-shading setup.
 *
 * MeshToonMaterial banded with a hand-built gradient ramp gives the flat,
 * hand-illustrated look without writing a bespoke shader. The ramp is a 1xN
 * texture sampled with NEAREST filtering, so lighting quantises to N tones
 * instead of falling off smoothly.
 */
import { PALETTE } from './palette';
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


/**
 * Build a banded gradient ramp.
 * @param tones how many lighting bands
 * @param floor darkest band (0..1) -- kept above zero so shadows stay coloured
 *              rather than crushing to black, which reads as "toon" not "unlit".
 */
export { PALETTE };

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
