/**
 * Terrain mesh generation, with no three.js dependency.
 *
 * Builds an indexed icosphere by recursive midpoint subdivision, displaces it
 * by the terrain field, and computes smooth normals and vertex colours. The
 * output is four plain typed arrays, which is exactly what a worker can hand
 * back by transfer and what three needs to make a BufferGeometry.
 *
 * This replaces three's IcosahedronGeometry + mergeVertices for two reasons:
 * keeping three out of the worker bundle, and because the midpoint cache welds
 * vertices as it goes -- PolyhedronGeometry emits every triangle unindexed and
 * then has to be welded afterwards, which is the slower half of the job.
 */
import type { TerrainField } from './field';

export interface TerrainArrays {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
  /** Unit directions, reused by the main thread for the ocean and queries. */
  vertexCount: number;
}

/** The twelve vertices of a unit icosahedron. */
function icosahedronBase(): { positions: number[]; faces: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const positions: number[] = [];
  for (const [x, y, z] of raw) {
    const inv = 1 / Math.hypot(x, y, z);
    positions.push(x * inv, y * inv, z * inv);
  }
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { positions, faces };
}

/**
 * Indexed unit icosphere.
 * @param subdivisions recursion depth; each level quadruples the face count.
 *                     6 gives 81,920 triangles from 40,962 welded vertices.
 */
export function buildIcosphere(subdivisions: number): {
  directions: Float32Array;
  index: Uint32Array;
} {
  const { positions, faces: baseFaces } = icosahedronBase();
  const verts = positions.slice();
  let faces = baseFaces;

  // Cache keyed on the ordered pair of endpoints, so an edge shared by two
  // triangles yields one vertex rather than two. This is the weld.
  const midpoints = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * 0x100000 + b : b * 0x100000 + a;
    const cached = midpoints.get(key);
    if (cached !== undefined) return cached;

    const x = (verts[a * 3] + verts[b * 3]) / 2;
    const y = (verts[a * 3 + 1] + verts[b * 3 + 1]) / 2;
    const z = (verts[a * 3 + 2] + verts[b * 3 + 2]) / 2;
    const inv = 1 / Math.hypot(x, y, z);
    const index = verts.length / 3;
    verts.push(x * inv, y * inv, z * inv);
    midpoints.set(key, index);
    return index;
  };

  for (let level = 0; level < subdivisions; level++) {
    const next: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
    midpoints.clear();
  }

  const index = new Uint32Array(faces.length * 3);
  for (let i = 0; i < faces.length; i++) {
    index[i * 3] = faces[i][0];
    index[i * 3 + 1] = faces[i][1];
    index[i * 3 + 2] = faces[i][2];
  }
  return { directions: new Float32Array(verts), index };
}

/**
 * Displace an icosphere by the field and compute normals and colours.
 *
 * @param onProgress called with 0..1 occasionally, so a worker can report back.
 */
export function buildTerrain(
  field: TerrainField,
  subdivisions: number,
  onProgress?: (fraction: number) => void,
): TerrainArrays {
  const { directions, index } = buildIcosphere(subdivisions);
  const vertexCount = directions.length / 3;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const heights = new Float32Array(vertexCount);

  // ---- displace
  const reportEvery = Math.max(1, Math.floor(vertexCount / 8));
  for (let i = 0; i < vertexCount; i++) {
    const x = directions[i * 3];
    const y = directions[i * 3 + 1];
    const z = directions[i * 3 + 2];
    const h = field.heightAt(x, y, z);
    heights[i] = h;
    position[i * 3] = x * h;
    position[i * 3 + 1] = y * h;
    position[i * 3 + 2] = z * h;
    if (onProgress && i % reportEvery === 0) onProgress((i / vertexCount) * 0.5);
  }

  // ---- smooth normals, accumulated per face
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3;
    const b = index[f + 1] * 3;
    const c = index[f + 2] * 3;

    const ax = position[b] - position[a];
    const ay = position[b + 1] - position[a + 1];
    const az = position[b + 2] - position[a + 2];
    const bx = position[c] - position[a];
    const by = position[c + 1] - position[a + 1];
    const bz = position[c + 2] - position[a + 2];

    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;

    normal[a] += nx; normal[a + 1] += ny; normal[a + 2] += nz;
    normal[b] += nx; normal[b + 1] += ny; normal[b + 2] += nz;
    normal[c] += nx; normal[c + 1] += ny; normal[c + 2] += nz;
  }
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const inv = 1 / (Math.hypot(normal[o], normal[o + 1], normal[o + 2]) || 1);
    normal[o] *= inv;
    normal[o + 1] *= inv;
    normal[o + 2] *= inv;
  }

  // ---- colour, after normals exist so cliff shading can use them
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const x = directions[o];
    const y = directions[o + 1];
    const z = directions[o + 2];
    // Slope straight from the shading normal: 1 - dot(normal, radial).
    const slope = 1 - (normal[o] * x + normal[o + 1] * y + normal[o + 2] * z);
    field.colorAt(x, y, z, heights[i], slope, color, o);
    if (onProgress && i % reportEvery === 0) onProgress(0.5 + (i / vertexCount) * 0.5);
  }

  onProgress?.(1);
  return { position, normal, color, index, vertexCount };
}
