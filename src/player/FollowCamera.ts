/**
 * Third-person orbit camera for a spherical world.
 *
 * The camera's heading is stored as a tangent vector rather than a yaw angle,
 * because there is no global frame to measure a yaw against here -- walk far
 * enough and your "north" has rotated. Each frame the heading is
 * parallel-transported into the player's current tangent plane, which keeps the
 * view continuous as the ground curves away beneath you and means the horizon
 * never tilts or snaps.
 *
 * Pitch stays a plain scalar measured from the local tangent plane, and the
 * camera's own up vector is set to the player's up before every lookAt.
 */
import { Object3D, PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { CONFIG } from '../config';
import type { Planet } from '../world/Planet';
import { clamp, damp, projectOnTangent, transportTangent } from '../util/sphere';
import type { Input } from './Input';

const _desired = new Vector3();
const _offset = new Vector3();
const _camDir = new Vector3();
const _toCamera = new Vector3();

export class FollowCamera {
  readonly camera: PerspectiveCamera;
  /** Tangent heading the camera looks along. Also drives player movement. */
  readonly forward = new Vector3(0, 0, 1);
  /** The point the camera is aimed at. */
  readonly lookTarget = new Vector3();

  private pitch: number = CONFIG.camera.startPitch;
  private distance: number = CONFIG.camera.distance;
  private distanceTarget: number = CONFIG.camera.distance;
  private initialised = false;

  /** Solid geometry the camera must not end up inside (buildings). */
  private colliders: Object3D[] = [];
  private readonly raycaster = new Raycaster();

  constructor(private readonly planet: Planet) {
    this.camera = new PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 1200);
    this.camera.name = 'followCamera';
  }

  /**
   * Register occluders. Pass fill meshes only: the outline shells are back-face
   * geometry and would report hits from inside their own hull.
   */
  setColliders(colliders: Object3D[]): void {
    this.colliders = colliders;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Point the camera along a tangent direction without any smoothing. */
  reset(up: Vector3, forward: Vector3): void {
    transportTangent(forward, up, this.forward);
    this.pitch = CONFIG.camera.startPitch;
    this.distance = this.distanceTarget;
    this.initialised = false;
  }

  update(dt: number, eye: Vector3, up: Vector3, input: Input, invertY: boolean, touch: boolean): void {
    // ---- look input
    const sensitivity = touch ? CONFIG.camera.touchSensitivity : CONFIG.camera.sensitivity;
    if (input.look.lengthSq() > 0) {
      // Yaw is a rotation of the heading about the player's up: the only
      // rotation that makes sense on a sphere.
      this.forward.applyAxisAngle(up, -input.look.x * sensitivity);
      this.pitch = clamp(
        this.pitch + input.look.y * sensitivity * (invertY ? -1 : 1),
        CONFIG.camera.minPitch,
        CONFIG.camera.maxPitch,
      );
    }

    if (input.zoom !== 0) {
      this.distanceTarget = clamp(
        this.distanceTarget + input.zoom,
        CONFIG.camera.minDistance,
        CONFIG.camera.maxDistance,
      );
    }
    this.distance += (this.distanceTarget - this.distance) * damp(0.2, dt);

    // Re-seat the heading in the current tangent plane.
    transportTangent(this.forward, up, this.forward);

    // ---- desired position: back along the heading and up by the pitch
    this.lookTarget.copy(eye);
    const cos = Math.cos(this.pitch);
    const sin = Math.sin(this.pitch);
    _offset
      .copy(this.forward)
      .multiplyScalar(-this.distance * cos)
      .addScaledVector(up, this.distance * sin + 0.25);
    _desired.copy(this.lookTarget).add(_offset);

    if (!this.initialised) {
      this.camera.position.copy(_desired);
      this.initialised = true;
    } else {
      // Smoothing is applied to position only. Smoothing the look target too
      // makes the character feel like it is sliding inside the frame.
      this.camera.position.lerp(_desired, damp(CONFIG.camera.smoothing, dt));
    }

    // Collision is resolved AFTER smoothing, never before: easing toward a
    // corrected target would still let the camera dip through a wall for a few
    // frames on the way there.
    this.resolveCollisions(up);

    this.camera.up.copy(up);
    this.camera.lookAt(this.lookTarget);
  }

  /**
   * Keep the camera above ground and out of buildings.
   *
   * Terrain is resolved FIRST and buildings second, deliberately. The other
   * order looks equivalent but is not: lifting the camera out of a hillside can
   * push it up into a roof, and nothing would then test for that. Doing the
   * building raycast last guarantees the final position has an unobstructed
   * line back to the player, which is the property that actually matters.
   */
  private resolveCollisions(up: Vector3): void {
    // Terrain: analytic, so this is a height lookup rather than a sweep test.
    _camDir.copy(this.camera.position).normalize();
    const floor = Math.max(this.planet.heightAt(_camDir), this.planet.seaLevel) + 0.7;
    if (this.camera.position.length() < floor) {
      this.camera.position.copy(_camDir).multiplyScalar(floor);
    }

    // Buildings: cast from the player's head out to the camera and stop short of
    // the first wall in the way.
    if (this.colliders.length > 0) {
      _toCamera.copy(this.camera.position).sub(this.lookTarget);
      const distance = _toCamera.length();
      if (distance > 0.05) {
        _toCamera.divideScalar(distance);
        this.raycaster.set(this.lookTarget, _toCamera);
        this.raycaster.near = 0;
        this.raycaster.far = distance;
        const hits = this.raycaster.intersectObjects(this.colliders, false);
        if (hits.length > 0) {
          // The wall always wins. An earlier version floored this at a
          // comfortable viewing distance, which simply pushed the camera
          // through the geometry it was supposed to avoid. When the correction
          // does bring the camera in close, main.ts hides the courier instead.
          const pulled = Math.max(1.0, hits[0].distance - 0.35);
          this.camera.position.copy(this.lookTarget).addScaledVector(_toCamera, pulled);
        }
      }
    }

    // Never let a correction drop the camera below the player's own feet.
    const minimum = this.lookTarget.dot(up) - CONFIG.player.headHeight + 0.25;
    if (this.camera.position.dot(up) < minimum) {
      this.camera.position.addScaledVector(up, minimum - this.camera.position.dot(up));
    }
  }

  /**
   * The heading handed to the character controller. Projected flat so that
   * looking up or down never changes how fast the player walks.
   */
  movementForward(up: Vector3, target = new Vector3()): Vector3 {
    return projectOnTangent(this.forward, up, target).normalize();
  }
}
