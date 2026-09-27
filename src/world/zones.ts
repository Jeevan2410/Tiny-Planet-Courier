/**
 * Three-facing view of the zone data.
 *
 * The numbers and the blending maths live in `zoneData.ts`, which is free of
 * any three import so the world generation worker can use them. This module
 * adds Vector3 centres for the game code that lays settlements out on the
 * sphere, and keeps the original API so nothing else had to change.
 */
import { Vector3 } from 'three';
import { ZONES as ZONE_DATA, zoneWeightsXYZ, type Zone as ZoneData } from './zoneData';

export type { ZoneData };

export interface Zone extends Omit<ZoneData, 'center'> {
  /** Unit vector pointing at the middle of the zone. */
  center: Vector3;
}

export const ZONES: Zone[] = ZONE_DATA.map((zone) => ({
  ...zone,
  center: new Vector3(zone.center[0], zone.center[1], zone.center[2]),
}));

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(
  ZONES.map((z) => [z.id, z]),
) as Record<string, Zone>;

/** See `zoneWeightsXYZ`. Accepts a Vector3 for convenience. */
export function zoneWeights(direction: Vector3, out: Float32Array): number {
  return zoneWeightsXYZ(direction.x, direction.y, direction.z, out);
}

const scratch = new Float32Array(ZONES.length);

export function zoneAt(direction: Vector3): Zone {
  return ZONES[zoneWeights(direction, scratch)];
}
