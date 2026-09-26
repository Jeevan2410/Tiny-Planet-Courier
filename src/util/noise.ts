/**
 * 3D simplex noise, seeded. Used for terrain displacement, zone blending and
 * scatter density. 3D (rather than 2D) noise is essential here: sampling noise
 * directly on the unit sphere avoids the pinching and seams you get from any
 * lat/long UV mapping.
 */
import type { Rng } from './rng';

const F3 = 1 / 3;
const G3 = 1 / 6;

const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

export class SimplexNoise {
  private readonly perm = new Uint8Array(512);
  private readonly permMod12 = new Uint8Array(512);

  constructor(rng: Rng) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Seeded shuffle of the permutation table.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Raw noise in roughly [-1, 1]. */
  noise(xin: number, yin: number, zin: number): number {
    const { perm, permMod12 } = this;

    // Skew the input space to determine which simplex cell we're in.
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    // Determine the traversal order of the simplex tetrahedron.
    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1;
      } else {
        i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1;
      } else if (x0 < z0) {
        i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1;
      } else {
        i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0;
      }
    }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n = 0;
    n += this.corner(permMod12[perm[ii + perm[jj + perm[kk]]]], x0, y0, z0);
    n += this.corner(permMod12[perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]]], x1, y1, z1);
    n += this.corner(permMod12[perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]]], x2, y2, z2);
    n += this.corner(permMod12[perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]]], x3, y3, z3);
    return 32 * n;
  }

  private corner(gi: number, x: number, y: number, z: number): number {
    let t = 0.6 - x * x - y * y - z * z;
    if (t < 0) return 0;
    const g = gi * 3;
    t *= t;
    return t * t * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
  }

  /** Fractal Brownian motion: layered octaves for natural-looking relief. */
  fbm(x: number, y: number, z: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amplitude * this.noise(x * frequency, y * frequency, z * frequency);
      norm += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal - produces sharp mountain crests rather than blobs. */
  ridged(x: number, y: number, z: number, octaves = 4): number {
    let amplitude = 1;
    let frequency = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise(x * frequency, y * frequency, z * frequency));
      sum += amplitude * n * n;
      norm += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    return sum / norm;
  }
}
