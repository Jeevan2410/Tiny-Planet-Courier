/**
 * DOM layer.
 *
 * The HUD is plain DOM driven by store subscriptions rather than anything drawn
 * into the canvas: text stays crisp at any pixel ratio, it is selectable and
 * screen-readable, and it costs the WebGL context nothing. Subscriptions are
 * per-slice (see `watch`) so a 60Hz distance readout does not re-render the
 * whole interface.
 */
import { gsap } from 'gsap';
import { EMOJI } from '../fx/EmojiField';
import { PALETTE } from '../fx/toon';
import { HAT_NAMES } from '../player/Courier';
import { store, watch, type Cosmetics, type Phase, type Settings } from '../state/store';
import type { LeaderboardRow } from '../net/backend';
import type { Quality } from '../config';

export interface UiCallbacks {
  onPlay: (name: string) => void;
  onEmoji: (slot: number) => void;
  onPanel: (panel: 'none' | 'customize' | 'settings' | 'help') => void;
  onPause: () => void;
  onResume: () => void;
  onCosmetics: (patch: Partial<Cosmetics>) => void;
  onSettings: (patch: Partial<Settings>) => void;
}

function need<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element as T;
}

const TOAST_LIFETIME = 2900;

export class Ui {
  private readonly loading = need('loading');
  private readonly loadBar = need('load-bar');
  private readonly loadLabel = need('load-label');

  private readonly title = need('title');
  private readonly nameInput = need<HTMLInputElement>('name-input');
  private readonly playButton = need<HTMLButtonElement>('play');
  private readonly leaderboardList = need('leaderboard-list');

  private readonly hud = need('hud');
  private readonly objective = need('objective');
  private readonly objectiveKind = need('objective-kind');
  private readonly objectiveText = need('objective-text');
  private readonly objectiveZone = need('objective-zone');
  private readonly objectiveDistance = need('objective-distance');
  private readonly timer = need('timer');
  private readonly timerFill = need('timer-fill');
  private readonly scoreEl = need('score');
  private readonly deliveriesEl = need('deliveries');
  private readonly streakEl = need('streak');
  private readonly netDot = need('net-dot');
  private readonly netText = need('net-text');
  private readonly statsEl = need('stats');
  private readonly compass = need('compass');
  private readonly prompt = need('prompt');
  private readonly promptKey = need('prompt-key');
  private readonly promptText = need('prompt-text');
  private readonly toastHost = need('toast');
  private readonly emojiBar = need('emoji-bar');

  private readonly panels: Record<string, HTMLElement> = {
    pause: need('panel-pause'),
    customize: need('panel-customize'),
    settings: need('panel-settings'),
    help: need('panel-help'),
  };

  private readonly customizeName = need<HTMLInputElement>('customize-name');
  private readonly swatchOutfit = need('swatch-outfit');
  private readonly swatchSkin = need('swatch-skin');
  private readonly chipsHat = need('chips-hat');
  private readonly chipsQuality = need('chips-quality');
  private readonly volume = need<HTMLInputElement>('volume');
  private readonly volumeValue = need<HTMLOutputElement>('volume-value');
  private readonly mutedInput = need<HTMLInputElement>('muted');
  private readonly invertInput = need<HTMLInputElement>('invert-y');
  private readonly fpsInput = need<HTMLInputElement>('show-fps');

  private unsubscribes: (() => void)[] = [];
  private lastToastId = 0;

  constructor(private readonly callbacks: UiCallbacks) {
    this.buildEmojiBar();
    this.buildSwatches();
    this.wireButtons();
    this.wireSettings();
    this.subscribe();
  }

  // ------------------------------------------------------------------ building

  private buildEmojiBar(): void {
    this.emojiBar.replaceChildren();
    EMOJI.forEach((glyph, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = glyph;
      button.title = `React (${index + 1})`;
      button.setAttribute('aria-label', `React with ${glyph}`);
      button.addEventListener('click', () => this.callbacks.onEmoji(index));
      this.emojiBar.append(button);
    });
  }

  private buildSwatches(): void {
    const swatch = (host: HTMLElement, colors: readonly number[], key: 'outfit' | 'skin') => {
      host.replaceChildren();
      colors.forEach((hex, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.style.background = `#${hex.toString(16).padStart(6, '0')}`;
        button.dataset.index = String(index);
        button.setAttribute('aria-label', `${key} ${index + 1}`);
        button.addEventListener('click', () => this.callbacks.onCosmetics({ [key]: index }));
        host.append(button);
      });
    };
    swatch(this.swatchOutfit, PALETTE.outfit, 'outfit');
    swatch(this.swatchSkin, PALETTE.skin, 'skin');

    this.chipsHat.replaceChildren();
    HAT_NAMES.forEach((name, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.dataset.index = String(index);
      button.addEventListener('click', () => this.callbacks.onCosmetics({ hat: index }));
      this.chipsHat.append(button);
    });
  }

  private wireButtons(): void {
    this.playButton.addEventListener('click', () => {
      this.callbacks.onPlay(this.nameInput.value.trim());
    });
    this.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.playButton.click();
    });

    // Panel buttons are declarative: data-action on any button inside a panel.
    for (const panel of Object.values(this.panels)) {
      panel.addEventListener('click', (event) => {
        const target = (event.target as HTMLElement).closest('button[data-action]');
        if (!target) return;
        const action = target.getAttribute('data-action');
        switch (action) {
          case 'resume':
          case 'close':
            this.callbacks.onResume();
            break;
          case 'customize':
            this.callbacks.onPanel('customize');
            break;
          case 'settings':
            this.callbacks.onPanel('settings');
            break;
          case 'help':
            this.callbacks.onPanel('help');
            break;
          default:
            break;
        }
      });
    }

    need('hud-menu').addEventListener('click', () => this.callbacks.onPause());

    this.customizeName.addEventListener('input', () => {
      this.callbacks.onCosmetics({ name: this.customizeName.value.slice(0, 18) });
    });
  }

  private wireSettings(): void {
    this.chipsQuality.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('button[data-quality]');
      if (!target) return;
      this.callbacks.onSettings({ quality: target.getAttribute('data-quality') as Quality });
    });

    this.volume.addEventListener('input', () => {
      this.callbacks.onSettings({ volume: Number(this.volume.value) / 100 });
    });
    this.mutedInput.addEventListener('change', () => {
      this.callbacks.onSettings({ muted: this.mutedInput.checked });
    });
    this.invertInput.addEventListener('change', () => {
      this.callbacks.onSettings({ invertY: this.invertInput.checked });
    });
    this.fpsInput.addEventListener('change', () => {
      this.callbacks.onSettings({ showFps: this.fpsInput.checked });
    });
  }

  // ------------------------------------------------------------- subscriptions

  private subscribe(): void {
    const add = (unsubscribe: () => void) => this.unsubscribes.push(unsubscribe);

    add(
      watch(
        (s) => ({ progress: s.loadProgress, label: s.loadLabel }),
        ({ progress, label }) => {
          this.loadBar.style.width = `${Math.round(progress * 100)}%`;
          this.loadLabel.textContent = label;
        },
        (a, b) => a.progress === b.progress && a.label === b.label,
      ),
    );

    add(watch((s) => s.phase, (phase) => this.applyPhase(phase)));

    add(
      watch(
        (s) => s.objective,
        (objective) => {
          if (!objective) return;
          this.objectiveKind.textContent =
            objective.kind === 'pickup' ? 'Pick up' : 'Deliver';
          this.objectiveText.textContent = objective.text;
          this.objectiveZone.textContent = objective.zone;
          // A short pop draws the eye to a changed objective without a modal.
          gsap.fromTo(
            this.objective,
            { scale: 0.94, x: -8, opacity: 0.6 },
            { scale: 1, x: 0, opacity: 1, duration: 0.34, ease: 'back.out(2)' },
          );
        },
        (a, b) => a?.text === b?.text && a?.zone === b?.zone,
      ),
    );

    add(
      watch(
        (s) => s.score,
        (score, previous) => {
          this.scoreEl.textContent = score.toLocaleString();
          if (score <= previous) return;
          this.scoreEl.classList.add('bumped');
          gsap.delayedCall(0.18, () => this.scoreEl.classList.remove('bumped'));
        },
      ),
    );

    add(
      watch(
        (s) => ({ deliveries: s.deliveries, streak: s.streak }),
        ({ deliveries, streak }) => {
          this.deliveriesEl.textContent = `${deliveries} delivered`;
          this.streakEl.textContent = streak > 1 ? `${streak}x streak` : '';
        },
        (a, b) => a.deliveries === b.deliveries && a.streak === b.streak,
      ),
    );

    add(
      watch(
        (s) => ({ left: s.timeLeft, carrying: s.carrying }),
        ({ left, carrying }) => {
          const show = carrying && left > 0;
          this.timer.classList.toggle('hidden', !show);
          if (!show) return;
          // 95 is the full parcel window; see CONFIG.gameplay.parcelTimer.
          const fraction = Math.max(0, Math.min(1, left / 95));
          this.timerFill.style.width = `${fraction * 100}%`;
          this.timerFill.classList.toggle('low', fraction < 0.25);
        },
        (a, b) => Math.round(a.left * 4) === Math.round(b.left * 4) && a.carrying === b.carrying,
      ),
    );

    add(
      watch(
        (s) => ({ distance: s.targetDistance, bearing: s.targetBearing, off: s.targetOffscreen }),
        ({ distance, bearing, off }) => {
          this.objectiveDistance.textContent = `${Math.round(distance)}m`;
          this.compass.classList.toggle('hidden', !off);
          if (off) {
            this.compass.style.transform = `rotate(${(bearing * 180) / Math.PI}deg)`;
          }
        },
        // Update at most every metre / few degrees: this fires every frame.
        (a, b) =>
          Math.round(a.distance) === Math.round(b.distance) &&
          Math.round(a.bearing * 24) === Math.round(b.bearing * 24) &&
          a.off === b.off,
      ),
    );

    add(
      watch(
        (s) => s.prompt,
        (prompt) => {
          this.prompt.classList.toggle('hidden', !prompt);
          if (!prompt) return;
          this.promptKey.textContent = prompt.key;
          this.promptText.textContent = prompt.text;
        },
        (a, b) => a?.text === b?.text && a?.key === b?.key,
      ),
    );

    add(
      watch(
        (s) => ({ status: s.netStatus, players: s.playersOnline }),
        ({ status, players }) => {
          this.netDot.className = `dot ${status}`;
          this.netText.textContent =
            status === 'online'
              ? `${players} online`
              : status === 'connecting'
                ? 'connecting'
                : status === 'error'
                  ? 'offline'
                  : 'solo';
        },
        (a, b) => a.status === b.status && a.players === b.players,
      ),
    );

    add(
      watch(
        (s) => s.toast,
        (toast) => {
          if (!toast || toast.id === this.lastToastId) return;
          this.lastToastId = toast.id;
          this.showToast(toast.text, toast.tone);
        },
        (a, b) => a?.id === b?.id,
      ),
    );

    // Panel visibility depends on BOTH the open panel and the phase, so it has
    // to watch them together: closing a sub-panel sets panel='none' while the
    // phase is still 'paused', and a watcher keyed on panel alone would then
    // leave the pause menu on screen after play resumed.
    add(
      watch(
        (s) => ({ panel: s.panel, phase: s.phase }),
        ({ panel, phase }) => this.applyPanel(panel, phase),
        (a, b) => a.panel === b.panel && a.phase === b.phase,
      ),
    );
    add(watch((s) => s.settings, (settings) => this.applySettings(settings)));
    add(watch((s) => s.cosmetics, (cosmetics) => this.applyCosmetics(cosmetics)));
  }

  // -------------------------------------------------------------------- render

  private applyPhase(phase: Phase): void {
    const fadeOut = (element: HTMLElement) => {
      if (element.classList.contains('hidden')) return;
      gsap.to(element, { opacity: 0, duration: 0.32, ease: 'power2.out' });
      // The class is committed on a plain timer rather than the tween's
      // onComplete: GSAP runs on requestAnimationFrame, which a background tab
      // throttles to a standstill -- so a player who clicked Play and switched
      // away would come back to a half-faded menu stuck over the game.
      window.setTimeout(() => {
        gsap.killTweensOf(element);
        element.classList.add('hidden');
        element.style.opacity = '';
      }, 340);
    };
    const fadeIn = (element: HTMLElement) => {
      if (!element.classList.contains('hidden')) return;
      element.classList.remove('hidden');
      gsap.fromTo(element, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'power2.out' });
    };

    switch (phase) {
      case 'loading':
        fadeIn(this.loading);
        break;
      case 'title':
        fadeOut(this.loading);
        fadeIn(this.title);
        this.hud.classList.add('hidden');
        break;
      case 'playing':
        fadeOut(this.loading);
        fadeOut(this.title);
        fadeIn(this.hud);
        break;
      case 'paused':
        fadeIn(this.hud);
        break;
      default:
        break;
    }
  }

  private applyPanel(panel: string, phase: Phase): void {
    const paused = phase === 'paused';
    for (const [name, element] of Object.entries(this.panels)) {
      // The pause menu is the backdrop for the other panels; showing a sub-panel
      // replaces it rather than stacking two dialogs.
      const visible = name === panel || (name === 'pause' && panel === 'none' && paused);
      element.classList.toggle('hidden', !visible);
    }
  }

  private applySettings(settings: Settings): void {
    for (const button of this.chipsQuality.querySelectorAll('button')) {
      button.setAttribute(
        'aria-pressed',
        String(button.getAttribute('data-quality') === settings.quality),
      );
    }
    this.volume.value = String(Math.round(settings.volume * 100));
    this.volumeValue.textContent = `${Math.round(settings.volume * 100)}%`;
    this.mutedInput.checked = settings.muted;
    this.invertInput.checked = settings.invertY;
    this.fpsInput.checked = settings.showFps;
    this.statsEl.classList.toggle('hidden', !settings.showFps);
  }

  private applyCosmetics(cosmetics: Cosmetics): void {
    const mark = (host: HTMLElement, selected: number) => {
      for (const button of host.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(Number(button.dataset.index) === selected));
      }
    };
    mark(this.swatchOutfit, cosmetics.outfit);
    mark(this.swatchSkin, cosmetics.skin);
    mark(this.chipsHat, cosmetics.hat);
    if (document.activeElement !== this.customizeName) this.customizeName.value = cosmetics.name;
    if (document.activeElement !== this.nameInput) this.nameInput.value = cosmetics.name;
  }

  private showToast(text: string, tone: 'info' | 'good'): void {
    const item = document.createElement('div');
    item.className = `toast-item ${tone}`;
    item.textContent = text;
    this.toastHost.append(item);

    // Keep at most three on screen; older ones leave early.
    while (this.toastHost.children.length > 3) this.toastHost.firstElementChild?.remove();

    window.setTimeout(() => {
      item.classList.add('leaving');
      window.setTimeout(() => item.remove(), 320);
    }, TOAST_LIFETIME);
  }

  // -------------------------------------------------------------------- public

  setLeaderboard(rows: LeaderboardRow[]): void {
    this.leaderboardList.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No rounds recorded yet. Be the first.';
      this.leaderboardList.append(empty);
      return;
    }
    for (const row of rows) {
      const item = document.createElement('li');
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = row.name || 'Courier';
      const points = document.createElement('span');
      points.className = 'pts';
      points.textContent = row.best_score.toLocaleString();
      item.append(who, points);
      this.leaderboardList.append(item);
    }
  }

  setStats(lines: string[]): void {
    this.statsEl.replaceChildren();
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      this.statsEl.append(div);
    }
  }

  /** Switch the HUD to its touch layout. */
  setTouchMode(touch: boolean): void {
    document.body.classList.toggle('touch-mode', touch);
    this.promptKey.textContent = touch ? 'E' : 'E';
  }

  focusNameInput(): void {
    if (store.getState().phase === 'title') this.nameInput.focus();
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
  }
}
