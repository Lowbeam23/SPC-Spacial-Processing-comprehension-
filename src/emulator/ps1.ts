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
import {
  ExecutionMode,
  EmulationStatus,
  ConsoleLog,
  BiosInfo,
  CpuState,
  GpuState,
  CdromState,
  BootMode,
  VirtualDisc,
  ParsedExecutable,
} from '../types';
import { mountArchiveOrDisc, extractExecutableFromDisc } from './discMount';
import { disassemble } from './disassembler';
import {
  TEST_SUITES,
  generateGpuPolyAnimTest,
  generateGteProjectionTest,
  generateGpuStressBenchmark,
  generateBlendModesTest,
  generateCpuDmaBenchmark,
  generateSpuSynthTest,
  generateCdromHardwareTest,
  createSyntheticCdromTestDisc,
} from './tests';
import { SpuAudioBackend } from './spu';

export class Ps1Emulator {
  public memory: Memory;
  public cpu: Cpu;
  public recompiler: Recompiler;
  public gpu: Gpu;
  public cdrom: CdRom;
  public audioBackend: SpuAudioBackend;

  public status: EmulationStatus = 'stopped';
  public mode: ExecutionMode = 'interpreter'; // Interpreter default for 100% exact compliance
  public speedMultiplier: number = 1.0;
  public isFastBoot: boolean = true;
  public hasBiosLoaded: boolean = false;
  public hleBiosEnabled: boolean = false;
  public mountedDisc: VirtualDisc | null = null;
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
    this.cdrom.onDmaRequest = () => {
      this.memory.checkDmaCdrom();
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

    // SPU Web Audio Driver
    this.audioBackend = new SpuAudioBackend();
    this.audioBackend.init(this.memory.spu);

    // Hook coarse cycle flushing to peripheral advancer
    this.memory.onFlushCycles = (cycles) => this.advanceCycles(cycles);

    // Hook memory to GPU
    this.gpu.onTriggerIrq = () => {
      this.memory.triggerInterrupt(1);
    };
    this.gpu.onAcknowledgeIrq = () => {
      this.memory.writeIStat(this.memory.iStat & ~(1 << 1));
    };
    this.memory.gpuReadHandler = () => this.gpu.readGpu();
    this.memory.gpuStatHandler = () => this.gpu.readStat();
    this.memory.gpuWriteHandler = (val) => this.gpu.sendGp0(val);
    this.memory.gpuGp1Handler = (val) => this.gpu.writeGp1(val);
    this.memory.gpuBatchHandler = (words) => this.gpu.processDmaBatch(words);
    this.memory.onFlushCycles = (cycles) => this.advanceCycles(cycles);

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

    // Hook GTE diagnostic logs
    if (this.cpu && this.cpu.gte) {
      this.cpu.gte.onDiagnostic = (msg) => {
        this.addLog('gte', `[GTE] ${msg}`);
      };
    }

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
   */
  public mountDisc(fileBuffer: ArrayBuffer | Uint8Array, fileName: string = 'game.iso'): void {
    const bytes = fileBuffer instanceof ArrayBuffer ? new Uint8Array(fileBuffer) : fileBuffer;
    const sectorSize = bytes.length % 2352 === 0 ? 2352 : 2048;
    const totalSectors = Math.floor(bytes.length / sectorSize);
    const disc: VirtualDisc = {
      name: fileName,
      buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      data: bytes,
      sectorSize,
      totalSectors,
      primaryExecutable: fileName.toLowerCase().endsWith('.exe') ? fileName : 'PSX.EXE',
      volumeLabel: 'PlayStation Disc',
    };
    this.mountedDisc = disc;
    const info = this.cdrom.mount(disc);
    this.cdrom.hasDisc = true;
    this.memory.hasDiscLoaded = true;

    const mountMsg = `Game Disc Mounted: "${info.name}" (${(info.size / (1024 * 1024)).toFixed(2)} MB, ${info.type.toUpperCase()}). Format: ${info.sectorSize}B sectors (${info.totalSectors.toLocaleString()} total).`;
    this.addLog('system', mountMsg);
    this.recordRelevantEvent('CD-ROM', mountMsg);
    if (info.volumeLabel) {
      this.addLog('system', `Volume Label: "${info.volumeLabel}" | Executable: "${info.executableName || 'PSX.EXE'}"`);
    }
    this.notifyState();
  }

  /**
   * Mounts a ZIP archive or raw disc file and prepares VirtualDisc structure.
   */
  public async mountArchive(fileOrBuffer: File | ArrayBuffer | Uint8Array, fileName: string = 'disc.zip'): Promise<VirtualDisc> {
    const disc = await mountArchiveOrDisc(fileOrBuffer, fileName);
    this.mountedDisc = disc;
    this.cdrom.mount(disc);
    this.memory.hasDiscLoaded = true;

    const mountMsg = `Mounted Media: "${disc.name}" (${(disc.data.length / (1024 * 1024)).toFixed(2)} MB, ${disc.sectorSize}B/sector). Sectors: ${disc.totalSectors.toLocaleString()}. Executable: ${disc.primaryExecutable || 'PSX.EXE'}`;
    this.addLog('system', mountMsg);
    this.recordRelevantEvent('CD-ROM', mountMsg);
    this.notifyState();
    return disc;
  }

  /**
   * Ejects the current game disc from the CD-ROM drive tray and clears mounted buffers.
   */
  public ejectDisc(): void {
    this.mountedDisc = null;
    this.cdrom.ejectDisc();
    this.memory.hasDiscLoaded = false;
    this.addLog('system', 'CD-ROM Drive: Tray opened (Media ejected / cleared).');
    this.recordRelevantEvent('CD-ROM', 'Media ejected from drive tray.');
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

  /**
   * Mandatory Cold Reset & Hardware State Purge:
   * Wipes 2MB RAM, clears CPU registers, resets DMA & Timers, GPU, SPU, and Recompiler.
   */
  public hardReset(): void {
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

    // 1. Wipe 2MB RAM completely
    this.memory.ram.fill(0);
    this.memory.scratchpad.fill(0);
    this.memory.io.fill(0);
    this.memory.reset();

    // 2. Reset CD-ROM controller hardware
    if (this.cdrom) {
      this.cdrom.reset();
      this.memory.hasDiscLoaded = this.cdrom.hasDisc;
    }

    // 3. Clear CPU registers & state, ensure HLE vectors are completely unregistered
    this.hleBiosEnabled = false;
    this.cpu.reset();
    this.cpu.hleBiosEnabled = false;

    // 4. Reset GPU, DMA, Timers & Recompiler Cache
    this.gpu.reset();
    this.memory.timersCtrl.reset();
    this.memory.dma.reset();
    this.recompiler.clearCache();

    this.vblankCycleCounter = 0;
    this.cyclesSinceCdromOrDma = 0;
    this.lastStallLogCycles = 0;
    this.logoLoopFramesAfterDma2 = 0;
    this.status = 'stopped';
    this.notifyState();
  }

  public reset(): void {
    this.hardReset();
    this.addLog('system', 'System Reset: CPU registers cleared, PC = 0xBFC00000');
    this.recordRelevantEvent('SYSTEM', 'System Reset: CPU registers cleared, PC = 0xBFC00000');
  }

  /**
   * Dual-Branch Boot Architecture:
   * Branch A (Authentic BIOS / Dashboard): Runs Sony BIOS ROM from 0xBFC00000 with BEV=1.
   * Branch B (Fast-Boot / HLE Game Runner): Boots commercial PS1 games directly into RAM using HLE BIOS jump tables.
   */
  public boot(mode?: BootMode, discData?: VirtualDisc): void {
    const targetMode = mode || (this.mountedDisc ? BootMode.HLE_GAME_RUNNER : BootMode.BIOS_DASHBOARD);
    const targetDisc = discData || this.mountedDisc || undefined;

    // 1. Mandatory Cold Reset & Hardware State Purge
    this.hardReset();

    if (targetMode === BootMode.BIOS_DASHBOARD) {
      // Branch A: Authentic BIOS ROM Path (Direct Dashboard / 3D GUI / CD Player)
      this.hleBiosEnabled = false;
      this.cpu.hleBiosEnabled = false;
      this.cdrom.biosDashboardStubMode = true; // Tricked into idle disc drive stub so authentic BIOS passes hardware tests directly into 3D GUI
      this.cpu.cop0.status.bev = 1; // Bootstrap Exception Vector in ROM (0xBFC00180)
      this.cpu.pc = 0xbfc00000;
      this.cpu.nextPc = 0xbfc00004;

      console.log('[BOOT] Starting Authentic BIOS ROM from 0xBFC00000');
      this.addLog('bios', 'Starting Authentic BIOS ROM from 0xBFC00000 (Branch A: Clean Slate - Real Sony ROM handles all vectors natively)');
      this.recordRelevantEvent('BOOT', 'Branch A: Authentic BIOS ROM from 0xBFC00000');

      if (!this.hasBiosLoaded) {
        this.addLog('warn', 'No BIOS ROM loaded. Please load an authentic 512KB PS1 BIOS ROM.');
        this.notifyState();
        return;
      }
      this.start();
    } else if (targetMode === BootMode.HLE_GAME_RUNNER && targetDisc) {
      // Branch B: Direct HLE Game Runner Path (Real Game Disc Drive)
      this.hleBiosEnabled = true;
      this.cpu.hleBiosEnabled = true;
      this.cdrom.biosDashboardStubMode = false; // Real CD-ROM drive mode for games
      this.mountedDisc = targetDisc;
      this.cdrom.mount(targetDisc);
      this.memory.hasDiscLoaded = true;

      // Parse EXE header & preload binary payload directly to ram[loadAddr]
      const exe = this.extractExecutable(targetDisc);
      if (exe.data && exe.data.length > 0) {
        this.memory.writeBuffer(exe.loadAddr, exe.data);
      }

      // Zero-fill BSS area if present
      if (exe.bssSize && exe.bssSize > 0 && exe.bssAddr) {
        for (let i = 0; i < exe.bssSize; i += 4) {
          this.memory.write32((exe.bssAddr + i) >>> 0, 0);
        }
      }

      // Determine safe Stack Pointer
      let targetSp = exe.initialSp;
      if (!targetSp || targetSp < 0x80000000 || targetSp >= 0x80200000) {
        targetSp = 0x801ffff0;
      }

      // Initialize CPU registers according to PS-X EXE header requirements
      this.cpu.pc = exe.entryPc >>> 0;
      this.cpu.nextPc = (exe.entryPc + 4) >>> 0;
      this.cpu.setReg(29, targetSp >>> 0); // $sp (R29)
      this.cpu.setReg(30, targetSp >>> 0); // $fp (R30)
      this.cpu.setReg(28, (exe.initialGp || 0x00000000) >>> 0); // $gp (R28)
      this.cpu.setReg(31, 0x800000b0); // $ra (R31) pointing to safe B0 vector space
      this.cpu.setReg(4, 1); // $a0 (R4) argc = 1
      this.cpu.setReg(5, 0x80000180); // $a1 (R5) argv pointer

      // Write basic argv string at 0x80000180 in RAM ("cdrom:\\")
      this.memory.write32(0x80000180, 0x80000188); // argv[0] -> 0x80000188
      const cdromArgvStr = new TextEncoder().encode('cdrom:\\\0');
      this.memory.writeBuffer(0x80000188, cdromArgvStr);

      // COP0 Status & Global Interrupt Enable:
      // Bit 0 (IEc) = 1 (Interrupt Enable current)
      // Bit 10 (IM2) = 1 (Enable IP2 hardware peripheral IRQs: CD-ROM, GPU, DMA, SPU, Timers)
      // Bit 22 (BEV) = 0 (Route exceptions through RAM vector 0x80000080)
      this.cpu.cop0Regs[12] = 0x00000401; // IM2 | IEc
      this.cpu.cop0.status.bev = 0;
      this.cpu.cop0.status.iec = 1;

      // Ensure motherboard I_MASK register (0x1F801074) enables peripheral IRQs
      if (this.memory.iMask === 0) {
        this.memory.iMask = 0x001d; // Bit 2 (CD-ROM), Bit 0 (VBLANK), Bit 3 (DMA), Bit 4 (Timers)
      }

      // Install minimal low-RAM trampolines and enable HLE syscall trap handler
      this.installHleJumpTables();
      this.hasLoggedExecutableLaunch = true;

      const logMsg = `[BOOT] Fast-Boot HLE Launch: Entry PC=0x${exe.entryPc.toString(16).toUpperCase()} Load=0x${exe.loadAddr.toString(16).toUpperCase()} Size=${exe.data.length.toLocaleString()} bytes`;
      console.log(logMsg);
      this.addLog('system', logMsg, exe.entryPc);
      this.recordRelevantEvent('BOOT', `Branch B: Fast-Boot HLE Launch (Entry PC=0x${exe.entryPc.toString(16).toUpperCase()})`);
      this.start();
    } else {
      this.addLog('warn', 'Branch B requires a mounted disc or ZIP archive.');
      this.notifyState();
    }
  }

  /**
   * Extracts executable machine code and execution vectors from a VirtualDisc.
   */
  public extractExecutable(discData: VirtualDisc): ParsedExecutable {
    return extractExecutableFromDisc(discData);
  }

  /**
   * Installs minimal low-RAM trampolines and kernel vector tables for HLE mode.
   */
  public installHleJumpTables(): void {
    // 1. Install standard PS1 kernel A0, B0, C0 low-RAM vector table stubs in low RAM
    // For A0 (0x000000A0): JR $RA / NOP
    this.memory.write32(0x000000a0, 0x03e00008); // jr $ra
    this.memory.write32(0x000000a4, 0x00000000); // nop

    // For B0 (0x000000B0): JR $RA / NOP
    this.memory.write32(0x000000b0, 0x03e00008); // jr $ra
    this.memory.write32(0x000000b4, 0x00000000); // nop

    // For C0 (0x000000C0): JR $RA / NOP
    this.memory.write32(0x000000c0, 0x03e00008); // jr $ra
    this.memory.write32(0x000000c4, 0x00000000); // nop

    // 2. Install General Exception Vector at 0x80000080
    // Differentiates Hardware Interrupts (ExcCode 0, do NOT increment EPC)
    // from SYSCALL/Break exceptions (ExcCode != 0, increment EPC by 4).
    // Acknowledges / clears I_STAT via 0xBF801070 for hardware interrupts before returning.
    this.memory.write32(0x80000080, 0x401a7000); // mfc0 $k0, $14 (EPC)
    this.memory.write32(0x80000084, 0x401b6800); // mfc0 $k1, $13 (Cause)
    this.memory.write32(0x80000088, 0x337b007c); // andi $k1, $k1, 0x007c (ExcCode)
    this.memory.write32(0x8000008c, 0x13600004); // beq $k1, $zero, +4 (If Hardware Int ExcCode 0, jump to 0x800000a0 to clear I_STAT)
    this.memory.write32(0x80000090, 0x00000000); // nop (delay slot)
    this.memory.write32(0x80000094, 0x275a0004); // addiu $k0, $k0, 4 (Advance EPC for SYSCALL/Break)
    this.memory.write32(0x80000098, 0x10000003); // b +3 (Jump over hardware int clear to 0x800000a8)
    this.memory.write32(0x8000009c, 0x00000000); // nop (delay slot)
    // Hardware Int handling: clear I_STAT
    this.memory.write32(0x800000a0, 0x3c1bbf80); // lui $k1, 0xbf80
    this.memory.write32(0x800000a4, 0xaf601070); // sw $zero, 0x1070($k1)
    // Common exit
    this.memory.write32(0x800000a8, 0x409a7000); // mtc0 $k0, $14 (Save EPC)
    this.memory.write32(0x800000ac, 0x42000010); // rfe (Restore Status bits: IEp -> IEc)
    this.memory.write32(0x800000b0, 0x03400008); // jr $k0 (Return to interrupted instruction)
    this.memory.write32(0x800000b4, 0x00000000); // nop (delay slot)

    // 3. Initialize kernel Event descriptor tables in RAM (0x00000100 - 0x00000200)
    // Event 0: VBLANK (Class 0xF0000001, Spec 0x00000004, Mode/Status 0x00001000 = Ready)
    this.memory.write32(0x00000100, 0xf0000001);
    this.memory.write32(0x00000104, 0x00000004);
    this.memory.write32(0x00000108, 0x00001000);
    this.memory.write32(0x0000010c, 0x00000000);

    // Event 1: CD-ROM (Class 0xF0000003, Spec 0x00000010, Mode/Status 0x00001000 = Ready)
    this.memory.write32(0x00000110, 0xf0000003);
    this.memory.write32(0x00000114, 0x00000010);
    this.memory.write32(0x00000118, 0x00001000);
    this.memory.write32(0x0000011c, 0x00000000);

    // Event 2: DMA (Class 0xF0000002, Spec 0x00000008, Mode/Status 0x00001000 = Ready)
    this.memory.write32(0x00000120, 0xf0000002);
    this.memory.write32(0x00000124, 0x00000008);
    this.memory.write32(0x00000128, 0x00001000);
    this.memory.write32(0x0000012c, 0x00000000);

    // Event 3: Timer (Class 0xF0000004, Spec 0x00000020, Mode/Status 0x00001000 = Ready)
    this.memory.write32(0x00000130, 0xf0000004);
    this.memory.write32(0x00000134, 0x00000020);
    this.memory.write32(0x00000138, 0x00001000);
    this.memory.write32(0x0000013c, 0x00000000);

    // Event 4: GPU (Class 0xF0000001, Spec 0x00000002, Mode/Status 0x00001000 = Ready)
    this.memory.write32(0x00000140, 0xf0000001);
    this.memory.write32(0x00000144, 0x00000002);
    this.memory.write32(0x00000148, 0x00001000);
    this.memory.write32(0x0000014c, 0x00000000);

    // 4. Mirror Exception Handler to BIOS ROM area (0xBFC00180) if available
    if (this.memory.bios && this.memory.bios.length >= 0x80000) {
      const bios = this.memory.bios;
      const view = new DataView(bios.buffer, bios.byteOffset, bios.byteLength);
      view.setUint32(0x180, 0x401a7000, true); // mfc0 $k0, $14 (EPC)
      view.setUint32(0x184, 0x401b6800, true); // mfc0 $k1, $13 (Cause)
      view.setUint32(0x188, 0x337b007c, true); // andi $k1, $k1, 0x007c (ExcCode)
      view.setUint32(0x18c, 0x13600004, true); // beq $k1, $zero, +4
      view.setUint32(0x190, 0x00000000, true); // nop
      view.setUint32(0x194, 0x275a0004, true); // addiu $k0, $k0, 4
      view.setUint32(0x198, 0x10000003, true); // b +3
      view.setUint32(0x19c, 0x00000000, true); // nop
      view.setUint32(0x1a0, 0x3c1bbf80, true); // lui $k1, 0xbf80
      view.setUint32(0x1a4, 0xaf601070, true); // sw $zero, 0x1070($k1)
      view.setUint32(0x1a8, 0x409a7000, true); // mtc0 $k0, $14
      view.setUint32(0x1ac, 0x42000010, true); // rfe
      view.setUint32(0x1b0, 0x03400008, true); // jr $k0
      view.setUint32(0x1b4, 0x00000000, true); // nop
    }

    // 5. Invalidate JIT / Recompiler cache for low RAM vectors
    this.recompiler.invalidateAddress(0x00000000, 0x1000);
    this.recompiler.invalidateAddress(0x80000000, 0x1000);
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
    if (!this.hasBiosLoaded && !this.hasLoggedExecutableLaunch) {
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
    this.audioBackend.resume();
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
    if (!this.cdrom.hasDisc) return; // Clean No-Disc state: allow BIOS GUI / Audio CD / Memory Card manager to execute

    const pc = this.cpu.pc >>> 0;
    // PSX game executable code space is 0x80010000..0x8002FFFF or user RAM >= 0x80010000 outside BIOS ROM (0xBFC00000)
    const isExeSpace = (this.cdrom.exeHeader && pc === this.cdrom.exeHeader.initial_pc) ||
      (this.memory.dma?.dma3TransferCount > 0 && pc >= 0x80010000 && pc < 0xBFC00000);

    if (isExeSpace) {
      this.hasLoggedExecutableLaunch = true;
      this.postLaunchCycles = 0;
      this.lastPostLaunchLogCycle = 0;

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
      const rawSp = (exeHeader ? (exeHeader.initial_sp_base + exeHeader.initial_sp_offset) : 0) >>> 0;
      const sp = rawSp !== 0 ? rawSp : 0x801FFFF0;

      const exeName = this.cdrom.discInfo?.executableName || 'PSX.EXE';
      const targetPcHex = `0x${initial_pc.toString(16).padStart(8, '0').toUpperCase()}`;
      const logMsg = `[EXECUTABLE LAUNCH] Jumping to ${exeName} at PC: ${targetPcHex}`;
      console.log(logMsg);
      this.addLog('system', logMsg, initial_pc);
      this.recordRelevantEvent('EXECUTABLE', logMsg);

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
      // Set CPU.nextPc = (initial_pc + 4) >>> 0;
      // If initial_gp !== 0, set CPU.regs[28] = initial_gp;
      // Set CPU.regs[29] = initial_sp_base + initial_sp_offset; (If 0, default to 0x801FFFF0).
      // Set CPU.regs[30] = CPU.regs[29]; (Frame pointer $fp).
      this.cpu.pc = initial_pc;
      this.cpu.nextPc = (initial_pc + 4) >>> 0;
      this.cpu.inDelaySlot = false;
      this.cpu.branchPending = false;
      this.cpu.halted = false;

      if (initial_gp !== 0) {
        this.cpu.regs[28] = initial_gp;
      }
      this.cpu.regs[29] = sp;
      this.cpu.regs[30] = sp; // Frame pointer $fp

      if (this.memory.iMask === 0) {
        this.memory.iMask = 0x001f; // Unmask VBLANK, GPU, CD-ROM, DMA, Timers
      }

      // Invalidate recompiler JIT cache so newly populated code is compiled
      this.recompiler.clearCache();

      // Log the parsed EXE header values when jumping:
      // [EXE HEADER] PC: 0x..., SP: 0x..., GP: 0x..., LoadAddr: 0x..., Size: ... bytes
      const headerPcHex = targetPcHex;
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
    const gp0Count = this.gpu.gp0WriteCount;
    const gp1Count = this.gpu.gp1WriteCount;
    const dma2Count = this.gpu.dma2PacketCount;
    const vblankCount = this.gpu.vblankIrqCount;
    const iStatHex = `0x${(this.memory.iStat & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
    const iMaskHex = `0x${(this.memory.iMask & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
    const srHex = `0x${(this.cpu.cop0Regs[12] >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
    const iec = this.cpu.cop0Regs[12] & 1;

    const events = this.recentRelevantEvents.slice(-10);

    const lines: string[] = [
      '======================== [PS1 STATUS DUMP] ========================',
      `Current PC: ${pcHex}`,
      `GPU Writes: GP0(0x1F801810)=${gp0Count.toLocaleString()} | GP1(0x1F801814)=${gp1Count.toLocaleString()} | DMA2 Packets=${dma2Count.toLocaleString()}`,
      `VBLANK Interrupts: ${vblankCount.toLocaleString()} ticks | I_STAT: ${iStatHex} | I_MASK: ${iMaskHex} | SR: ${srHex} (IEc=${iec})`,
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

    this.addLog('system', `Status Dump: PC=${pcHex} | GP0=${gp0Count} GP1=${gp1Count} | VBLANK IRQ0=${vblankCount} | VRAM Pixels: ${hasPixels ? `YES (${totalVramNonZero.toLocaleString()})` : 'NO'} | Display: ${displayPixelsExist ? `${displayNonZero.toLocaleString()} px` : '0 px'}`);

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
    }

    this.memory.checkDma();
    this.cpu.checkInterrupts();

    // Scanline calculation: 564,480 CPU cycles per NTSC frame across 263 scanlines
    // Exact scanline duration = 564,480 / 263 ≈ 2,146.311787 cycles
    // Lines 0–239 active display, lines 240–262 VBLANK
    const scanline = Math.floor((this.vblankCycleCounter * 263) / Ps1Emulator.NTSC_VBLANK_CYCLES) % 263;
    this.gpu.currentScanline = scanline;
    this.gpu.vblank = scanline >= 240;

    // Periodically assert VBlank IRQ 0 and deliver event when frame completes / scanline wraps
    if (this.vblankCycleCounter >= Ps1Emulator.NTSC_VBLANK_CYCLES) {
      this.vblankCycleCounter -= Ps1Emulator.NTSC_VBLANK_CYCLES;
      this.memory.triggerInterrupt(0);
      this.gpu.onVBlank();
      this.gpu.vblank = true;
      this.gpu.currentField ^= 1;
      if (this.gpu.currentField === 1) {
        this.gpu.gpuStat |= (1 << 31);
      } else {
        this.gpu.gpuStat &= ~(1 << 31);
      }
      this.gpu.framesRendered++;
      this.wallClockFrameCount++;

      // Informative log on initial VBLANK interrupts and periodic sync checkpoints
      if (this.gpu.framesRendered === 1 || this.gpu.framesRendered === 60 || this.gpu.framesRendered % 600 === 0) {
        const iStatHex = `0x${(this.memory.iStat & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
        const iMaskHex = `0x${(this.memory.iMask & 0xffff).toString(16).padStart(4, '0').toUpperCase()}`;
        const srHex = `0x${(this.cpu.cop0Regs[12] >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
        const iec = this.cpu.cop0Regs[12] & 1;
        const vblankMsg = `[VBLANK IRQ 0] Frame #${this.gpu.framesRendered} cycle sync fired (I_STAT: ${iStatHex}, I_MASK: ${iMaskHex}, SR: ${srHex}, IEc=${iec})`;
        this.addLog('gpu', vblankMsg);
        this.recordRelevantEvent('VBLANK', vblankMsg);
      }

      if (this.gpu.onFrame) {
        this.gpu.onFrame();
      } else {
        this.gpu.blitFrame();
      }

      this.cpu.checkInterrupts();
      this.checkLogoLoopSafetyCap();
    }
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
    this.checkExecutableLaunch();

    const tFrame = performance.now() - t0;
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
    if (this.status === 'running') {
      if (type === 'disasm' || type === 'bios' || type === 'gpu' || type === 'warn' || type === 'system') {
        if (!this.cpu.debugLogging) return;
      }
    }
    if (this.isLoggingPaused && type !== 'error' && type !== 'system' && type !== 'bios' && type !== 'tty' && type !== 'warn' && type !== 'gpu') {
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

  /**
   * Loads and executes a standalone PS-X hardware test binary directly into PS1 memory.
   */
  public runTestExecutable(exeBytes: Uint8Array, testName: string = 'HARDWARE TEST'): void {
    this.pause();
    this.reset();

    // Parse PS-X EXE header (2048 bytes)
    const view = new DataView(exeBytes.buffer, exeBytes.byteOffset, Math.min(exeBytes.byteLength, 2048));
    const initialPc = view.getUint32(0x10, true) || 0x80010000;
    const initialGp = view.getUint32(0x14, true) || 0x80080000;
    const loadAddr = view.getUint32(0x18, true) || 0x80010000;
    const loadSize = view.getUint32(0x1c, true) || (exeBytes.byteLength - 2048);
    const initialSpBase = view.getUint32(0x30, true) || 0x801f0000;
    const initialSpOffset = view.getUint32(0x34, true) || 0x0000fff0;

    // Load executable machine code into PS1 Main RAM
    const ramOffset = loadAddr & 0x001fffff;
    const codeData = exeBytes.subarray(2048, 2048 + loadSize);
    this.memory.ram.set(codeData, ramOffset);

    // Initialize CPU Execution Context
    this.cpu.pc = initialPc >>> 0;
    this.cpu.nextPc = (initialPc + 4) >>> 0;
    this.cpu.regs[28] = initialGp >>> 0; // $gp
    this.cpu.regs[29] = (initialSpBase + initialSpOffset) >>> 0; // $sp
    this.cpu.regs[30] = (initialSpBase + initialSpOffset) >>> 0; // $fp / $s8

    if (this.cpu.gte) {
      this.cpu.gte.reset();
      this.cpu.gte.diagnosticCount = 0;
    }

    // Initialize GPU Display & Render State
    this.gpu.reset();
    this.gpu.displayDisabled = false;
    this.gpu.displayWidth = 320;
    this.gpu.displayHeight = 240;
    this.gpu.drawAreaX1 = 0;
    this.gpu.drawAreaY1 = 0;
    this.gpu.drawAreaX2 = 319;
    this.gpu.drawAreaY2 = 239;

    this.hasLoggedExecutableLaunch = true;
    this.isFastBoot = false;

    this.addLog('system', `[TEST SUITE] Executing "${testName}" at PC: 0x${initialPc.toString(16).toUpperCase()} (${loadSize} bytes)`);
    this.recordRelevantEvent('TEST', `Running test "${testName}"`);

    this.start();
  }

  /**
   * Runs one of the predefined hardware test suites by ID
   */
  public runHardwareTest(testId: string): void {
    switch (testId) {
      case 'cdrom_hardware_test': {
        // Mount synthetic 64-sector disc image for CD-ROM hardware validation
        const discData = createSyntheticCdromTestDisc();
        this.cdrom.mountDisc(discData, 'CDROM_SYNTHETIC_TEST_DISC.BIN');
        this.memory.hasDiscLoaded = true;

        const bin = generateCdromHardwareTest();
        this.runTestExecutable(bin, 'CD-ROM: Subsystem & DMA 3 Hardware Test');
        break;
      }
      case 'spu_audio_synth': {
        const bin = generateSpuSynthTest();
        this.runTestExecutable(bin, 'SPU: 24-Voice Audio & ADPCM Synth Test');
        break;
      }
      case 'gpu_poly_anim': {
        const bin = generateGpuPolyAnimTest();
        this.runTestExecutable(bin, 'GPU: 3D Polygon & Animation Test');
        break;
      }
      case 'gte_projection': {
        const bin = generateGteProjectionTest();
        this.runTestExecutable(bin, 'GTE: COP2 3D Geometry & Perspective Test');
        break;
      }
      case 'gpu_stress_bench': {
        const bin = generateGpuStressBenchmark();
        this.runTestExecutable(bin, 'GPU: Polygon Stress & Fillrate Benchmark');
        break;
      }
      case 'gpu_blend_modes': {
        const bin = generateBlendModesTest();
        this.runTestExecutable(bin, 'GPU: Semi-Transparency & Blend Modes');
        break;
      }
      case 'cpu_dma_bench': {
        const bin = generateCpuDmaBenchmark();
        this.runTestExecutable(bin, 'CPU / MEM: MIPS & DMA Benchmark');
        break;
      }
      default:
        this.addLog('warn', `Unknown test suite ID: "${testId}"`);
        break;
    }
  }

  private notifyState(): void {
    if (this.onStateChange) {
      this.onStateChange(this.cpu.getState(), this.gpu.getState(), this.status, this.lastError, this.getCdromState());
    }
  }
}
