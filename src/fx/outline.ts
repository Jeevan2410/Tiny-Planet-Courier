/**
 * Inverted-hull outlines.
 *
 * The mesh is drawn a second time, back faces only, with every vertex pushed
 * outward along its normal. What survives the depth test is a rim of solid
 * colour around the silhouette -- the cheap trick that makes low-poly toon
 * scenes read as drawn rather than rendered. Chosen over a post-process outline
 * because it costs one extra draw call instead of a full-screen pass, which
 * matters on phones.
 */
import {
  BackSide,
  BufferGeometry,
  Color,
  InstancedMesh,
  Mesh,
  Object3D,
  ShaderMaterial,
} from 'three';
import { CONFIG } from '../config';

const VERTEX = /* glsl */ `
uniform float uWidth;

void main() {
  // Push along the local normal, then let the standard instancing/model
  // transform apply. Under instancing the offset inherits the instance's
  // scale, which is what we want: bigger props get proportionally thicker lines.
  vec3 pushed = position + normal * uWidth;

  #ifdef USE_INSTANCING
    pushed = ( instanceMatrix * vec4( pushed, 1.0 ) ).xyz;
  #endif

  gl_Position = projectionMatrix * modelViewMatrix * vec4( pushed, 1.0 );
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;

void main() {
  // Written straight to the (sRGB-encoded) drawing buffer with no tone mapping,
  // so uColor is authored as the literal on-screen value.
  gl_FragColor = vec4( uColor, 1.0 );
}
`;

export interface OutlineOptions {
  width?: number;
  color?: number;
}

export function createOutlineMaterial(options: OutlineOptions = {}): ShaderMaterial {
  return new ShaderMaterial({
    name: 'outline',
    uniforms: {
      uWidth: { value: options.width ?? CONFIG.render.outlineWidth },
      uColor: { value: new Color(options.color ?? 0x1c2431) },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: BackSide,
  });
}

/** One shared material instance per width, so outlines batch together. */
const materialCache = new Map<string, ShaderMaterial>();

function sharedOutlineMaterial(width: number, color: number): ShaderMaterial {
  const key = `${width.toFixed(4)}:${color}`;
  let mat = materialCache.get(key);
  if (!mat) {
    mat = createOutlineMaterial({ width, color });
    materialCache.set(key, mat);
  }
  return mat;
}

/**
 * Attach an outline shell to a mesh. The shell is added as a sibling child so it
 * inherits the mesh's transform automatically.
 */
export function addOutline(mesh: Mesh, options: OutlineOptions = {}): Mesh {
  const width = options.width ?? CONFIG.render.outlineWidth;
  const shell = new Mesh(mesh.geometry, sharedOutlineMaterial(width, options.color ?? 0x1c2431));
  shell.name = `${mesh.name || 'mesh'}:outline`;
  shell.castShadow = false;
  shell.receiveShadow = false;
  // Render outlines slightly early so they never punch through the fill.
  shell.renderOrder = (mesh.renderOrder ?? 0) - 1;
  mesh.add(shell);
  return shell;
}

/**
 * Outline shell for an InstancedMesh. The shell shares the source's
 * instanceMatrix buffer, so repacking instances for LOD culling updates both
 * with no extra bookkeeping beyond keeping `count` in sync.
 */
export function addInstancedOutline(
  source: InstancedMesh,
  options: OutlineOptions = {},
): InstancedMesh {
  const width = options.width ?? CONFIG.render.outlineWidth;
  const shell = new InstancedMesh(
    source.geometry as BufferGeometry,
    sharedOutlineMaterial(width, options.color ?? 0x1c2431),
    source.count,
  );
  shell.instanceMatrix = source.instanceMatrix;
  shell.name = `${source.name || 'instances'}:outline`;
  shell.frustumCulled = source.frustumCulled;
  shell.renderOrder = (source.renderOrder ?? 0) - 1;
  shell.castShadow = false;
  shell.receiveShadow = false;
  return shell;
}

/** Walk a subtree and outline every mesh in it. Used for assembled props. */
export function outlineSubtree(root: Object3D, options: OutlineOptions = {}): void {
  const targets: Mesh[] = [];
  root.traverse((child) => {
    if ((child as Mesh).isMesh && !child.name.endsWith(':outline')) targets.push(child as Mesh);
  });
  for (const mesh of targets) addOutline(mesh, options);
}

/** Toggle every outline in a subtree (used by the low-quality preset). */
export function setOutlinesVisible(root: Object3D, visible: boolean): void {
  root.traverse((child) => {
    if (child.name.endsWith(':outline')) child.visible = visible;
  });
}
