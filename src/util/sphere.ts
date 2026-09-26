/**
 * Spherical-world math. Everything in this game lives on the surface of a ball,
 * so "up" is a per-position value rather than a constant, and "walking forward"
 * is a rotation about the planet's centre rather than a translation.
 */
import { Vector3, Quaternion, Matrix4 } from 'three';

const _axis = new Vector3();
const _right = new Vector3();
const _m = new Matrix4();
const _tmp = new Vector3();

/** Local up at a position: the radial direction from the planet's centre. */
export function upAt(position: Vector3, target = new Vector3()): Vector3 {
  return target.copy(position).normalize();
}

/** Remove the component of `v` parallel to `up`, leaving a tangent vector. */
export function projectOnTangent(v: Vector3, up: Vector3, target = new Vector3()): Vector3 {
  return target.copy(v).addScaledVector(up, -v.dot(up));
}

/**
 * Move a point along the surface of a sphere by `distance`, heading in the
 * tangent direction `dir`. Implemented as a rotation about the axis
 * perpendicular to both up and heading, which keeps the point exactly on its
 * shell and follows a great circle -- no drift, no renormalisation artefacts.
 *
 * @param radius the sphere to measure `distance` against. Pass this explicitly
 *   whenever `position` is a unit direction rather than a world position --
 *   otherwise the arc is measured against a radius of 1 and the point travels
 *   the planet's radius times too far.
 */
export function moveOnSphere(
  position: Vector3,
  dir: Vector3,
  distance: number,
  radius = position.length(),
): Vector3 {
  if (radius < 1e-6 || distance === 0) return position;
  const length = position.length();
  if (length < 1e-6) return position;
  _axis.copy(position).divideScalar(length).cross(dir);
  const axisLength = _axis.length();
  if (axisLength < 1e-6) return position;
  _axis.divideScalar(axisLength);
  return position.applyAxisAngle(_axis, distance / radius);
}

/**
 * Orientation that stands an object upright on the surface, facing `forward`.
 * Models in this project are authored facing local +Z, so the basis is
 * (X = up x forward, Y = up, Z = forward).
 */
export function surfaceQuaternion(
  up: Vector3,
  forward: Vector3,
  target = new Quaternion(),
): Quaternion {
  _tmp.copy(forward);
  // Guard against a forward that has drifted parallel to up.
  if (Math.abs(_tmp.dot(up)) > 0.999) {
    _tmp.set(up.y, -up.x, 0);
    if (_tmp.lengthSq() < 1e-6) _tmp.set(1, 0, 0);
  }
  projectOnTangent(_tmp, up, _tmp).normalize();
  _right.copy(up).cross(_tmp).normalize();
  _m.makeBasis(_right, up, _tmp);
  return target.setFromRotationMatrix(_m);
}

/** Great-circle (surface) distance between two points on the same sphere. */
export function surfaceDistance(a: Vector3, b: Vector3, radius: number): number {
  const la = a.length();
  const lb = b.length();
  if (la < 1e-6 || lb < 1e-6) return 0;
  const cos = a.dot(b) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, cos))) * radius;
}

/**
 * Parallel-transport a tangent vector to a new surface point's tangent plane.
 * The camera's heading uses this so that walking over the curve of the planet
 * never makes the horizon tilt or the view snap.
 */
export function transportTangent(v: Vector3, newUp: Vector3, target = new Vector3()): Vector3 {
  projectOnTangent(v, newUp, target);
  const len = target.length();
  if (len < 1e-5) {
    // Degenerate: the old heading now points straight up. Pick any tangent.
    target.set(newUp.y, -newUp.x, 0);
    if (target.lengthSq() < 1e-6) target.set(1, 0, 0);
    projectOnTangent(target, newUp, target);
    return target.normalize();
  }
  return target.divideScalar(len);
}

/**
 * Evenly distributed points on a unit sphere via the Fibonacci spiral.
 * Used as the sampling grid for scattering props: far more uniform than
 * rejection-sampling random directions.
 */
export function fibonacciSphere(count: number, out: Vector3[] = []): Vector3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out.push(new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r));
  }
  return out;
}

/** A uniformly distributed random direction on the unit sphere. */
export function randomDirection(rng: () => number, target = new Vector3()): Vector3 {
  const z = rng() * 2 - 1;
  const t = rng() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return target.set(Math.cos(t) * r, Math.sin(t) * r, z);
}

/** Any unit vector perpendicular to `n`. */
export function anyTangent(n: Vector3, target = new Vector3()): Vector3 {
  target.set(0, 1, 0);
  if (Math.abs(n.dot(target)) > 0.95) target.set(1, 0, 0);
  return projectOnTangent(target, n, target).normalize();
}

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Frame-rate independent smoothing factor. `t` is the fraction of the gap to
 * close in 1/60 s; the result is the fraction to close in `dt` seconds.
 */
export const damp = (t: number, dt: number) => 1 - Math.pow(1 - t, dt * 60);

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};
