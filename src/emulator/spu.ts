/**
 * PlayStation 1 Sound Processing Unit (SPU) Subsystem
 * 
 * Implements the 24-voice SPU hardware with:
 * - 512 KB Sound RAM (0x80000 bytes)
 * - 24 independent voices with 16-byte register stride
 * - 16-byte ADPCM block decoder with 2-pole IIR filter
 * - 4-point Gaussian interpolation resampling
 * - 4-phase ADSR envelope engine (Attack, Decay, Sustain, Release)
 * - Full MMIO register space (0x1F801C00 - 0x1F801FFF)
 * - SPU DMA (Channel 4) block transfers
 * - High-performance Float32 stereo sample generation & Web Audio driver
 */

export const enum AdsrPhase {
  OFF = 0,
  ATTACK = 1,
  DECAY = 2,
  SUSTAIN = 3,
  RELEASE = 4,
}

// ADPCM filter tables
const SPU_POS_ADPCM_TABLE = [0, 60, 115, 98, 122];
const SPU_NEG_ADPCM_TABLE = [0, 0, -52, -55, -60];

/**
 * Pre-calculated 512-entry PS1 Gaussian Interpolation Table
 * Normalized so that g0 + g1 + g2 + g3 === 0x8000 (32768) for exact unity gain.
 */
function createGaussTable(): Int16Array {
  const table = new Int16Array(512);
  const sigma = 0.85;
  for (let i = 0; i < 512; i++) {
    const d = 2.0 * (511 - i) / 511.0;
    const val = Math.exp(-0.5 * Math.pow(d / sigma, 2.0));
    table[i] = Math.round(val * 17200);
  }
  for (let u = 0; u < 256; u++) {
    const idx0 = 0x0FF - u;
    const idx1 = 0x1FF - u;
    const idx2 = 0x100 + u;
    const idx3 = 0x000 + u;
    const sum = table[idx0] + table[idx1] + table[idx2] + table[idx3];
    if (sum !== 0x8000) {
      table[idx1] += (0x8000 - sum);
    }
  }
  return table;
}

export const GAUSS_TABLE: Int16Array = createGaussTable();

/**
 * Individual SPU Voice representation
 * Pre-allocated typed arrays ensure zero per-sample garbage collection.
 */
export class SpuVoice {
  public id: number;

  // Voice Registers
  public volL: number = 0; // signed 16-bit (-32768..32767)
  public volR: number = 0; // signed 16-bit (-32768..32767)
  public pitch: number = 0x1000; // 0x1000 = 44.1 kHz (1.0x pitch)
  public startAddr: number = 0; // byte address in Sound RAM
  public adsr1: number = 0; // lower ADSR configuration word
  public adsr2: number = 0; // upper ADSR configuration word
  public envLevel: number = 0; // 0..0x7FFF
  public repeatAddr: number = 0; // loop/repeat byte address

  // Runtime Playback State
  public active: boolean = false;
  public currentAddr: number = 0;
  public loopAddr: number = 0;
  public hasLoopStarted: boolean = false;

  // ADPCM Decoder State
  public readonly blockBuffer: Int16Array = new Int16Array(28);
  public blockSampleIndex: number = 28; // triggers decode immediately on start
  public hist0: number = 0;
  public hist1: number = 0;

  // 4-Sample Resampling History & Fixed-Point Pitch Counter
  public readonly s: Int16Array = new Int16Array(4);
  public counter: number = 0; // 12-bit fractional sample counter (4096 = 1.0 sample)

  // ADSR State Machine
  public envPhase: AdsrPhase = AdsrPhase.OFF;
  public endx: boolean = false;

  constructor(id: number) {
    this.id = id;
  }

  public reset(): void {
    this.volL = 0;
    this.volR = 0;
    this.pitch = 0x1000;
    this.startAddr = 0;
    this.adsr1 = 0;
    this.adsr2 = 0;
    this.envLevel = 0;
    this.repeatAddr = 0;
    this.active = false;
    this.currentAddr = 0;
    this.loopAddr = 0;
    this.hasLoopStarted = false;
    this.blockSampleIndex = 28;
    this.hist0 = 0;
    this.hist1 = 0;
    this.counter = 0;
    this.envPhase = AdsrPhase.OFF;
    this.endx = false;
    this.s.fill(0);
    this.blockBuffer.fill(0);
  }

  public keyOn(): void {
    this.active = true;
    this.currentAddr = this.startAddr & 0x7FFF0;
    this.loopAddr = this.currentAddr;
    this.hasLoopStarted = false;
    this.hist0 = 0;
    this.hist1 = 0;
    this.s.fill(0);
    this.counter = 0;
    this.blockSampleIndex = 28; // will decode first 28-sample block
    this.envLevel = 0;
    this.envPhase = AdsrPhase.ATTACK;
    this.endx = false;
  }

  public keyOff(): void {
    if (this.active && this.envPhase !== AdsrPhase.OFF) {
      this.envPhase = AdsrPhase.RELEASE;
    }
  }
}

/**
 * PlayStation 1 Sound Processing Unit (SPU)
 */
export class Spu {
  // 512 KB Sound RAM
  public readonly soundRam: Uint8Array = new Uint8Array(0x80000);

  // 24 Hardware Voices
  public readonly voices: SpuVoice[] = [];

  // Global Volumes (Signed 16-bit, default to unity gain 0x7FFF)
  public mainVolL: number = 0x7FFF;
  public mainVolR: number = 0x7FFF;
  public reverbVolL: number = 0;
  public reverbVolR: number = 0;
  public cdVolL: number = 0x7FFF;
  public cdVolR: number = 0x7FFF;
  public extVolL: number = 0;
  public extVolR: number = 0;

  // Global SPU Control & Transfer Registers
  public mbase: number = 0; // Reverb Workarea Base Address
  public irqAddr: number = 0; // SPU IRQ9 Trigger Address
  public taddr: number = 0; // Sound RAM Transfer Pointer (in bytes)
  public spucnt: number = 0xC000; // SPU Control Register (Enabled + Unmuted)
  public tctrl: number = 0x0004; // SPU Transfer Control
  public irqEnabled: boolean = false;
  public irqPending: boolean = false;

  // Pitch Modulation, Noise & Echo Channel Masks
  public pmon: number = 0; // Pitch modulation enable bitmask (voices 0..23)
  public non: number = 0; // Noise mode enable bitmask (voices 0..23)
  public eon: number = 0; // Echo/Reverb enable bitmask (voices 0..23)

  // IRQ Callback Hook
  public onTriggerIrq?: (asserted: boolean) => void;

  // Ring buffer for smooth host audio streaming
  public readonly ringBuffer: SpuRingBuffer = new SpuRingBuffer(32768);

  // Diagnostics
  private mixDiagnosticTimer: number = 0;
  private sampleLogCounter: number = 0;
  private hasLoggedInitialMix: boolean = false;

  constructor() {
    for (let i = 0; i < 24; i++) {
      this.voices.push(new SpuVoice(i));
    }
    this.reset();
  }

  public reset(): void {
    this.soundRam.fill(0);
    for (let i = 0; i < 24; i++) {
      this.voices[i].reset();
    }
    this.mainVolL = 0x7FFF;
    this.mainVolR = 0x7FFF;
    this.reverbVolL = 0;
    this.reverbVolR = 0;
    this.cdVolL = 0x7FFF;
    this.cdVolR = 0x7FFF;
    this.extVolL = 0;
    this.extVolR = 0;
    this.mbase = 0;
    this.irqAddr = 0;
    this.taddr = 0x1000; // 0x0200 halfwords (standard PS1 BIOS post-boot state at 0x1F801DA6)
    this.spucnt = 0xc085; // Standard SPU boot state: Enabled (0x8000) | Unmuted (0x4000) | CD Audio (0x0080) | Mode (0x0005)
    this.tctrl = 0x0004;
    this.irqEnabled = false;
    this.irqPending = false;
    this.pmon = 0;
    this.non = 0;
    this.eon = 0;
    this.ringBuffer.clear();
  }

  // =========================================================================
  // MMIO Register Access (0x1F801C00 - 0x1F801FFF)
  // =========================================================================

  public read16(addr: number): number {
    const offset = addr & 0x3FF;

    // 1. Voice Registers (0x000 - 0x17F: 24 voices * 16 bytes)
    if (offset < 0x180) {
      const vIdx = offset >> 4;
      const reg = offset & 0x0E;
      const v = this.voices[vIdx];
      switch (reg) {
        case 0x00: return v.volL & 0xFFFF;
        case 0x02: return v.volR & 0xFFFF;
        case 0x04: return v.pitch & 0xFFFF;
        case 0x06: return (v.startAddr >> 3) & 0xFFFF;
        case 0x08: return v.adsr1 & 0xFFFF;
        case 0x0A: return v.adsr2 & 0xFFFF;
        case 0x0C: return v.envLevel & 0xFFFF;
        case 0x0E: return (v.repeatAddr >> 3) & 0xFFFF;
      }
    }

    // 2. Global SPU Registers (0x180 - 0x1FF)
    switch (offset) {
      case 0x180: return this.mainVolL & 0xFFFF;
      case 0x182: return this.mainVolR & 0xFFFF;
      case 0x184: return this.reverbVolL & 0xFFFF;
      case 0x186: return this.reverbVolR & 0xFFFF;
      case 0x188: return 0; // KON low write-only
      case 0x18A: return 0; // KON high write-only
      case 0x18C: return 0; // KOFF low write-only
      case 0x18E: return 0; // KOFF high write-only
      case 0x190: return this.pmon & 0xFFFF;
      case 0x192: return (this.pmon >>> 16) & 0xFF;
      case 0x194: return this.non & 0xFFFF;
      case 0x196: return (this.non >>> 16) & 0xFF;
      case 0x198: return this.eon & 0xFFFF;
      case 0x19A: return (this.eon >>> 16) & 0xFF;
      case 0x19C: return this.readEndxLow();
      case 0x19E: return this.readEndxHigh();
      case 0x1A0: return 0;
      case 0x1A2: return (this.mbase >> 3) & 0xFFFF;
      case 0x1A4: return (this.irqAddr >> 3) & 0xFFFF;
      case 0x1A6: return (this.taddr >> 3) & 0xFFFF;
      case 0x1A8: return this.readFifo();
      case 0x1AA: return this.spucnt & 0xFFFF;
      case 0x1AC: return this.tctrl & 0xFFFF;
      case 0x1AE: return this.readSpustat();
      case 0x1B0: return this.cdVolL & 0xFFFF;
      case 0x1B2: return this.cdVolR & 0xFFFF;
      case 0x1B4: return this.extVolL & 0xFFFF;
      case 0x1B6: return this.extVolR & 0xFFFF;
      case 0x1B8: return this.mainVolL & 0xFFFF;
      case 0x1BA: return this.mainVolR & 0xFFFF;
    }

    return 0;
  }

  public write16(addr: number, val: number): void {
    val &= 0xFFFF;
    const offset = addr & 0x3FF;

    // 1. Voice Registers (0x000 - 0x17F)
    if (offset < 0x180) {
      const vIdx = offset >> 4;
      const reg = offset & 0x0E;
      const v = this.voices[vIdx];
      switch (reg) {
        case 0x00:
          v.volL = (val << 16) >> 16;
          return;
        case 0x02:
          v.volR = (val << 16) >> 16;
          return;
        case 0x04:
          v.pitch = val;
          return;
        case 0x06:
          v.startAddr = (val << 3) & 0x7FFF0;
          return;
        case 0x08:
          v.adsr1 = val;
          return;
        case 0x0A:
          v.adsr2 = val;
          return;
        case 0x0C:
          v.envLevel = val & 0x7FFF;
          return;
        case 0x0E:
          v.repeatAddr = (val << 3) & 0x7FFF0;
          return;
      }
    }

    // 2. Global SPU Registers (0x180 - 0x1FF)
    switch (offset) {
      case 0x180: this.mainVolL = (val << 16) >> 16; break;
      case 0x182: this.mainVolR = (val << 16) >> 16; break;
      case 0x184: this.reverbVolL = (val << 16) >> 16; break;
      case 0x186: this.reverbVolR = (val << 16) >> 16; break;
      case 0x188: this.keyOn(val, 0); break;
      case 0x18A: this.keyOn(val & 0xFF, 16); break;
      case 0x18C: this.keyOff(val, 0); break;
      case 0x18E: this.keyOff(val & 0xFF, 16); break;
      case 0x190: this.pmon = (this.pmon & 0xFF0000) | val; break;
      case 0x192: this.pmon = (this.pmon & 0x00FFFF) | ((val & 0xFF) << 16); break;
      case 0x194: this.non = (this.non & 0xFF0000) | val; break;
      case 0x196: this.non = (this.non & 0x00FFFF) | ((val & 0xFF) << 16); break;
      case 0x198: this.eon = (this.eon & 0xFF0000) | val; break;
      case 0x19A: this.eon = (this.eon & 0x00FFFF) | ((val & 0xFF) << 16); break;
      case 0x19C: this.clearEndx(val, 0); break;
      case 0x19E: this.clearEndx(val & 0xFF, 16); break;
      case 0x1A2: this.mbase = (val << 3) & 0x7FFFF; break;
      case 0x1A4: this.irqAddr = (val << 3) & 0x7FFFF; break;
      case 0x1A6: this.taddr = (val << 3) & 0x7FFFF; break;
      case 0x1A8: this.writeFifo(val); break;
      case 0x1AA:
        this.spucnt = val;
        this.irqEnabled = (val & 0x0040) !== 0;
        if (!this.irqEnabled) {
          this.irqPending = false;
          if (this.onTriggerIrq) this.onTriggerIrq(false);
        }
        break;
      case 0x1AC: this.tctrl = val; break;
      case 0x1B0: this.cdVolL = (val << 16) >> 16; break;
      case 0x1B2: this.cdVolR = (val << 16) >> 16; break;
      case 0x1B4: this.extVolL = (val << 16) >> 16; break;
      case 0x1B6: this.extVolR = (val << 16) >> 16; break;
    }
  }

  public read8(addr: number): number {
    const word = this.read16(addr & ~1);
    return (addr & 1) ? ((word >> 8) & 0xFF) : (word & 0xFF);
  }

  public write8(addr: number, val: number): void {
    const current = this.read16(addr & ~1);
    const updated = (addr & 1)
      ? ((current & 0x00FF) | ((val & 0xFF) << 8))
      : ((current & 0xFF00) | (val & 0xFF));
    this.write16(addr & ~1, updated);
  }

  public read32(addr: number): number {
    const low = this.read16(addr);
    const high = this.read16(addr + 2);
    return ((high << 16) | low) >>> 0;
  }

  public write32(addr: number, val: number): void {
    this.write16(addr, val & 0xFFFF);
    this.write16(addr + 2, (val >>> 16) & 0xFFFF);
  }

  // =========================================================================
  // FIFO and DMA Channel 4 Sound RAM Transfers
  // =========================================================================

  public readFifo(): number {
    const low = this.soundRam[this.taddr];
    const high = this.soundRam[(this.taddr + 1) & 0x7FFFF];
    this.stepTransferPointer();
    return (low | (high << 8)) & 0xFFFF;
  }

  public writeFifo(val: number): void {
    this.soundRam[this.taddr] = val & 0xFF;
    this.soundRam[(this.taddr + 1) & 0x7FFFF] = (val >>> 8) & 0xFF;
    this.stepTransferPointer();
  }

  private stepTransferPointer(): void {
    this.taddr = (this.taddr + 2) & 0x7FFFF;
    if (this.irqEnabled && this.taddr === this.irqAddr) {
      this.triggerIrq();
    }
  }

  public dmaWrite(val: number): void {
    this.writeFifo(val & 0xFFFF);
    this.writeFifo((val >>> 16) & 0xFFFF);
  }

  public dmaRead(): number {
    const low = this.readFifo();
    const high = this.readFifo();
    return ((high << 16) | low) >>> 0;
  }

  public readSpustat(): number {
    let stat = this.spucnt & 0x003f;
    if (this.irqPending) {
      stat |= 0x0040; // Bit 6: IRQ9 flag
    }
    const xferMode = (this.spucnt >>> 4) & 3;
    if (xferMode === 1) {
      stat |= (1 << 7); // Bit 7: Manual write ready
    } else if (xferMode === 2) {
      stat |= (1 << 8); // Bit 8: DMA write request / ready
    } else if (xferMode === 3) {
      stat |= (1 << 9); // Bit 9: DMA read request / ready
    } else {
      stat |= 0x0080; // Stop/idle: data transfer ready
    }
    // Bit 10: Data Transfer Busy Flag (0 = Ready, 1 = Busy) -> Always 0 (Ready)
    return stat & 0xffff;
  }

  private triggerIrq(): void {
    this.irqPending = true;
    if (this.onTriggerIrq) {
      this.onTriggerIrq(true);
    }
  }

  private keyOn(mask: number, baseIdx: number): void {
    for (let i = 0; i < 16 && (baseIdx + i) < 24; i++) {
      if ((mask & (1 << i)) !== 0) {
        this.voices[baseIdx + i].keyOn();
      }
    }
  }

  private keyOff(mask: number, baseIdx: number): void {
    for (let i = 0; i < 16 && (baseIdx + i) < 24; i++) {
      if ((mask & (1 << i)) !== 0) {
        this.voices[baseIdx + i].keyOff();
      }
    }
  }

  private clearEndx(mask: number, baseIdx: number): void {
    for (let i = 0; i < 16 && (baseIdx + i) < 24; i++) {
      if ((mask & (1 << i)) !== 0) {
        this.voices[baseIdx + i].endx = false;
      }
    }
  }

  private readEndxLow(): number {
    let val = 0;
    for (let i = 0; i < 16; i++) {
      if (this.voices[i].endx) val |= (1 << i);
    }
    return val;
  }

  private readEndxHigh(): number {
    let val = 0;
    for (let i = 0; i < 8; i++) {
      if (this.voices[16 + i].endx) val |= (1 << i);
    }
    return val;
  }

  // =========================================================================
  // ADPCM Block Decoder (spu_read_block)
  // =========================================================================

  private decodeBlock(v: SpuVoice): void {
    const addr = v.currentAddr & 0x7FFF0;
    const hdr = this.soundRam[addr];
    const flags = this.soundRam[(addr + 1) & 0x7FFFF];

    let shift = 12 - (hdr & 0x0F);
    if (shift < 0) shift = 0;
    const filter = Math.min((hdr >> 4) & 0x07, 4);

    const f0 = SPU_POS_ADPCM_TABLE[filter];
    const f1 = SPU_NEG_ADPCM_TABLE[filter];

    let h0 = v.hist0;
    let h1 = v.hist1;
    let outIdx = 0;

    // 14 data bytes yield 28 samples (4-bit nibbles)
    for (let i = 0; i < 14; i++) {
      const byte = this.soundRam[(addr + 2 + i) & 0x7FFFF];

      // Lower nibble first
      for (let n = 0; n < 2; n++) {
        const rawNibble = n === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
        const signedNibble = (rawNibble << 28) >> 28; // sign extend 4 bits to 32 bits
        let sample = (signedNibble << shift) + (((h0 * f0) + (h1 * f1) + 32) >> 6);

        if (sample > 32767) sample = 32767;
        else if (sample < -32768) sample = -32768;

        h1 = h0;
        h0 = sample;
        v.blockBuffer[outIdx++] = sample;
      }
    }

    v.hist0 = h0;
    v.hist1 = h1;
    v.blockSampleIndex = 0;

    // Flags: Loop Start (bit 2), Loop Repeat (bit 1), Loop End (bit 0)
    if ((flags & 0x04) !== 0) {
      v.loopAddr = addr;
      v.hasLoopStarted = true;
    }

    if ((flags & 0x01) !== 0) {
      v.endx = true;
      if ((flags & 0x02) !== 0) {
        v.currentAddr = v.hasLoopStarted ? v.loopAddr : v.repeatAddr;
      } else {
        v.envPhase = AdsrPhase.RELEASE;
        v.currentAddr = (addr + 16) & 0x7FFFF;
      }
    } else {
      v.currentAddr = (addr + 16) & 0x7FFFF;
    }

    if (this.irqEnabled && v.currentAddr === this.irqAddr) {
      this.triggerIrq();
    }
  }

  // =========================================================================
  // ADSR Envelope Engine
  // =========================================================================

  private stepEnvelope(v: SpuVoice): void {
    if (v.envPhase === AdsrPhase.OFF) {
      v.envLevel = 0;
      return;
    }

    if (v.envPhase === AdsrPhase.ATTACK) {
      const isExp = (v.adsr1 & 0x80) !== 0;
      const attackRate = (v.adsr1 >> 8) & 0x7F;
      // Step rate: higher rate = faster attack
      const rateFactor = Math.max(1, attackRate > 0 ? (attackRate + 1) * 8 : 64);
      let inc = rateFactor;
      if (isExp && v.envLevel > 0x6000) {
        inc = Math.max(1, inc >> 2);
      }
      v.envLevel += inc;
      if (v.envLevel >= 0x7FFF) {
        v.envLevel = 0x7FFF;
        v.envPhase = AdsrPhase.DECAY;
      }
      return;
    }

    if (v.envPhase === AdsrPhase.DECAY) {
      const sl = (v.adsr1 >> 12) & 0x0F;
      const target = Math.min(0x7FFF, (sl + 1) * 0x800 - 1);
      const shift = (v.adsr1 >> 4) & 0x0F;
      const dec = Math.max(1, (v.envLevel * (shift + 1)) >> 8);
      v.envLevel -= dec;
      if (v.envLevel <= target) {
        v.envLevel = target;
        v.envPhase = AdsrPhase.SUSTAIN;
      }
      return;
    }

    if (v.envPhase === AdsrPhase.SUSTAIN) {
      const isDirDec = (v.adsr2 & 0x4000) !== 0 || (v.adsr2 & 0x40) !== 0;
      const isExp = (v.adsr2 & 0x8000) !== 0 || (v.adsr2 & 0x80) !== 0;
      const shift = v.adsr2 & 0x7F;

      if (isDirDec) {
        let dec = Math.max(1, (shift + 1) * 2);
        if (isExp) {
          dec = Math.max(1, (v.envLevel * (shift + 1)) >> 10);
        }
        v.envLevel -= dec;
        if (v.envLevel <= 0) {
          v.envLevel = 0;
          v.envPhase = AdsrPhase.OFF;
          v.active = false;
          v.endx = true;
        }
      } else {
        // Sustaining / holding level
        if (shift > 0) {
          let inc = Math.max(1, shift + 1);
          if (isExp && v.envLevel > 0x6000) {
            inc = Math.max(1, inc >> 2);
          }
          v.envLevel = Math.min(0x7FFF, v.envLevel + inc);
        }
      }
      return;
    }

    if (v.envPhase === AdsrPhase.RELEASE) {
      const isExp = (v.adsr2 & 0x2000) !== 0;
      const shift = (v.adsr2 >> 8) & 0x1F;
      let dec = Math.max(1, (shift + 1) * 4);
      if (isExp) {
        dec = Math.max(1, (v.envLevel * (shift + 1)) >> 8);
      }
      v.envLevel -= dec;
      if (v.envLevel <= 0) {
        v.envLevel = 0;
        v.envPhase = AdsrPhase.OFF;
        v.active = false;
        v.endx = true;
      }
      return;
    }
  }

  // =========================================================================
  // Mixer & Audio Buffer Generation
  // =========================================================================

  /**
   * Generates stereo 44,100 Hz Float32 audio samples into the provided arrays.
   * Fully optimized for V8 JIT with zero GC allocations in the inner loop.
   */
  public generateSamples(outputLeft: Float32Array, outputRight: Float32Array, sampleCount: number): void {
    // If SPU is disabled (bit 15 = 0) or muted (bit 14 = 0)
    const isEnabled = (this.spucnt & 0x8000) !== 0;
    const isUnmuted = (this.spucnt & 0x4000) !== 0;

    if (!isEnabled || !isUnmuted) {
      outputLeft.fill(0, 0, sampleCount);
      outputRight.fill(0, 0, sampleCount);
      return;
    }

    let maxAmp = 0;
    let activeVoiceCount = 0;

    for (let s = 0; s < sampleCount; s++) {
      let mixL = 0;
      let mixR = 0;
      let curActive = 0;

      for (let i = 0; i < 24; i++) {
        const v = this.voices[i];
        if (!v.active || v.envPhase === AdsrPhase.OFF) continue;
        curActive++;

        // Step ADSR envelope
        this.stepEnvelope(v);
        if (!v.active || (v.envPhase as AdsrPhase) === AdsrPhase.OFF) continue;

        // Resample: advance sample history when fractional counter passes boundary
        while (v.counter >= 0x1000) {
          v.counter -= 0x1000;
          v.s[0] = v.s[1];
          v.s[1] = v.s[2];
          v.s[2] = v.s[3];

          if (v.blockSampleIndex >= 28) {
            this.decodeBlock(v);
          }
          v.s[3] = v.blockBuffer[v.blockSampleIndex++];
        }

        // 4-Point Gaussian Interpolation
        const gaussIndex = (v.counter >> 4) & 0xFF;
        const g0 = GAUSS_TABLE[0x0FF - gaussIndex];
        const g1 = GAUSS_TABLE[0x1FF - gaussIndex];
        const g2 = GAUSS_TABLE[0x100 + gaussIndex];
        const g3 = GAUSS_TABLE[0x000 + gaussIndex];

        const interpolated =
          ((g0 * v.s[3]) >> 15) +
          ((g1 * v.s[2]) >> 15) +
          ((g2 * v.s[1]) >> 15) +
          ((g3 * v.s[0]) >> 15);

        // Advance pitch step
        v.counter += v.pitch;

        // Scale by ADSR volume & channel volume
        const envSample = (interpolated * v.envLevel) >> 15;
        mixL += (envSample * v.volL) >> 15;
        mixR += (envSample * v.volR) >> 15;
      }

      if (curActive > activeVoiceCount) {
        activeVoiceCount = curActive;
      }

      // Apply master volume
      const finalL = (mixL * this.mainVolL) >> 15;
      const finalR = (mixR * this.mainVolR) >> 15;

      // Clamp to signed 16-bit
      const clampedL = Math.max(-32768, Math.min(32767, finalL));
      const clampedR = Math.max(-32768, Math.min(32767, finalR));

      // Convert to normalized Float32 [-1.0, 1.0]
      const outL = clampedL / 32768.0;
      const outR = clampedR / 32768.0;
      outputLeft[s] = outL;
      outputRight[s] = outR;

      const ampL = Math.abs(outL);
      const ampR = Math.abs(outR);
      if (ampL > maxAmp) maxAmp = ampL;
      if (ampR > maxAmp) maxAmp = ampR;
    }

    this.mixDiagnosticTimer += sampleCount;
    if (this.mixDiagnosticTimer >= 44100 || (!this.hasLoggedInitialMix && activeVoiceCount > 0)) {
      this.hasLoggedInitialMix = true;
      this.mixDiagnosticTimer = 0;
      console.log(`[SPU Mix] Active Voices: ${activeVoiceCount}, Max Sample Amp:${maxAmp.toFixed(3)}`);
    }
  }

  /**
   * Advances the SPU by a given number of CPU cycles.
   * SPU clock is 44,100 Hz (33,868,800 / 768 = 44,100 cycles).
   */
  private cycleDebt: number = 0;
  private readonly scratchL: Float32Array = new Float32Array(512);
  private readonly scratchR: Float32Array = new Float32Array(512);

  public stepCycles(cpuCycles: number): void {
    this.cycleDebt += cpuCycles;
    const samplesToGenerate = (this.cycleDebt / 768) | 0;
    if (samplesToGenerate <= 0) return;

    this.cycleDebt -= samplesToGenerate * 768;

    let remaining = samplesToGenerate;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 512);
      this.generateSamples(this.scratchL, this.scratchR, chunk);
      this.ringBuffer.write(this.scratchL, this.scratchR, chunk);
      remaining -= chunk;
    }

    this.sampleLogCounter += samplesToGenerate;
    if (this.sampleLogCounter >= 44100) {
      this.sampleLogCounter = 0;
      // console.log(`[SPU Buffer] SPU clocking: generated 44.1k samples (RingBuffer: ${this.ringBuffer.available()}/${this.ringBuffer.capacity})`);
    }
  }
}

/**
 * Lock-free Audio Ring Buffer for Web Audio streaming
 */
export class SpuRingBuffer {
  public readonly left: Float32Array;
  public readonly right: Float32Array;
  public readonly capacity: number;
  private writeIdx: number = 0;
  private readIdx: number = 0;

  constructor(capacity: number = 32768) {
    this.capacity = capacity;
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
  }

  public clear(): void {
    this.writeIdx = 0;
    this.readIdx = 0;
    this.left.fill(0);
    this.right.fill(0);
  }

  public available(): number {
    return (this.writeIdx - this.readIdx + this.capacity) % this.capacity;
  }

  public write(inL: Float32Array, inR: Float32Array, count: number): void {
    for (let i = 0; i < count; i++) {
      this.left[this.writeIdx] = inL[i];
      this.right[this.writeIdx] = inR[i];
      this.writeIdx = (this.writeIdx + 1) % this.capacity;
      if (this.writeIdx === this.readIdx) {
        // Drop oldest sample if buffer overruns
        this.readIdx = (this.readIdx + 1) % this.capacity;
      }
    }
  }

  public read(outL: Float32Array, outR: Float32Array, count: number): number {
    let readCount = 0;
    for (let i = 0; i < count; i++) {
      if (this.readIdx === this.writeIdx) {
        // Buffer underrun: fill with silence
        outL[i] = 0;
        outR[i] = 0;
      } else {
        outL[i] = this.left[this.readIdx];
        outR[i] = this.right[this.readIdx];
        this.readIdx = (this.readIdx + 1) % this.capacity;
        readCount++;
      }
    }
    return readCount;
  }
}

/**
 * Clean Web Audio Backend Driver for PlayStation 1 SPU
 */
export class SpuAudioBackend {
  private ctx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private spu: Spu | null = null;

  public init(spu: Spu): void {
    this.spu = spu;
    if (typeof window === 'undefined') return;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      this.ctx = new AudioCtx({ sampleRate: 44100 });
      console.log(`[SPU Audio] AudioContext state on init: ${this.ctx.state}`);

      if (this.ctx.state === 'suspended') {
        const unlock = () => {
          if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().then(() => {
              console.log(`[SPU Audio] AudioContext unlocked via user gesture, state: ${this.ctx?.state}`);
            }).catch((err) => {
              console.warn('[SPU Audio] Resume failed:', err);
            });
          }
          window.removeEventListener('click', unlock);
          window.removeEventListener('keydown', unlock);
          window.removeEventListener('touchstart', unlock);
        };
        window.addEventListener('click', unlock);
        window.addEventListener('keydown', unlock);
        window.addEventListener('touchstart', unlock);
      }

      // 2048 sample buffer yields ~46ms latency, smooth and stutter-free
      this.scriptNode = this.ctx.createScriptProcessor(2048, 0, 2);
      this.scriptNode.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!this.spu) return;
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        this.spu.ringBuffer.read(outL, outR, outL.length);
      };

      this.scriptNode.connect(this.ctx.destination);
    } catch (err) {
      console.warn('[SPU Audio] Failed to initialize AudioContext:', err);
    }
  }

  public resume(): void {
    if (this.ctx) {
      console.log(`[SPU Audio] AudioContext state on start/resume: ${this.ctx.state}`);
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().then(() => {
          console.log(`[SPU Audio] AudioContext resumed, state: ${this.ctx?.state}`);
        }).catch(() => {});
      }
    }
  }

  public stop(): void {
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
