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
uniform float uJitter;
uniform float uNearClamp;
uniform float uFarClamp;

// Cheap per-vertex hash. Deterministic in object space, so the wobble is baked
// into the model rather than crawling as the camera moves.
float hash13( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}

void main() {
  vec3 objectNormal = normalize( normal );
  vec4 mvPosition;

  #ifdef USE_INSTANCING
    // Rotate the normal by the instance transform, then push in view space.
    objectNormal = normalize( mat3( instanceMatrix ) * objectNormal );
    mvPosition = modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
  #else
    mvPosition = modelViewMatrix * vec4( position, 1.0 );
  #endif

  vec3 viewNormal = normalize( normalMatrix * objectNormal );

  // Expanding in VIEW space scaled by depth keeps the line a roughly constant
  // thickness on screen, instead of the object-space push the first version
  // used -- which made near props look inked and distant ones look untouched.
  //
  // The clamp matters: left unbounded, a tree on the far side of the planet
  // grows an outline wider than the tree and reads as a black blob. Past
  // uFarClamp the line stops growing and distant silhouettes thin out
  // naturally, the way ink does.
  float depth = clamp( -mvPosition.z, uNearClamp, uFarClamp );

  // Vary the width per vertex so the silhouette breathes like a drawn line
  // rather than a uniform offset. On low-poly geometry the samples are sparse,
  // which is exactly what gives it the hand-inked wobble.
  float wobble = 1.0 + ( hash13( position * 1.7 ) - 0.5 ) * 2.0 * uJitter;

  mvPosition.xyz += viewNormal * ( uWidth * depth * wobble );

  gl_Position = projectionMatrix * mvPosition;
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
  /** 0 = perfectly even line, 1 = heavily hand-drawn. */
  jitter?: number;
}

export function createOutlineMaterial(options: OutlineOptions = {}): ShaderMaterial {
  return new ShaderMaterial({
    name: 'outline',
    uniforms: {
      uWidth: { value: options.width ?? CONFIG.render.outlineWidth },
      uColor: { value: new Color(options.color ?? 0x1c2431) },
      uJitter: { value: options.jitter ?? CONFIG.render.outlineJitter },
      uNearClamp: { value: 1.2 },
      uFarClamp: { value: 22 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: BackSide,
  });
}

/** One shared material instance per style, so outlines batch together. */
const materialCache = new Map<string, ShaderMaterial>();

function sharedOutlineMaterial(width: number, color: number, jitter: number): ShaderMaterial {
  const key = `${width.toFixed(4)}:${color}:${jitter.toFixed(3)}`;
  let mat = materialCache.get(key);
  if (!mat) {
    mat = createOutlineMaterial({ width, color, jitter });
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
  const jitter = options.jitter ?? CONFIG.render.outlineJitter;
  const shell = new Mesh(mesh.geometry, sharedOutlineMaterial(width, options.color ?? 0x1c2431, jitter));
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
  const jitter = options.jitter ?? CONFIG.render.outlineJitter;
  const shell = new InstancedMesh(
    source.geometry as BufferGeometry,
    sharedOutlineMaterial(width, options.color ?? 0x1c2431, jitter),
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
