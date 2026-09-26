/**
 * Tunable constants for the whole experience.
 * Kept in one place so the feel of the game can be adjusted without hunting.
 */
export const CONFIG = {
  planet: {
    /** Base radius of the planet in world units. */
    radius: 22,
    /**
     * Icosphere edge segments. Note this is PolyhedronGeometry's "detail", which
     * splits each icosahedron edge into (detail + 1) segments -- it is NOT a
     * recursion depth. 56 gives 20 * 57^2 = 64,980 triangles from 32,492 welded
     * vertices: fine enough that the horizon reads as a curve rather than a
     * polygon, cheap enough to generate in well under a second.
     */
    detail: 56,
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
    outlineWidth: 0.022,
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
