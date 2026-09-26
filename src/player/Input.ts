/**
 * Input aggregation for keyboard, mouse and touch.
 *
 * Everything funnels into one small struct that the controller and camera read
 * once per frame, so the rest of the game never needs to know whether a move
 * came from WASD or a thumb on glass. Edge-triggered actions (jump, interact,
 * emoji) are latched and cleared by `endFrame()`.
 */
import { Vector2 } from 'three';
import { clamp } from '../util/sphere';

export type ActionName =
  | 'jump'
  | 'interact'
  | 'pause'
  | 'customize'
  | 'help'
  | 'toggleQuality'
  | 'mute';

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

export class Input {
  /** Movement intent in camera space: x = strafe, y = forward. Length <= 1. */
  readonly move = new Vector2();
  /** Accumulated look delta in pixels, consumed each frame. */
  readonly look = new Vector2();
  /** Accumulated zoom intent, consumed each frame. */
  zoom = 0;

  run = false;
  /** True on the frame the action was triggered. */
  jump = false;
  interact = false;
  /** Emoji slot requested this frame, or -1. */
  emoji = -1;

  /** True while the pointer is locked or a drag-look is in progress. */
  looking = false;
  /** Set by the touch layer so the HUD can switch to touch affordances. */
  touchActive = false;

  private readonly keys = new Set<string>();
  private readonly listeners = new Map<ActionName, Set<() => void>>();
  private readonly touchMove = new Vector2();
  private touchRun = false;
  private dragging = false;
  private lastPointer = new Vector2();
  private enabled = true;
  private disposers: (() => void)[] = [];

  constructor(private readonly element: HTMLElement) {}

  attach(): void {
    // Union of the three event maps, so element, document and window events
    // can all go through one type-safe helper.
    type AnyEventMap = WindowEventMap & DocumentEventMap & HTMLElementEventMap;
    const on = <K extends keyof AnyEventMap>(
      target: EventTarget,
      type: K,
      handler: (event: AnyEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler as EventListener, options);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener, options));
    };

    on(window, 'keydown', (event) => this.onKeyDown(event));
    on(window, 'keyup', (event) => this.onKeyUp(event));
    on(window, 'blur', () => this.releaseAll());

    // Mouse look. Pointer lock is the good experience; a plain drag is the
    // fallback for browsers or users that refuse the lock.
    on(this.element, 'pointerdown', (event) => this.onPointerDown(event));
    on(window, 'pointerup', (event) => this.onPointerUp(event));
    on(window, 'pointermove', (event) => this.onPointerMove(event));
    on(this.element, 'wheel', (event) => this.onWheel(event), { passive: false });
    on(document, 'pointerlockchange', () => {
      this.looking = document.pointerLockElement === this.element;
    });
    on(this.element, 'contextmenu', (event) => event.preventDefault());
  }

  detach(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  /** Disable gameplay input (used while a panel or the title screen is open). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  on(action: ActionName, handler: () => void): () => void {
    let set = this.listeners.get(action);
    if (!set) this.listeners.set(action, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  private emit(action: ActionName): void {
    const set = this.listeners.get(action);
    if (!set) return;
    for (const handler of set) handler();
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Never swallow keys aimed at a text field (the name input in Customise).
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    if (event.repeat) return;
    this.keys.add(event.code);

    switch (event.code) {
      case 'Escape':
        this.emit('pause');
        break;
      case 'Tab':
        event.preventDefault();
        this.emit('customize');
        break;
      case 'KeyH':
      case 'Slash':
        this.emit('help');
        break;
      case 'KeyM':
        this.emit('mute');
        break;
      case 'KeyG':
        this.emit('toggleQuality');
        break;
      default:
        break;
    }

    if (!this.enabled) return;

    if (event.code === 'Space') {
      event.preventDefault();
      this.jump = true;
      this.emit('jump');
    }
    if (event.code === 'KeyE' || event.code === 'Enter') {
      this.interact = true;
      this.emit('interact');
    }
    // Emoji on the number row.
    if (event.code.startsWith('Digit')) {
      const slot = Number(event.code.slice(5)) - 1;
      if (slot >= 0 && slot < 6) this.emoji = slot;
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.keys.delete(event.code);
  }

  private releaseAll(): void {
    this.keys.clear();
    this.move.set(0, 0);
    this.touchMove.set(0, 0);
    this.dragging = false;
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'touch') return; // handled by the touch layer
    if (event.button !== 0 && event.button !== 2) return;
    if (!this.enabled) return;

    this.dragging = true;
    this.lastPointer.set(event.clientX, event.clientY);

    // Ask for pointer lock on a left click; if the browser declines we still
    // have drag-look, so this never becomes a hard requirement.
    if (event.button === 0 && document.pointerLockElement !== this.element) {
      void this.element.requestPointerLock?.();
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    this.dragging = false;
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    if (!this.enabled) return;

    if (document.pointerLockElement === this.element) {
      this.look.x += event.movementX;
      this.look.y += event.movementY;
      return;
    }
    if (!this.dragging) return;
    this.look.x += event.clientX - this.lastPointer.x;
    this.look.y += event.clientY - this.lastPointer.y;
    this.lastPointer.set(event.clientX, event.clientY);
  }

  private onWheel(event: WheelEvent): void {
    if (!this.enabled) return;
    event.preventDefault();
    this.zoom += Math.sign(event.deltaY) * 0.6;
  }

  // ------------------------------------------------------------- touch bridge

  /** Called by the on-screen joystick. Components in -1..1. */
  setTouchMove(x: number, y: number): void {
    this.touchActive = true;
    this.touchMove.set(x, y);
  }

  /** Called by the touch look pad, in pixels. */
  addTouchLook(dx: number, dy: number): void {
    this.touchActive = true;
    this.look.x += dx;
    this.look.y += dy;
  }

  /** Held state of the on-screen run button. */
  setRun(run: boolean): void {
    this.touchRun = run;
  }

  pressJump(): void {
    if (!this.enabled) return;
    this.jump = true;
    this.emit('jump');
  }

  pressInteract(): void {
    if (!this.enabled) return;
    this.interact = true;
    this.emit('interact');
  }

  pressEmoji(slot: number): void {
    this.emoji = slot;
  }

  // ------------------------------------------------------------------- per-frame

  /** Fold key state into `move`. Call once at the top of each frame. */
  beginFrame(): void {
    if (!this.enabled) {
      this.move.set(0, 0);
      return;
    }

    let x = 0;
    let y = 0;
    for (const code of this.keys) {
      const axis = MOVE_KEYS[code];
      if (axis) {
        x += axis[0];
        y += axis[1];
      }
    }

    // Touch stick wins when it is being held, so a stray key cannot fight it.
    if (this.touchMove.lengthSq() > 0.0004) {
      x = this.touchMove.x;
      y = this.touchMove.y;
    }

    this.move.set(clamp(x, -1, 1), clamp(y, -1, 1));
    if (this.move.lengthSq() > 1) this.move.normalize();

    this.run = this.touchRun || this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Clear per-frame latches. Call at the very end of the frame. */
  endFrame(): void {
    this.look.set(0, 0);
    this.zoom = 0;
    this.jump = false;
    this.interact = false;
    this.emoji = -1;
  }
}
