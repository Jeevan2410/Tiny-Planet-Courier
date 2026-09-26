/**
 * Flavour text and names. Short, varied lines do a lot of work in a game with
 * no voice acting: they make a mailbox feel like it belongs to somebody.
 */
import { pick, type Rng } from '../util/rng';

export const RECIPIENT_NAMES = [
  'Pella', 'Marn', 'Ottoline', 'Bram', 'Juno', 'Fennick', 'Saffi', 'Cobb',
  'Delia', 'Hovis', 'Teasel', 'Rook', 'Mira', 'Pimm', 'Wren', 'Guff',
  'Nettle', 'Barnaby', 'Clove', 'Tamsin', 'Oskar', 'Peony', 'Hale', 'Vesper',
  'Quill', 'Marlow', 'Sorrel', 'Tibbs', 'Ida', 'Grebe',
] as const;

export const HOUSE_SUFFIXES = [
  'Cottage', 'Lodge', 'Rest', 'End', 'Nook', 'Roost', 'Croft', 'Hollow', 'Wharf', 'Barn',
] as const;

/** What the depot clerk says when handing over a parcel. */
export const PICKUP_LINES = [
  'One parcel, handle with feeling.',
  'This one rattles. Try not to shake it.',
  'Careful, the label says FRAGILE twice.',
  'Someone has been waiting all week for this.',
  'Still warm. Do not ask.',
  'Marked urgent, which here means "before supper".',
  'It hums a little. Perfectly normal.',
  'Do not read the postcard on the way.',
  'Heavier than it looks. Good luck.',
  'Smells faintly of pepper. Off you go.',
] as const;

/** What a recipient says on a successful delivery. */
export const DELIVERY_LINES = [
  'Oh, finally! Thank you.',
  'You came all the way up here?',
  'I was starting to think it was lost.',
  'Just in time. Kettle is already on.',
  'That is the one! You are a marvel.',
  'Put it anywhere. Anywhere is fine.',
  'My cousin said it would never arrive.',
  'Is it the seeds? Please let it be the seeds.',
  'Right on time, as always.',
  'You must be exhausted. Sit a moment.',
  'It is bigger than I pictured.',
  'I will name the cat after you.',
  'Wonderful. Now, about the last one...',
  'Straight through the gate next time, it sticks.',
] as const;

/** Idle chatter from NPCs standing around the world. */
export const IDLE_LINES = [
  'Lovely weather for a walk.',
  'Mind the slope past the ridge.',
  'The mail used to take a week, you know.',
  'Have you seen my hat?',
  'They say the far side is colder.',
  'I am waiting for a very specific box.',
  'Watch out for the puddles.',
  'The windmill has been squeaking again.',
  'You can see the whole world from the peak.',
  'Nice bag. Very official.',
] as const;

export const ZONE_HINTS: Record<string, string> = {
  meadow: 'down in the meadow',
  forest: 'somewhere in the pines',
  works: 'over by the works',
  dunes: 'out past the dunes',
  frost: 'up on the frostcap',
};

export function pickupLine(rng: Rng): string {
  return pick(rng, PICKUP_LINES);
}

export function deliveryLine(rng: Rng): string {
  return pick(rng, DELIVERY_LINES);
}

export function idleLine(rng: Rng): string {
  return pick(rng, IDLE_LINES);
}

/** A house name like "Bram's Roost". */
export function houseName(rng: Rng): string {
  return `${pick(rng, RECIPIENT_NAMES)}'s ${pick(rng, HOUSE_SUFFIXES)}`;
}
