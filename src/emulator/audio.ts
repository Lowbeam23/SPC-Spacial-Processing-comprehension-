/**
 * Web Audio API synthesizer for the iconic PlayStation 1 boot sound
 * Deep atmospheric drone + sparkling chime
 */
class Ps1Audio {
  private ctx: AudioContext | null = null;
  private isPlaying = false;

  private initContext(): AudioContext | null {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public playBootSound(): void {
    const ctx = this.initContext();
    if (!ctx || this.isPlaying) return;

    this.isPlaying = true;
    const now = ctx.currentTime;

    // Master Gain
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.4, now);
    masterGain.connect(ctx.destination);

    // 1. Deep Sub Bass Drone (65 Hz -> 98 Hz -> 73 Hz)
    const subOsc = ctx.createOscillator();
    const subGain = ctx.createGain();
    subOsc.type = 'sawtooth';
    subOsc.frequency.setValueAtTime(55, now);
    subOsc.frequency.exponentialRampToValueAtTime(73.4, now + 2.5);
    subOsc.frequency.exponentialRampToValueAtTime(65.4, now + 5.0);

    const subFilter = ctx.createBiquadFilter();
    subFilter.type = 'lowpass';
    subFilter.frequency.setValueAtTime(140, now);
    subFilter.frequency.linearRampToValueAtTime(260, now + 3.0);
    subFilter.frequency.linearRampToValueAtTime(100, now + 7.0);

    subGain.gain.setValueAtTime(0.01, now);
    subGain.gain.linearRampToValueAtTime(0.45, now + 1.2);
    subGain.gain.exponentialRampToValueAtTime(0.001, now + 8.0);

    subOsc.connect(subFilter);
    subFilter.connect(subGain);
    subGain.connect(masterGain);

    subOsc.start(now);
    subOsc.stop(now + 8.0);

    // 2. Mid Warmth Choir / Organ Pad
    const padFrequencies = [110, 164.8, 220, 261.6]; // A minor / C major warmth
    padFrequencies.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = idx % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 1.5);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 7.0);

      osc.connect(gain);
      gain.connect(masterGain);

      osc.start(now);
      osc.stop(now + 7.0);
    });

    // 3. Shimmering Chime / Bells at ~2.8s (The iconic PS1 logo chime)
    const chimeTime = now + 2.4;
    const chimeNotes = [587.33, 880, 1174.66, 1318.5, 1760]; // D5, A5, D6, E6, A6

    chimeNotes.forEach((noteFreq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(noteFreq, chimeTime + index * 0.08);

      gain.gain.setValueAtTime(0.001, chimeTime + index * 0.08);
      gain.gain.linearRampToValueAtTime(0.12, chimeTime + index * 0.08 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, chimeTime + index * 0.08 + 4.5);

      osc.connect(gain);
      gain.connect(masterGain);

      osc.start(chimeTime + index * 0.08);
      osc.stop(chimeTime + index * 0.08 + 4.5);
    });

    setTimeout(() => {
      this.isPlaying = false;
    }, 8500);
  }
}

export const ps1Audio = new Ps1Audio();
