/**
 * Renderer, scene and the frame loop.
 *
 * Quality is a real switch, not a label: it changes pixel ratio, antialiasing,
 * shadow resolution and outline visibility, which between them account for most
 * of the GPU cost in a scene this simple. The loop also clamps delta time --
 * without that, one long stall (a tab restore, a GC pause) would teleport the
 * character through the world when the next frame finally lands.
 */
import {
  Color,
  NoToneMapping,
  PCFSoftShadowMap,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { CONFIG, type Quality } from '../config';

export interface FrameInfo {
  dt: number;
  elapsed: number;
  frame: number;
}

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();

  /** Called once per frame with a clamped delta. */
  onFrame: ((info: FrameInfo) => void) | null = null;
  /** Reported once a second. */
  onFps: ((fps: number) => void) | null = null;

  private quality: Quality = 'high';
  private running = false;
  private rafHandle = 0;
  private lastTime = 0;
  private elapsed = 0;
  private frame = 0;
  private fpsFrames = 0;
  private fpsElapsed = 0;
  private disposers: (() => void)[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // The scene is opaque behind the sky dome; no need to composite with the page.
      alpha: false,
      stencil: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Toon shading is authored in final colours; tone mapping would desaturate
    // the whole palette and fight the flat look.
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.setClearColor(new Color(0x9ed3ea));

    this.scene.name = 'world';
    this.applyQuality();
  }

  attach(onResize: (width: number, height: number) => void): void {
    const handle = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      this.renderer.setSize(width, height, false);
      onResize(width, height);
    };
    handle();
    window.addEventListener('resize', handle);
    this.disposers.push(() => window.removeEventListener('resize', handle));

    // Stop burning battery and GPU while the tab is hidden.
    const visibility = () => {
      if (document.hidden) this.stop();
      else if (!this.running) this.start();
    };
    document.addEventListener('visibilitychange', visibility);
    this.disposers.push(() => document.removeEventListener('visibilitychange', visibility));
  }

  setQuality(quality: Quality): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.applyQuality();
  }

  getQuality(): Quality {
    return this.quality;
  }

  private applyQuality(): void {
    const cap =
      this.quality === 'high' ? CONFIG.render.maxPixelRatioHigh : CONFIG.render.maxPixelRatioLow;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.needsUpdate = true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.rafHandle = requestAnimationFrame(tick);

      // Clamp to 100ms: a longer gap is a stall, not slow motion, and should be
      // dropped rather than simulated.
      const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.elapsed += dt;
      this.frame++;

      this.onFrame?.({ dt, elapsed: this.elapsed, frame: this.frame });

      this.fpsFrames++;
      this.fpsElapsed += dt;
      if (this.fpsElapsed >= 1) {
        this.onFps?.(Math.round(this.fpsFrames / this.fpsElapsed));
        this.fpsFrames = 0;
        this.fpsElapsed = 0;
      }
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /** Draw-call and triangle counts, for the stats readout. */
  stats(): { calls: number; triangles: number } {
    const info = this.renderer.info.render;
    return { calls: info.calls, triangles: info.triangles };
  }

  dispose(): void {
    this.stop();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.renderer.dispose();
  }
}
