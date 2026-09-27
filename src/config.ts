/**
 * Tunable constants for the whole experience.
 * Kept in one place so the feel of the game can be adjusted without hunting.
 */
export const CONFIG = {
  planet: {
    /** Base radius of the planet in world units. */
    radius: 22,
    /**
     * Icosphere subdivision depth. Each level quadruples the face count, so 6
     * gives 20 * 4^6 = 81,920 triangles from 40,962 welded vertices -- fine
     * enough that the horizon reads as a curve rather than a polygon.
     *
     * The mesh is built by recursive midpoint subdivision in terrainMesh.ts
     * rather than by three's IcosahedronGeometry, both to keep three out of the
     * generation worker and because the midpoint cache welds vertices as it
     * goes instead of emitting every triangle unindexed and welding afterwards.
     */
    subdivisions: 6,
    /** Peak-to-trough amplitude of the terrain displacement. */
    terrainAmplitude: 2.2,
    /** Radius of the water shell; terrain below this reads as ocean. */
    seaLevel: 22.05,
    seed: 20260926,
  },

  player: {
    walkSpeed: 4.6,
    runSpeed: 8.6,
    /** How fast the character rotates to face its movement direction (rad/s). */
    turnSpeed: 10,
    jumpSpeed: 7.2,
    gravity: 22,
    /** Look-at target height above the character's feet. */
    headHeight: 1.3,
  },

  camera: {
    distance: 8.5,
    minDistance: 4,
    maxDistance: 16,
    /** Pitch limits in radians, measured up from the local tangent plane. */
    minPitch: -0.28,
    maxPitch: 1.15,
    startPitch: 0.34,
    /** Mouse look sensitivity (radians per pixel). */
    sensitivity: 0.0026,
    touchSensitivity: 0.0052,
    /** Positional smoothing: fraction of the gap closed per 60fps frame. */
    smoothing: 0.16,
    fov: 58,
  },

  gameplay: {
    /** How close the player must be to a mailbox/NPC to interact. */
    interactRadius: 2.6,
    /** Minimum great-circle distance between consecutive delivery targets. */
    minTargetSpread: 12,
    /** Seconds of bonus-scoring time granted per delivery. */
    parcelTimer: 95,
    scorePerDelivery: 100,
    streakBonus: 25,
  },

  net: {
    /** Outgoing position broadcast rate (Hz). */
    tickRate: 15,
    /** Remote avatars are rendered this many ms in the past, to interpolate. */
    interpolationDelayMs: 130,
    /** Drop a remote player after this long without an update. */
    timeoutMs: 12_000,
    emojiLifetimeMs: 2600,
  },

  render: {
    /** Devicepixelratio caps per quality tier. */
    maxPixelRatioHigh: 2,
    maxPixelRatioLow: 1,
    /**
     * Outline thickness as a fraction of view depth: the shader expands in view
     * space scaled by distance, so this is roughly a constant screen width
     * rather than an object-space offset.
     */
    outlineWidth: 0.0072,
    /** Per-vertex width variation, which is what makes the line read as ink. */
    outlineJitter: 0.32,
    /** Radius around the camera within which small scatter props are drawn. */
    scatterDrawDistanceHigh: 46,
    scatterDrawDistanceLow: 26,
  },

  dayCycle: {
    /** Seconds for one full day/night rotation. */
    lengthSeconds: 420,
    /** Where the cycle starts: 0 = dawn, 0.25 = noon, 0.5 = dusk, 0.75 = midnight. */
    startPhase: 0.17,
  },
} as const;

export type Quality = 'low' | 'high';
