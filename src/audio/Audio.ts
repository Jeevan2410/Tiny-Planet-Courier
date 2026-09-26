/**
 * Audio, synthesised at runtime with the Web Audio API.
 *
 * There are no sound files in this project. Everything -- the ambient bed, the
 * footsteps, the delivery chime -- is generated from oscillators and a single
 * procedurally-filled noise buffer. That keeps the download at zero bytes of
 * audio (this is a browser toy; load time is the whole game) and means the music
 * never loops audibly, because the arpeggio is re-rolled from a pentatonic scale
 * every few seconds.
 *
 * The context is created on the first user gesture, as autoplay policy requires.
 */
import { clamp } from '../util/sphere';

/** A minor pentatonic scale in Hz, two octaves. Warm and hard to make sour. */
const SCALE = [
  196.0, 233.08, 261.63, 293.66, 349.23, 392.0, 466.16, 523.25, 587.33, 698.46, 784.0,
];

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private noiseBuffer!: AudioBuffer;
  private padVoices: { osc: OscillatorNode; gain: GainNode }[] = [];
  private padFilter!: BiquadFilterNode;

  private volume = 0.7;
  private muted = false;
  private started = false;

  /** Seconds until the next ambient note. */
  private nextNote = 1.2;
  private lastFootstep = 0;
  private melodyIndex = 2;

  get isStarted(): boolean {
    return this.started;
  }

  /** Must be called from a user-gesture handler. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.started) {
      await this.ctx?.resume();
      return;
    }

    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return; // No Web Audio: the game is still perfectly playable.

    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    // A soft limiter on the master bus so a burst of overlapping SFX cannot clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 18;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;
    limiter.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.34;
    this.musicBus.connect(limiter);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 0.75;
    this.sfxBus.connect(limiter);

    this.noiseBuffer = this.buildNoise(ctx);
    this.buildPad(ctx);

    this.started = true;
    await ctx.resume();
  }

  /** Two seconds of white noise, reused by every noise-based effect. */
  private buildNoise(ctx: AudioContext): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * The drone: three detuned saws an octave apart through a lowpass whose cutoff
   * drifts on a slow LFO. This is the whole "soundtrack" -- quiet, tonal, and
   * always consonant with the arpeggio because both draw from SCALE.
   */
  private buildPad(ctx: AudioContext): void {
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 520;
    this.padFilter.Q.value = 2.2;
    this.padFilter.connect(this.musicBus);

    // LFO on the cutoff.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.045;
    lfoGain.gain.value = 240;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();

    const roots = [98, 146.83, 196];
    const detune = [-6, 4, -3];
    for (let i = 0; i < roots.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.value = roots[i];
      osc.detune.value = detune[i];

      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.padFilter);
      osc.start();

      // Fade in over a few seconds so the music arrives rather than snapping on.
      gain.gain.setTargetAtTime(i === 0 ? 0.1 : 0.055, ctx.currentTime, 2.4);
      this.padVoices.push({ osc, gain });
    }
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.08);
    }
  }

  /** Duck the music while a panel is open, so UI reads as "paused". */
  setMusicDucked(ducked: boolean): void {
    if (!this.ctx) return;
    this.musicBus.gain.setTargetAtTime(ducked ? 0.12 : 0.34, this.ctx.currentTime, 0.2);
  }

  // ----------------------------------------------------------------- primitives

  private tone(
    frequency: number,
    duration: number,
    options: {
      type?: OscillatorType;
      gain?: number;
      delay?: number;
      sweepTo?: number;
      pan?: number;
      attack?: number;
    } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const start = ctx.currentTime + (options.delay ?? 0);
    const peak = options.gain ?? 0.2;
    const attack = options.attack ?? 0.008;

    const osc = ctx.createOscillator();
    osc.type = options.type ?? 'sine';
    osc.frequency.setValueAtTime(frequency, start);
    if (options.sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.sweepTo), start + duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    let node: AudioNode = gain;
    if (options.pan !== undefined && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(options.pan, -1, 1);
      gain.connect(panner);
      node = panner;
    }

    osc.connect(gain);
    node.connect(this.sfxBus);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private noise(
    duration: number,
    options: {
      frequency?: number;
      Q?: number;
      gain?: number;
      type?: BiquadFilterType;
      delay?: number;
      bus?: GainNode;
    } = {},
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const start = ctx.currentTime + (options.delay ?? 0);

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    // Random offset so repeated footsteps are not bit-identical.
    const offset = Math.random() * 1.5;

    const filter = ctx.createBiquadFilter();
    filter.type = options.type ?? 'bandpass';
    filter.frequency.value = options.frequency ?? 900;
    filter.Q.value = options.Q ?? 1.1;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(options.gain ?? 0.16, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    source.connect(filter).connect(gain).connect(options.bus ?? this.sfxBus);
    source.start(start, offset, duration + 0.05);
    source.stop(start + duration + 0.05);
  }

  // --------------------------------------------------------------------- events

  /** @param speed 0..1 of run speed; faster steps are brighter and louder. */
  footstep(speed: number, inWater = false): void {
    if (!this.ctx) return;
    // Guard against animation events firing twice in one frame.
    const now = this.ctx.currentTime;
    if (now - this.lastFootstep < 0.09) return;
    this.lastFootstep = now;

    if (inWater) {
      this.noise(0.22, { frequency: 420 + Math.random() * 180, Q: 0.7, gain: 0.1, type: 'lowpass' });
      this.noise(0.1, { frequency: 2400, Q: 0.9, gain: 0.045 });
      return;
    }

    const brightness = 380 + speed * 520 + Math.random() * 160;
    this.noise(0.085, { frequency: brightness, Q: 1.4, gain: 0.055 + speed * 0.05 });
    this.tone(70 + Math.random() * 18, 0.07, { type: 'sine', gain: 0.045 + speed * 0.03 });
  }

  land(): void {
    this.noise(0.16, { frequency: 260, Q: 0.8, gain: 0.13, type: 'lowpass' });
    this.tone(90, 0.16, { type: 'sine', gain: 0.1, sweepTo: 48 });
  }

  jump(): void {
    this.tone(320, 0.12, { type: 'triangle', gain: 0.075, sweepTo: 520 });
  }

  pickup(): void {
    this.tone(SCALE[4], 0.16, { type: 'triangle', gain: 0.15 });
    this.tone(SCALE[6], 0.22, { type: 'triangle', gain: 0.13, delay: 0.09 });
  }

  deliver(): void {
    // A rising figure, the reward sound.
    this.tone(SCALE[3], 0.18, { type: 'triangle', gain: 0.16 });
    this.tone(SCALE[5], 0.18, { type: 'triangle', gain: 0.15, delay: 0.085 });
    this.tone(SCALE[7], 0.3, { type: 'triangle', gain: 0.15, delay: 0.17 });
    this.tone(SCALE[9], 0.42, { type: 'sine', gain: 0.1, delay: 0.26 });
    this.noise(0.4, { frequency: 5200, Q: 0.6, gain: 0.03 });
  }

  expire(): void {
    this.tone(SCALE[5], 0.2, { type: 'triangle', gain: 0.12 });
    this.tone(SCALE[3], 0.26, { type: 'triangle', gain: 0.11, delay: 0.1 });
    this.tone(SCALE[1], 0.4, { type: 'sine', gain: 0.1, delay: 0.21 });
  }

  emoji(): void {
    this.tone(720 + Math.random() * 240, 0.1, { type: 'sine', gain: 0.09, sweepTo: 1300 });
  }

  /** A quieter blip for remote players' reactions. */
  remoteEmoji(): void {
    this.tone(560 + Math.random() * 200, 0.09, { type: 'sine', gain: 0.035, sweepTo: 900 });
  }

  ui(): void {
    this.tone(520, 0.06, { type: 'square', gain: 0.03 });
  }

  chime(): void {
    this.tone(SCALE[7], 0.5, { type: 'sine', gain: 0.1 });
    this.tone(SCALE[9], 0.6, { type: 'sine', gain: 0.07, delay: 0.06 });
  }

  /**
   * Advance the ambient arpeggio. Notes walk the scale in small steps, which
   * keeps the melody wandering rather than jumping around.
   */
  update(dt: number): void {
    if (!this.ctx || this.muted) return;
    this.nextNote -= dt;
    if (this.nextNote > 0) return;
    this.nextNote = 1.1 + Math.random() * 2.2;

    const step = Math.floor(Math.random() * 5) - 2;
    this.melodyIndex = clamp(this.melodyIndex + step, 0, SCALE.length - 1);
    const frequency = SCALE[this.melodyIndex];
    const pan = Math.random() * 1.4 - 0.7;

    const ctx = this.ctx;
    const start = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = frequency * 2;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.07, start + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 2.4);

    const panner = ctx.createStereoPanner?.();
    if (panner) {
      panner.pan.value = pan;
      osc.connect(gain).connect(panner).connect(this.musicBus);
    } else {
      osc.connect(gain).connect(this.musicBus);
    }
    osc.start(start);
    osc.stop(start + 2.5);

    // A soft fifth below, half the time, for a fuller bed.
    if (Math.random() < 0.5) {
      this.tone(frequency, 1.8, { type: 'sine', gain: 0.03, attack: 0.2, delay: 0.05 });
    }
  }

  dispose(): void {
    for (const voice of this.padVoices) {
      try {
        voice.osc.stop();
      } catch {
        /* already stopped */
      }
    }
    this.padVoices = [];
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}
