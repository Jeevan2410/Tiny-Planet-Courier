/**
 * Sky dome, drifting clouds and a star field.
 *
 * On a tiny planet you can walk to a point where your "up" is the opposite of
 * where it was five minutes ago, so a sky gradient keyed to world +Y would tip
 * over as you travelled. Instead the dome takes the player's current up vector
 * as a uniform and orients its gradient to that, which keeps the horizon
 * looking like a horizon everywhere on the surface.
 */
import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  IcosahedronGeometry,
  Mesh,
  Points,
  PointsMaterial,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import { toonMaterial } from '../fx/toon';
import { mulberry32, randRange } from '../util/rng';
import { anyTangent, fibonacciSphere } from '../util/sphere';

const SKY_VERTEX = /* glsl */ `
varying vec3 vDirection;

void main() {
  // Direction from the dome's centre to this vertex, in world space.
  vDirection = normalize( ( modelMatrix * vec4( position, 1.0 ) ).xyz - cameraPosition );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uUp;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;

varying vec3 vDirection;

void main() {
  vec3 dir = normalize( vDirection );
  float h = dot( dir, normalize( uUp ) );

  // Two-sided gradient: zenith above, horizon at the band, a darker wash below
  // so the underside of the dome does not glow through the planet's limb.
  vec3 color = mix( uHorizon, uZenith, smoothstep( 0.0, 0.62, h ) );
  color = mix( uGround, color, smoothstep( -0.32, 0.02, h ) );

  // Sun disc plus a broad glow, both clamped so they never blow out the toon look.
  float sun = max( 0.0, dot( dir, normalize( uSunDirection ) ) );
  color += uSunColor * pow( sun, 620.0 ) * uSunIntensity * 1.4;
  color += uSunColor * pow( sun, 6.0 ) * uSunIntensity * 0.16;

  gl_FragColor = vec4( color, 1.0 );
}
`;

export class Sky {
  readonly group = new Group();

  private readonly dome: Mesh;
  private readonly material: ShaderMaterial;
  private readonly clouds: Group;
  private readonly stars: Points;
  private readonly starMaterial: PointsMaterial;

  constructor(seed = CONFIG.planet.seed + 99) {
    this.group.name = 'sky';

    this.material = new ShaderMaterial({
      name: 'sky',
      uniforms: {
        uUp: { value: new Vector3(0, 1, 0) },
        uZenith: { value: new Color(0x4a9fe0) },
        uHorizon: { value: new Color(0xbfe4f2) },
        uGround: { value: new Color(0x2c3d52) },
        uSunDirection: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(0xfff2cf) },
        uSunIntensity: { value: 1 },
      },
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });

    this.dome = new Mesh(new IcosahedronGeometry(400, 3), this.material);
    this.dome.name = 'skyDome';
    this.dome.frustumCulled = false;
    // Drawn first, and never writes depth, so everything else lands on top.
    this.dome.renderOrder = -100;
    this.group.add(this.dome);

    this.clouds = this.buildClouds(seed);
    this.group.add(this.clouds);

    const { points, material } = this.buildStars(seed + 31);
    this.stars = points;
    this.starMaterial = material;
    this.group.add(this.stars);
  }

  /**
   * Clouds are lumps of merged spheres sitting on a shell above the planet. The
   * whole shell turns slowly, which reads as weather drifting past and costs one
   * rotation per frame.
   */
  private buildClouds(seed: number): Group {
    const rng = mulberry32(seed);
    const group = new Group();
    group.name = 'clouds';

    const shellRadius = CONFIG.planet.radius + 9;
    const anchors = fibonacciSphere(46);
    const parts: BufferGeometry[] = [];
    const up = new Vector3();
    const tangent = new Vector3();

    for (const anchor of anchors) {
      if (rng() < 0.32) continue;
      up.copy(anchor).normalize();
      anyTangent(up, tangent).applyAxisAngle(up, rng() * Math.PI * 2);
      const side = new Vector3().copy(up).cross(tangent).normalize();

      const radius = shellRadius + randRange(rng, -1.6, 2.4);
      const lumps = 3 + Math.floor(rng() * 3);
      const scale = randRange(rng, 0.9, 1.8);

      for (let i = 0; i < lumps; i++) {
        const blob = new SphereGeometry(randRange(rng, 0.8, 1.5) * scale, 7, 5);
        blob.deleteAttribute('uv');
        // Squash vertically so the lumps read as a flat-bottomed cloud.
        blob.scale(1.25, 0.62, 1.05);
        const centre = new Vector3()
          .copy(up)
          .multiplyScalar(radius)
          .addScaledVector(tangent, randRange(rng, -1.7, 1.7) * scale)
          .addScaledVector(side, randRange(rng, -1.1, 1.1) * scale);
        blob.translate(centre.x, centre.y, centre.z);
        parts.push(blob);
      }
    }

    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (merged) {
      const mesh = new Mesh(
        merged,
        toonMaterial({ color: 0xfdfdff, tones: 2, transparent: true, opacity: 0.94, name: 'clouds' }),
      );
      mesh.name = 'clouds';
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      group.add(mesh);
    }
    return group;
  }

  private buildStars(seed: number): { points: Points; material: PointsMaterial } {
    const rng = mulberry32(seed);
    const count = 900;
    const positions = new Float32Array(count * 3);
    const radius = 340;

    for (let i = 0; i < count; i++) {
      // Uniform on a sphere.
      const z = rng() * 2 - 1;
      const t = rng() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      positions[i * 3 + 0] = Math.cos(t) * r * radius;
      positions[i * 3 + 1] = z * radius;
      positions[i * 3 + 2] = Math.sin(t) * r * radius;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));

    const material = new PointsMaterial({
      color: 0xffffff,
      size: 2.4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });

    const points = new Points(geometry, material);
    points.name = 'stars';
    points.frustumCulled = false;
    points.renderOrder = -99;
    return { points, material };
  }

  /** Keep the dome and stars centred on the viewer so they never clip. */
  follow(cameraPosition: Vector3): void {
    this.dome.position.copy(cameraPosition);
    this.stars.position.copy(cameraPosition);
  }

  update(dt: number, localUp: Vector3): void {
    this.clouds.rotateY(dt * 0.012);
    (this.material.uniforms.uUp.value as Vector3).copy(localUp);
  }

  setPalette(zenith: Color, horizon: Color, ground: Color): void {
    (this.material.uniforms.uZenith.value as Color).copy(zenith);
    (this.material.uniforms.uHorizon.value as Color).copy(horizon);
    (this.material.uniforms.uGround.value as Color).copy(ground);
  }

  setSun(direction: Vector3, color: Color, intensity: number): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(direction);
    (this.material.uniforms.uSunColor.value as Color).copy(color);
    this.material.uniforms.uSunIntensity.value = intensity;
  }

  setStarOpacity(opacity: number): void {
    this.starMaterial.opacity = opacity;
  }
}
