/**
 * Procedural low-poly prop geometry.
 *
 * Every prop is assembled from primitives and merged into a single
 * BufferGeometry with its colours baked into a vertex-colour attribute. That
 * means a tree with a brown trunk and three green tiers is ONE geometry drawn
 * with ONE material -- which in turn means the whole forest can be a single
 * InstancedMesh. It is the main reason this scene holds thousands of props and
 * still issues only a few dozen draw calls.
 *
 * Convention for every builder: origin sits at the base of the prop, +Y is up,
 * and the prop faces +Z. Placement code then only has to position and orient.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, srgb } from '../fx/toon';
import { pick, randRange, type Rng } from '../util/rng';

const _color = new Color();
const _m = new Matrix4();

/** Collects coloured, transformed primitives and welds them into one geometry. */
export class Assembly {
  private parts: BufferGeometry[] = [];

  /**
   * @param geometry primitive to add (consumed -- do not reuse it afterwards)
   * @param color    sRGB hex baked into the vertex colours
   */
  add(geometry: BufferGeometry, color: number, matrix?: Matrix4): this {
    // Normalise to non-indexed with no UVs so every part can be merged.
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    if (geo !== geometry) geometry.dispose();
    geo.deleteAttribute('uv');

    if (matrix) geo.applyMatrix4(matrix);

    srgb(color, _color);
    const count = geo.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3 + 0] = _color.r;
      colors[i * 3 + 1] = _color.g;
      colors[i * 3 + 2] = _color.b;
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));

    this.parts.push(geo);
    return this;
  }

  /** Convenience: axis-aligned block sized (w,h,d) centred at (x,y,z). */
  block(w: number, h: number, d: number, x: number, y: number, z: number, color: number): this {
    return this.add(new BoxGeometry(w, h, d), color, _m.makeTranslation(x, y, z).clone());
  }

  build(name: string): BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error(`Failed to merge geometry for "${name}"`);
    for (const part of this.parts) part.dispose();
    this.parts = [];
    merged.computeBoundingSphere();
    merged.name = name;
    return merged;
  }
}

/** Translate + uniform-scale + Y-rotate helper, returned as a fresh matrix. */
function place(
  x: number,
  y: number,
  z: number,
  scale = 1,
  rotY = 0,
  rotX = 0,
): Matrix4 {
  const m = new Matrix4().makeTranslation(x, y, z);
  if (rotY) m.multiply(new Matrix4().makeRotationY(rotY));
  if (rotX) m.multiply(new Matrix4().makeRotationX(rotX));
  if (scale !== 1) m.multiply(new Matrix4().makeScale(scale, scale, scale));
  return m;
}

// ------------------------------------------------------------------ vegetation

export function pineTree(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const height = randRange(rng, 2.6, 4.4);
  const trunkH = height * 0.3;
  const trunkR = height * 0.045;
  const needle = rng() < 0.3 ? PALETTE.pineDark : PALETTE.pine;

  a.add(
    new CylinderGeometry(trunkR * 0.8, trunkR, trunkH, 6),
    PALETTE.woodDark,
    place(0, trunkH / 2, 0),
  );

  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const tierR = height * (0.29 - t * 0.09);
    const tierH = height * 0.38;
    const y = trunkH * 0.75 + t * height * 0.31;
    a.add(new ConeGeometry(tierR, tierH, 7), i === tiers - 1 ? needle : PALETTE.pine, place(0, y + tierH / 2, 0));
  }
  return a.build('pine');
}

export function broadleafTree(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const height = randRange(rng, 2.2, 3.6);
  const trunkH = height * 0.45;
  const trunkR = height * 0.06;
  const leaf = pick(rng, [PALETTE.leaf, PALETTE.leafAlt, 0x57a83f]);

  a.add(new CylinderGeometry(trunkR * 0.75, trunkR, trunkH, 6), PALETTE.wood, place(0, trunkH / 2, 0));

  const blobs = 2 + (rng() < 0.5 ? 1 : 0);
  for (let i = 0; i < blobs; i++) {
    const r = height * randRange(rng, 0.24, 0.34);
    const ox = randRange(rng, -0.28, 0.28) * height * 0.5;
    const oz = randRange(rng, -0.28, 0.28) * height * 0.5;
    const oy = trunkH + height * randRange(rng, 0.1, 0.3);
    const geo = new IcosahedronGeometry(r, 1);
    geo.scale(1, 0.85, 1);
    a.add(geo, leaf, place(ox, oy, oz));
  }
  return a.build('broadleaf');
}

export function bush(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const blobs = 2 + Math.floor(rng() * 2);
  const leaf = pick(rng, [PALETTE.leaf, 0x4f9c3d, PALETTE.leafAlt]);
  for (let i = 0; i < blobs; i++) {
    const r = randRange(rng, 0.24, 0.44);
    const geo = new DodecahedronGeometry(r, 0);
    geo.scale(1, 0.8, 1);
    a.add(geo, leaf, place(randRange(rng, -0.25, 0.25), r * 0.7, randRange(rng, -0.25, 0.25)));
  }
  return a.build('bush');
}

export function grassTuft(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const blades = 3;
  const color = rng() < 0.25 ? 0x9ed46a : PALETTE.grass;
  for (let i = 0; i < blades; i++) {
    const h = randRange(rng, 0.3, 0.6);
    const lean = randRange(rng, -0.4, 0.4);
    const geo = new ConeGeometry(0.045, h, 3);
    const m = place(randRange(rng, -0.12, 0.12), h / 2, randRange(rng, -0.12, 0.12));
    m.multiply(new Matrix4().makeRotationZ(lean));
    a.add(geo, color, m);
  }
  return a.build('grass');
}

export function reed(rng: Rng): BufferGeometry {
  const a = new Assembly();
  for (let i = 0; i < 4; i++) {
    const h = randRange(rng, 0.7, 1.3);
    const geo = new CylinderGeometry(0.018, 0.03, h, 4);
    const m = place(randRange(rng, -0.16, 0.16), h / 2, randRange(rng, -0.16, 0.16));
    m.multiply(new Matrix4().makeRotationZ(randRange(rng, -0.22, 0.22)));
    a.add(geo, 0x93a85c, m);
    if (rng() < 0.6) {
      a.add(new CylinderGeometry(0.05, 0.03, 0.18, 5), 0x8a6b3f, place(0, h, 0));
    }
  }
  return a.build('reed');
}

export function cactus(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const h = randRange(rng, 1.1, 2.2);
  const r = randRange(rng, 0.14, 0.2);
  const green = 0x3f8f5c;
  a.add(new CylinderGeometry(r, r * 1.05, h, 8), green, place(0, h / 2, 0));
  a.add(new SphereGeometry(r, 8, 5), green, place(0, h, 0));

  const arms = rng() < 0.7 ? 1 + Math.floor(rng() * 2) : 0;
  for (let i = 0; i < arms; i++) {
    const side = i === 0 ? 1 : -1;
    const armH = h * randRange(rng, 0.3, 0.45);
    const y = h * randRange(rng, 0.45, 0.62);
    const ar = r * 0.66;
    a.add(new CylinderGeometry(ar, ar, r * 2.4, 6), green, place(side * r * 1.1, y, 0, 1, 0, 0)
      .multiply(new Matrix4().makeRotationZ(Math.PI / 2)));
    a.add(new CylinderGeometry(ar, ar, armH, 6), green, place(side * r * 2.1, y + armH / 2, 0));
    a.add(new SphereGeometry(ar, 6, 4), green, place(side * r * 2.1, y + armH, 0));
  }
  return a.build('cactus');
}

// ----------------------------------------------------------------------- rocks

export function rock(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const shade = pick(rng, [PALETTE.rock, PALETTE.rockDark, 0xa79c92]);
  const r = randRange(rng, 0.3, 0.95);
  const main = new IcosahedronGeometry(r, 0);
  main.scale(randRange(rng, 0.8, 1.3), randRange(rng, 0.5, 0.9), randRange(rng, 0.8, 1.3));
  a.add(main, shade, place(0, r * 0.4, 0, 1, rng() * Math.PI));

  if (rng() < 0.5) {
    const r2 = r * randRange(rng, 0.35, 0.6);
    const side = new IcosahedronGeometry(r2, 0);
    side.scale(1.1, 0.7, 1);
    a.add(side, shade, place(randRange(rng, -r, r), r2 * 0.35, randRange(rng, -r, r), 1, rng() * Math.PI));
  }
  return a.build('rock');
}

export function pebbles(rng: Rng): BufferGeometry {
  const a = new Assembly();
  for (let i = 0; i < 3; i++) {
    const r = randRange(rng, 0.07, 0.16);
    const geo = new DodecahedronGeometry(r, 0);
    geo.scale(1, 0.6, 1);
    a.add(geo, pick(rng, [PALETTE.rock, PALETTE.rockDark]), place(randRange(rng, -0.25, 0.25), r * 0.5, randRange(rng, -0.25, 0.25)));
  }
  return a.build('pebbles');
}

// ------------------------------------------------------------- industrial bits

export function crate(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const s = randRange(rng, 0.45, 0.7);
  a.block(s, s, s, 0, s / 2, 0, PALETTE.wood);
  // Slat detailing: two thin bands per visible face reads as planking.
  const t = s * 0.08;
  a.block(s * 1.02, t, s * 1.02, 0, s * 0.25, 0, PALETTE.woodDark);
  a.block(s * 1.02, t, s * 1.02, 0, s * 0.75, 0, PALETTE.woodDark);
  return a.build('crate');
}

export function pipeSegment(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const len = randRange(rng, 1.2, 2.4);
  const r = randRange(rng, 0.12, 0.2);
  const m = place(0, r * 1.6, 0);
  m.multiply(new Matrix4().makeRotationX(Math.PI / 2));
  a.add(new CylinderGeometry(r, r, len, 8), PALETTE.pipe, m);
  for (const z of [-len / 2 + 0.08, len / 2 - 0.08]) {
    const rm = place(0, r * 1.6, z);
    rm.multiply(new Matrix4().makeRotationX(Math.PI / 2));
    a.add(new CylinderGeometry(r * 1.25, r * 1.25, 0.1, 8), PALETTE.metalDark, rm);
  }
  // Short legs so the pipe reads as raised off the ground.
  for (const z of [-len * 0.3, len * 0.3]) {
    a.add(new CylinderGeometry(0.04, 0.05, r * 1.6, 4), PALETTE.metalDark, place(0, r * 0.8, z));
  }
  return a.build('pipe');
}

export function barrel(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const h = randRange(rng, 0.6, 0.8);
  const r = h * 0.32;
  const color = pick(rng, [0xc75f3f, 0x4f8fa8, 0x8a8f66]);
  a.add(new CylinderGeometry(r, r, h, 10), color, place(0, h / 2, 0));
  for (const y of [h * 0.28, h * 0.72]) {
    a.add(new TorusGeometry(r * 1.02, 0.025, 4, 10), PALETTE.metalDark, place(0, y, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
  }
  return a.build('barrel');
}

/** A cooling tower: the landmark silhouette of the Powerworks zone. */
export function coolingTower(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const h = randRange(rng, 4.2, 5.6);
  const rBase = h * 0.24;
  const rWaist = h * 0.16;
  const rTop = h * 0.2;
  a.add(new CylinderGeometry(rWaist, rBase, h * 0.6, 12, 1, true), PALETTE.wall, place(0, h * 0.3, 0));
  a.add(new CylinderGeometry(rTop, rWaist, h * 0.4, 12, 1, true), PALETTE.wallAlt, place(0, h * 0.8, 0));
  a.add(new TorusGeometry(rTop, 0.07, 4, 12), PALETTE.metalDark, place(0, h, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
  a.add(new CylinderGeometry(rBase * 1.08, rBase * 1.12, 0.3, 12), PALETTE.rockDark, place(0, 0.15, 0));
  return a.build('coolingTower');
}

export function smokestack(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const h = randRange(rng, 3.4, 5);
  const r = h * 0.07;
  a.add(new CylinderGeometry(r, r * 1.35, h, 9), PALETTE.wallAlt, place(0, h / 2, 0));
  a.add(new CylinderGeometry(r * 1.2, r * 1.2, h * 0.08, 9), 0xc0573f, place(0, h * 0.72, 0));
  a.add(new CylinderGeometry(r * 1.15, r * 1.15, h * 0.06, 9), PALETTE.metalDark, place(0, h, 0));
  return a.build('smokestack');
}

// ------------------------------------------------------------------- buildings

export interface HouseOptions {
  width?: number;
  depth?: number;
  storeys?: number;
  roof?: number;
  wall?: number;
  /** 'gable' reads as a cottage, 'pyramid' as a cabin or shed. */
  roofStyle?: 'gable' | 'pyramid';
  chimney?: boolean;
}

export function house(rng: Rng, options: HouseOptions = {}): BufferGeometry {
  const a = new Assembly();
  const w = options.width ?? randRange(rng, 1.9, 2.9);
  const d = options.depth ?? randRange(rng, 1.8, 2.6);
  const storeys = options.storeys ?? (rng() < 0.3 ? 2 : 1);
  const storeyH = 1.25;
  const bodyH = storeyH * storeys;
  const wall = options.wall ?? pick(rng, [PALETTE.wall, PALETTE.wallAlt, 0xf0dfc4]);
  const roofColor =
    options.roof ??
    pick(rng, [PALETTE.roofRed, PALETTE.roofOrange, PALETTE.roofBlue, PALETTE.roofTeal, PALETTE.roofPurple]);
  const roofStyle = options.roofStyle ?? (rng() < 0.65 ? 'gable' : 'pyramid');

  // Foundation skirt: extends below the origin so the house never shows a gap
  // where it meets uneven ground.
  a.block(w * 1.04, 0.7, d * 1.04, 0, -0.25, 0, PALETTE.rockDark);
  a.block(w, bodyH, d, 0, bodyH / 2, 0, wall);

  if (roofStyle === 'gable') {
    // A 3-sided cylinder laid on its side is a triangular prism: the ridge runs
    // along Z, so the gable ends face the front and back of the house.
    const roofH = w * 0.42;
    const m = place(0, bodyH + roofH * 0.34, 0);
    m.multiply(new Matrix4().makeRotationX(Math.PI / 2));
    m.multiply(new Matrix4().makeRotationZ(Math.PI / 2));
    const prism = new CylinderGeometry(roofH, roofH, d * 1.18, 3, 1);
    a.add(prism, roofColor, m);
  } else {
    a.add(new ConeGeometry(Math.max(w, d) * 0.78, w * 0.7, 4), roofColor, place(0, bodyH + w * 0.35, 0, 1, Math.PI / 4));
  }

  // Door on the +Z face, so the building "faces" the way placement points it.
  a.block(0.52, 0.95, 0.09, 0, 0.475, d / 2 + 0.02, PALETTE.woodDark);
  a.block(0.1, 0.1, 0.06, 0.16, 0.55, d / 2 + 0.07, PALETTE.accent);

  // Windows.
  const windowY = 0.72;
  for (const sx of [-1, 1]) {
    a.block(0.42, 0.42, 0.07, sx * w * 0.3, windowY, d / 2 + 0.02, PALETTE.window);
    a.block(0.48, 0.48, 0.04, sx * w * 0.3, windowY, d / 2 + 0.01, wall === PALETTE.wall ? PALETTE.wallAlt : PALETTE.wall);
  }
  if (storeys > 1) {
    for (const sx of [-1, 1]) {
      a.block(0.38, 0.38, 0.07, sx * w * 0.26, storeyH + 0.65, d / 2 + 0.02, PALETTE.window);
    }
  }
  // Side windows.
  for (const sz of [-1, 1]) {
    a.block(0.07, 0.38, 0.38, w / 2 + 0.02, windowY, sz * d * 0.26, PALETTE.window);
  }

  if (options.chimney ?? rng() < 0.55) {
    const cx = w * 0.28;
    a.block(0.32, bodyH * 0.55 + w * 0.5, 0.32, cx, bodyH + w * 0.16, -d * 0.2, PALETTE.rockDark);
    a.block(0.4, 0.1, 0.4, cx, bodyH + w * 0.42, -d * 0.2, PALETTE.rock);
  }

  return a.build('house');
}

/** The depot: where parcels are collected. Deliberately distinct and readable. */
export function depot(): BufferGeometry {
  const a = new Assembly();
  const w = 4.4;
  const d = 3.4;
  const bodyH = 2.3;

  a.block(w * 1.05, 0.8, d * 1.05, 0, -0.3, 0, PALETTE.rockDark);
  a.block(w, bodyH, d, 0, bodyH / 2, 0, PALETTE.wall);
  // Band of colour at the base, the way a post office paints its plinth.
  a.block(w * 1.01, 0.45, d * 1.01, 0, 0.22, 0, PALETTE.mailbox);

  // Hipped roof, slightly overhanging.
  const roofH = 1.5;
  const m = place(0, bodyH + roofH * 0.34, 0);
  m.multiply(new Matrix4().makeRotationX(Math.PI / 2));
  m.multiply(new Matrix4().makeRotationZ(Math.PI / 2));
  a.add(new CylinderGeometry(roofH, roofH, d * 1.22, 3, 1), PALETTE.roofRed, m);

  // Awning over the door, on posts.
  a.block(2.6, 0.12, 1.1, 0, 2.05, d / 2 + 0.5, PALETTE.roofRed);
  for (const sx of [-1, 1]) {
    a.add(new CylinderGeometry(0.07, 0.07, 2.0, 6), PALETTE.wood, place(sx * 1.15, 1.0, d / 2 + 0.92));
  }

  // Double doors and windows.
  a.block(1.5, 1.6, 0.1, 0, 0.8, d / 2 + 0.03, PALETTE.woodDark);
  a.block(0.06, 1.6, 0.06, 0, 0.8, d / 2 + 0.09, PALETTE.accent);
  for (const sx of [-1, 1]) {
    a.block(0.7, 0.7, 0.08, sx * 1.55, 1.3, d / 2 + 0.03, PALETTE.window);
  }
  for (const sz of [-1, 1]) {
    a.block(0.08, 0.7, 0.7, w / 2 + 0.02, 1.3, sz * 1.0, PALETTE.window);
  }

  // Sign board above the awning.
  a.block(2.2, 0.62, 0.12, 0, 2.62, d / 2 + 0.1, PALETTE.accent);
  a.block(1.85, 0.3, 0.06, 0, 2.62, d / 2 + 0.18, PALETTE.woodDark);

  // Parcel pile by the door, hinting at what you are meant to do here.
  a.block(0.5, 0.5, 0.5, -1.9, 0.25, d / 2 + 0.7, PALETTE.parcel);
  a.block(0.52, 0.09, 0.52, -1.9, 0.5, d / 2 + 0.7, PALETTE.parcelTape);
  a.block(0.42, 0.42, 0.42, -1.6, 0.21, d / 2 + 1.25, PALETTE.parcel);

  return a.build('depot');
}

export function mailbox(): BufferGeometry {
  const a = new Assembly();
  a.add(new CylinderGeometry(0.07, 0.08, 1.0, 6), PALETTE.woodDark, place(0, 0.5, 0));
  // Body: a cylinder capped flat on the bottom reads as a classic mailbox.
  const body = place(0, 1.18, 0);
  body.multiply(new Matrix4().makeRotationX(Math.PI / 2));
  a.add(new CylinderGeometry(0.24, 0.24, 0.62, 10, 1, false, 0, Math.PI), PALETTE.mailbox, body);
  a.block(0.48, 0.05, 0.62, 0, 0.95, 0, PALETTE.mailbox);
  a.block(0.03, 0.14, 0.2, 0, 1.18, 0.33, PALETTE.metalDark);
  // Flag, raised: a small readable "something is here" cue.
  a.block(0.04, 0.3, 0.04, 0.26, 1.3, 0, PALETTE.metalDark);
  a.block(0.05, 0.16, 0.14, 0.26, 1.46, 0.06, PALETTE.accent);
  return a.build('mailbox');
}

export function lamp(): BufferGeometry {
  const a = new Assembly();
  a.add(new CylinderGeometry(0.06, 0.09, 2.5, 6), PALETTE.metalDark, place(0, 1.25, 0));
  a.add(new ConeGeometry(0.28, 0.32, 6), PALETTE.metalDark, place(0, 2.66, 0, 1, 0, Math.PI));
  a.add(new SphereGeometry(0.17, 8, 6), PALETTE.lamp, place(0, 2.52, 0));
  a.add(new ConeGeometry(0.3, 0.26, 6), PALETTE.metal, place(0, 2.85, 0));
  return a.build('lamp');
}

export function bench(): BufferGeometry {
  const a = new Assembly();
  a.block(1.5, 0.1, 0.45, 0, 0.45, 0, PALETTE.wood);
  a.block(1.5, 0.45, 0.1, 0, 0.68, -0.18, PALETTE.wood);
  for (const sx of [-1, 1]) {
    a.block(0.1, 0.45, 0.42, sx * 0.62, 0.22, 0, PALETTE.woodDark);
  }
  return a.build('bench');
}

export function fence(): BufferGeometry {
  const a = new Assembly();
  for (const sx of [-0.55, 0.55]) {
    a.add(new CylinderGeometry(0.055, 0.06, 0.95, 5), PALETTE.wood, place(sx, 0.475, 0));
  }
  a.block(1.3, 0.09, 0.07, 0, 0.75, 0, PALETTE.woodDark);
  a.block(1.3, 0.09, 0.07, 0, 0.45, 0, PALETTE.woodDark);
  return a.build('fence');
}

export function signpost(rng: Rng): BufferGeometry {
  const a = new Assembly();
  a.add(new CylinderGeometry(0.06, 0.07, 1.7, 6), PALETTE.wood, place(0, 0.85, 0));
  const boards = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < boards; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    a.block(0.9, 0.24, 0.07, side * 0.4, 1.5 - i * 0.34, 0, PALETTE.wallAlt);
  }
  return a.build('signpost');
}

/** The parcel: used both as a held prop and as scenery around the depot. */
export function parcel(size = 0.42): BufferGeometry {
  const a = new Assembly();
  a.block(size, size, size, 0, 0, 0, PALETTE.parcel);
  a.block(size * 1.03, size * 0.16, size * 1.03, 0, 0, 0, PALETTE.parcelTape);
  a.block(size * 0.16, size * 1.03, size * 1.03, 0, 0, 0, PALETTE.parcelTape);
  // Little address label.
  a.block(size * 0.42, size * 0.3, size * 0.02, size * 0.12, size * 0.22, size * 0.52, 0xfdf6e8);
  return a.build('parcel');
}

/** Water tower: a readable landmark for the meadow town. */
export function waterTower(): BufferGeometry {
  const a = new Assembly();
  const legH = 2.4;
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(angle) * 0.7;
    const z = Math.sin(angle) * 0.7;
    const m = place(x, legH / 2, z);
    m.multiply(new Matrix4().makeRotationZ(-x * 0.08));
    m.multiply(new Matrix4().makeRotationX(z * 0.08));
    a.add(new CylinderGeometry(0.07, 0.09, legH, 5), PALETTE.metalDark, m);
  }
  a.add(new CylinderGeometry(1.0, 1.0, 1.5, 12), PALETTE.metal, place(0, legH + 0.75, 0));
  a.add(new ConeGeometry(1.1, 0.6, 12), PALETTE.roofTeal, place(0, legH + 1.8, 0));
  a.add(new TorusGeometry(1.01, 0.05, 4, 12), PALETTE.metalDark, place(0, legH + 0.4, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
  return a.build('waterTower');
}

/** Windmill tower plus a separate blade geometry so the blades can spin. */
export function windmill(): { tower: BufferGeometry; blades: BufferGeometry } {
  const tower = new Assembly();
  const h = 3.6;
  tower.add(new CylinderGeometry(0.55, 0.85, h, 8), PALETTE.wall, place(0, h / 2, 0));
  tower.add(new ConeGeometry(0.78, 0.7, 8), PALETTE.roofBlue, place(0, h + 0.35, 0));
  tower.block(0.5, 0.9, 0.08, 0, 0.45, 0.83, PALETTE.woodDark);
  tower.add(new CylinderGeometry(0.1, 0.1, 0.3, 6), PALETTE.woodDark, place(0, h * 0.82, 0.62).multiply(new Matrix4().makeRotationX(Math.PI / 2)));

  const blades = new Assembly();
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2;
    const m = new Matrix4().makeRotationZ(angle);
    m.multiply(new Matrix4().makeTranslation(0, 1.05, 0));
    blades.add(new BoxGeometry(0.22, 1.9, 0.06), PALETTE.wallAlt, m);
  }
  blades.add(new CylinderGeometry(0.12, 0.12, 0.16, 6), PALETTE.woodDark, new Matrix4().makeRotationX(Math.PI / 2));

  return { tower: tower.build('windmillTower'), blades: blades.build('windmillBlades') };
}

/** Marker beacon hovering over the active objective. */
export function beacon(): BufferGeometry {
  const a = new Assembly();
  a.add(new ConeGeometry(0.34, 0.85, 4), PALETTE.accent, place(0, 0.425, 0, 1, Math.PI / 4, Math.PI));
  a.add(new ConeGeometry(0.2, 0.3, 4), 0xfff3c4, place(0, 0.95, 0, 1, Math.PI / 4));
  return a.build('beacon');
}

// ------------------------------------------------------------ street dressing
//
// The props below exist to make the town read as a place somebody lives rather
// than an arrangement of houses on a lawn. Density of incidental detail -- the
// air conditioner, the bins, the crate of plants by the door -- is most of what
// separates a hand-built town from a scattered one.

/** Utility pole with a crossarm and insulators. */
export function utilityPole(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const h = randRange(rng, 4.6, 5.8);
  a.add(new CylinderGeometry(0.09, 0.13, h, 7), PALETTE.woodDark, place(0, h / 2, 0));

  // Crossarms near the top.
  for (let i = 0; i < 2; i++) {
    const y = h - 0.35 - i * 0.55;
    a.block(1.5, 0.09, 0.11, 0, y, 0, PALETTE.wood);
    for (const sx of [-1, 1]) {
      a.add(new CylinderGeometry(0.05, 0.05, 0.16, 5), PALETTE.window, place(sx * 0.62, y + 0.12, 0));
    }
  }
  // Transformer can.
  if (rng() < 0.5) {
    a.add(new CylinderGeometry(0.19, 0.19, 0.5, 8), PALETTE.metalDark, place(0.24, h * 0.66, 0));
  }
  return a.build('utilityPole');
}

/** Wall-mounted air conditioning unit, hung on the side of a building. */
export function airConditioner(): BufferGeometry {
  const a = new Assembly();
  a.block(0.62, 0.42, 0.3, 0, 0, 0, PALETTE.wallAlt);
  a.block(0.5, 0.32, 0.03, 0, 0, 0.16, PALETTE.metalDark);
  a.add(new CylinderGeometry(0.13, 0.13, 0.03, 8), PALETTE.metal, place(0, 0, 0.18));
  a.block(0.66, 0.05, 0.34, 0, 0.22, 0, PALETTE.metal);
  return a.build('airConditioner');
}

export function vendingMachine(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const body = pick(rng, [0xd9534f, 0x3f7fd6, 0x37a86c]);
  a.block(0.9, 1.75, 0.6, 0, 0.875, 0, body);
  // Glass front with three shelves of product.
  a.block(0.62, 1.15, 0.05, -0.1, 1.05, 0.31, PALETTE.window);
  for (let i = 0; i < 3; i++) {
    a.block(0.56, 0.06, 0.04, -0.1, 0.65 + i * 0.36, 0.33, PALETTE.wallAlt);
  }
  a.block(0.22, 0.5, 0.05, 0.28, 1.05, 0.31, PALETTE.metalDark);
  a.block(0.86, 0.12, 0.05, 0, 0.32, 0.31, PALETTE.metalDark);
  a.block(0.94, 0.08, 0.64, 0, 1.79, 0, PALETTE.accent);
  return a.build('vendingMachine');
}

export function postbox(): BufferGeometry {
  const a = new Assembly();
  a.add(new CylinderGeometry(0.26, 0.28, 1.25, 10), PALETTE.mailbox, place(0, 0.625, 0));
  a.add(new SphereGeometry(0.26, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), PALETTE.mailbox, place(0, 1.25, 0));
  a.block(0.3, 0.07, 0.05, 0, 1.12, 0.26, 0x2c2c30);
  a.add(new CylinderGeometry(0.3, 0.3, 0.07, 10), PALETTE.rockDark, place(0, 0.035, 0));
  return a.build('postbox');
}

export function trafficCone(): BufferGeometry {
  const a = new Assembly();
  a.block(0.34, 0.05, 0.34, 0, 0.025, 0, 0xe2662f);
  a.add(new ConeGeometry(0.14, 0.55, 7), 0xe2662f, place(0, 0.3, 0));
  a.add(new CylinderGeometry(0.1, 0.115, 0.09, 7), 0xfdf6e8, place(0, 0.33, 0));
  return a.build('trafficCone');
}

/** Planter with a couple of leafy shoots -- the classic doorstep pot. */
export function planter(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const r = randRange(rng, 0.17, 0.24);
  a.add(new CylinderGeometry(r, r * 0.78, 0.3, 8), PALETTE.pipe, place(0, 0.15, 0));
  a.add(new CylinderGeometry(r * 1.06, r * 1.06, 0.05, 8), 0xa85f34, place(0, 0.3, 0));
  const shoots = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < shoots; i++) {
    const blade = new ConeGeometry(0.07, randRange(rng, 0.3, 0.5), 3);
    const m = place(randRange(rng, -0.08, 0.08), 0.45, randRange(rng, -0.08, 0.08));
    m.multiply(new Matrix4().makeRotationZ(randRange(rng, -0.4, 0.4)));
    a.add(blade, pick(rng, [PALETTE.leaf, 0x4f9c3d]), m);
  }
  return a.build('planter');
}

export function wheelieBin(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const color = pick(rng, [0x4a7f5c, 0x3f6f9e, 0x7a7f86]);
  a.block(0.46, 0.62, 0.4, 0, 0.42, 0, color);
  a.block(0.5, 0.07, 0.44, 0, 0.76, 0, shadeColor(color, 0.25));
  for (const sx of [-1, 1]) {
    a.add(new CylinderGeometry(0.09, 0.09, 0.05, 8), 0x2c2c30, place(sx * 0.2, 0.09, -0.12).multiply(new Matrix4().makeRotationZ(Math.PI / 2)));
  }
  return a.build('wheelieBin');
}

/** Flat road furniture: a manhole cover painted onto the street. */
export function manhole(): BufferGeometry {
  const a = new Assembly();
  a.add(new CylinderGeometry(0.34, 0.34, 0.04, 12), PALETTE.metalDark, place(0, 0.02, 0));
  a.add(new CylinderGeometry(0.24, 0.24, 0.05, 12), 0x5f646e, place(0, 0.035, 0));
  return a.build('manhole');
}

/** Low kerb wall used to edge a forecourt. */
export function lowWall(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const len = randRange(rng, 1.6, 2.6);
  a.block(len, 0.42, 0.22, 0, 0.21, 0, PALETTE.concrete);
  a.block(len * 1.02, 0.07, 0.28, 0, 0.44, 0, PALETTE.kerb);
  return a.build('lowWall');
}

/** Shop awning + sign board, mounted against a wall. */
export function shopFront(rng: Rng): BufferGeometry {
  const a = new Assembly();
  const color = pick(rng, [PALETTE.roofTeal, PALETTE.roofRed, PALETTE.roofBlue]);
  a.block(2.1, 0.5, 0.14, 0, 1.55, 0, color);
  a.block(1.7, 0.22, 0.06, 0, 1.55, 0.1, 0xfdf6e8);
  // Striped awning below the sign.
  for (let i = 0; i < 5; i++) {
    a.block(0.4, 0.06, 0.62, -0.82 + i * 0.41, 1.22, 0.36, i % 2 === 0 ? 0xfdf6e8 : color);
  }
  a.block(2.2, 0.06, 0.08, 0, 1.15, 0.66, shadeColor(color, 0.3));
  return a.build('shopFront');
}

function shadeColor(hex: number, amount: number): number {
  const r = Math.round(((hex >> 16) & 255) * (1 - amount));
  const g = Math.round(((hex >> 8) & 255) * (1 - amount));
  const b = Math.round((hex & 255) * (1 - amount));
  return (r << 16) | (g << 8) | b;
}
