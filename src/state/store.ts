/**
 * Central UI/game state. The 3D simulation owns its own transforms (it would be
 * wasteful to push 60Hz vectors through a store) -- this holds the things the
 * DOM layer and the network layer both need to agree on.
 */
import { createStore } from 'zustand/vanilla';
import type { Quality } from '../config';

export type Phase = 'loading' | 'title' | 'playing' | 'paused';
export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

export interface Objective {
  kind: 'pickup' | 'deliver';
  /** Short imperative line shown in the HUD. */
  text: string;
  /** Name of the recipient or depot. */
  target: string;
  zone: string;
}

export interface InteractPrompt {
  text: string;
  key: string;
}

export interface Cosmetics {
  name: string;
  /** Index into the outfit palette. */
  outfit: number;
  /** Index into the headgear list. */
  hat: number;
  /** Index into the skin-tone palette. */
  skin: number;
}

export interface Settings {
  quality: Quality;
  volume: number;
  muted: boolean;
  invertY: boolean;
  showFps: boolean;
}

export interface GameState {
  phase: Phase;
  loadProgress: number;
  loadLabel: string;

  score: number;
  streak: number;
  bestStreak: number;
  deliveries: number;
  /** Seconds remaining on the current parcel's bonus window. */
  timeLeft: number;

  objective: Objective | null;
  carrying: boolean;
  prompt: InteractPrompt | null;

  /** Distance in metres to the current objective, for the HUD compass. */
  targetDistance: number;
  /** Screen-space angle to the objective in radians, 0 = straight ahead. */
  targetBearing: number;
  /** True when the objective is off-screen and the arrow should show. */
  targetOffscreen: boolean;

  netStatus: NetStatus;
  playersOnline: number;

  cosmetics: Cosmetics;
  settings: Settings;

  panel: 'none' | 'customize' | 'settings' | 'help';
  toast: { id: number; text: string; tone: 'info' | 'good' } | null;
  fps: number;
}

export interface GameActions {
  setPhase(phase: Phase): void;
  setLoading(progress: number, label: string): void;
  setObjective(objective: Objective | null): void;
  setCarrying(carrying: boolean): void;
  setPrompt(prompt: InteractPrompt | null): void;
  setTargeting(distance: number, bearing: number, offscreen: boolean): void;
  setNet(status: NetStatus, playersOnline?: number): void;
  setPlayersOnline(count: number): void;
  addDelivery(points: number, streak: number): void;
  resetStreak(): void;
  setTimeLeft(seconds: number): void;
  setCosmetics(patch: Partial<Cosmetics>): void;
  setSettings(patch: Partial<Settings>): void;
  setPanel(panel: GameState['panel']): void;
  pushToast(text: string, tone?: 'info' | 'good'): void;
  setFps(fps: number): void;
  hydrateScore(score: number, deliveries: number, bestStreak: number): void;
}

const COSMETICS_KEY = 'tpc.cosmetics.v1';
const SETTINGS_KEY = 'tpc.settings.v1';

const DEFAULT_COSMETICS: Cosmetics = { name: '', outfit: 0, hat: 0, skin: 1 };
const DEFAULT_SETTINGS: Settings = {
  quality: 'high',
  volume: 0.7,
  muted: false,
  invertY: false,
  showFps: false,
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private browsing / quota. Cosmetics are a nicety, never a hard failure. */
  }
}

let toastSeq = 0;

export const store = createStore<GameState & GameActions>((set, get) => ({
  phase: 'loading',
  loadProgress: 0,
  loadLabel: 'Warming up',

  score: 0,
  streak: 0,
  bestStreak: 0,
  deliveries: 0,
  timeLeft: 0,

  objective: null,
  carrying: false,
  prompt: null,

  targetDistance: 0,
  targetBearing: 0,
  targetOffscreen: false,

  netStatus: 'offline',
  playersOnline: 0,

  cosmetics: load(COSMETICS_KEY, DEFAULT_COSMETICS),
  settings: load(SETTINGS_KEY, DEFAULT_SETTINGS),

  panel: 'none',
  toast: null,
  fps: 0,

  setPhase: (phase) => set({ phase }),
  setLoading: (loadProgress, loadLabel) => set({ loadProgress, loadLabel }),
  setObjective: (objective) => set({ objective }),
  setCarrying: (carrying) => set({ carrying }),
  setPrompt: (prompt) => set({ prompt }),
  setTargeting: (targetDistance, targetBearing, targetOffscreen) =>
    set({ targetDistance, targetBearing, targetOffscreen }),
  setNet: (netStatus, playersOnline) =>
    set(playersOnline === undefined ? { netStatus } : { netStatus, playersOnline }),
  setPlayersOnline: (playersOnline) => set({ playersOnline }),

  addDelivery: (points, streak) =>
    set((s) => ({
      score: s.score + points,
      deliveries: s.deliveries + 1,
      streak,
      bestStreak: Math.max(s.bestStreak, streak),
    })),
  resetStreak: () => set({ streak: 0 }),
  setTimeLeft: (timeLeft) => set({ timeLeft }),

  setCosmetics: (patch) => {
    const cosmetics = { ...get().cosmetics, ...patch };
    save(COSMETICS_KEY, cosmetics);
    set({ cosmetics });
  },
  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    save(SETTINGS_KEY, settings);
    set({ settings });
  },
  setPanel: (panel) => set({ panel }),
  pushToast: (text, tone = 'info') => set({ toast: { id: ++toastSeq, text, tone } }),
  setFps: (fps) => set({ fps }),
  hydrateScore: (score, deliveries, bestStreak) => set({ score, deliveries, bestStreak }),
}));

export const getState = store.getState;
export const setState = store.setState;

/** Subscribe to one derived slice, firing only when that slice changes. */
export function watch<T>(
  selector: (s: GameState & GameActions) => T,
  run: (value: T, previous: T) => void,
  equals: (a: T, b: T) => boolean = Object.is,
): () => void {
  let previous = selector(store.getState());
  run(previous, previous);
  return store.subscribe((state) => {
    const next = selector(state);
    if (equals(next, previous)) return;
    const prev = previous;
    previous = next;
    run(next, prev);
  });
}
