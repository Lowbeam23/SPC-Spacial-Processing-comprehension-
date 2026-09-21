/**
 * PlayStation 1 Root Counters / Timers (0x1F801100 - 0x1F801128)
 *
 * Timer 0 (0x1F801100): Pixelclock or System Clock
 * Timer 1 (0x1F801110): HBlank or System Clock
 * Timer 2 (0x1F801120): System Clock or System Clock / 8
 */

export class RootTimer {
  public currentValue: number = 0; // 16-bit counter register
  public mode: number = 0x0400;    // 16-bit mode / status register
  public targetValue: number = 0xffff; // 16-bit target register
  public fractional: number = 0;
  public irqFired: boolean = false;

  public get value(): number {
    return this.currentValue;
  }
  public set value(v: number) {
    this.currentValue = v;
  }

  public get target(): number {
    return this.targetValue;
  }
  public set target(v: number) {
    this.targetValue = v;
  }
}

export class TimersController {
  public timers: RootTimer[] = [
    new RootTimer(),
    new RootTimer(),
    new RootTimer(),
  ];

  public timer1ReadCount: number = 0;

  public reset(): void {
    this.timer1ReadCount = 0;
    for (let i = 0; i < 3; i++) {
      this.timers[i].currentValue = 0;
      this.timers[i].mode = 0x0400; // Bit 10: IRQ high/inactive
      this.timers[i].targetValue = 0xffff;
      this.timers[i].fractional = 0;
      this.timers[i].irqFired = false;
    }
  }

  public readCounter(index: number, cpuCycles?: number): number {
    if (index === 1) {
      this.timer1ReadCount++;
      if (this.timer1ReadCount % 1000 === 0) {
        console.log(`[TIMER 1 READ] Reads: ${this.timer1ReadCount} | Value: ${this.timers[1].currentValue} | Target: ${this.timers[1].targetValue} | Mode: 0x${this.timers[1].mode.toString(16)}`);
      }
      if (cpuCycles !== undefined && cpuCycles > 0) {
        const scanline = Math.floor((cpuCycles / 2170) % 263);
        return scanline & 0xffff;
      }
    }
    return this.timers[index].currentValue & 0xffff;
  }

  public writeCounter(index: number, val: number): void {
    this.timers[index].currentValue = val & 0xffff;
  }

  public readMode(index: number): number {
    if (index === 1) {
      // Return target reached (bit 11), overflow (bit 12), and IRQ inactive/ready (bit 10)
      return (1 << 11) | (1 << 12) | (1 << 10);
    }
    const t = this.timers[index];
    const mode = t.mode & 0xffff;
    // Bits 11 and 12 (Target hit and Overflow) reset upon reading
    t.mode &= ~0x1800;
    // If IRQ pulse mode (bit 7 === 0), bit 10 restores to 1 (inactive) after reading
    if ((mode & (1 << 7)) === 0) {
      t.mode |= 0x0400;
    }
    return mode;
  }

  public writeMode(index: number, val: number): void {
    const t = this.timers[index];
    // Bits 0-9 written, bit 10 initialized high (inactive), bits 11-12 cleared
    t.mode = (val & 0x03ff) | 0x0400;
    t.currentValue = 0; // Writing to mode resets currentValue to 0
    t.irqFired = false;
    t.fractional = 0;
  }

  public readTarget(index: number): number {
    return this.timers[index].targetValue & 0xffff;
  }

  public writeTarget(index: number, val: number): void {
    this.timers[index].targetValue = val & 0xffff;
    this.timers[index].irqFired = false;
  }

  /**
   * Advance timer counters according to elapsed CPU cycles
   */
  public advanceCycles(cycles: number, triggerIrq: (irqBit: number) => void): void {
    if (cycles <= 0) return;

    // Timer 0: Dotclock (bit 8 = 1) or System Clock (bit 8 = 0)
    const t0 = this.timers[0];
    const t0Src = (t0.mode >>> 8) & 1;
    if (t0Src === 1) {
      t0.fractional += cycles;
      // In 320 mode, dotclock ticks every ~6.3126 CPU cycles
      const dotTicks = Math.floor(t0.fractional / 6.3126);
      if (dotTicks > 0) {
        t0.fractional -= dotTicks * 6.3126;
        this.tickTimer(0, dotTicks, 4, triggerIrq);
      }
    } else {
      this.tickTimer(0, cycles, 4, triggerIrq);
    }

    // Timer 1: HBlank (bit 8 = 1) or System Clock / 8 or System Clock (depending on mode)
    const t1 = this.timers[1];
    const t1ClockSrc = (t1.mode >>> 8) & 3; // Bit 8-9 clock source selection
    if (t1ClockSrc === 1 || t1ClockSrc === 3) {
      // Horizontal scanline mode: ticks every ~2160 CPU cycles (approximate scanline period)
      t1.fractional += cycles;
      const scanlineCycles = 2160;
      const scanlines = Math.floor(t1.fractional / scanlineCycles);
      if (scanlines > 0) {
        t1.fractional -= scanlines * scanlineCycles;
        this.tickTimer(1, scanlines, 5, triggerIrq);
      }
    } else if (t1ClockSrc === 2) {
      // System Clock / 8 mode
      t1.fractional += cycles;
      const ticks = Math.floor(t1.fractional / 8);
      if (ticks > 0) {
        t1.fractional %= 8;
        this.tickTimer(1, ticks, 5, triggerIrq);
      }
    } else {
      // System Clock mode (or other fallback): ticks relative to CPU cycles elapsed
      this.tickTimer(1, cycles, 5, triggerIrq);
    }

    // Timer 2: System Clock (bits 8-9 = 0,1) or System Clock / 8 (bits 8-9 = 2,3)
    const t2 = this.timers[2];
    const t2Src = (t2.mode >>> 8) & 3;
    if (t2Src >= 2) {
      t2.fractional += cycles;
      const ticks = Math.floor(t2.fractional / 8);
      if (ticks > 0) {
        t2.fractional %= 8;
        this.tickTimer(2, ticks, 6, triggerIrq);
      }
    } else {
      this.tickTimer(2, cycles, 6, triggerIrq);
    }
  }

  private tickTimer(index: number, inc: number, irqBit: number, triggerIrq: (irqBit: number) => void): void {
    const t = this.timers[index];
    if (inc <= 0) return;

    // Timer 2 sync gate check: bits 1-2 = 0 or 3 with sync enabled stops counter
    const syncEnable = (t.mode & 1) !== 0;
    if (index === 2 && syncEnable) {
      const syncMode = (t.mode >>> 1) & 3;
      if (syncMode === 0 || syncMode === 3) {
        return; // Stopped by gate
      }
    }

    const prev = t.currentValue;
    t.currentValue += inc;

    // Target 0 is treated as 0x10000 (65536) on PS1
    const target = t.targetValue === 0 ? 0x10000 : t.targetValue;
    const resetOnTarget = (t.mode & (1 << 3)) !== 0; // Bit 3: Reset counter to 0 on target
    const irqOnTarget = (t.mode & (1 << 4)) !== 0;   // Bit 4: IRQ when Counter = Target
    const irqOnOverflow = (t.mode & (1 << 5)) !== 0; // Bit 5: IRQ when Counter = FFFFh
    const isRepeated = (t.mode & (1 << 6)) !== 0;    // Bit 6: IRQ Once / Repeat
    const isToggle = (t.mode & (1 << 7)) !== 0;      // Bit 7: IRQ Pulse / Toggle

    // Target hit check (0x1F801104, 0x1F801114, 0x1F801124)
    if (prev < target && t.currentValue >= target) {
      t.mode |= (1 << 11); // Bit 11: Reached Target Value flag

      if (irqOnTarget) {
        if (!t.irqFired || isRepeated) {
          triggerIrq(irqBit);
          if (isToggle) {
            t.mode ^= (1 << 10);
          } else {
            t.mode &= ~(1 << 10); // Bit 10 = 0 (Interrupt Request active)
          }
          if (!isRepeated) {
            t.irqFired = true;
          }
        }
      }

      if (resetOnTarget) {
        t.currentValue = t.currentValue % target;
      }
    }

    // Overflow 0xFFFF check
    if (t.currentValue >= 0x10000) {
      t.mode |= (1 << 12); // Bit 12: Reached FFFFh / Overflow flag
      t.currentValue &= 0xffff;

      if (irqOnOverflow) {
        if (!t.irqFired || isRepeated) {
          triggerIrq(irqBit);
          if (isToggle) {
            t.mode ^= (1 << 10);
          } else {
            t.mode &= ~(1 << 10); // Bit 10 = 0 (Interrupt Request active)
          }
          if (!isRepeated) {
            t.irqFired = true;
          }
        }
      }
    }
  }
}
