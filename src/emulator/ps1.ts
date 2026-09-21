/**
 * Main PlayStation 1 Emulator Coordinator
 * Coordinates CPU, Memory, GPU, DMA, and BIOS execution.
 */

import { Memory } from './memory';
import { Cpu } from './cpu';
import { Recompiler } from './recompiler';
import { Gpu } from './gpu';
import { CdRom, PsxExeHeader } from './cdrom';
import { BiosManager } from './bios';
import { saveBiosToStorage, loadBiosFromStorage, deleteBiosFromStorage } from './biosStorage';
import { ExecutionMode, EmulationStatus, ConsoleLog, BiosInfo, CpuState, GpuState, CdromState } from '../types';
import { disassemble } from './disassembler';

export class Ps1Emulator {
  public memory: Memory;
  public cpu: Cpu;
  public recompiler: Recompiler;
  public gpu: Gpu;
  public cdrom: CdRom;

  public status: EmulationStatus = 'stopped';
  public mode: ExecutionMode = 'interpreter'; // Interpreter default for 100% exact compliance
  public speedMultiplier: number = 1.0;
  public isFastBoot: boolean = true;
  public hasBiosLoaded: boolean = false;
  public currentBiosInfo: BiosInfo | null = null;
  public lastError: string | null = null;

  private animationFrameId: number | null = null;
  private lastTimestamp: number = 0;
  private ipsCounter: number = 0;
  public currentIps: number = 0;
  private lastIpsTime: number = 0;

  // Real-time wall clock and cycle debt tracking
  public static readonly CPU_HZ: number = 33868800;
  private lastTime: number = 0;
  private cycleDebt: number = 0;
  private wallClockFrameCount: number = 0;
  private lastWallClockFpsTime: number = 0;

  // Subsystem frame profiling
  private totalCpuMs: number = 0;
  private totalGpuMs: number = 0;
  private totalBlitMs: number = 0;
  private profileSampleCount: number = 0;

  // NTSC Vertical Blank timing: 33.8688 MHz clock / 60 Hz = ~564,480 CPU cycles per frame
  // Total scanlines: 263. Active display: 240 scanlines (~515,114 cycles). VBLANK: 23 scanlines (~49,366 cycles).
  public static readonly NTSC_VBLANK_CYCLES: number = 564480;
  public static readonly NTSC_VBLANK_START: number = 515114;
  private vblankCycleCounter: number = 0;
  private cyclesSinceCdromOrDma: number = 0;
  private lastStallLogCycles: number = 0;

  // State Transition & Event Logging
  public totalCycles: number = 0;
  public hasLogged500kTotal: boolean = false;
  public hasLogged500kPostLaunch: boolean = false;
  public hasLoggedExecutableLaunch: boolean = false;
  public postLaunchCycles: number = 0;
  public lastPostLaunchLogCycle: number = 0;
  public recentRelevantEvents: { tag: string; message: string; timestamp: number }[] = [];

  // Listeners
  public onLog?: (log: ConsoleLog) => void;
  public onStateChange?: (cpu: CpuState, gpu: GpuState, status: EmulationStatus, error: string | null, cdrom: CdromState) => void;
  public onTtyOutput?: (char: string) => void;

  constructor() {
    this.memory = new Memory();
    this.cdrom = new CdRom();
    this.memory.cdrom = this.cdrom;
    this.cdrom.onTriggerIrq = (asserted: boolean) => {
      if (asserted) {
        this.memory.iStat |= (1 << 2);
      } else {
        this.memory.iStat &= ~(1 << 2);
      }
      this.memory.updateInterrupts();
      if (this.cpu) {
        this.cpu.checkInterrupts();
      }
    };
    this.cdrom.onLog = (level, message) => {
      this.addLog(level, message);
      if (
        message.includes('Mounted') ||
        message.includes('Target Location') ||
        message.includes('Reading initialized') ||
        message.includes('Setloc') ||
        message.includes('ReadN') ||
        message.includes('ReadS') ||
        message.includes('MotorOn')
      ) {
        this.recordRelevantEvent('CD-ROM', message);
      }
    };
    this.cdrom.onActivity = () => {
      this.cyclesSinceCdromOrDma = 0;
    };
    this.memory.onDmaActivity = () => {
      this.cyclesSinceCdromOrDma = 0;
    };
    this.memory.dma.onDmaTransfer = (channel, message) => {
      this.recordRelevantEvent(`DMA${channel}`, message);
    };

    this.cpu = new Cpu(this.memory);
    this.memory.cpu = this.cpu;
    this.recompiler = new Recompiler();
    this.memory.recompiler = this.recompiler;
    this.gpu = new Gpu();
    this.memory.gpu = this.gpu;

    // Hook coarse cycle flushing to peripheral advancer
    this.memory.onFlushCycles = (cycles) => this.advanceCycles(cycles);

    // Hook memory to GPU
    this.memory.gpuReadHandler = () => this.gpu.readGpu();
    this.memory.gpuStatHandler = () => this.gpu.readStat();
    this.memory.gpuWriteHandler = (val) => this.gpu.sendGp0(val);
    this.memory.gpuGp1Handler = (val) => this.gpu.writeGp1(val);
    this.memory.gpuBatchHandler = (words) => this.gpu.processDmaBatch(words);

    // Hook logs from memory & GPU
    this.memory.onLog = (level, message, addr) => {
      this.addLog(level, message, addr);
    };
    this.gpu.onLog = (type, msg) => {
      this.addLog(type, msg);
    };
    this.gpu.onScreenChange = (msg) => {
      this.recordRelevantEvent('SCREEN', msg);
    };
    this.gpu.onBootBenchmark = () => {
      this.handleBootBenchmarkTrigger();
    };

    // Hook CPU errors so they are NEVER hidden
    this.cpu.onError = (err, pc, opcode) => {
      this.lastError = err;
      this.status = 'error';
      this.addLog('error', err, pc, opcode ? `Opcode: 0x${opcode.toString(16)}` : undefined);
      this.notifyState();
    };

    // Hook TTY
    this.memory.onTtyChar = (char) => this.handleTtyChar(char);
    this.cpu.onTty = (char) => this.handleTtyChar(char);

    // Hook Syscall
    this.cpu.onSyscall = (pc, func, args) => {
      this.addLog('system', `SYSCALL at 0x${pc.toString(16).toUpperCase()} func=${func} args=[${args.map(a => '0x' + a.toString(16).toUpperCase()).join(', ')}]`, pc);
    };

    // Expose dumpStatus and emulator instance on global window for developer console debugging
    if (typeof window !== 'undefined') {
      (window as any).dumpStatus = () => this.dumpStatus();
      (window as any).ps1 = this;
    }

    // Auto-load any previously saved authentic 512KB BIOS from browser storage
    this.initStorageAndCheckBios();
  }

  /**
   * Initializes persistent storage check for saved BIOS
   */
  public async initStorageAndCheckBios(): Promise<boolean> {
    try {
      const saved = await loadBiosFromStorage();
      if (saved && saved.data && saved.data.length === 524288) {
        this.applyBios(saved.data, saved.fileName, false);
        this.addLog('bios', `Restored authentic 512 KB BIOS "${saved.fileName}" from browser storage.`);
        return true;
      }
    } catch (err) {
      console.warn('Could not auto-restore saved BIOS:', err);
    }
    return false;
  }

  /**
   * Loads an authentic 512 KB PlayStation 1 System BIOS dump (SCPH-1001, SCPH-7001, etc.)
   */
  public async loadCustomBios(buffer: Uint8Array, fileName: string, saveToStorage: boolean = true): Promise<void> {
    if (buffer.length !== 524288) {
      const err = `Invalid BIOS size: ${buffer.length.toLocaleString()} bytes. Authentic Sony PS1 BIOS ROM dumps must be exactly 524,288 bytes (512 KB).`;
      this.addLog('error', err);
      throw new Error(err);
    }

    this.applyBios(buffer, fileName, saveToStorage);
    if (saveToStorage) {
      await saveBiosToStorage(buffer, fileName);
    }
    this.start();
  }

  private applyBios(buffer: Uint8Array, fileName: string, isNewLoad: boolean): void {
    const info = BiosManager.inspectBios(buffer, fileName);
    this.currentBiosInfo = info;
    this.memory.loadBios(buffer);
    this.hasBiosLoaded = true;
    this.reset();

    this.addLog(
      'bios',
      `Loaded authentic BIOS ROM: "${fileName}" (512 KB). Type: ${info.versionString}. Checksum: ${info.checksum}`
    );
    if (info.isOfficial) {
      this.addLog('bios', 'Official Sony PlayStation 1 System ROM verified. Cold Reset Vector: 0xBFC00000.');
    }
    this.notifyState();
  }

  /**
   * Unloads the current BIOS and clears persistent storage
   */
  public async unloadBios(): Promise<void> {
    this.pause();
    this.memory.bios.fill(0);
    this.hasBiosLoaded = false;
    this.currentBiosInfo = null;
    await deleteBiosFromStorage();
    this.reset();
    this.addLog('bios', 'BIOS unloaded. Please load a 512KB PS1 BIOS ROM to begin.');
    this.notifyState();
  }

  /**
   * Separate Game Disc Mount:
   * Passes game or homebrew image directly to CD-ROM controller.
   * Resets CPU to 0xBFC00000 to execute the authentic BIOS with the disc inserted.
   */
  public mountDisc(fileBuffer: ArrayBuffer | Uint8Array, fileName: string = 'game.iso'): void {
    const info = this.cdrom.mountDisc(fileBuffer, fileName);
    this.cdrom.hasDisc = true;
    this.memory.hasDiscLoaded = true;

    this.reset();
    const mountMsg = `Game Disc Mounted: "${info.name}" (${(info.size / (1024 * 1024)).toFixed(2)} MB, ${info.type.toUpperCase()}). Format: ${info.sectorSize}B sectors (${info.totalSectors.toLocaleString()} total).`;
    this.addLog('system', mountMsg);
    this.recordRelevantEvent('CD-ROM', mountMsg);
    if (info.volumeLabel) {
      this.addLog('system', `Volume Label: "${info.volumeLabel}" | Executable: "${info.executableName || 'PSX.EXE'}"`);
    }

    if (this.hasBiosLoaded) {
      this.addLog('bios', `System reset to 0xBFC00000. Booting authentic BIOS with disc inserted in drive.`);
      this.start();
    } else {
      this.addLog('warn', 'Disc mounted in CD-ROM drive. Please load a 512KB PS1 BIOS ROM to begin.');
      this.notifyState();
    }
  }

  /**
   * Ejects the current game disc from the CD-ROM drive tray.
   */
  public ejectDisc(): void {
    this.cdrom.ejectDisc();
    this.memory.hasDiscLoaded = false;
    this.addLog('system', 'CD-ROM Drive: Tray opened (Disc ejected).');
    this.recordRelevantEvent('CD-ROM', 'Disc ejected from drive tray.');
    this.notifyState();
  }

  public getCdromState(): CdromState {
    return {
      hasDisc: this.cdrom.hasDisc,
      discInfo: this.cdrom.discInfo,
      isMotorOn: this.cdrom.isMotorOn,
      isReading: this.cdrom.isReading,
      status: this.cdrom.status,
      sectorsReadCount: this.cdrom.sectorsReadCount,
    };
  }

  private _bootLogged: boolean = false;

  public reset(): void {
    this.pause();
    this.lastError = null;
    this.isFastBoot = true;
    this._bootLogged = false;
    this.hasLoggedExecutableLaunch = false;
    this.postLaunchCycles = 0;
    this.lastPostLaunchLogCycle = 0;
    this.totalCycles = 0;
    this.hasLogged500kTotal = false;
    this.hasLogged500kPostLaunch = false;
    this.memory.reset();
    if (this.cdrom) {
      this.cdrom.reset();
      this.memory.hasDiscLoaded = this.cdrom.hasDisc;
    }
    this.cpu.reset();
    this.gpu.reset();
    this.recompiler.clearCache();
    this.vblankCycleCounter = 0;
    this.cyclesSinceCdromOrDma = 0;
    this.lastStallLogCycles = 0;
    this.logoLoopFramesAfterDma2 = 0;
    this.status = 'stopped';
    this.notifyState();
    this.addLog('system', 'System Reset: CPU registers cleared, PC = 0xBFC00000');
    this.recordRelevantEvent('SYSTEM', 'System Reset: CPU registers cleared, PC = 0xBFC00000');
  }

  public setFastBoot(enable: boolean): void {
    if (this.isFastBoot !== enable) {
      this.isFastBoot = enable;
      if (!enable) {
        this.cycleDebt = 0;
        this.lastTime = performance.now();
        console.log(`[FAST-BOOT] Automatic throttle engaged (60 FPS normal mode) at PC: 0x${this.cpu.pc.toString(16).toUpperCase()}`);
      }
    }
  }

  private handleBootBenchmarkTrigger(): void {
    if (!this._bootLogged) {
      this._bootLogged = true;
      console.log(`[BOOT BENCHMARK] Reached 3D GUI!`);
      console.log(`Total Virtual Frames Rendered: ${this.gpu.framesRendered}`);
      console.log(`Total CPU Cycles Elapsed: ${this.cpu.instructionsExecuted}`);
      console.log(`Expected Authentic Frames: ~450 (NTSC 60Hz) or ~375 (PAL 50Hz)`);
    }
    if (this.isFastBoot) {
      this.setFastBoot(false);
    }
  }

  public logoLoopFramesAfterDma2: number = 0;

  public checkLogoLoopSafetyCap(): void {
    const pc = this.cpu.pc >>> 0;
    const isLogoLoop = (pc >>> 8) === 0x8004F6 || (pc >>> 8) === 0x8005C2;
    const dma2Done = (this.memory.dma?.dma2TransferCount || 0) >= 450 || this.gpu.totalDrawPacketsProcessed >= 450;

    if (isLogoLoop && dma2Done) {
      this.logoLoopFramesAfterDma2++;
      if (this.logoLoopFramesAfterDma2 === 301) {
        console.log(`[BIOS LOGO SAFETY CAP] 300 frames elapsed in 0x8004F6xx logo loop (PC: 0x${pc.toString(16).toUpperCase()}) after DMA2 #450. Stepping VBLANK event timers forward...`);
      }
      if (this.logoLoopFramesAfterDma2 >= 300) {
        this.stepVblankCountersForward();
      }
    } else if (!isLogoLoop && (pc < 0x8004F000 || pc > 0x80060000)) {
      this.logoLoopFramesAfterDma2 = 0;
    }
  }

  private stepVblankCountersForward(): void {
    // 1. Scan kernel Event table (0x00000080 - 0x00001000) for VBLANK event descriptors (0xF0000001 / 0xF4000001)
    for (let addr = 0x80; addr < 0x1000; addr += 4) {
      const cls = this.memory.read32(addr) >>> 0;
      if (cls === 0xF0000001 || cls === 0xF4000001) {
        const curCount = this.memory.read32(addr + 16) >>> 0;
        const target = this.memory.read32(addr + 20) >>> 0;
        const nextCount = target > 0 ? Math.max(curCount + 10, target) : curCount + 10;
        this.memory.write32(addr + 16, nextCount);
        this.memory.write32(addr + 12, 0x1000); // Mark event triggered / ready
      }
    }

    // 2. Step kernel VSync / timer variables in the 0x00000080 area
    const vblankVarAddrs = [0x70, 0x80, 0x84, 0x88, 0x90, 0x94, 0x98, 0xa0, 0x100, 0x140];
    for (const off of vblankVarAddrs) {
      const val = this.memory.read32(off) >>> 0;
      if (val > 0 && val < 0x1000000) {
        this.memory.write32(off, (val + 10) >>> 0);
      }
    }

    // 3. Step common comparison registers if PC is actively inside the wait loop
    const pc = this.cpu.pc >>> 0;
    if ((pc >>> 8) === 0x8004F6) {
      if (this.cpu.regs[2] < 1000000) this.cpu.regs[2] += 10;
      if (this.cpu.regs[3] < 1000000) this.cpu.regs[3] += 10;
    }

    // 4. Assert VBLANK IRQ 0 to kick kernel polling handlers
    this.memory.triggerInterrupt(0);
    this.cpu.checkInterrupts();
  }

  public checkFastBootTransition(): void {
    if (this.gpu.hasBootBenchmarked) {
      this.handleBootBenchmarkTrigger();
    }
  }

  public boot(): void {
    this.reset();
    this.addLog('bios', `Booting PS1 MIPS R3000A from reset vector 0x${this.cpu.pc.toString(16).toUpperCase()}...`);
    this.start();
  }

  public setExecutionMode(mode: ExecutionMode): void {
    this.mode = mode;
    this.addLog('system', `Execution mode switched to: ${mode.toUpperCase()} ${mode === 'hybrid' ? '(JIT with Interpreter Fallback)' : ''}`);
  }

  public setSpeedMultiplier(mult: number): void {
    this.speedMultiplier = mult;
  }

  public isLoggingPaused: boolean = false;

  public setLoggingPaused(paused: boolean): void {
    this.isLoggingPaused = paused;
    this.gpu.isLoggingPaused = paused;
    this.memory.isLoggingPaused = paused;
  }

  public start(): void {
    if (this.status === 'running') return;
    if (!this.hasBiosLoaded) {
      this.status = 'stopped';
      this.addLog('warn', 'Please load a 512KB PS1 BIOS ROM to begin.');
      this.notifyState();
      return;
    }
    this.status = 'running';
    this.lastError = null;
    this.lastTimestamp = performance.now();
    this.lastIpsTime = performance.now();
    this.lastTime = performance.now();
    this.cycleDebt = 0;
    this.wallClockFrameCount = 0;
    this.lastWallClockFpsTime = performance.now();
    this.ipsCounter = 0;
    this.setLoggingPaused(true);
    this.cpu.debugLogging = false;
    this.gpu.debugLogging = false;
    this.memory.debugLogging = false;
    this.cpu.onInstruction = undefined;
    this.addLog('system', `Emulator running (Mode: ${this.mode.toUpperCase()}, PC: 0x${this.cpu.pc.toString(16).toUpperCase()})`);
    this.loop();
  }

  public pause(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.status === 'running') {
      this.status = 'paused';
      this.addLog('system', `Emulator paused at PC = 0x${this.cpu.pc.toString(16).toUpperCase()}`);
    }
    this.setLoggingPaused(true);
    this.cpu.debugLogging = true;
    this.gpu.debugLogging = true;
    this.memory.debugLogging = true;
    this.notifyState();
  }

  /**
   * Record significant state transitions (disc mounted, CD-ROM commands, DMA3, executable launch, etc.)
   */
  public recordRelevantEvent(tag: string, message: string): void {
    this.recentRelevantEvents.push({ tag, message, timestamp: Date.now() });
    if (this.recentRelevantEvents.length > 50) {
      this.recentRelevantEvents.shift();
    }
  }

  /**
   * Detects and logs when PC executes an instruction at or above 0x80010000 (executable handoff)
   * Parses the 2048-byte header, initializes CPU registers ($pc, $gp, $sp, $fp), and loads payload
   */
  public checkExecutableLaunch(): void {
    if (this.hasLoggedExecutableLaunch) return;

    const pc = this.cpu.pc >>> 0;
    // PSX game executable code space is 0x80010000..0x8002FFFF or user RAM >= 0x80010000 outside BIOS ROM (0xBFC00000)
    const isExeSpace = (pc >= 0x80010000 && pc <= 0x8002FFFF) ||
      (this.memory.dma?.dma3TransferCount > 0 && pc >= 0x80010000 && pc < 0xBFC00000) ||
      (this.cdrom.exeHeader && pc === this.cdrom.exeHeader.initial_pc);

    if (isExeSpace) {
      this.hasLoggedExecutableLaunch = true;
      this.postLaunchCycles = 0;
      this.lastPostLaunchLogCycle = 0;

      const exeName = this.cdrom.discInfo?.executableName || 'PSX.EXE';
      const pcHex = `0x${pc.toString(16).padStart(8, '0').toUpperCase()}`;
      const logMsg = `[EXECUTABLE LAUNCH] Jumping to ${exeName} at PC: ${pcHex}`;
      console.log(logMsg);
      this.addLog('system', logMsg, pc);
      this.recordRelevantEvent('EXECUTABLE', logMsg);

      // Parse 2048-byte header from disc or RAM:
      // initial_pc: offset 0x10 (4 bytes)
      // initial_gp: offset 0x14 (4 bytes)
      // load_addr: offset 0x18 (4 bytes)
      // load_size: offset 0x1C (4 bytes)
      // initial_sp_base: offset 0x30 (4 bytes)
      // initial_sp_offset: offset 0x34 (4 bytes)
      let exeHeader = this.cdrom.exeHeader || this.cdrom.parseExeHeader();
      if (!exeHeader) {
        exeHeader = this.parseExeHeaderFromRam();
      }

      const initial_pc = (exeHeader ? exeHeader.initial_pc : pc) >>> 0;
      const initial_gp = (exeHeader ? exeHeader.initial_gp : 0) >>> 0;
      const load_addr = (exeHeader ? exeHeader.load_addr : pc) >>> 0;
      const load_size = (exeHeader ? exeHeader.load_size : 0) >>> 0;
      const initial_sp_base = (exeHeader ? exeHeader.initial_sp_base : 0x801FFFF0) >>> 0;
      const initial_sp_offset = (exeHeader ? exeHeader.initial_sp_offset : 0) >>> 0;

      let sp = (initial_sp_base + initial_sp_offset) >>> 0;
      if (sp === 0) {
        sp = 0x801FFFF0;
      }

      // If executable payload is available from disc, ensure destination RAM is populated
      if (this.cdrom) {
        const payload = this.cdrom.getExePayload();
        if (payload && payload.data.length > 0) {
          const destRam = (payload.load_addr & 0x001FFFFF) >>> 0;
          for (let i = 0; i < payload.data.length && (destRam + i) < this.memory.ram.length; i++) {
            this.memory.ram[destRam + i] = payload.data[i];
          }
        }
      }

      // Zero-fill BSS area if present
      if (exeHeader && exeHeader.bss_size && exeHeader.bss_size > 0 && exeHeader.bss_addr) {
        const bssAddr = exeHeader.bss_addr;
        const bssSize = exeHeader.bss_size;
        const bssLog = `[BSS CLEAR] Clearing BSS memory from 0x${bssAddr.toString(16).toUpperCase()} to 0x${(bssAddr + bssSize).toString(16).toUpperCase()} (${bssSize} bytes)`;
        console.log(bssLog);
        this.addLog('system', bssLog, bssAddr);
        this.recordRelevantEvent('BSS CLEAR', bssLog);
        for (let i = 0; i < bssSize; i += 4) {
          this.memory.write32((bssAddr + i) >>> 0, 0);
        }
      }

      // Initialize CPU Registers Before Jumping:
      // Set CPU.pc = initial_pc;
      // If initial_gp !== 0, set CPU.regs[28] = initial_gp;
      // Set CPU.regs[29] = initial_sp_base + initial_sp_offset; (If 0, default to 0x801FFFF0).
      // Set CPU.regs[30] = CPU.regs[29]; (Frame pointer $fp).
      this.cpu.pc = initial_pc;
      this.cpu.nextPc = (initial_pc + 4) >>> 0;
      this.cpu.inDelaySlot = false;
      this.cpu.branchPending = false;
      this.cpu.halted = false;

      this.cpu.regs[28] = initial_gp !== 0 ? initial_gp : 0x80070000;
      this.cpu.regs[29] = sp;
      this.cpu.regs[30] = sp; // Frame pointer $fp

      // Invalidate recompiler JIT cache so newly populated code is compiled
      this.recompiler.clearCache();

      // Log the parsed EXE header values when jumping:
      // [EXE HEADER] PC: 0x..., SP: 0x..., GP: 0x..., LoadAddr: 0x..., Size: ... bytes
      const headerPcHex = `0x${initial_pc.toString(16).padStart(8, '0').toUpperCase()}`;
      const spHex = `0x${sp.toString(16).padStart(8, '0').toUpperCase()}`;
      const gpHex = `0x${initial_gp.toString(16).padStart(8, '0').toUpperCase()}`;
      const loadAddrHex = `0x${load_addr.toString(16).padStart(8, '0').toUpperCase()}`;
      const headerLog = `[EXE HEADER] PC: ${headerPcHex}, SP: ${spHex}, GP: ${gpHex}, LoadAddr: ${loadAddrHex}, Size: ${load_size} bytes`;
      console.log(headerLog);
      this.addLog('system', headerLog, initial_pc);
      this.recordRelevantEvent('EXE HEADER', headerLog);
    }
  }

  /**
   * Scans 2MB RAM for a 2048-byte PS-X EXE header
   */
  private parseExeHeaderFromRam(): PsxExeHeader | null {
    const ram = this.memory.ram;
    for (let i = 0; i <= ram.length - 2048; i += 4) {
      if (
        ram[i] === 0x50 && ram[i+1] === 0x53 && ram[i+2] === 0x2D && ram[i+3] === 0x58 &&
        ram[i+4] === 0x20 && ram[i+5] === 0x45 && ram[i+6] === 0x58 && ram[i+7] === 0x45
      ) {
        const view = new DataView(ram.buffer, ram.byteOffset + i, 2048);
        return {
          initial_pc: view.getUint32(0x10, true) >>> 0,
          initial_gp: view.getUint32(0x14, true) >>> 0,
          load_addr: view.getUint32(0x18, true) >>> 0,
          load_size: view.getUint32(0x1c, true) >>> 0,
          initial_sp_base: view.getUint32(0x30, true) >>> 0,
          initial_sp_offset: view.getUint32(0x34, true) >>> 0,
          headerOffset: i,
          bss_addr: view.getUint32(0x38, true) >>> 0,
          bss_size: view.getUint32(0x3c, true) >>> 0,
        };
      }
    }
    return null;
  }

  /**
   * Status Dump: prints the last 10 relevant events, current PC, and whether pixels exist in VRAM
   */
  public dumpStatus(): string {
    const pcHex = `0x${this.cpu.pc.toString(16).padStart(8, '0').toUpperCase()}`;
    const totalVramNonZero = this.gpu.getTotalVramNonZeroCount();
    const displayNonZero = this.gpu.getDisplayNonZeroCount();
    const dispW = this.gpu.displayWidth;
    const dispH = this.gpu.displayHeight;
    const dispX = this.gpu.displayVramX;
    const dispY = this.gpu.displayVramY;
    const hasPixels = totalVramNonZero > 0;
    const displayPixelsExist = displayNonZero > 0;

    const events = this.recentRelevantEvents.slice(-10);

    const lines: string[] = [
      '======================== [PS1 STATUS DUMP] ========================',
      `Current PC: ${pcHex}`,
      `Pixels Exist in VRAM: ${hasPixels ? 'YES' : 'NO'} (Total non-zero pixels in 1MB VRAM: ${totalVramNonZero.toLocaleString()})`,
      `Active Display Viewport: (${dispX},${dispY}) @ ${dispW}x${dispH} | Viewport non-zero pixels: ${displayNonZero.toLocaleString()} | Blanked: ${this.gpu.displayDisabled ? 'YES' : 'NO'}`,
      `Total GP0 Draw Packets: ${this.gpu.totalDrawPacketsProcessed.toLocaleString()} | Frames Rendered: ${this.gpu.framesRendered}`,
      `CD-ROM: ${this.cdrom.hasDisc ? `"${this.cdrom.discInfo?.name}" (${this.cdrom.discInfo?.executableName || 'PSX.EXE'})` : 'No Disc'} | DMA3 Transfers: ${this.memory.dma.dma3TransferCount}`,
      `Execution Mode: ${this.mode.toUpperCase()} | Status: ${this.status.toUpperCase()}`,
      'Last 10 Relevant Events:'
    ];

    if (events.length === 0) {
      lines.push('  (No events recorded yet)');
    } else {
      events.forEach((ev, idx) => {
        const timeStr = new Date(ev.timestamp).toLocaleTimeString();
        lines.push(`  ${idx + 1}. [${timeStr}] [${ev.tag}] ${ev.message}`);
      });
    }
    lines.push('====================================================================');

    const output = lines.join('\n');
    console.log(output);
    this.gpu.blitCheckLoggedCount = 0;

    this.addLog('system', `Status Dump: PC=${pcHex} | VRAM Pixels: ${hasPixels ? `YES (${totalVramNonZero.toLocaleString()})` : 'NO'} | Display: ${displayPixelsExist ? `${displayNonZero.toLocaleString()} px` : '0 px'} | Last Event: ${events.length > 0 ? events[events.length - 1].message : 'None'}`);

    return output;
  }

  /**
   * Advance hardware cycle accumulator and manage cyclic VBLANK period transitions
   * NTSC frame rate: 33.8688 MHz / 60 Hz ≈ 564,480 CPU cycles per frame
   * (or line cycles: 33.8688 MHz / 15,734 Hz ≈ 2152 cycles per scanline, lines 0–239 active display, lines 240–262 VBLANK).
   * When the frame cycle counter hits 564,480 (or scanline hits 240):
   * 1. Set Bit 0 of I_STAT (0x1F801070 |= 0x01)
   * 2. Reset the frame cycle counter
   * 3. Trigger blitFrame() to update the canvas
   * 4. If (this.iStat & this.iMask) !== 0 and COP0 status IEc is 1, signal the CPU hardware interrupt (IP2 in Cause)
   */
  private advanceCycles(stepCycles: number): void {
    this.memory.addCycles(stepCycles);
    if (this.cpu) {
      this.cpu.checkInterrupts();
    }
    this.vblankCycleCounter += stepCycles;
    this.cyclesSinceCdromOrDma += stepCycles;
    this.totalCycles += stepCycles;

    // Log condition check after 500,000 total cycles
    if (this.totalCycles >= 500000 && !this.hasLogged500kTotal) {
      this.hasLogged500kTotal = true;
      const currentPcHex = `0x${this.cpu.pc.toString(16).padStart(8, '0').toUpperCase()}`;
      const v0Hex = `0x${(this.cpu.regs[2] >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
      const lastReads = this.memory.getLastReadAddresses(3).map(a => `0x${a.toString(16).toUpperCase()}`).join(', ');
      const lastDataReads = this.memory.getLastDataReadAddresses(3).map(a => `0x${a.toString(16).toUpperCase()}`).join(', ');
      const logMsg = `[500,000 CYCLES INSPECTION] PC: ${currentPcHex} | Last 3 Reads: [${lastReads}] (Data/IO Reads: [${lastDataReads}]) | $v0: ${v0Hex}`;
      console.log(logMsg);
      this.addLog('system', logMsg, this.cpu.pc);
      this.recordRelevantEvent('DEBUG', logMsg);
    }

    // Check game handoff / executable launch
    this.checkExecutableLaunch();

    if (this.hasLoggedExecutableLaunch) {
      this.postLaunchCycles += stepCycles;
      if (this.postLaunchCycles >= 500000 && !this.hasLogged500kPostLaunch) {
        this.hasLogged500kPostLaunch = true;
        const currentPcHex = `0x${this.cpu.pc.toString(16).padStart(8, '0').toUpperCase()}`;
        const v0Hex = `0x${(this.cpu.regs[2] >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
        const lastReads = this.memory.getLastReadAddresses(3).map(a => `0x${a.toString(16).toUpperCase()}`).join(', ');
        const lastDataReads = this.memory.getLastDataReadAddresses(3).map(a => `0x${a.toString(16).toUpperCase()}`).join(', ');
        const logMsg = `[PSX.EXE 500,000 CYCLES POST-LAUNCH] PC: ${currentPcHex} | Last 3 Reads: [${lastReads}] (Data/IO Reads: [${lastDataReads}]) | $v0: ${v0Hex}`;
        console.log(logMsg);
        this.addLog('system', logMsg, this.cpu.pc);
        this.recordRelevantEvent('DEBUG', logMsg);
      }
      if (this.postLaunchCycles - this.lastPostLaunchLogCycle >= 100000) {
        this.lastPostLaunchLogCycle = this.postLaunchCycles;
        const currentPcHex = `0x${this.cpu.pc.toString(16).padStart(8, '0').toUpperCase()}`;
        console.log(`[PSX.EXE RUNNING] PC: ${currentPcHex} (+${this.postLaunchCycles.toLocaleString()} cycles post-launch)`);
      }
    }

    // Silenced per user request: [CPU STALL / KERNEL LOOP]
    // if (this.cyclesSinceCdromOrDma >= 1000000) {
    //   if (this.cyclesSinceCdromOrDma - this.lastStallLogCycles >= 1000000) {
    //     this.lastStallLogCycles = this.cyclesSinceCdromOrDma;
    //     const pcHex = `0x${this.cpu.pc.toString(16).padStart(8, '0').toUpperCase()}`;
    //     const iStatHex = `0x${this.memory.iStat.toString(16).padStart(4, '0').toUpperCase()}`;
    //     const iMaskHex = `0x${this.memory.iMask.toString(16).padStart(4, '0').toUpperCase()}`;
    //     const stallMsg = `[CPU STALL / KERNEL LOOP] PC: ${pcHex} | I_STAT: ${iStatHex} | I_MASK: ${iMaskHex} | Cycles without CD/DMA: ${this.cyclesSinceCdromOrDma.toLocaleString()}`;
    //     console.log(stallMsg);
    //     this.addLog('bios', stallMsg, this.cpu.pc);
    //   }
    // }

    this.memory.checkDma();
    this.cpu.checkInterrupts();

    // Scanline calculation: 564,480 CPU cycles per NTSC frame across 263 scanlines
    // Exact scanline duration = 564,480 / 263 ≈ 2,146.311787 cycles
    // Lines 0–239 active display, lines 240–262 VBLANK
    const scanline = Math.floor((this.vblankCycleCounter * 263) / Ps1Emulator.NTSC_VBLANK_CYCLES) % 263;
    this.gpu.currentScanline = scanline;
    this.gpu.vblank = scanline >= 240;
  }

  public step(): void {
    if (this.status === 'running') {
      this.pause();
    }

    if (!this.hasBiosLoaded) {
      this.addLog('warn', 'Please load a 512KB PS1 BIOS ROM to begin.');
      this.notifyState();
      return;
    }

    const currentPc = this.cpu.pc;
    const opcode = this.memory.read32(currentPc);
    const dis = disassemble(currentPc, opcode);

    // Execute one instruction via interpreter
    try {
      const cycles = this.cpu.step();
      const stepCycles = Math.max(cycles, 1);
      this.advanceCycles(stepCycles);
      this.addLog('disasm', `[0x${dis.hex}] ${dis.assembly}`, currentPc, dis.description);
      this.status = 'paused';
      this.notifyState();
    } catch (err: any) {
      const msg = err.message || String(err);
      this.lastError = msg;
      this.status = 'error';
      this.addLog('error', `Step Error at PC 0x${currentPc.toString(16).toUpperCase()}: ${msg}`);
      this.notifyState();
    }
  }

  public runFrame(): void {
    const t0 = performance.now();
    const gpuDrawBefore = this.gpu.totalGpuDrawMs;
    const blitBefore = this.gpu.totalBlitMs;

    const targetCycles = Math.round(Ps1Emulator.NTSC_VBLANK_CYCLES * this.speedMultiplier);
    const TARGET_SLICE_CYCLES = 4000;
    let executed = 0;
    const useJit = this.mode === 'jit';

    // Silence frame logging for clean performance
    // if (this.gpu.framesRendered % 60 === 0) {
    //   console.log(`[FRAME ${this.gpu.framesRendered}] PC: 0x${this.cpu.pc.toString(16)}, mode: ${this.mode}, IPS: ${this.ipsCounter}`);
    // }

    let blocksInFrame = 0;

    while (executed < targetCycles) {
      if (this.status !== 'running' || this.cpu.halted) break;

      let sliceCycles = 0;
      const currentSliceTarget = Math.min(TARGET_SLICE_CYCLES, targetCycles - executed);

      if (useJit) {
        while (sliceCycles < currentSliceTarget && !this.cpu.halted) {
          const instsBefore = this.cpu.instructionsExecuted;
          const blockCycles = this.recompiler.stepBlock(this.cpu, this.memory, false);
          const instsRan = this.cpu.instructionsExecuted - instsBefore;
          blocksInFrame++;
          const cycles = blockCycles > 0 ? blockCycles : 1;
          this.memory.cycleAccumulator += cycles;
          if (this.memory.cycleAccumulator >= 256) {
            this.memory.flushCycles();
          }
          this.ipsCounter += instsRan > 0 ? instsRan : 1;
          sliceCycles += cycles;
          if ((this.memory.iStat & this.memory.iMask) !== 0) {
            if (this.cpu.checkInterrupts()) {
              break;
            }
          }
        }
      } else {
        while (sliceCycles < currentSliceTarget && !this.cpu.halted) {
          const cycles = this.cpu.step();
          const stepCycles = cycles > 0 ? cycles : 1;
          this.memory.cycleAccumulator += stepCycles;
          if (this.memory.cycleAccumulator >= 64) {
            this.memory.flushCycles();
          }
          this.ipsCounter++;
          sliceCycles += stepCycles;
          if ((this.memory.iStat & this.memory.iMask) !== 0) {
            if (this.cpu.checkInterrupts()) {
              break;
            }
          }
        }
      }

      executed += sliceCycles;
      this.memory.checkDma();
      this.cpu.checkInterrupts();
    }

    this.memory.flushCycles();

    if (this.vblankCycleCounter >= Ps1Emulator.NTSC_VBLANK_CYCLES) {
      // 1. Set Bit 0 of I_STAT (0x1F801070 |= 0x01) and update interrupts
      this.memory.triggerInterrupt(0);
      this.gpu.onVBlank();

      // 2. Reset the frame cycle counter
      this.vblankCycleCounter -= Ps1Emulator.NTSC_VBLANK_CYCLES;
      if (this.vblankCycleCounter >= Ps1Emulator.NTSC_VBLANK_CYCLES) {
        this.vblankCycleCounter = 0;
      }

      this.gpu.vblank = true;
      this.gpu.currentField ^= 1;
      if (this.gpu.currentField === 1) {
        this.gpu.gpuStat |= (1 << 19);
      } else {
        this.gpu.gpuStat &= ~(1 << 19);
      }
      this.gpu.framesRendered++;
      this.wallClockFrameCount++;

      if (this.gpu.framesRendered % 1000 === 0) {
        console.log(`[GPU DRAW STATS @ Frame ${this.gpu.framesRendered}] Total GP0 Draw Packets: ${this.gpu.totalDrawPacketsProcessed.toLocaleString()} | Display: ${this.gpu.displayWidth}x${this.gpu.displayHeight} @ VRAM (${this.gpu.displayVramX},${this.gpu.displayVramY}) | DrawOffset: (${this.gpu.drawOffsetX},${this.gpu.drawOffsetY}) | Blanking: ${this.gpu.displayDisabled ? 'BLANKED' : 'ENABLED'}`);
      }

      // 3. Trigger canvas presentation once per frame during VBLANK (60 Hz)
      // Force canvas flush at the end of every VBLANK tick so the browser paints the frame
      if (this.gpu.onFrame) {
        this.gpu.onFrame();
      } else {
        this.gpu.blitFrame();
      }

      // 4. Evaluate CPU interrupt
      this.cpu.checkInterrupts();

      // 5. Safety cap check for BIOS logo loop
      this.checkLogoLoopSafetyCap();
    }

    const tFrame = performance.now() - t0;
    // if (useJit && (this.gpu.framesRendered % 60 === 0 || this.gpu.framesRendered === 1)) {
    //   console.log(`[JIT FRAME PROFILER] Frame ${this.gpu.framesRendered}: ${blocksInFrame} blocks executed, ${executed} virtual cycles, host execution time: ${tFrame.toFixed(2)} ms`);
    // }
    const gpuDrawFrame = this.gpu.totalGpuDrawMs - gpuDrawBefore;
    const blitFrame = this.gpu.totalBlitMs - blitBefore;
    const cpuFrame = Math.max(0, tFrame - gpuDrawFrame - blitFrame);

    this.totalCpuMs += cpuFrame;
    this.totalGpuMs += gpuDrawFrame;
    this.totalBlitMs += blitFrame;
    this.profileSampleCount++;

    if (this.profileSampleCount >= 60) {
      // const avgCpu = this.totalCpuMs / 60;
      // const avgGpu = this.totalGpuMs / 60;
      // const avgBlit = this.totalBlitMs / 60;
      // const avgTotal = avgCpu + avgGpu + avgBlit;
      // console.log(`[PROFILE 60-FRAME AVG] Total Frame: ${avgTotal.toFixed(2)}ms | CPU: ${avgCpu.toFixed(2)}ms | GPU Draw: ${avgGpu.toFixed(2)}ms | Blit: ${avgBlit.toFixed(2)}ms`);
      this.totalCpuMs = 0;
      this.totalGpuMs = 0;
      this.totalBlitMs = 0;
      this.profileSampleCount = 0;
      this.gpu.totalGpuDrawMs = 0;
      this.gpu.totalBlitMs = 0;
    }

    this.checkFastBootTransition();
  }

  private loop = (now: number = performance.now()): void => {
    if (this.status !== 'running') return;

    this.lastTimestamp = now;

    // Real Wall-Clock FPS Logging
    if (now - this.lastWallClockFpsTime >= 1000) {
      // console.log(`[REAL WALL-CLOCK FPS]: ${this.wallClockFrameCount}`);
      this.wallClockFrameCount = 0;
      this.lastWallClockFpsTime = now;
    }

    try {
      if (this.isFastBoot) {
        const frameStart = performance.now();
        // Unthrottled Fast-Boot Mode: burst run frames up to 12ms per tick
        while (performance.now() - frameStart < 12 && this.status === 'running' && !this.cpu.halted && this.isFastBoot) {
          this.runFrame();
          this.checkFastBootTransition();
        }
      } else {
        // Delta-Time Cycle Debt Accumulator (Normal 60 FPS Mode)
        const dt = Math.min((now - this.lastTime) / 1000, 0.05); // Cap at 50ms to prevent spiral of death
        this.lastTime = now;
        this.cycleDebt += dt * Ps1Emulator.CPU_HZ * this.speedMultiplier;

        if (this.cycleDebt >= Ps1Emulator.NTSC_VBLANK_CYCLES && this.status === 'running' && !this.cpu.halted) {
          this.runFrame();
          this.cycleDebt = Math.min(this.cycleDebt - Ps1Emulator.NTSC_VBLANK_CYCLES, Ps1Emulator.NTSC_VBLANK_CYCLES);
          this.checkFastBootTransition();
        }
      }

      if (this.cpu.lastError) {
        this.status = 'error';
        this.lastError = this.cpu.lastError;
        this.notifyState();
        return;
      }
    } catch (err: any) {
      const msg = err.message || String(err);
      this.status = 'error';
      this.lastError = msg;
      this.addLog('error', `CPU Execution Exception at PC 0x${this.cpu.pc.toString(16).toUpperCase()}: ${msg}`);
      this.notifyState();
      return;
    }

    // Calculate IPS (Instructions per second)
    if (now - this.lastIpsTime >= 500) {
      const dtIps = (now - this.lastIpsTime) / 1000;
      this.currentIps = Math.round(this.ipsCounter / dtIps);
      this.ipsCounter = 0;
      this.lastIpsTime = now;
      this.notifyState();
    }

    if (this.status === 'running') {
      this.animationFrameId = requestAnimationFrame(this.loop);
    }
  };

  private ttyBuffer: string = '';
  private handleTtyChar(char: string): void {
    if (this.onTtyOutput) {
      this.onTtyOutput(char);
    }
    this.ttyBuffer += char;
    if (char === '\n' || this.ttyBuffer.length >= 80) {
      const line = this.ttyBuffer.trimEnd();
      this.addLog('tty', `[TTY] ${line}`);
      this.ttyBuffer = '';
    }
  }

  public addLog(type: ConsoleLog['type'], message: string, pc?: number, details?: string): void {
    if (this.status === 'running' && type === 'disasm') {
      return;
    }
    if (this.isLoggingPaused && type !== 'error' && type !== 'system' && type !== 'bios' && type !== 'tty' && type !== 'warn') {
      return;
    }
    const log: ConsoleLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
      type,
      message,
      pc,
      details,
    };
    if (this.onLog) {
      this.onLog(log);
    }
  }

  public fastForwardSplash(): void {
    this.cpu.fastForwardSplash();
  }

  private notifyState(): void {
    if (this.onStateChange) {
      this.onStateChange(this.cpu.getState(), this.gpu.getState(), this.status, this.lastError, this.getCdromState());
    }
  }
}
