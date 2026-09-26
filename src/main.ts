/**
 * Entry point and orchestration.
 *
 * Responsibilities, in order: build the world behind a progress bar, hand the
 * player a character, then run one frame loop that ticks simulation, gameplay,
 * networking and rendering. Everything below is wiring -- the systems themselves
 * are self-contained and know nothing about each other.
 */
import './style.css';
import { Vector3 } from 'three';
import { AudioManager } from './audio/Audio';
import { CONFIG, type Quality } from './config';
import { Engine } from './core/Engine';
import { runSteps } from './core/Loader';
import { EmojiField } from './fx/EmojiField';
import { ConfettiField } from './fx/Particles';
import { setOutlinesVisible } from './fx/outline';
import { Delivery } from './gameplay/Delivery';
import { Villagers } from './gameplay/NPC';
import { Backend } from './net/backend';
import { RemotePlayers } from './net/RemotePlayers';
import { SocketTransport } from './net/SocketTransport';
import { SupabaseTransport } from './net/SupabaseTransport';
import {
  OfflineTransport,
  profileId,
  type NetTransport,
  type PlayerIdentity,
  type TransportHandlers,
} from './net/transport';
import { CharacterController } from './player/Controller';
import { Courier } from './player/Courier';
import { FollowCamera } from './player/FollowCamera';
import { Input } from './player/Input';
import { getState, store, watch, type Cosmetics } from './state/store';
import { Ui } from './ui/ui';
import { TouchControls } from './ui/touch';
import { DayCycle } from './world/DayCycle';
import { Planet } from './world/Planet';
import { ScatterField } from './world/Scatter';
import { Settlements } from './world/Settlements';
import { Sky } from './world/Sky';

const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
if (!canvas) throw new Error('Missing #scene canvas');

// ------------------------------------------------------------------- scaffolding

const engine = new Engine(canvas);
const input = new Input(canvas);
const audio = new AudioManager();

const planet = new Planet();
const settlements = new Settlements(planet);
const scatter = new ScatterField(planet, settlements.exclusions);
const villagers = new Villagers(planet);
const sky = new Sky();
const dayCycle = new DayCycle();
const confetti = new ConfettiField();
const emojiField = new EmojiField();
const remotePlayers = new RemotePlayers(planet);

const controller = new CharacterController(planet);
const followCamera = new FollowCamera(planet);
let courier: Courier;
let delivery: Delivery;

const backend = new Backend(
  import.meta.env.VITE_SUPABASE_URL as string | undefined,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
);

/** Stable per-browser id: what the leaderboard row is keyed on. */
const myId = profileId();
let transport: NetTransport | null = null;
let netAccumulator = 0;
let started = false;
let cosmeticsSaveTimer = 0;

const _tmpForward = new Vector3();
const _tmpUp = new Vector3();
const _tmpPosition = new Vector3();

// -------------------------------------------------------------------------- UI

const ui = new Ui({
  onPlay: (name) => void beginPlay(name),
  onEmoji: (slot) => sendEmoji(slot),
  onPanel: (panel) => openPanel(panel),
  onPause: () => pause(),
  onResume: () => resume(),
  onCosmetics: (patch) => {
    getState().setCosmetics(patch);
  },
  onSettings: (patch) => {
    getState().setSettings(patch);
  },
});

const touchControls = new TouchControls(input, () => {
  document.getElementById('emoji-bar')?.classList.toggle('open');
});

// --------------------------------------------------------------- world building

async function buildWorld(): Promise<void> {
  const progress = (fraction: number, label: string) => getState().setLoading(fraction, label);

  await runSteps(
    [
      {
        label: 'Choosing where the towns go',
        weight: 1,
        run: () => settlements.reserve(),
      },
      {
        label: 'Sculpting the planet',
        weight: 5,
        run: () => planet.build(),
      },
      {
        label: 'Raising roofs and lamp posts',
        weight: 2,
        run: () => settlements.build(),
      },
      {
        label: 'Planting trees and rocks',
        weight: 5,
        run: () => scatter.build(),
      },
      {
        label: 'Waking the villagers',
        weight: 1,
        run: () => villagers.build(settlements.npcSpawns),
      },
      {
        label: 'Hanging the sky',
        weight: 1,
        run: () => {
          dayCycle.addTo(engine.scene);
          engine.scene.add(
            planet.group,
            settlements.group,
            scatter.group,
            villagers.group,
            sky.group,
            confetti.mesh,
            emojiField.group,
            remotePlayers.group,
          );
        },
      },
      {
        label: 'Tailoring your uniform',
        weight: 1,
        run: () => {
          courier = new Courier(getState().cosmetics);
          courier.onFootstep = (speed) => audio.footstep(speed, controller.inWater);
          engine.scene.add(courier.root);

          delivery = new Delivery(planet, settlements, villagers, confetti, {
            onPickup: (line) => {
              audio.pickup();
              courier.setCarrying(true);
              courier.playGesture('handover');
              getState().pushToast(line);
            },
            onDeliver: (line, points, streak) => {
              audio.deliver();
              courier.setCarrying(false);
              courier.playGesture('handover');
              getState().pushToast(`${line}  +${points}`, 'good');
              if (streak >= 3) {
                getState().pushToast(`${streak} in a row!`, 'good');
              }
              void submitScore();
            },
            onExpire: () => {
              audio.expire();
              getState().pushToast('Too slow -- streak lost.');
            },
            onPromptChange: (text) => {
              const current = getState().prompt;
              if (!text) {
                if (current) getState().setPrompt(null);
                return;
              }
              if (current?.text !== text) getState().setPrompt({ text, key: 'E' });
            },
          });
          engine.scene.add(delivery.group);

          // Drop in beside the depot, facing it, so the first objective is
          // visible the instant the camera opens.
          followCamera.setColliders(settlements.colliders);
          controller.setBlockers(settlements.blockers);
          controller.spawn(settlements.spawnDir);
          _tmpForward.copy(settlements.depotDir).sub(controller.dir);
          followCamera.reset(controller.up, _tmpForward);
          courier.root.position.copy(controller.position);
          courier.root.quaternion.copy(controller.quaternion);
        },
      },
      {
        label: 'Checking the post office records',
        weight: 1,
        run: async () => {
          if (!backend.available) return;
          const [profile, board] = await Promise.all([
            backend.loadProfile(myId),
            backend.leaderboard(8),
          ]);
          if (profile) {
            getState().setCosmetics({
              name: profile.name ?? '',
              outfit: profile.outfit ?? 0,
              hat: profile.hat ?? 0,
              skin: profile.skin ?? 1,
            });
            getState().hydrateScore(0, profile.total_deliveries ?? 0, profile.best_streak ?? 0);
          }
          ui.setLeaderboard(board);
        },
      },
    ],
    progress,
  );

  applyQuality(getState().settings.quality);
  engine.attach((width, height) => followCamera.setAspect(width / height));
  engine.onFrame = ({ dt, elapsed }) => frame(dt, elapsed);
  engine.onFps = (fps) => {
    getState().setFps(fps);
    if (!getState().settings.showFps) return;
    const stats = engine.stats();
    ui.setStats([
      `${fps} fps`,
      `${stats.calls} draw calls`,
      `${(stats.triangles / 1000).toFixed(0)}k tris`,
      `${scatter.instanceCount} props`,
    ]);
  };

  // Render the title screen behind the menu: a still, slowly-lit planet sells the
  // game better than a black screen with a button on it.
  engine.start();
  getState().setPhase('title');
  ui.focusNameInput();
}

// -------------------------------------------------------------------- lifecycle

async function beginPlay(name: string): Promise<void> {
  if (started) return;
  started = true;

  getState().setCosmetics({ name: name.slice(0, 18) });
  courier.setCosmetics(getState().cosmetics);

  // Audio must be created inside the click handler chain.
  await audio.start();
  audio.setVolume(getState().settings.volume);
  audio.setMuted(getState().settings.muted);

  if (TouchControls.isTouchDevice()) {
    touchControls.enable();
    ui.setTouchMode(true);
  }

  getState().setPhase('playing');
  input.attach();
  input.setEnabled(true);
  delivery.start();
  audio.chime();

  void connectNetwork();
}

function pause(): void {
  if (getState().phase !== 'playing') return;
  getState().setPhase('paused');
  getState().setPanel('none');
  input.setEnabled(false);
  audio.setMusicDucked(true);
  if (document.pointerLockElement) document.exitPointerLock();
}

function resume(): void {
  getState().setPanel('none');
  if (getState().phase !== 'paused') return;
  getState().setPhase('playing');
  input.setEnabled(true);
  audio.setMusicDucked(false);
}

function openPanel(panel: 'none' | 'customize' | 'settings' | 'help'): void {
  if (panel === 'none') {
    resume();
    return;
  }
  if (getState().phase === 'playing') pause();
  getState().setPanel(panel);
  audio.ui();
}

// ------------------------------------------------------------------ networking

function transportHandlers(): TransportHandlers {
  return {
    onState: (update) => remotePlayers.onState(update),
    onIdentity: (id, identity) => remotePlayers.onIdentity(id, identity),
    onEmoji: (id, slot) => {
      const rig = remotePlayers.rigFor(id);
      if (!rig) return;
      rig.getWorldPosition(_tmpPosition);
      _tmpUp.copy(_tmpPosition).normalize();
      emojiField.spawn(slot, _tmpPosition.addScaledVector(_tmpUp, 2.05), _tmpUp, rig);
      audio.remoteEmoji();
    },
    onLeave: (id) => {
      const rig = remotePlayers.rigFor(id);
      if (rig) emojiField.clearFollowing(rig);
      remotePlayers.onLeave(id);
    },
    onStatus: (status) => getState().setNet(status),
    onPresence: (count) => getState().setPlayersOnline(count),
  };
}

function identity(): PlayerIdentity {
  const cosmetics = getState().cosmetics;
  return {
    name: cosmetics.name || 'Courier',
    outfit: cosmetics.outfit,
    hat: cosmetics.hat,
    skin: cosmetics.skin,
  };
}

async function connectNetwork(): Promise<void> {
  const handlers = transportHandlers();
  const mode = (import.meta.env.VITE_NET_TRANSPORT as string | undefined) ?? 'supabase';
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  if (mode === 'socket') {
    const socketUrl = (import.meta.env.VITE_SOCKET_URL as string | undefined) ?? 'http://localhost:8787';
    transport = new SocketTransport(socketUrl, handlers);
  } else if (mode === 'supabase' && url && key) {
    transport = new SupabaseTransport(url, key, handlers);
  } else {
    transport = new OfflineTransport(handlers);
  }

  try {
    await transport.connect(identity());
  } catch (error) {
    console.warn('[net] connect failed:', error);
    getState().setNet('error');
  }
}

function sendEmoji(slot: number): void {
  if (!courier) return;
  courier.headAnchor(_tmpPosition);
  _tmpUp.copy(controller.up);
  emojiField.spawn(slot, _tmpPosition, _tmpUp, courier.root);
  audio.emoji();
  transport?.sendEmoji(slot);
}

async function submitScore(): Promise<void> {
  const state = getState();
  await backend.submit(myId, state.cosmetics, state.score, state.deliveries, state.bestStreak);
}

// -------------------------------------------------------------------- settings

function applyQuality(quality: Quality): void {
  engine.setQuality(quality);
  scatter.setQuality(quality);
  dayCycle.setQuality(quality);
  setOutlinesVisible(settlements.group, quality === 'high');
  setOutlinesVisible(villagers.group, quality === 'high');
  if (courier) setOutlinesVisible(courier.root, quality === 'high');
  setOutlinesVisible(remotePlayers.group, quality === 'high');
}

watch(
  (s) => s.settings,
  (settings, previous) => {
    if (settings.quality !== previous.quality) applyQuality(settings.quality);
    audio.setVolume(settings.volume);
    audio.setMuted(settings.muted);
  },
);

watch(
  (s) => s.cosmetics,
  (cosmetics: Cosmetics, previous) => {
    if (courier) courier.setCosmetics(cosmetics);
    const changed =
      cosmetics.name !== previous.name ||
      cosmetics.outfit !== previous.outfit ||
      cosmetics.hat !== previous.hat ||
      cosmetics.skin !== previous.skin;
    if (!changed) return;
    transport?.sendIdentity(identity());

    // Clicking along a row of swatches should cost one write, not one per click.
    if (cosmeticsSaveTimer) window.clearTimeout(cosmeticsSaveTimer);
    cosmeticsSaveTimer = window.setTimeout(() => {
      cosmeticsSaveTimer = 0;
      void backend.saveCosmetics(myId, getState().cosmetics);
    }, 900);
  },
);

// ---------------------------------------------------------------- input wiring

input.on('pause', () => {
  const state = getState();
  if (state.panel !== 'none') resume();
  else if (state.phase === 'playing') pause();
  else if (state.phase === 'paused') resume();
});
input.on('customize', () => {
  openPanel(getState().panel === 'customize' ? 'none' : 'customize');
});
input.on('help', () => {
  openPanel(getState().panel === 'help' ? 'none' : 'help');
});
input.on('mute', () => {
  getState().setSettings({ muted: !getState().settings.muted });
});
input.on('toggleQuality', () => {
  const next: Quality = getState().settings.quality === 'high' ? 'low' : 'high';
  getState().setSettings({ quality: next });
  getState().pushToast(`Graphics: ${next}`);
});
input.on('jump', () => {
  if (!controller.airborne) audio.jump();
});

// ------------------------------------------------------------------ frame loop

function frame(dt: number, elapsed: number): void {
  const state = getState();
  const playing = state.phase === 'playing';

  input.beginFrame();

  // ---- character and camera
  if (playing) {
    followCamera.movementForward(controller.up, _tmpForward);
    controller.update(dt, input, _tmpForward);
    if (controller.justLanded) audio.land();
  }

  courier.root.position.copy(controller.position);
  courier.root.quaternion.copy(controller.quaternion);
  courier.setPose(dt, {
    speed: playing ? controller.speed : 0,
    airborne: controller.airborne,
    verticalVelocity: controller.verticalVelocity,
  });

  controller.eyePoint(_tmpPosition);
  // When a wall forces the camera in close, hide the courier rather than fill
  // the screen with the back of their head.
  courier.root.visible = followCamera.camera.position.distanceTo(controller.position) > 2.4;
  followCamera.update(
    dt,
    _tmpPosition,
    controller.up,
    input,
    state.settings.invertY,
    input.touchActive,
  );

  // ---- world
  planet.update(elapsed);
  sky.follow(followCamera.camera.position);
  sky.update(dt, controller.up);
  dayCycle.update(dt, engine.scene, sky, controller.position, controller.up);
  settlements.setNight(dayCycle.nightAmount);
  settlements.update(dt);
  villagers.update(dt);
  scatter.update(dt, followCamera.camera.position);
  confetti.update(dt);
  emojiField.update(dt);
  remotePlayers.update(dt, followCamera.camera.position);

  // ---- gameplay
  followCamera.movementForward(controller.up, _tmpForward);
  delivery.update(dt, controller.dir, followCamera.camera, _tmpForward, controller.up);

  if (playing) {
    if (input.interact) handleInteract();
    if (input.emoji >= 0) sendEmoji(input.emoji);
  }

  // ---- networking: fixed-rate outgoing state
  if (transport && playing) {
    netAccumulator += dt;
    const interval = 1 / transport.tickRate;
    if (netAccumulator >= interval) {
      netAccumulator = netAccumulator % interval;
      transport.sendState({
        d: [controller.dir.x, controller.dir.y, controller.dir.z],
        f: [controller.facing.x, controller.facing.y, controller.facing.z],
        h: Number(controller.heightAboveGround.toFixed(3)),
        s: Number(controller.speed.toFixed(2)),
        c: delivery.isCarrying ? 1 : 0,
      });
    }
  }

  audio.update(dt);
  engine.renderer.render(engine.scene, followCamera.camera);
  input.endFrame();
}

/** Context action: deliver if we can, otherwise chat to whoever is closest. */
function handleInteract(): void {
  if (delivery.interact(controller.dir, controller.position, controller.up)) return;

  const nearby = villagers.nearest(controller.dir, CONFIG.gameplay.interactRadius + 0.4);
  if (nearby >= 0) {
    getState().pushToast(`${villagers.name(nearby)}: "${villagers.line(nearby)}"`);
    courier.playGesture('wave');
    audio.ui();
  }
}

// ------------------------------------------------------------------- shutdown

window.addEventListener('pagehide', () => {
  transport?.disconnect();
  const state = getState();
  if (state.deliveries > 0) {
    void backend.submit(myId, state.cosmetics, state.score, state.deliveries, state.bestStreak, {
      force: true,
    });
  }
});

// Keep the store's toast channel usable from the console during development.
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    tpc: {
      store,
      planet,
      controller,
      engine,
      settlements,
      scatter,
      followCamera,
      villagers,
      // Accessors: these are assigned during world generation, after this runs.
      get courier() {
        return courier;
      },
      get delivery() {
        return delivery;
      },
    },
  });
}

void buildWorld().catch((error) => {
  console.error('[boot] world generation failed', error);
  getState().setLoading(1, 'Something went wrong. Please reload.');
});
