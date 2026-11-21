import { SIREN_AUDIO_PATH } from './types';

export class HorrorAudioEngine {
  private ctx: AudioContext | null = null;
  private sirenEl: HTMLAudioElement | null = null;
  private sirenGain: GainNode | null = null;
  private sirenPan: StereoPannerNode | null = null;
  private sirenFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private initialized = false;
  private currentSirenVol = 0;
  private sirenShouldPlay = false;
  private spatialAccum = 0;

  init(): void {
    if (this.initialized) {
      this.resume();
      return;
    }
    this.initialized = true;

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AudioCtx();

    // Pre-generate 2 seconds of pink-ish noise for rain, gunshots, and crashes
    const sampleRate = this.ctx.sampleRate;
    const len = sampleRate * 2;
    this.noiseBuffer = this.ctx.createBuffer(1, len, sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    }

    // Continuous Rain Ambience
    const rainSource = this.ctx.createBufferSource();
    rainSource.buffer = this.noiseBuffer;
    rainSource.loop = true;

    const rainFilter = this.ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 1150;
    rainFilter.Q.value = 0.6;

    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.value = 0.17;

    rainSource.connect(rainFilter);
    rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.ctx.destination);
    rainSource.start();

    // Infinite-looping Siren Head MP3 routed through GainNode + 3D StereoPanner + Distance Filter
    const audio = new Audio(SIREN_AUDIO_PATH);
    audio.loop = true;
    audio.preload = 'auto';
    audio.crossOrigin = 'anonymous';
    audio.addEventListener('ended', () => {
      if (this.sirenShouldPlay) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
    });
    this.sirenEl = audio;

    try {
      const source = this.ctx.createMediaElementSource(audio);
      this.sirenFilter = this.ctx.createBiquadFilter();
      this.sirenFilter.type = 'lowpass';
      this.sirenFilter.frequency.value = 2600;

      this.sirenPan = this.ctx.createStereoPanner();
      this.sirenPan.pan.value = 0;

      this.sirenGain = this.ctx.createGain();
      this.sirenGain.gain.value = 0;

      source.connect(this.sirenFilter);
      this.sirenFilter.connect(this.sirenPan);
      this.sirenPan.connect(this.sirenGain);
      this.sirenGain.connect(this.ctx.destination);
    } catch {
      audio.volume = 0;
    }
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  startSirenLoop(): void {
    this.init();
    this.sirenShouldPlay = true;
    if (this.sirenEl && this.sirenEl.paused) {
      this.sirenEl.play().catch(() => {});
    }
    if (this.rainGain && this.ctx) {
      this.rainGain.gain.setTargetAtTime(this.muted ? 0 : 0.17, this.ctx.currentTime, 0.2);
    }
  }

  stopSirenLoop(): void {
    this.sirenShouldPlay = false;
    if (this.sirenGain && this.ctx) {
      this.sirenGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    }
    if (this.sirenEl) {
      this.sirenEl.pause();
      this.sirenEl.currentTime = 0;
    }
    this.currentSirenVol = 0;
  }

  setPaused(paused: boolean): void {
    if (!this.ctx) return;
    if (paused) {
      if (this.sirenEl && !this.sirenEl.paused) {
        this.sirenEl.pause();
      }
      if (this.rainGain) {
        this.rainGain.gain.setTargetAtTime(0.03, this.ctx.currentTime, 0.1);
      }
    } else {
      this.resume();
      if (this.sirenShouldPlay && this.sirenEl && this.sirenEl.paused) {
        this.sirenEl.play().catch(() => {});
      }
      if (this.rainGain) {
        this.rainGain.gain.setTargetAtTime(this.muted ? 0 : 0.17, this.ctx.currentTime, 0.15);
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.rainGain) {
      this.rainGain.gain.setTargetAtTime(muted ? 0 : 0.17, this.ctx.currentTime, 0.08);
    }
    if (this.sirenEl && !this.sirenGain) {
      this.sirenEl.muted = muted;
    }
    if (this.ctx && this.sirenGain && muted) {
      this.sirenGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /**
   * Scales siren volume smoothly by 3D meter distance (up to 155m) and pans based on camera right dot product.
   */
  updateSirenSpatial(distanceMeters: number, pan3d: number, isSirenDead: boolean, dt: number): void {
    if (!this.sirenEl) return;

    if (this.sirenShouldPlay && !isSirenDead && this.sirenEl.paused) {
      this.sirenEl.play().catch(() => {});
    }

    const maxHearMeters = 155;
    let targetVol = 0;
    if (!isSirenDead && !this.muted && distanceMeters < maxHearMeters) {
      const norm = 1 - distanceMeters / maxHearMeters;
      targetVol = Math.min(1, Math.pow(norm, 1.8) * 0.96 + 0.015);
    }

    const lerpRate = Math.min(1, dt * 4.5);
    this.currentSirenVol += (targetVol - this.currentSirenVol) * lerpRate;

    this.spatialAccum += dt;
    if (this.spatialAccum < 0.05) return;
    this.spatialAccum = 0;

    if (this.ctx && this.sirenGain && this.sirenPan && this.sirenFilter) {
      const now = this.ctx.currentTime;
      this.sirenGain.gain.setTargetAtTime(this.muted ? 0 : this.currentSirenVol, now, 0.06);
      this.sirenPan.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, pan3d)), now, 0.08);

      const closeness = Math.max(0, Math.min(1, 1 - distanceMeters / 135));
      const cutoff = 480 + closeness * 5200;
      this.sirenFilter.frequency.setTargetAtTime(cutoff, now, 0.1);
    } else {
      this.sirenEl.volume = this.muted ? 0 : Math.max(0, Math.min(1, this.currentSirenVol));
    }
  }

  playFlashlightClick(on: boolean): void {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(on ? 1400 : 980, now);
    osc.frequency.exponentialRampToValueAtTime(on ? 2100 : 620, now + 0.035);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.045);
  }

  playAK47Shot(): void {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const oscGain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(165, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.11);
    oscGain.gain.setValueAtTime(0.36, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(oscGain);
    oscGain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.13);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1900, now);
    filter.frequency.exponentialRampToValueAtTime(450, now + 0.14);
    filter.Q.value = 0.7;

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.55, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    noise.connect(filter);
    filter.connect(nGain);
    nGain.connect(this.ctx.destination);
    noise.start(now, Math.random() * 0.5, 0.18);
  }

  playDryFire(): void {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(750, now);
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.025);
    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.035);
  }

  playReload(): void {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    [0, 0.55].forEach((offset, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(idx === 0 ? 480 : 720, now + offset);
      osc.frequency.exponentialRampToValueAtTime(idx === 0 ? 290 : 960, now + offset + 0.07);
      gain.gain.setValueAtTime(0.16, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.08);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.09);
    });
  }

  playTreeSmash(distanceMeters: number): void {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const atten = Math.max(0.04, Math.min(1, 1 - distanceMeters / 95));
    const now = this.ctx.currentTime;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(680, now);
    filter.frequency.exponentialRampToValueAtTime(140, now + 0.28);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.48 * atten, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    noise.start(now, Math.random() * 0.6, 0.32);
  }

  playFootstep(distanceMeters: number): void {
    if (this.muted || !this.ctx) return;
    const atten = Math.max(0, Math.min(1, 1 - distanceMeters / 80));
    if (atten <= 0.02) return;
    const now = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(76, now);
    osc.frequency.exponentialRampToValueAtTime(26, now + 0.17);
    gain.gain.setValueAtTime(0.36 * atten, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  playTowerStrike(collapsed: boolean): void {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const dur = collapsed ? 1.25 : 0.45;

    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(collapsed ? 140 : 190, now);
    osc.frequency.exponentialRampToValueAtTime(collapsed ? 32 : 95, now + dur);
    og.gain.setValueAtTime(collapsed ? 0.38 : 0.22, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(og);
    og.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + dur + 0.05);

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = collapsed ? 1200 : 700;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(collapsed ? 0.62 : 0.3, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(filter);
    filter.connect(ng);
    ng.connect(this.ctx.destination);
    noise.start(now, 0, dur);
  }

  playThunder(): void {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(240, now);
    filter.frequency.exponentialRampToValueAtTime(60, now + 1.9);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.32, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 2.0);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    noise.start(now, 0, 2.05);
  }

  playLoot(): void {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25].forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);
      gain.gain.setValueAtTime(0.15, now + idx * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.14);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + 0.15);
    });
  }

  playHurt(): void {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(130, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.24);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.27);
  }

  playSirenDeath(): void {
    if (this.muted || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, now);
    osc.frequency.exponentialRampToValueAtTime(22, now + 1.6);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.65);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 1.7);
  }

  playDevourScreech(): void {
    if (this.muted || !this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    // Distorted low roar + high siren screech
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(580, now + 0.35);
    osc.frequency.exponentialRampToValueAtTime(65, now + 1.1);
    gain.gain.setValueAtTime(0.42, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.15);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 1.2);

    // Visceral crunch burst
    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.5, now + 0.15);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
    noise.connect(filter);
    filter.connect(ng);
    ng.connect(this.ctx.destination);
    noise.start(now + 0.15, 0, 0.75);
  }
}
