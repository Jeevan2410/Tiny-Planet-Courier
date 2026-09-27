/**
 * The project's colour palette, as plain hex numbers.
 *
 * Deliberately free of any three.js import. The terrain field and the world
 * generation worker both need these values, and the worker must not pull three
 * in -- a second copy of the library in the worker bundle would cost more
 * download than the worker saves in main-thread time.
 */
/** Warm, saturated storybook palette. Every colour in the game comes from here. */
export const PALETTE = {
  // Terrain
  meadow: 0x8ccb5e,
  meadowDark: 0x63a848,
  grass: 0x7abf55,
  forestFloor: 0x4f8f4a,
  pine: 0x2f7f58,
  pineDark: 0x246349,
  leaf: 0x66b84a,
  leafAlt: 0x8fc74f,
  sand: 0xe6d3a3,
  rock: 0x9b9189,
  rockDark: 0x7c736c,
  soot: 0x6f6862,
  snow: 0xf4f7fb,
  water: 0x3fa3da,
  waterDeep: 0x2b74b0,

  // Built surfaces
  asphalt: 0x6f7480,
  kerb: 0xb9b7ae,
  concrete: 0xc3c0b6,

  // Built things
  wall: 0xf6e8cf,
  wallAlt: 0xe9d5b3,
  roofRed: 0xdf5a49,
  roofOrange: 0xe08a3c,
  roofBlue: 0x5c79cf,
  roofTeal: 0x45a49b,
  roofPurple: 0x8a6fc9,
  wood: 0x8b5b3c,
  woodDark: 0x6b452e,
  metal: 0xa9b2bb,
  metalDark: 0x7a838c,
  pipe: 0xc2723f,
  window: 0x9fdcf0,
  lamp: 0xffd98a,

  // Characters + props
  skin: [0xf2c9a0, 0xe0a87b, 0xb97d52, 0x8a5a3b, 0xf7dcc0] as number[],
  outfit: [0x3f7fd6, 0xe0574a, 0x37a86c, 0xefb13c, 0x8a5ed6, 0x2bb3ad, 0xf07ab0, 0x2f3c52] as number[],
  hair: [0x2b2118, 0x6b3a20, 0xd8a24a, 0xc45a3a, 0x8c8c94] as number[],
  parcel: 0xd9a066,
  parcelTape: 0xc07a3f,
  mailbox: 0xe8503f,
  accent: 0xffcf5c,
  shadow: 0x1d2530,
} as const;
