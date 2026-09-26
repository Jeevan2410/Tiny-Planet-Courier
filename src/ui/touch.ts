/**
 * Touch controls: a left-thumb virtual stick, a right-thumb look pad and a
 * cluster of action buttons.
 *
 * The look pad is a region rather than a widget, because on a phone the natural
 * gesture for "turn the camera" is dragging anywhere on the right of the screen.
 * Only `pointerType === 'touch'` events are handled, so a mouse on a
 * touch-capable laptop still gets proper mouse-look.
 */
import type { Input } from '../player/Input';

const STICK_RADIUS = 52;

export class TouchControls {
  private readonly root = document.getElementById('touch') as HTMLElement | null;
  private readonly stickZone = document.getElementById('stick-zone') as HTMLElement | null;
  private readonly stickBase = document.getElementById('stick-base') as HTMLElement | null;
  private readonly stickKnob = document.getElementById('stick-knob') as HTMLElement | null;
  private readonly lookZone = document.getElementById('look-zone') as HTMLElement | null;

  private stickPointer: number | null = null;
  private lookPointer: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private enabled = false;

  constructor(
    private readonly input: Input,
    private readonly onToggleEmoji: () => void,
  ) {}

  /** True when this device should use touch controls. */
  static isTouchDevice(): boolean {
    const forced = new URLSearchParams(location.search).get('touch');
    if (forced === '1') return true;
    if (forced === '0') return false;
    return (
      'ontouchstart' in window ||
      (navigator.maxTouchPoints ?? 0) > 0 ||
      window.matchMedia('(pointer: coarse)').matches
    );
  }

  enable(): void {
    if (this.enabled || !this.root) return;
    this.enabled = true;
    this.root.classList.remove('hidden');
    this.input.touchActive = true;

    this.wireStick();
    this.wireLook();
    this.wireButtons();
  }

  private wireStick(): void {
    const zone = this.stickZone;
    const base = this.stickBase;
    const knob = this.stickKnob;
    if (!zone || !base || !knob) return;

    const centre = () => {
      const rect = base.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };

    const move = (event: PointerEvent) => {
      const origin = centre();
      let dx = event.clientX - origin.x;
      let dy = event.clientY - origin.y;
      const length = Math.hypot(dx, dy);
      if (length > STICK_RADIUS) {
        dx = (dx / length) * STICK_RADIUS;
        dy = (dy / length) * STICK_RADIUS;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      // Screen y grows downward; forward is negative y.
      this.input.setTouchMove(dx / STICK_RADIUS, -dy / STICK_RADIUS);
    };

    zone.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || this.stickPointer !== null) return;
      this.stickPointer = event.pointerId;
      zone.setPointerCapture(event.pointerId);
      base.classList.add('active');
      move(event);
    });

    zone.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.stickPointer) return;
      event.preventDefault();
      move(event);
    });

    const release = (event: PointerEvent) => {
      if (event.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      base.classList.remove('active');
      knob.style.transform = '';
      this.input.setTouchMove(0, 0);
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
  }

  private wireLook(): void {
    const zone = this.lookZone;
    if (!zone) return;

    zone.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' || this.lookPointer !== null) return;
      this.lookPointer = event.pointerId;
      zone.setPointerCapture(event.pointerId);
      this.lookLast = { x: event.clientX, y: event.clientY };
    });

    zone.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.lookPointer) return;
      event.preventDefault();
      this.input.addTouchLook(event.clientX - this.lookLast.x, event.clientY - this.lookLast.y);
      this.lookLast = { x: event.clientX, y: event.clientY };
    });

    const release = (event: PointerEvent) => {
      if (event.pointerId !== this.lookPointer) return;
      this.lookPointer = null;
    };
    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
  }

  private wireButtons(): void {
    const tap = (id: string, action: () => void) => {
      const button = document.getElementById(id);
      if (!button) return;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        action();
      });
    };

    tap('touch-jump', () => this.input.pressJump());
    tap('touch-interact', () => this.input.pressInteract());
    tap('touch-emoji', () => this.onToggleEmoji());

    // Run is a hold, not a tap.
    const run = document.getElementById('touch-run');
    if (run) {
      const press = (event: Event) => {
        event.preventDefault();
        this.input.setRun(true);
        run.classList.add('held');
      };
      const release = () => {
        this.input.setRun(false);
        run.classList.remove('held');
      };
      run.addEventListener('pointerdown', press);
      run.addEventListener('pointerup', release);
      run.addEventListener('pointercancel', release);
      run.addEventListener('pointerleave', release);
    }
  }
}
