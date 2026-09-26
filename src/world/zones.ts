/**
 * The planet is divided into overlapping biomes. Each zone owns a direction on
 * the sphere and a soft angular falloff, so terrain shape, colour and prop mix
 * all blend continuously into their neighbours instead of meeting at a seam.
 */
import { Vector3 } from 'three';
import { PALETTE } from '../fx/toon';

export interface Zone {
  id: string;
  name: string;
  /** Unit vector pointing at the middle of the zone. */
  center: Vector3;
  /** Angular falloff in radians. Larger = the zone bleeds further out. */
  spread: number;

  /** Multiplier on terrain relief. Low = flat and walkable. */
  relief: number;
  /** 0..1 blend of ridged noise, which produces crests rather than blobs. */
  ridged: number;
  /** Raises the whole zone: keeps settlements clear of the waterline. */
  lift: number;

  ground: number;
  groundAlt: number;
  /** Colour used on steep faces in this zone. */
  cliff: number;
  /** Set for zones that get snow on their high ground. */
  snowLine?: number;

  /** Per-1000-samples density of each scatter type. */
  density: {
    pine: number;
    broadleaf: number;
    rock: number;
    grass: number;
    reed: number;
    crate: number;
    pipe: number;
    cactus: number;
  };
}

const dir = (x: number, y: number, z: number) => new Vector3(x, y, z).normalize();

export const ZONES: Zone[] = [
  {
    id: 'meadow',
    name: 'Harborlight Meadow',
    center: dir(0.15, 0.3, 1),
    spread: 0.95,
    relief: 0.32,
    ridged: 0.05,
    lift: 0.52,
    ground: PALETTE.meadow,
    groundAlt: PALETTE.meadowDark,
    cliff: PALETTE.rock,
    density: { pine: 6, broadleaf: 22, rock: 8, grass: 150, reed: 14, crate: 2, pipe: 0, cactus: 0 },
  },
  {
    id: 'forest',
    name: 'Pinewood Hollow',
    center: dir(1, 0.12, -0.3),
    spread: 0.88,
    relief: 0.72,
    ridged: 0.28,
    lift: 0.46,
    ground: PALETTE.forestFloor,
    groundAlt: PALETTE.pineDark,
    cliff: PALETTE.rockDark,
    density: { pine: 130, broadleaf: 38, rock: 20, grass: 90, reed: 8, crate: 1, pipe: 0, cactus: 0 },
  },
  {
    id: 'works',
    name: 'Cogford Powerworks',
    center: dir(-0.85, -0.25, 0.45),
    spread: 0.78,
    relief: 0.34,
    ridged: 0.1,
    lift: 0.48,
    ground: PALETTE.soot,
    groundAlt: PALETTE.rockDark,
    cliff: PALETTE.rockDark,
    density: { pine: 4, broadleaf: 4, rock: 26, grass: 30, reed: 2, crate: 26, pipe: 18, cactus: 0 },
  },
  {
    id: 'dunes',
    name: 'Sunbell Dunes',
    center: dir(-0.25, -0.92, -0.3),
    spread: 0.82,
    relief: 0.5,
    ridged: 0.08,
    lift: 0.4,
    ground: PALETTE.sand,
    groundAlt: 0xd9c189,
    cliff: 0xc9ac79,
    density: { pine: 0, broadleaf: 2, rock: 16, grass: 18, reed: 0, crate: 3, pipe: 0, cactus: 26 },
  },
  {
    id: 'frost',
    name: 'Frostcap Rise',
    center: dir(0.05, 0.95, -0.25),
    spread: 0.8,
    relief: 1.25,
    ridged: 0.62,
    lift: 0.62,
    ground: 0xcfe0e8,
    groundAlt: 0xa9c4d2,
    cliff: 0x8d9aa6,
    snowLine: 0.55,
    density: { pine: 26, broadleaf: 0, rock: 34, grass: 12, reed: 0, crate: 1, pipe: 0, cactus: 0 },
  },
];

export const ZONE_BY_ID: Record<string, Zone> = Object.fromEntries(
  ZONES.map((z) => [z.id, z]),
) as Record<string, Zone>;

/**
 * Smooth zone membership for a direction. Writes normalised weights into
 * `out` (indexed to match ZONES) and returns the index of the dominant zone.
 *
 * Uses a Gaussian of angular distance: cheap, always positive, and the sum
 * never hits zero anywhere on the sphere, so there are no undefined patches.
 */
export function zoneWeights(direction: Vector3, out: Float32Array): number {
  let total = 0;
  let best = 0;
  let bestWeight = -1;

  for (let i = 0; i < ZONES.length; i++) {
    const zone = ZONES[i];
    const cos = Math.min(1, Math.max(-1, direction.dot(zone.center)));
    const angle = Math.acos(cos);
    const t = angle / zone.spread;
    const w = Math.exp(-t * t * 1.35);
    out[i] = w;
    total += w;
    if (w > bestWeight) {
      bestWeight = w;
      best = i;
    }
  }

  const inv = total > 1e-6 ? 1 / total : 0;
  for (let i = 0; i < ZONES.length; i++) out[i] *= inv;
  return best;
}

/** Scratch buffer for callers that only need the dominant zone. */
const scratch = new Float32Array(ZONES.length);

export function zoneAt(direction: Vector3): Zone {
  return ZONES[zoneWeights(direction, scratch)];
}
