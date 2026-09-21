/**
 * PlayStation 1 Memory Bus & Interconnect
 */

import type { Gpu } from './gpu';
import type { CdRom } from './cdrom';
import { DmaController } from './dma';
import { TimersController, RootTimer } from './timers';
import { SioController } from './sio';
import { logWarnRateLimited, logErrorRateLimited } from './logger';

export type TtyCallback = (char: string) => void;
export type MemoryLogCallback = (level: 'warn' | 'error' | 'system' | 'bios' | 'gpu', message: string, addr?: number) => void;

export interface CpuInterruptTarget {
  pc?: number;
  regs?: ArrayLike<number>;
  clearInterruptPending(bit: number): void;
  setInterruptPending(bit: number): void;
}

export class Memory {
  // 2 MB Main RAM
  public ram: Uint8Array = new Uint8Array(2 * 1024 * 1024);
  public ramView: DataView = new DataView(this.ram.buffer);
  public ram32: Uint32Array = new Uint32Array(this.ram.buffer);
  public ram16: Uint16Array = new Uint16Array(this.ram.buffer);

  // 512 KB BIOS ROM
  public bios: Uint8Array = new Uint8Array(512 * 1024);
  public biosView: DataView = new DataView(this.bios.buffer);

  // 1 KB Scratchpad (D-Cache)
  public scratchpad: Uint8Array = new Uint8Array(1024);
  public scratchpadView: DataView = new DataView(this.scratchpad.buffer);

  // Hardware Registers & IO buffer
  public io: Uint8Array = new Uint8Array(64 * 1024);
  public ioView: DataView = new DataView(this.io.buffer);

  // CPU link for hardware interrupt assertion / deassertion
  public cpu?: CpuInterruptTarget;

  // Recompiler link for RAM cache invalidation
  public recompiler?: { invalidateAddress(vaddr: number, length?: number): void };

  // Status flags and peripherals
  public iStat: number = 0; // 0x1F801070
  public iMask: number = 0; // 0x1F801074
  public dpcr: number = 0x07654321; // DMA Control (0x1F8010F0)
  // DMA Interrupt Register (0x1F8010F4)
  public irqFlags: number = 0; // Bits 24-30: IRQ flags (W1C)
  public irqEnables: number = 0; // Bits 16-22: IRQ enables
  public forceIrq: boolean = false; // Bit 15: force IRQ
  public masterEnable: boolean = false; // Bit 23: master enable
  public dicrLow: number = 0; // Bits 0-14: low control bits
  public masterFlag: boolean = false; // Bit 31: master DMA IRQ flag

  public get dicr(): number {
    return this.readDicr();
  }

  public set dicr(val: number) {
    this.writeDicr(val);
  }

  public updateMasterFlag(): void {
    const prevMaster = this.masterFlag;
    // Master flag is active ONLY if forceIrq is set, OR if masterEnable is true AND an enabled channel has an active IRQ:
    const activeChannelIrq = this.masterEnable && ((this.irqFlags & this.irqEnables) !== 0);
    this.masterFlag = this.forceIrq || activeChannelIrq;

    // Only assert I_STAT bit 3 on a rising edge (0 -> 1)
    if (!prevMaster && this.masterFlag) {
      this.triggerInterrupt(3); // Assert DMA IRQ
    } else if (!this.masterFlag) {
      this.iStat &= ~(1 << 3);  // Clear DMA bit in I_STAT
      this.updateInterrupts();
    }
  }

  public onDmaActivity?: () => void;

  public triggerDmaIrq(channel: number): void {
    // Channel completion IRQ flag in DICR (bits 24-30) is ALWAYS set upon DMA completion:
    this.irqFlags |= (1 << channel);
    this.updateMasterFlag();
    if (this.onDmaActivity) {
      this.onDmaActivity();
    }
  }

  public writeDicr(val: number): void {
    // Bits 0-14: control/bus delay
    this.dicrLow = val & 0x7FFF;

    // Bit 15: force IRQ
    this.forceIrq = (val & 0x8000) !== 0;

    // Bits 16-22: channel interrupt enables
    this.irqEnables = (val >> 16) & 0x7F;

    // Bit 23: Master interrupt enable
    this.masterEnable = (val & 0x00800000) !== 0;

    // Bits 24-30: Write-1-to-Clear IRQ flags
    const w1cFlags = (val >> 24) & 0x7F;
    this.irqFlags &= ~w1cFlags;

    this.updateMasterFlag();
  }

  public readDicr(): number {
    return (
      (this.masterFlag ? 0x80000000 : 0) |
      ((this.irqFlags & 0x7F) << 24) |
      (this.masterEnable ? 0x00800000 : 0) |
      ((this.irqEnables & 0x7F) << 16) |
      (this.forceIrq ? 0x8000 : 0) |
      (this.dicrLow & 0x7FFF)
    ) >>> 0;
  }
  public ramSize: number = 0x00000B88; // 0x1F801060 (2MB RAM default)
  public cacheControl: number = 0; // 0xFFFE0130
  public timerTicks: number = 0;
  public vblankCount: number = 0;

  // Root Counters / Timers (0: Dotclock/Sysclock, 1: HBlank/Sysclock, 2: Sysclock/Sysclock/8)
  public timersCtrl: TimersController = new TimersController();
  public get timers(): RootTimer[] {
    return this.timersCtrl.timers;
  }

  // DMA Channel 2 (GPU) Dedicated Registers
  public dma2Madr: number = 0; // 0x1F8010A0 (Base Address)
  public dma2Bcr: number = 0;  // 0x1F8010A4 (Block Control)
  public dma2Chcr: number = 0; // 0x1F8010A8 (Channel Control)

  // DMA Channel 3 (CD-ROM) Dedicated Registers
  public dma3Madr: number = 0; // 0x1F8010B0 (Base Address)
  public dma3Bcr: number = 0;  // 0x1F8010B4 (Block Control)
  public dma3Chcr: number = 0; // 0x1F8010B8 (Channel Control)
  public dma: DmaController = new DmaController();

  // CD-ROM Controller Reference (0x1F801800 - 0x1F801803)
  private _cdrom?: CdRom;
  public get cdrom(): CdRom | undefined {
    return this._cdrom;
  }
  public set cdrom(cd: CdRom | undefined) {
    this._cdrom = cd;
    if (cd) {
      cd.onDmaRequest = () => this.checkDmaCdrom();
    }
  }
  public cdromIndex: number = 0;
  public hasDiscLoaded: boolean = false;
  public cdromResponseFifo: number[] = [];
  public cdromParameterFifo: number[] = [];
  public cdromInterruptFlag: number = 0;
  public cdromInterruptEnable: number = 0x1f;
  public cdromReadsCount: number = 0;
  public cdromWritesCount: number = 0;
  public _cdLogCount: number = 0;
  public hasLoggedFirstCdromAccess: boolean = false;
  public cdromCommandHistory: { cmd: number; name: string; params: number[]; cycle: number }[] = [];
  private cdromLastLoggedStatus: number = -1;
  private cdromLastLoggedIntFlag: number = -1;
  public dma2LogCount: number = 0;
  public hasLoggedHistogram: boolean = false;
  public lastFrameOpcodes: Record<string, number> = {};

  // Track recent memory read addresses for inspection and debugging
  public lastReadAddresses: number[] = [];
  public lastDataReadAddresses: number[] = [];

  public recordReadAddress(addr: number, isData: boolean = false): void {
    this.lastReadAddresses.push(addr >>> 0);
    if (this.lastReadAddresses.length > 20) {
      this.lastReadAddresses.shift();
    }
    if (isData) {
      this.lastDataReadAddresses.push(addr >>> 0);
      if (this.lastDataReadAddresses.length > 20) {
        this.lastDataReadAddresses.shift();
      }
    }
  }

  public getLastReadAddresses(count: number = 3): number[] {
    return this.lastReadAddresses.slice(-count);
  }

  public getLastDataReadAddresses(count: number = 3): number[] {
    return this.lastDataReadAddresses.slice(-count);
  }

  // JOYPAD / SIO Controller State (0x1F801040 - 0x1F80104E)
  public sio: SioController = new SioController();

  public get joyRxFifo(): number[] { return this.sio.rxFifo; }
  public set joyRxFifo(val: number[]) { this.sio.rxFifo = val; }
  public get joyAck(): boolean { return this.sio.ack; }
  public set joyAck(val: boolean) { this.sio.ack = val; }
  public get joyCtrl(): number { return this.sio.ctrl; }
  public set joyCtrl(val: number) { this.sio.ctrl = val; }
  public get joyMode(): number { return this.sio.mode; }
  public set joyMode(val: number) { this.sio.mode = val; }
  public get joyBaud(): number { return this.sio.baud; }
  public set joyBaud(val: number) { this.sio.baud = val; }

  public readJoyStat(): number {
    return this.sio.readStat(this.iStat);
  }

  public readJoyData(): number {
    return this.sio.readData();
  }

  public writeJoyData(val: number): void {
    this.sio.writeData(val);
  }

  public writeJoyCtrl(val: number): void {
    this.sio.writeCtrl(val, () => {
      this.iStat &= ~(1 << 7);
      this.updateInterrupts();
    });
  }

  // Cache isolation (COP0 SR bit 16 IsC)
  public isCacheIsolated: boolean = false;
  private loggedUnmapped: Set<number> = new Set();

  // Callbacks
  public onTtyChar?: TtyCallback;
  public onLog?: MemoryLogCallback;
  public isLoggingPaused: boolean = false;
  public debugLogging: boolean = false;

  // Cycle accumulation for coarse peripheral ticking
  public cycleAccumulator: number = 0;
  public onFlushCycles?: (cycles: number) => void;

  public flushCycles(): void {
    if (this.cycleAccumulator > 0) {
      const cycles = this.cycleAccumulator;
      this.cycleAccumulator = 0;
      if (this.onFlushCycles) {
        this.onFlushCycles(cycles);
      }
    }
  }

  public checkDmaCdrom(): void {
    if ((this.dma3Chcr & 0x01000000) !== 0 || (this.dma3Chcr & 0x10000000) !== 0 || ((this.dma3Chcr >>> 9) & 3) === 1) {
      if (this.cdrom) {
        this.dma.dma3Madr = this.dma3Madr;
        this.dma.dma3Bcr = this.dma3Bcr;
        this.dma.dma3Chcr = this.dma3Chcr;
        if (this.dma.executeDma3(this, this.cdrom)) {
          this.dma3Madr = this.dma.dma3Madr;
          this.dma3Bcr = this.dma.dma3Bcr;
          this.dma3Chcr = this.dma.dma3Chcr;
          this.safeWriteIo32(0x1f8010b0 - 0x1f801000, this.dma3Madr);
          this.safeWriteIo32(0x1f8010b4 - 0x1f801000, this.dma3Bcr);
          this.safeWriteIo32(0x1f8010b8 - 0x1f801000, this.dma3Chcr);
        }
      }
    }
  }

  public checkDma(): void {
    this.checkDmaCdrom();
  }

  public tickDma(): void {
    this.checkDma();
  }

  public tick(): void {
    this.addCycles(1);
  }

  private logEvent(level: 'system' | 'bios' | 'gpu' | 'error' | 'warn', msg: string, addr?: number): void {
    if (this.isLoggingPaused) return;
    if (this.onLog) {
      this.onLog(level, msg, addr);
    }
  }

  // External GPU reference
  public gpu?: Gpu;
  public currentCpuPc: number = 0;
  private ioReadLogCount: Map<number, number> = new Map();
  public gpuReadHandler?: () => number;
  public gpuStatHandler?: () => number;
  public gpuWriteHandler?: (val: number) => void;
  public gpuGp1Handler?: (val: number) => void;
  public gpuBatchHandler?: (words: number[]) => void;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.ram.fill(0);
    this.scratchpad.fill(0);
    this.io.fill(0);
    this.iStat = 0;
    this.iStat &= ~8;
    this.iMask = 0;
    this.updateInterrupts();
    this.dpcr = 0x07654321;
    this.irqFlags = 0;
    this.irqEnables = 0;
    this.forceIrq = false;
    this.masterEnable = false;
    this.dicrLow = 0;
    this.masterFlag = false;
    this.ramSize = 0x00000B88;
    this.cacheControl = 0;
    this.timerTicks = 0;
    this.vblankCount = 0;
    this.timersCtrl.reset();
    this.sio.reset();
    this.dma2Madr = 0;
    this.dma2Bcr = 0;
    this.dma2Chcr = 0;
    this.dma3Madr = 0;
    this.dma3Bcr = 0;
    this.dma3Chcr = 0;
    this.hasLoggedHistogram = false;
    this.lastFrameOpcodes = {};

    // CD-ROM Controller Reset
    this.cdromIndex = 0;
    this.hasDiscLoaded = this.cdrom ? this.cdrom.hasDisc : this.hasDiscLoaded;
    this.cdromResponseFifo = [];
    this.cdromParameterFifo = [];
    this.cdromInterruptFlag = 0;
    this.cdromInterruptEnable = 0x1f;
    this.hasLoggedFirstCdromAccess = false;
    this._cdLogCount = 0;

    this.isCacheIsolated = false;
    this.loggedUnmapped.clear();

    // RAM read/write roundtrip startup test
    this.write32(0x00001000, 0x12345678);
    this.write32(0x00001000, 0);
  }

  public addCycles(cycles: number): void {
    this.timerTicks = (this.timerTicks + cycles) & 0xffff;
    this.timersCtrl.advanceCycles(cycles, (irqBit) => this.triggerInterrupt(irqBit));

    if (this.cdrom) {
      this.cdrom.advanceCycles(cycles);
    }
  }

  public static readonly CDROM_CMD_NAMES: Record<number, string> = {
    0x01: 'Getstat',
    0x02: 'Setloc',
    0x03: 'Play',
    0x04: 'Forward',
    0x05: 'Backward',
    0x06: 'ReadN',
    0x07: 'MotorOn',
    0x08: 'Stop',
    0x09: 'Pause',
    0x0A: 'Init',
    0x0B: 'Mute',
    0x0C: 'Demute',
    0x0D: 'Setfilter',
    0x0E: 'Setmode',
    0x0F: 'Getparam',
    0x10: 'GetlocL',
    0x11: 'GetlocP',
    0x12: 'Setsession',
    0x13: 'GetTN',
    0x14: 'GetTD',
    0x15: 'SeekL',
    0x16: 'SeekP',
    0x19: 'Test',
    0x1A: 'GetID',
    0x1B: 'ReadS',
    0x1C: 'Reset',
    0x1D: 'GetQ',
    0x1E: 'ReadTOC',
  };

  /**
   * CD-ROM Controller Register Read Handlers (0x1F801800 - 0x1F801803)
   */
  public readCdrom(port: number): number {
    if (this.cdrom) {
      return this.cdrom.readRegister(port);
    }
    this.cdromReadsCount++;
    let result = 0;

    switch (port) {
      case 0: {
        // Port 0x1F801800: Status register
        // Bit 0-1: Currently selected index
        // Bit 2: ADPCM busy (0)
        // Bit 3: Parameter FIFO empty (1)
        // Bit 4: Parameter FIFO writable (1) / Shell Open when index == 0
        // Bit 5: Response FIFO not empty
        // Bit 6: Data FIFO not empty (0)
        // Bit 7: Transmission busy (0 = idle / ready)
        let status = 0x18 | (this.cdromIndex & 3);
        if (this.cdromResponseFifo.length > 0) {
          status |= (1 << 5);
        }
        if (!this.hasDiscLoaded) {
          status |= 0x10; // 0x10 = STATUS_SHELL_OPEN
        }
        result = status;
        break;
      }

      case 1: {
        // Port 0x1F801801: Response FIFO read (pop byte)
        if (this.cdromResponseFifo.length > 0) {
          result = this.cdromResponseFifo.shift()!;
        } else {
          result = this.hasDiscLoaded ? 0x02 : 0x10; // 0x02 = Motor on / ready, 0x10 = Shell open
        }
        break;
      }

      case 2: {
        // Port 0x1F801802: Data FIFO or Interrupt Enable
        if (this.cdromIndex === 1) {
          result = this.cdromInterruptEnable;
        } else {
          result = 0x00;
        }
        break;
      }

      case 3: {
        // Port 0x1F801803: Interrupt Flag register
        // Bit 0-2: Interrupt code (INT3 = first response)
        // Bit 3: Parameter FIFO empty (1)
        // Bit 4: Response FIFO not empty
        // Bit 5-7: Fixed 1 (0xE0)
        let flag = 0xe0 | (this.cdromInterruptFlag & 0x07);
        if (this.cdromParameterFifo.length === 0) flag |= 0x08;
        if (this.cdromResponseFifo.length > 0) flag |= 0x10;
        result = flag;
        break;
      }

      default:
        result = 0;
        break;
    }

    // if (this._cdLogCount < 25) {
    //   this._cdLogCount++;
    //   console.log(`[CD-ROM IO #${this._cdLogCount}] Port: ${port}, Op: READ -> 0x${result.toString(16).padStart(2, '0')}`);
    // }

    return result;
  }

  /**
   * CD-ROM Controller Register Write Handlers (0x1F801800 - 0x1F801803)
   */
  public writeCdrom(port: number, val: number): void {
    if (this.cdrom) {
      this.cdrom.writeRegister(port, val);
      return;
    }
    val = val & 0xff;
    this.cdromWritesCount++;

    // if (this._cdLogCount < 25) {
    //   this._cdLogCount++;
    //   console.log(`[CD-ROM IO #${this._cdLogCount}] Port: ${port}, Op: WRITE 0x${val.toString(16).padStart(2, '0')}`);
    // }

    switch (port) {
      case 0: // 0x1F801800: Index select
        this.cdromIndex = val & 3;
        break;

      case 1: // 0x1F801801: Command register (Index 0) or parameter
        if (this.cdromIndex === 0) {
          const cmd = val;
          const cmdName = Memory.CDROM_CMD_NAMES[cmd] || `Unknown_0x${cmd.toString(16).padStart(2, '0')}`;
          const currentParams = [...this.cdromParameterFifo];
          console.log(`[CD-ROM CMD] 0x${cmd.toString(16).padStart(2, '0').toUpperCase()} (${cmdName}) Params: [${currentParams.map(p => '0x' + p.toString(16)).join(', ')}]`);
          this.cdromCommandHistory.push({
            cmd,
            name: cmdName,
            params: currentParams,
            cycle: this.timerTicks,
          });

          this.cdromParameterFifo = []; // clear parameter FIFO

          const currentStatus = this.hasDiscLoaded ? 0x02 : 0x10; // 0x02 = Motor on / ready, 0x10 = Shell open

          // Prepare response FIFO based on command
          if (cmd === 0x19) {
            // Test command
            this.cdromResponseFifo = []; // Clear response FIFO
            const subFn = currentParams.length > 0 ? currentParams[0] : 0x20;
            if (subFn === 0x20 || currentParams.length === 0) {
              // Subfunction 0x20: Get Firmware Version -> [YY, MM, DD, Ver] (0x94, 0x09, 0x19, 0xC0)
              this.cdromResponseFifo = [0x94, 0x09, 0x19, 0xc0];
            } else {
              // Subfunction 0x04 or other test subfunctions -> return current status
              this.cdromResponseFifo = [currentStatus];
            }
            this.cdromParameterFifo = []; // Ensure parameter FIFO is cleared
            this.cdromInterruptFlag = 3; // INT3 (Acknowledge)
          } else if (cmd === 0x1a) {
            // GetID: return standard disc header info or ShellOpen/Disc Error when no ISO is loaded
            if (this.hasDiscLoaded) {
              this.cdromResponseFifo = [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41];
              this.cdromInterruptFlag = 3; // INT3
            } else {
              // No disc: respond with INT5 (stat 0x08 / 0x10, error 0x40, 0x00...)
              this.cdromResponseFifo = [0x08, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
              this.cdromInterruptFlag = 5; // INT5 (Disc Error / Shell Open)
            }
          } else if (!this.hasDiscLoaded && (cmd === 0x02 || cmd === 0x06 || cmd === 0x15 || cmd === 0x1b)) {
            // Setloc (0x02), ReadN (0x06), SeekL (0x15), ReadS (0x1b) without disc -> Error INT5
            this.cdromResponseFifo = [0x14]; // 0x10 | 0x04 (ShellOpen | Error)
            this.cdromInterruptFlag = 5; // INT5
          } else if (cmd === 0x01) {
            // Getstat
            this.cdromResponseFifo = [currentStatus];
            this.cdromInterruptFlag = 3; // INT3
          } else {
            // Standard commands (0x09 Pause, 0x0A Init, etc.)
            if (!Memory.CDROM_CMD_NAMES[cmd]) {
              console.warn(`[CD-ROM UNHANDLED COMMAND] Cmd: 0x${cmd.toString(16).toUpperCase()} Params: [${currentParams.join(', ')}]`);
            }
            this.cdromResponseFifo = [currentStatus];
            this.cdromInterruptFlag = 3; // INT3
          }

          // Pulse I_STAT bit 2 (CD-ROM IRQ)
          this.triggerInterrupt(2);
        } else {
          this.cdromParameterFifo.push(val);
        }
        break;

      case 2: // 0x1F801802: Parameter FIFO (Index 0) or Interrupt Enable (Index 1)
        if (this.cdromIndex === 0) {
          this.cdromParameterFifo.push(val);
        } else if (this.cdromIndex === 1) {
          this.cdromInterruptEnable = val & 0x1f;
        }
        break;

      case 3: // 0x1F801803: Request register (Index 0) or Interrupt Flag Acknowledge (Index 1)
        if (this.cdromIndex === 0) {
          if ((val & 0x80) !== 0) {
            this.cdromResponseFifo = [];
          }
        } else if (this.cdromIndex === 1) {
          const ackFlags = val & 0x07;
          this.cdromInterruptFlag &= ~ackFlags;
          if ((val & 0x40) !== 0) {
            this.cdromParameterFifo = [];
          }
          if ((this.cdromInterruptFlag & 0x07) === 0) {
            // All CD-ROM pending interrupts cleared, ensure I_STAT bit 2 is dropped if pending
            this.iStat &= ~(1 << 2);
            this.updateInterrupts();
          }
        }
        break;
    }
  }

  public getCdromActivitySummary(): string {
    const cmdList = this.cdromCommandHistory.map(c => `0x${c.cmd.toString(16).toUpperCase()} (${c.name})`).join(', ');
    return `CD-ROM Controller Status: Total Reads: ${this.cdromReadsCount}, Total Writes: ${this.cdromWritesCount}, Commands: ${cmdList || 'None'}`;
  }

  public updateInterrupts(): void {
    if (this.cpu) {
      if ((this.iStat & this.iMask) === 0) {
        this.cpu.clearInterruptPending(2); // Clear IP2 (bit 10 of Cause)
      } else {
        this.cpu.setInterruptPending(2); // Assert IP2 (bit 10 of Cause)
      }
    }
  }

  public triggerInterrupt(bit: number): void {
    // GPU VBLANK sets Bit 0 in I_STAT (0x1F801070)
    this.iStat |= (1 << bit);
    this.updateInterrupts();

    if (bit === 0) {
      this.vblankCount++;
    }
  }

  public writeIStat(val: number): void {
    // On PS1 hardware, writing 0 to a bit acknowledges (clears) it: I_STAT = I_STAT & val
    this.iStat = (this.iStat & val) & 0x7ff;
    this.updateInterrupts();
  }

  public loadBios(data: Uint8Array): void {
    if (data.length > this.bios.length) {
      // If greater, copy up to 512KB
      this.bios.set(data.subarray(0, this.bios.length));
    } else {
      this.bios.fill(0);
      this.bios.set(data);
    }
  }

  /**
   * Translate virtual address to physical address in PS1 memory map
   * KUSEG: 0x00000000 - 0x7FFFFFFF (direct to RAM/IO: vaddr & 0x1FFFFFFF)
   * KSEG0: 0x80000000 - 0x9FFFFFFF (cached: vaddr & 0x1FFFFFFF)
   * KSEG1: 0xA0000000 - 0xBFFFFFFF (uncached: vaddr & 0x1FFFFFFF)
   * KSEG2: 0xC0000000 - 0xFFFFFFFF
   */
  public maskAddress(vaddr: number): number {
    return (vaddr & 0x1fffffff) >>> 0;
  }

  /**
   * Checks whether a virtual address is mapped to valid physical memory
   */
  public isMappedAddress(vaddr: number): boolean {
    const paddr = this.maskAddress(vaddr);
    if (paddr < 0x1f000000) {
      if (vaddr < 0x80000000) return vaddr < 0x00200000;
      return true;
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) return true; // Scratchpad
    if (paddr >= 0x1f801000 && paddr < 0x1f803000) return true; // IO
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) return true; // BIOS ROM
    return false;
  }

  /**
   * Checks whether a virtual address is valid for CPU instruction fetch.
   * Instructions can only be fetched from RAM (<=2MB) or BIOS ROM.
   */
  public isInstructionFetchMapped(vaddr: number): boolean {
    const paddr = this.maskAddress(vaddr);
    if (paddr < 0x1f000000) {
      if (vaddr < 0x80000000) return vaddr < 0x00200000;
      return true;
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) return true; // Execute from Scratchpad
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) return true;
    return false;
  }

  // ==========================================
  // SAFE BOUNDS-CHECKED MEMORY ACCESS HELPERS
  // ==========================================
  public safeReadRam32(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.ram.length - 4) {
      if ((offset & 3) === 0) {
        return this.ram32[offset >>> 2];
      }
      return this.ramView.getUint32(offset, true);
    }
    if (offset < this.ram.length) {
      return (
        this.ram[offset] |
        ((this.ram[(offset + 1) & 0x1fffff] || 0) << 8) |
        ((this.ram[(offset + 2) & 0x1fffff] || 0) << 16) |
        ((this.ram[(offset + 3) & 0x1fffff] || 0) << 24)
      ) >>> 0;
    }
    return 0;
  }

  public safeWriteRam32(offset: number, val: number): void {
    offset = offset >>> 0;
    val = val >>> 0;
    if (this.recompiler) {
      this.recompiler.invalidateAddress(offset, 4);
    }
    if (offset <= this.ram.length - 4) {
      if ((offset & 3) === 0) {
        this.ram32[offset >>> 2] = val;
      } else {
        this.ramView.setUint32(offset, val, true);
      }
    } else if (offset < this.ram.length) {
      this.ram[offset] = val & 0xff;
      this.ram[(offset + 1) & 0x1fffff] = (val >>> 8) & 0xff;
      this.ram[(offset + 2) & 0x1fffff] = (val >>> 16) & 0xff;
      this.ram[(offset + 3) & 0x1fffff] = (val >>> 24) & 0xff;
    }
  }

  private safeReadRam16(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.ram.length - 2) {
      return this.ramView.getUint16(offset, true);
    }
    if (offset < this.ram.length) {
      return (this.ram[offset] | ((this.ram[(offset + 1) & 0x1fffff] || 0) << 8)) & 0xffff;
    }
    return 0;
  }

  private safeWriteRam16(offset: number, val: number): void {
    offset = offset >>> 0;
    val = val & 0xffff;
    if (this.recompiler) {
      this.recompiler.invalidateAddress(offset, 2);
    }
    if (offset <= this.ram.length - 2) {
      this.ramView.setUint16(offset, val, true);
    } else if (offset < this.ram.length) {
      this.ram[offset] = val & 0xff;
      this.ram[(offset + 1) & 0x1fffff] = (val >>> 8) & 0xff;
    }
  }

  private safeReadBios32(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.bios.length - 4) {
      return this.biosView.getUint32(offset, true);
    }
    if (offset < this.bios.length) {
      return (
        this.bios[offset] |
        ((this.bios[(offset + 1) % this.bios.length] || 0) << 8) |
        ((this.bios[(offset + 2) % this.bios.length] || 0) << 16) |
        ((this.bios[(offset + 3) % this.bios.length] || 0) << 24)
      ) >>> 0;
    }
    return 0;
  }

  private safeReadBios16(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.bios.length - 2) {
      return this.biosView.getUint16(offset, true);
    }
    if (offset < this.bios.length) {
      return (this.bios[offset] | ((this.bios[(offset + 1) % this.bios.length] || 0) << 8)) & 0xffff;
    }
    return 0;
  }

  private safeReadScratchpad32(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.scratchpad.length - 4) {
      return this.scratchpadView.getUint32(offset, true);
    }
    if (offset < this.scratchpad.length) {
      return (
        this.scratchpad[offset] |
        ((this.scratchpad[(offset + 1) % 1024] || 0) << 8) |
        ((this.scratchpad[(offset + 2) % 1024] || 0) << 16) |
        ((this.scratchpad[(offset + 3) % 1024] || 0) << 24)
      ) >>> 0;
    }
    return 0;
  }

  private safeWriteScratchpad32(offset: number, val: number): void {
    offset = offset >>> 0;
    val = val >>> 0;
    if (offset <= this.scratchpad.length - 4) {
      this.scratchpadView.setUint32(offset, val, true);
    } else if (offset < this.scratchpad.length) {
      this.scratchpad[offset] = val & 0xff;
      this.scratchpad[(offset + 1) % 1024] = (val >>> 8) & 0xff;
      this.scratchpad[(offset + 2) % 1024] = (val >>> 16) & 0xff;
      this.scratchpad[(offset + 3) % 1024] = (val >>> 24) & 0xff;
    }
  }

  private safeReadScratchpad16(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.scratchpad.length - 2) {
      return this.scratchpadView.getUint16(offset, true);
    }
    if (offset < this.scratchpad.length) {
      return (this.scratchpad[offset] | ((this.scratchpad[(offset + 1) % 1024] || 0) << 8)) & 0xffff;
    }
    return 0;
  }

  private safeWriteScratchpad16(offset: number, val: number): void {
    offset = offset >>> 0;
    val = val & 0xffff;
    if (offset <= this.scratchpad.length - 2) {
      this.scratchpadView.setUint16(offset, val, true);
    } else if (offset < this.scratchpad.length) {
      this.scratchpad[offset] = val & 0xff;
      this.scratchpad[(offset + 1) % 1024] = (val >>> 8) & 0xff;
    }
  }

  private safeReadIo32(offset: number): number {
    offset = offset >>> 0;
    if (offset <= this.io.length - 4) {
      return this.ioView.getUint32(offset, true);
    }
    return 0;
  }

  private safeWriteIo32(offset: number, val: number): void {
    offset = offset >>> 0;
    val = val >>> 0;
    if (offset <= this.io.length - 4) {
      this.ioView.setUint32(offset, val, true);
    }
  }

  // ==========================================
  // 32-BIT READ
  // ==========================================
  public read32(vaddr: number): number {
    const paddr = this.maskAddress(vaddr);
    this.recordReadAddress(vaddr, (paddr >= 0x1f800000 && paddr < 0x1f803000));
    if ((paddr & 0x1fff0000) === 0x1f800000 && this.cycleAccumulator > 0) {
      this.flushCycles();
    }

    // Main RAM & Mirrors (0x00000000 - 0x1EFFFFFF, 2 MB wrap mask: paddr & 0x001FFFFF)
    if (paddr < 0x1f000000) {
      return this.safeReadRam32(paddr & 0x001fffff);
    }

    // BIOS ROM (512 KB: 0x1FC00000 - 0x1FC7FFFF)
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) {
      return this.safeReadBios32(paddr - 0x1fc00000);
    }

    // Scratchpad / D-Cache (1 KB: 0x1F800000 - 0x1F8003FF)
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      return this.safeReadScratchpad32(paddr - 0x1f800000);
    }

    // Hardware IO Registers
    if (paddr >= 0x1f801000 && paddr < 0x1f803000) {
      return this.readIo32(paddr);
    }

    // Expansion Region 1 (512 KB: 0x1F000000 - 0x1F07FFFF)
    if (paddr >= 0x1f000000 && paddr < 0x1f080000) {
      // if (this.debugLogging && paddr === 0x1f000084) {
      //   console.log(`[EXPANSION TRAP] Read from 0x1F000084 (Expansion Region 1)`);
      // }
      return 0xffffffff;
    }

    // Cache Control (0xFFFE0130)
    if (vaddr === 0xfffe0130) {
      return this.cacheControl;
    }

    // Fallback: unmapped read returns 0xFFFFFFFF (open bus)
    const hex = `0x${paddr.toString(16).toUpperCase()}`;
    logWarnRateLimited(`unmapped_read32_${paddr}`, `[Memory] Unhandled Hardware Read32 from unmapped address: ${hex}`);
    return 0xffffffff;
  }

  // ==========================================
  // 16-BIT READ
  // ==========================================
  public read16(vaddr: number): number {
    const paddr = this.maskAddress(vaddr);
    this.recordReadAddress(vaddr, true);
    if ((paddr & 0x1fff0000) === 0x1f800000 && this.cycleAccumulator > 0) {
      this.flushCycles();
    }

    // Main RAM & Mirrors (0x00000000 - 0x1EFFFFFF, 2 MB wrap mask: paddr & 0x001FFFFF)
    if (paddr < 0x1f000000) {
      return this.safeReadRam16(paddr & 0x001fffff);
    }
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) {
      return this.safeReadBios16(paddr - 0x1fc00000);
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      return this.safeReadScratchpad16(paddr - 0x1f800000);
    }
    if (paddr >= 0x1f801800 && paddr <= 0x1f801803) {
      if ((paddr & 3) === 2 && this.cdrom && (this.cdrom.index === 0 || this.cdrom.index === 2)) {
        return this.cdrom.readDataHalfword();
      }
      const b0 = this.readCdrom(paddr & 3);
      const b1 = this.readCdrom((paddr + 1) & 3);
      return (b0 | (b1 << 8)) & 0xffff;
    }
    if (paddr === 0x1f801040) {
      return this.readJoyData();
    }
    if (paddr === 0x1f801044) {
      return this.readJoyStat() & 0xffff;
    }
    if (paddr === 0x1f801048) {
      return this.joyMode & 0xffff;
    }
    if (paddr === 0x1f80104a) {
      return this.joyCtrl & 0xffff;
    }
    if (paddr === 0x1f80104e) {
      return this.joyBaud & 0xffff;
    }
    if (paddr >= 0x1f801100 && paddr <= 0x1f801128) {
      return this.readTimer16(paddr);
    }
    if (paddr >= 0x1f801000 && paddr < 0x1f803000) {
      return (this.readIo32(paddr & ~3) >>> ((paddr & 2) * 8)) & 0xffff;
    }

    if (paddr >= 0x1f000000 && paddr < 0x1f080000) {
      return 0xffff;
    }

    const hex = `0x${paddr.toString(16).toUpperCase()}`;
    logWarnRateLimited(`unmapped_read16_${paddr}`, `[Memory] Unhandled Hardware Read16 from unmapped address: ${hex}`);
    return 0xffff;
  }

  // ==========================================
  // 8-BIT READ
  // ==========================================
  public read8(vaddr: number): number {
    const paddr = this.maskAddress(vaddr);
    this.recordReadAddress(vaddr, true);
    if ((paddr & 0x1fff0000) === 0x1f800000 && this.cycleAccumulator > 0) {
      this.flushCycles();
    }

    // Main RAM & Mirrors (0x00000000 - 0x1EFFFFFF, 2 MB wrap mask: paddr & 0x001FFFFF)
    if (paddr < 0x1f000000) {
      return this.ram[paddr & 0x001fffff] || 0;
    }
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) {
      const off = paddr - 0x1fc00000;
      return off < this.bios.length ? this.bios[off] : 0;
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      const off = paddr - 0x1f800000;
      return off < this.scratchpad.length ? this.scratchpad[off] : 0;
    }
    if (paddr >= 0x1f801800 && paddr <= 0x1f801803) {
      return this.readCdrom(paddr & 3);
    }
    if (paddr === 0x1f801040) {
      return this.readJoyData();
    }
    if (paddr === 0x1f801044) {
      return this.readJoyStat() & 0xff;
    }
    if (paddr === 0x1f801045) {
      return (this.readJoyStat() >>> 8) & 0xff;
    }
    if (paddr >= 0x1f801000 && paddr < 0x1f803000) {
      const w = this.readIo32(paddr & ~3);
      return (w >>> ((paddr & 3) * 8)) & 0xff;
    }

    if (paddr >= 0x1f000000 && paddr < 0x1f080000) {
      return 0xff;
    }

    const hex = `0x${paddr.toString(16).toUpperCase()}`;
    logWarnRateLimited(`unmapped_read8_${paddr}`, `[Memory] Unhandled Hardware Read8 from unmapped address: ${hex}`);
    return 0xff;
  }

  // ==========================================
  // 32-BIT WRITE
  // ==========================================
  public write32(vaddr: number, val: number): void {
    val = val >>> 0;

    // Cache Control (0xFFFE0130)
    if (vaddr === 0xfffe0130) {
      this.cacheControl = val;
      return;
    }

    const paddr = this.maskAddress(vaddr);
    if ((paddr & 0x1fff0000) === 0x1f800000 && this.cycleAccumulator > 0) {
      this.flushCycles();
    }

    // RAM (Cache isolation check, 2 MB wrap mask)
    if (paddr < 0x1f000000) {
      if (this.isCacheIsolated) return;
      this.safeWriteRam32(paddr & 0x001fffff, val);
      return;
    }

    // Scratchpad
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      this.safeWriteScratchpad32(paddr - 0x1f800000, val);
      return;
    }

    // Hardware IO
    if (paddr >= 0x1f801000 && paddr < 0x1f803000) {
      this.writeIo32(paddr, val);
      return;
    }

    // Attempted write to BIOS ROM
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) {
      return;
    }

    // Unmapped write
    const hex = `0x${paddr.toString(16).toUpperCase()}`;
    logWarnRateLimited(`unmapped_write32_${paddr}`, `[Memory] Unhandled Hardware Write32 to unmapped address: ${hex} = 0x${val.toString(16).toUpperCase()}`);
    if (this.onLog && !this.loggedUnmapped.has(paddr)) {
      this.loggedUnmapped.add(paddr);
      this.onLog(
        'warn',
        `Unmapped MMIO write32: 0x${paddr.toString(16).toUpperCase()} = 0x${val.toString(16).toUpperCase()}`,
        paddr
      );
    }
  }

  // ==========================================
  // 16-BIT WRITE
  // ==========================================
  public write16(vaddr: number, val: number): void {
    val = val & 0xffff;
    const paddr = this.maskAddress(vaddr);
    if ((paddr & 0x1fff0000) === 0x1f800000 && this.cycleAccumulator > 0) {
      this.flushCycles();
    }

    // RAM (Cache isolation check, 2 MB wrap mask)
    if (paddr < 0x1f000000) {
      if (this.isCacheIsolated) return;
      this.safeWriteRam16(paddr & 0x001fffff, val);
      return;
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      this.safeWriteScratchpad16(paddr - 0x1f800000, val);
      return;
    }
    if (paddr >= 0x1f801000 && paddr < 0x1f803000) {
      if (paddr === 0x1f801070) {
        this.writeIStat(val & 0xffff);
        return;
      }
      if (paddr === 0x1f801072) {
        return;
      }
      if (paddr === 0x1f801074) {
        this.iMask = val & 0xffff;
        this.updateInterrupts();
        return;
      }
      if (paddr === 0x1f801076) {
        return;
      }
      if (paddr === 0x1f8010f4) {
        this.dicrLow = val & 0x7fff;
        this.forceIrq = (val & 0x8000) !== 0;
        this.updateMasterFlag();
        return;
      }
      if (paddr === 0x1f8010f6) {
        this.irqEnables = val & 0x7f;
        this.masterEnable = (val & (1 << 7)) !== 0;
        const w1cFlags = (val >> 8) & 0x7f;
        this.irqFlags &= ~w1cFlags;
        this.updateMasterFlag();
        return;
      }
      if (paddr >= 0x1f801800 && paddr <= 0x1f801803) {
        this.writeCdrom(paddr & 3, val & 0xff);
        this.writeCdrom((paddr + 1) & 3, (val >>> 8) & 0xff);
        return;
      }
      if (paddr === 0x1f801040) {
        this.writeJoyData(val & 0xff);
        return;
      }
      if (paddr === 0x1f801048) {
        this.joyMode = val & 0xffff;
        return;
      }
      if (paddr === 0x1f80104a) {
        this.writeJoyCtrl(val & 0xffff);
        return;
      }
      if (paddr === 0x1f80104e) {
        this.joyBaud = val & 0xffff;
        return;
      }
      if (paddr >= 0x1f801100 && paddr <= 0x1f801128) {
        this.writeTimer16(paddr, val);
        return;
      }
      const aligned = paddr & ~3;
      const current = this.readIo32(aligned);
      const shift = (paddr & 2) * 8;
      const mask = ~(0xffff << shift);
      this.writeIo32(aligned, ((current & mask) | (val << shift)) >>> 0);
      return;
    }

    const hex = `0x${paddr.toString(16).toUpperCase()}`;
    logWarnRateLimited(`unmapped_write16_${paddr}`, `[Memory] Unhandled Hardware Write16 to unmapped address: ${hex} = 0x${val.toString(16).toUpperCase()}`);
    if (this.onLog && !this.loggedUnmapped.has(paddr)) {
      this.loggedUnmapped.add(paddr);
      this.onLog('warn', `Unmapped MMIO write16: ${hex} = 0x${val.toString(16).toUpperCase()}`, paddr);
    }
  }

  // ==========================================
  // 8-BIT WRITE
  // ==========================================
  public write8(vaddr: number, val: number): void {
    val = val & 0xff;
    const paddr = this.maskAddress(vaddr);
    if ((paddr & 0x1fff0000) === 0x1f800000 && this.cycleAccumulator > 0) {
      this.flushCycles();
    }

    // RAM (Cache isolation check, 2 MB wrap mask)
    if (paddr < 0x1f000000) {
      if (this.isCacheIsolated) return;
      const ramAddr = paddr & 0x001fffff;
      if (this.recompiler) this.recompiler.invalidateAddress(ramAddr, 1);
      this.ram[ramAddr] = val;
      return;
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      this.scratchpad[paddr - 0x1f800000] = val;
      return;
    }

    // SIO0 / Controller Data Register
    if (paddr === 0x1f801040) {
      this.writeJoyData(val);
      return;
    }

    // CD-ROM Controller 8-bit writes (0x1F801800 - 0x1F801803)
    if (paddr >= 0x1f801800 && paddr <= 0x1f801803) {
      this.writeCdrom(paddr & 3, val);
      return;
    }

    // I_STAT byte writes (0=clear, 1=no change)
    if (paddr === 0x1f801070) {
      this.writeIStat(0xff00 | (val & 0xff));
      return;
    }
    if (paddr === 0x1f801071) {
      this.writeIStat(((val & 0xff) << 8) | 0x00ff);
      return;
    }
    if (paddr === 0x1f801072 || paddr === 0x1f801073) {
      return;
    }

    // I_MASK byte writes
    if (paddr === 0x1f801074) {
      this.iMask = (this.iMask & 0xff00) | (val & 0xff);
      this.updateInterrupts();
      return;
    }
    if (paddr === 0x1f801075) {
      this.iMask = (this.iMask & 0x00ff) | ((val & 0xff) << 8);
      this.updateInterrupts();
      return;
    }

    // TTY serial debug port (0x1F801050 or Expansion 2 debug write)
    if (paddr === 0x1f801050 || paddr === 0x1f802023 || paddr === 0x1f802020) {
      if (this.onTtyChar) {
        this.onTtyChar(String.fromCharCode(val));
      }
      return;
    }

    // POST Diagnostic Register (0x1F802041)
    if (paddr === 0x1f802041) {
      if (this.onLog) {
        this.onLog(
          'bios',
          `[POST] BIOS Checkpoint: 0x${val.toString(16).padStart(2, '0').toUpperCase()}`,
          paddr
        );
      }
      return;
    }

    // JOY_DATA (0x1F801040)
    if (paddr === 0x1f801040) {
      this.writeJoyData(val & 0xff);
      return;
    }
    // JOY_CTRL (0x1F80104A / 0x1F80104B)
    if (paddr === 0x1f80104a) {
      this.writeJoyCtrl((this.joyCtrl & 0xff00) | (val & 0xff));
      return;
    }
    if (paddr === 0x1f80104b) {
      this.writeJoyCtrl((this.joyCtrl & 0x00ff) | ((val & 0xff) << 8));
      return;
    }

    if (paddr >= 0x1f801000 && paddr < 0x1f803000) {
      const aligned = paddr & ~3;
      const current = this.readIo32(aligned);
      const shift = (paddr & 3) * 8;
      const mask = ~(0xff << shift);
      this.writeIo32(aligned, ((current & mask) | (val << shift)) >>> 0);
      return;
    }

    const hex = `0x${paddr.toString(16).toUpperCase()}`;
    logWarnRateLimited(`unmapped_write8_${paddr}`, `[Memory] Unhandled Hardware Write8 to unmapped address: ${hex} = 0x${val.toString(16).toUpperCase()}`);
    if (this.onLog && !this.loggedUnmapped.has(paddr)) {
      this.loggedUnmapped.add(paddr);
      this.onLog('warn', `Unmapped MMIO write8: ${hex} = 0x${val.toString(16).toUpperCase()}`, paddr);
    }
  }

  // ==========================================
  // IO REGISTERS
  // ==========================================
  private readIo32(paddr: number): number {
    switch (paddr) {
      case 0x1f801010: // EXP1 Base
        return 0x1f000000;
      case 0x1f801014: // EXP2 Base
        return 0x1f802000;
      case 0x1f801060: // RAM_SIZE
        return this.ramSize;
      case 0x1f801070: // I_STAT
        return this.iStat;
      case 0x1f801074: // I_MASK
        return this.iMask;
      case 0x1f8010a0: // DMA 2 (GPU) Base Address (MADR2)
        return this.dma2Madr;
      case 0x1f8010a4: // DMA 2 (GPU) Block Control (BCR2)
        return this.dma2Bcr;
      case 0x1f8010a8: // DMA 2 (GPU) Channel Control (CHCR2)
        return this.dma2Chcr;
      case 0x1f8010b0: // DMA 3 (CD-ROM) Base Address (MADR3)
        return this.dma3Madr;
      case 0x1f8010b4: // DMA 3 (CD-ROM) Block Control (BCR3)
        return this.dma3Bcr;
      case 0x1f8010b8: // DMA 3 (CD-ROM) Channel Control (CHCR3)
        return this.dma3Chcr;
      case 0x1f801040: // JOY_DATA
        return this.readJoyData();
      case 0x1f801044: // JOY_STAT
        return this.readJoyStat();
      case 0x1f801048: // JOY_MODE / JOY_CTRL
        return (this.joyMode & 0xffff) | ((this.joyCtrl & 0xffff) << 16);
      case 0x1f80104c:
      case 0x1f80104e:
        return this.joyBaud & 0xffff;
      case 0x1f8010f0: // DPCR
        return this.dpcr;
      case 0x1f8010f4: // DICR
        return this.dicr;
      case 0x1f801100: // Timer 0 Counter
        return this.timersCtrl.readCounter(0);
      case 0x1f801104: // Timer 0 Mode
        return this.timersCtrl.readMode(0);
      case 0x1f801108: // Timer 0 Target
        return this.timersCtrl.readTarget(0);
      case 0x1f801110: // Timer 1 Counter
        return this.timersCtrl.readCounter(1);
      case 0x1f801114: // Timer 1 Mode
        return this.timersCtrl.readMode(1);
      case 0x1f801118: // Timer 1 Target
        return this.timersCtrl.readTarget(1);
      case 0x1f801120: // Timer 2 Counter
        return this.timersCtrl.readCounter(2);
      case 0x1f801124: // Timer 2 Mode
        return this.timersCtrl.readMode(2);
      case 0x1f801128: // Timer 2 Target
        return this.timersCtrl.readTarget(2);
      case 0x1f801800: // CD-ROM Controller Registers (0x1F801800 - 0x1F801803)
        return (this.readCdrom(0) | (this.readCdrom(1) << 8) | (this.readCdrom(2) << 16) | (this.readCdrom(3) << 24)) >>> 0;
      case 0x1f801802:
        if (this.cdrom && (this.cdrom.index === 0 || this.cdrom.index === 2)) {
          return this.cdrom.readDataWord();
        }
        return (this.readCdrom(2) | (this.readCdrom(3) << 8)) >>> 0;
      case 0x1f801810: // GP0 / GPUREAD
        return this.gpuReadHandler ? this.gpuReadHandler() : 0;
      case 0x1f801814: // GP1 / GPUSTAT
        {
          let stat = this.gpuStatHandler ? this.gpuStatHandler() : 0x1c802000;
          return (stat | (1 << 26) | (1 << 27) | (1 << 28)) >>> 0;
        }
      case 0x1f801824: // MDEC Status
        return 0x00000000;
      default:
        // Return stored generic IO register
        const offset = paddr - 0x1f801000;
        return this.safeReadIo32(offset);
    }
  }

  private writeIo32(paddr: number, val: number): void {
    switch (paddr) {
      case 0x1f801040: // JOY_DATA
        this.writeJoyData(val & 0xff);
        break;
      case 0x1f801048: // JOY_MODE / JOY_CTRL
        this.joyMode = val & 0xffff;
        this.writeJoyCtrl((val >>> 16) & 0xffff);
        break;
      case 0x1f801060: // RAM_SIZE
        this.ramSize = val;
        break;
      case 0x1f801070: // I_STAT
        this.writeIStat(val);
        break;
      case 0x1f801074: // I_MASK
        this.iMask = val & 0xFFFF;
        this.updateInterrupts();
        break;
      case 0x1f8010a0: // DMA 2 (GPU) Base Address (MADR2)
        this.dma.writeMadr2(val);
        this.dma2Madr = this.dma.dma2Madr;
        this.safeWriteIo32(0x1f8010a0 - 0x1f801000, this.dma2Madr);
        break;
      case 0x1f8010a4: // DMA 2 (GPU) Block Control (BCR2)
        this.dma.writeBcr2(val);
        this.dma2Bcr = this.dma.dma2Bcr;
        this.safeWriteIo32(0x1f8010a4 - 0x1f801000, this.dma2Bcr);
        break;
      case 0x1f8010a8: // DMA 2 (GPU) Channel Control (CHCR2)
        this.writeDmaGpu(val);
        break;
      case 0x1f8010b0: // DMA 3 (CD-ROM) Base Address (MADR3)
        this.dma.writeMadr3(val);
        this.dma3Madr = this.dma.dma3Madr;
        this.safeWriteIo32(0x1f8010b0 - 0x1f801000, this.dma3Madr);
        break;
      case 0x1f8010b4: // DMA 3 (CD-ROM) Block Control (BCR3)
        this.dma.writeBcr3(val);
        this.dma3Bcr = this.dma.dma3Bcr;
        this.safeWriteIo32(0x1f8010b4 - 0x1f801000, this.dma3Bcr);
        break;
      case 0x1f8010b8: // DMA 3 (CD-ROM) Channel Control (CHCR3)
        this.writeDmaCdrom(val);
        break;
      case 0x1f8010e8: // DMA 6 (OTC) Channel Control
        this.writeDmaOtc(val);
        break;
      case 0x1f8010f0: // DPCR
        this.dpcr = val;
        break;
      case 0x1f8010f4: // DICR - DMA Interrupt Register
        this.writeDicr(val);
        break;
      case 0x1f801100: // Timer 0 Counter
        this.timersCtrl.writeCounter(0, val);
        break;
      case 0x1f801104: // Timer 0 Mode
        this.timersCtrl.writeMode(0, val);
        break;
      case 0x1f801108: // Timer 0 Target
        this.timersCtrl.writeTarget(0, val);
        break;
      case 0x1f801110: // Timer 1 Counter
        this.timersCtrl.writeCounter(1, val);
        break;
      case 0x1f801114: // Timer 1 Mode
        this.timersCtrl.writeMode(1, val);
        break;
      case 0x1f801118: // Timer 1 Target
        this.timersCtrl.writeTarget(1, val);
        break;
      case 0x1f801120: // Timer 2 Counter
        this.timersCtrl.writeCounter(2, val);
        break;
      case 0x1f801124: // Timer 2 Mode
        this.timersCtrl.writeMode(2, val);
        break;
      case 0x1f801128: // Timer 2 Target
        this.timersCtrl.writeTarget(2, val);
        break;
      case 0x1f801800: // CD-ROM Controller Registers
        this.writeCdrom(0, val & 0xff);
        this.writeCdrom(1, (val >>> 8) & 0xff);
        this.writeCdrom(2, (val >>> 16) & 0xff);
        this.writeCdrom(3, (val >>> 24) & 0xff);
        break;
      case 0x1f801801:
        this.writeCdrom(1, val & 0xff);
        break;
      case 0x1f801802:
        this.writeCdrom(2, val & 0xff);
        break;
      case 0x1f801803:
        this.writeCdrom(3, val & 0xff);
        break;
      case 0x1f801810: // GP0 (Write commands to GPU)
        if (this.gpu) {
          this.gpu.sendGp0(val);
        } else if (this.gpuWriteHandler) {
          this.gpuWriteHandler(val);
        }
        break;
      case 0x1f801814: // GP1 (Write control to GPU)
        if (this.gpuGp1Handler) {
          this.gpuGp1Handler(val);
        }
        break;
      default:
        const offset = paddr - 0x1f801000;
        this.safeWriteIo32(offset, val);
        break;
    }
  }

  public writeDmaGpu(chcr: number): void {
    this.dma.dma2Madr = this.dma2Madr;
    this.dma.dma2Bcr = this.dma2Bcr;
    this.dma.writeChcr2(chcr, this, this.gpu);
    this.dma2Madr = this.dma.dma2Madr;
    this.dma2Bcr = this.dma.dma2Bcr;
    this.dma2Chcr = this.dma.dma2Chcr;
    this.safeWriteIo32(0x1f8010a0 - 0x1f801000, this.dma2Madr);
    this.safeWriteIo32(0x1f8010a4 - 0x1f801000, this.dma2Bcr);
    this.safeWriteIo32(0x1f8010a8 - 0x1f801000, this.dma2Chcr);
  }

  private writeDmaOtc(chcr: number): void {
    if ((chcr & 0x01000000) !== 0) {
      const madr = this.readIo32(0x1f8010e0);
      const bcr = this.readIo32(0x1f8010e4);
      let entries = bcr & 0xffff;
      let addr = madr & 0x1ffffc;
      while (entries > 1 && addr >= 4 && addr <= this.ram.length - 4) {
        this.safeWriteRam32(addr, (addr - 4) & 0x00ffffff);
        addr -= 4;
        entries--;
      }
      if (addr <= this.ram.length - 4) {
        this.safeWriteRam32(addr, 0x00ffffff);
      }
      this.safeWriteIo32(0x1f8010e8 - 0x1f801000, chcr & ~0x01000000);
      this.triggerDmaIrq(6);
    } else {
      this.safeWriteIo32(0x1f8010e8 - 0x1f801000, chcr);
    }
  }

  public writeDmaCdrom(chcr: number): void {
    this.dma.dma3Madr = this.dma3Madr;
    this.dma.dma3Bcr = this.dma3Bcr;
    this.dma.writeChcr3(chcr, this, this.cdrom);
    this.dma3Madr = this.dma.dma3Madr;
    this.dma3Bcr = this.dma.dma3Bcr;
    this.dma3Chcr = this.dma.dma3Chcr;
    this.safeWriteIo32(0x1f8010b0 - 0x1f801000, this.dma3Madr);
    this.safeWriteIo32(0x1f8010b4 - 0x1f801000, this.dma3Bcr);
    this.safeWriteIo32(0x1f8010b8 - 0x1f801000, this.dma3Chcr);
  }

  public readTimer16(paddr: number): number {
    switch (paddr) {
      case 0x1f801100: return this.timersCtrl.readCounter(0);
      case 0x1f801104: return this.timersCtrl.readMode(0);
      case 0x1f801108: return this.timersCtrl.readTarget(0);
      case 0x1f801110: return this.timersCtrl.readCounter(1);
      case 0x1f801114: return this.timersCtrl.readMode(1);
      case 0x1f801118: return this.timersCtrl.readTarget(1);
      case 0x1f801120: return this.timersCtrl.readCounter(2);
      case 0x1f801124: return this.timersCtrl.readMode(2);
      case 0x1f801128: return this.timersCtrl.readTarget(2);
      default: return 0;
    }
  }

  public writeTimer16(paddr: number, val: number): void {
    switch (paddr) {
      case 0x1f801100: this.timersCtrl.writeCounter(0, val); break;
      case 0x1f801104: this.timersCtrl.writeMode(0, val); break;
      case 0x1f801108: this.timersCtrl.writeTarget(0, val); break;
      case 0x1f801110: this.timersCtrl.writeCounter(1, val); break;
      case 0x1f801114: this.timersCtrl.writeMode(1, val); break;
      case 0x1f801118: this.timersCtrl.writeTarget(1, val); break;
      case 0x1f801120: this.timersCtrl.writeCounter(2, val); break;
      case 0x1f801124: this.timersCtrl.writeMode(2, val); break;
      case 0x1f801128: this.timersCtrl.writeTarget(2, val); break;
    }
  }
}
