/**
 * PlayStation 1 CD-ROM Controller Subsystem (0x1F801800 - 0x1F801803) & Disc Image Parser
 * Supports ISO-9660 images (.iso), Raw Mode 1 / Mode 2 Form 1/2 BIN images (.bin), CUE descriptors (.cue), and PS-X EXEs.
 */

export interface DiscInfo {
  name: string;
  size: number;
  type: 'iso' | 'bin' | 'cue' | 'ps-exe' | 'unknown';
  volumeLabel?: string;
  executableName?: string;
  sectorSize: number;
  totalSectors: number;
}

export interface PsxExeHeader {
  initial_pc: number;
  initial_gp: number;
  load_addr: number;
  load_size: number;
  initial_sp_base: number;
  initial_sp_offset: number;
  headerOffset: number;
  bss_addr?: number;
  bss_size?: number;
}

export interface QueuedInterrupt {
  flag: number;
  response: number[];
}

export class CdRom {
  // Mounted Disc Data
  public discBuffer: ArrayBuffer | null = null;
  public discData: Uint8Array | null = null;
  public hasDisc: boolean = false;
  public discInfo: DiscInfo | null = null;
  public exeHeader: PsxExeHeader | null = null;

  // Controller State (0x1F801800 - 0x1F801803)
  public index: number = 0; // Register bank index (0..3)
  public status: number = 0x10; // Drive Status byte (0x10 = Shell Open initially)
  public responseFifo: number[] = [];
  public parameterFifo: number[] = [];
  public dataFifo: number[] = [];
  public dataFifoIndex: number = 0;
  public sectorBuffer: Uint8Array = new Uint8Array(2352);
  public sectorBufferLength: number = 2048;
  public pioBytesReadThisSector: number = 0;
  public interruptFlag: number = 0; // IFR (Bits 0..2: INT1..INT5)
  public interruptEnable: number = 0x1f; // IER (Bits 0..4)
  public interruptQueue: QueuedInterrupt[] = [];

  // Drive mechanics and head position
  public isShellOpen: boolean = false;
  public isMotorOn: boolean = false;
  public isReading: boolean = false;
  public isSeeking: boolean = false;
  public isDoubleSpeed: boolean = false;
  public sectorSizeSetting: number = 2048;

  // Read / Seek / Lid Timing
  public readCyclesCountdown: number = 0;
  public pendingSeekCycles: number = 0;
  public pendingLidCycles: number = 0;

  // Command Latency Cadence
  public pendingCommandDelay: number = 0;
  public pendingCommandInt: number = 0;
  public pendingCommandResponse: number[] = [];
  public pendingCommandName: string = '';
  public pendingCommandPostAction?: () => void;

  // Seek location (Minutes, Seconds, Frames)
  public seekMinute: number = 0;
  public seekSecond: number = 2; // Track 1 starts at 00:02:00
  public seekSector: number = 0;
  public currentLba: number = 0;

  // Audio Volume and Attenuation Registers
  public volumeLeftToLeft: number = 0x80;
  public volumeLeftToRight: number = 0x00;
  public volumeRightToRight: number = 0x80;
  public volumeRightToLeft: number = 0x00;

  // Statistics and Logging
  public totalReads: number = 0;
  public totalWrites: number = 0;
  public sectorsReadCount: number = 0;
  public cyclesSinceLastInt1: number = 0;
  public commandHistory: { cmd: number; name: string; params: number[]; time: number }[] = [];

  // Callback to signal IRQ to Memory / CPU (Interrupt 2 = CD-ROM)
  public onTriggerIrq?: (asserted: boolean) => void;
  public onDmaRequest?: () => void;
  public onActivity?: () => void;
  public onLog?: (type: 'system' | 'bios' | 'warn' | 'error', msg: string) => void;
  public getIdCallCount: number = 0;

  public static readonly COMMAND_NAMES: Record<number, string> = {
    0x01: 'Getstat',
    0x02: 'Setloc',
    0x03: 'Play',
    0x04: 'Forward',
    0x05: 'Backward',
    0x06: 'ReadN',
    0x07: 'MotorOn',
    0x08: 'Stop',
    0x09: 'Pause',
    0x0a: 'Init',
    0x0b: 'Mute',
    0x0c: 'Demute',
    0x0d: 'Setfilter',
    0x0e: 'Setmode',
    0x0f: 'Getparam',
    0x10: 'GetlocL',
    0x11: 'GetlocP',
    0x12: 'SetSession',
    0x13: 'GetTN',
    0x14: 'GetTD',
    0x15: 'SeekL',
    0x16: 'SeekP',
    0x19: 'Test',
    0x1a: 'GetID',
    0x1b: 'ReadS',
    0x1c: 'Reset',
    0x1e: 'ReadTOC',
  };

  constructor() {
    this.reset();
  }

  /**
   * Drive status byte returned in Getstat and first response of commands:
   * Bit 0: Error (0x01)
   * Bit 1: Motor on (0x02) - Set when disc is mounted / motor running
   * Bit 2: Seek error (0x04)
   * Bit 3: Id / Spindle (0x08)
   * Bit 4: Shell open (0x10) - Set when tray open / no disc, 0 when disc mounted
   * Bit 5: Read (0x20) - Set when ReadN / ReadS in progress
   * Bit 6: Seek (0x40) - Set when SeekL / SeekP in progress
   * Bit 7: Play (0x80) - Set when audio playing
   */
  public getStatus(): number {
    let stat = 0;
    if (this.isShellOpen || !this.hasDisc) {
      stat |= 0x10; // Bit 4: Shell open
    } else if (this.isMotorOn) {
      stat |= 0x02; // Bit 1: Motor on (Disc mounted and shell closed)
    }
    if (this.isReading) {
      stat |= 0x20; // Bit 5: Read in progress
    }
    if (this.isSeeking) {
      stat |= 0x40; // Bit 6: Seek in progress
    }
    return stat;
  }

  /**
   * Hardware interrupt gating: asserts IRQ 3 line when (interruptFlag & interruptEnable) !== 0
   */
  public updateIrq(): void {
    const isAsserted = (this.interruptFlag & this.interruptEnable) !== 0;
    if (this.onTriggerIrq) {
      this.onTriggerIrq(isAsserted);
    }
  }

  /**
   * Delivers an interrupt or queues it if an interrupt is already pending
   */
  public deliverInterrupt(flag: number, response: number[]): void {
    if (this.interruptFlag !== 0) {
      // Current interrupt has not been acknowledged yet; queue in FIFO
      this.interruptQueue.push({ flag, response });
      return;
    }
    this.interruptFlag = flag;
    this.responseFifo = [...response];
    this.updateIrq();
  }

  public reset(): void {
    this.index = 0;
    this.responseFifo = [];
    this.parameterFifo = [];
    this.dataFifo = [];
    this.dataFifoIndex = 0;
    this.pioBytesReadThisSector = 0;
    this.sectorBufferLength = 2048;
    this.interruptFlag = 0;
    this.interruptEnable = 0x1f;
    this.interruptQueue = [];
    this.getIdCallCount = 0;
    this.isReading = false;
    this.isSeeking = false;
    this.currentLba = 0;
    this.readCyclesCountdown = 0;
    this.pendingSeekCycles = 0;
    this.pendingCommandDelay = 0;
    this.pendingCommandPostAction = undefined;

    if (this.hasDisc) {
      this.isShellOpen = false;
      this.isMotorOn = true;
      this.status = 0x02; // Spindle spinning
      this.interruptFlag = 0; // No interrupt blocking the bus!
      this.pendingLidCycles = 0;
    } else {
      this.isShellOpen = true;
      this.isMotorOn = false;
      this.status = 0x10; // Shell open
      this.interruptFlag = 0;
      this.pendingLidCycles = 0;
    }
    this.updateIrq();
  }

  /**
   * Mounts a game disc buffer without touching the BIOS ROM memory.
   */
  public mountDisc(fileBuffer: ArrayBuffer | Uint8Array, fileName: string = 'game.iso'): DiscInfo {
    const ab = fileBuffer instanceof ArrayBuffer ? fileBuffer : fileBuffer.buffer.slice(fileBuffer.byteOffset, fileBuffer.byteOffset + fileBuffer.byteLength);
    return this.setDisc(ab as ArrayBuffer, fileName);
  }

  public setDisc(fileBuffer: ArrayBuffer, fileName: string = 'game.iso'): DiscInfo {
    this.discBuffer = fileBuffer;
    this.discData = new Uint8Array(fileBuffer);
    this.hasDisc = true;
    this.isMotorOn = true;
    this.isShellOpen = false;
    this.status = 0x02; // Spindle spinning
    this.interruptFlag = 0; // No interrupt blocking the bus!

    const info = this.inspectDisc(this.discData, fileName);
    this.discInfo = info;
    this.parseExeHeader();

    // Set pending INT5 to wait until BIOS is ready
    this.pendingLidCycles = 0;

    const exeDetails = this.exeHeader
      ? ` | Initial PC: 0x${this.exeHeader.initial_pc.toString(16).toUpperCase()}, SP: 0x${(this.exeHeader.initial_sp_base + this.exeHeader.initial_sp_offset).toString(16).toUpperCase()}, LoadAddr: 0x${this.exeHeader.load_addr.toString(16).toUpperCase()}`
      : '';
    const logMsg = `CD-ROM: Mounted "${info.name}" (${(info.size / (1024 * 1024)).toFixed(2)} MB, ${info.type.toUpperCase()}). Total Sectors: ${info.totalSectors.toLocaleString()}${info.volumeLabel ? ` [${info.volumeLabel}]` : ''}${exeDetails}`;
    console.log(`[CD-ROM MOUNT] ${logMsg}`);
    if (this.onLog) {
      this.onLog('system', logMsg);
    }

    return info;
  }

  /**
   * Ejects current disc, opens CD tray (Shell Open 0x10).
   */
  public ejectDisc(): void {
    this.discBuffer = null;
    this.discData = null;
    this.hasDisc = false;
    this.discInfo = null;
    this.exeHeader = null;
    this.isMotorOn = false;
    this.isReading = false;
    this.isSeeking = false;
    this.isShellOpen = true;
    this.status = this.getStatus();
    this.dataFifo = [];
    this.pendingLidCycles = 0;
    this.pendingCommandDelay = 0;
    this.pendingCommandPostAction = undefined;

    this.deliverInterrupt(5, [this.status]);

    if (this.onLog) {
      this.onLog('system', 'CD-ROM: Drive tray opened (Disc ejected, INT5 Shell Open 0x10).');
    }
  }

  /**
   * Scans disc image for PS-X EXE header ("PS-X EXE" magic) and parses its metadata
   */
  public parseExeHeader(): PsxExeHeader | null {
    if (!this.discData || this.discData.length < 2048) {
      this.exeHeader = null;
      return null;
    }

    const data = this.discData;
    let headerOffset = -1;

    // 1. Direct check at offset 0 (stand-alone PS-X EXE)
    if (
      data[0] === 0x50 && data[1] === 0x53 && data[2] === 0x2D && data[3] === 0x58 &&
      data[4] === 0x20 && data[5] === 0x45 && data[6] === 0x58 && data[7] === 0x45
    ) {
      headerOffset = 0;
    }

    const sectorSize = this.discInfo?.sectorSize || (data.length % 2352 === 0 ? 2352 : 2048);

    // 2. Scan sector boundaries (Mode 2 Form 1, Mode 1, ISO)
    if (headerOffset === -1) {
      const totalSectors = Math.min(Math.floor(data.length / sectorSize), 50000);
      for (let s = 0; s < totalSectors; s++) {
        const candidates = sectorSize === 2352
          ? [s * 2352 + 24, s * 2352 + 16, s * 2352]
          : [s * 2048];

        for (let c = 0; c < candidates.length; c++) {
          const cand = candidates[c];
          if (cand + 2048 <= data.length) {
            if (
              data[cand] === 0x50 && data[cand+1] === 0x53 && data[cand+2] === 0x2D && data[cand+3] === 0x58 &&
              data[cand+4] === 0x20 && data[cand+5] === 0x45 && data[cand+6] === 0x58 && data[cand+7] === 0x45
            ) {
              headerOffset = cand;
              break;
            }
          }
        }
        if (headerOffset !== -1) break;
      }
    }

    // 3. Fallback: linear byte scan across the image if not aligned to checked boundaries
    if (headerOffset === -1) {
      const searchLimit = Math.min(data.length - 2048, 100 * 1024 * 1024);
      for (let i = 0; i <= searchLimit; i++) {
        if (
          data[i] === 0x50 && data[i+1] === 0x53 && data[i+2] === 0x2D && data[i+3] === 0x58 &&
          data[i+4] === 0x20 && data[i+5] === 0x45 && data[i+6] === 0x58 && data[i+7] === 0x45
        ) {
          headerOffset = i;
          break;
        }
      }
    }

    if (headerOffset === -1 || headerOffset + 0x38 > data.length) {
      this.exeHeader = null;
      return null;
    }

    const view = new DataView(data.buffer, data.byteOffset + headerOffset, Math.min(2048, data.length - headerOffset));
    const initial_pc = view.getUint32(0x10, true) >>> 0;
    const initial_gp = view.getUint32(0x14, true) >>> 0;
    const load_addr = view.getUint32(0x18, true) >>> 0;
    const load_size = view.getUint32(0x1c, true) >>> 0;
    const initial_sp_base = view.getUint32(0x30, true) >>> 0;
    const initial_sp_offset = view.getUint32(0x34, true) >>> 0;
    const bss_addr = view.getUint32(0x38, true) >>> 0;
    const bss_size = view.getUint32(0x3c, true) >>> 0;

    this.exeHeader = {
      initial_pc,
      initial_gp,
      load_addr,
      load_size,
      initial_sp_base,
      initial_sp_offset,
      headerOffset,
      bss_addr,
      bss_size,
    };

    return this.exeHeader;
  }

  /**
   * Extracts the executable payload from disc based on the parsed EXE header
   */
  public getExePayload(): { load_addr: number; data: Uint8Array } | null {
    if (!this.discData || !this.exeHeader) return null;
    const { load_addr, load_size, headerOffset } = this.exeHeader;
    if (!load_addr || !load_size || load_size <= 0) return null;

    const sectorSize = this.discInfo?.sectorSize || (this.discData.length % 2352 === 0 ? 2352 : 2048);
    const payload = new Uint8Array(load_size);

    if (sectorSize === 2352 || this.discData.length % 2352 === 0) {
      const subOffset = (headerOffset % 2352 === 24 || headerOffset % 2352 === 16)
        ? (headerOffset % 2352)
        : 24;
      const headerLba = Math.floor(headerOffset / 2352);
      let bytesRead = 0;
      let currentLba = headerLba + 1;
      while (bytesRead < load_size && (currentLba * 2352 + subOffset) < this.discData.length) {
        const srcStart = currentLba * 2352 + subOffset;
        const chunkLen = Math.min(2048, load_size - bytesRead, this.discData.length - srcStart);
        payload.set(this.discData.subarray(srcStart, srcStart + chunkLen), bytesRead);
        bytesRead += chunkLen;
        currentLba++;
      }
      console.log(`[CD-ROM PAYLOAD] Extracted ${bytesRead} bytes sector-by-sector from LBA ${headerLba + 1} with subOffset ${subOffset}`);
      return { load_addr, data: payload };
    } else {
      const srcStart = headerOffset + 2048;
      const chunkLen = Math.min(load_size, this.discData.length - srcStart);
      if (chunkLen > 0) {
        payload.set(this.discData.subarray(srcStart, srcStart + chunkLen), 0);
      }
      console.log(`[CD-ROM PAYLOAD] Extracted ${chunkLen} bytes linearly from offset ${srcStart}`);
      return { load_addr, data: payload };
    }
  }

  /**
   * Analyzes disc image header to determine sector format, ISO9660 Volume Descriptor, and SYSTEM.CNF
   */
  public inspectDisc(data: Uint8Array, fileName: string): DiscInfo {
    const size = data.length;
    let type: DiscInfo['type'] = 'unknown';
    let sectorSize = 2048;
    let volumeLabel = '';
    let executableName = '';

    // Check for PS-X EXE (Header starts with "PS-X EXE")
    const isPsExe = data.length >= 8 &&
      data[0] === 0x50 && data[1] === 0x53 && data[2] === 0x2D && data[3] === 0x58 &&
      data[4] === 0x20 && data[5] === 0x45 && data[6] === 0x58 && data[7] === 0x45;

    if (isPsExe) {
      type = 'ps-exe';
      sectorSize = 2048;
      volumeLabel = 'PS-X Direct Executable';
      executableName = fileName;
    } else {
      // Determine sector size (2048 standard ISO vs 2352 Raw BIN / Mode 2)
      if (size % 2352 === 0 && size >= 2352 * 16) {
        // Raw 2352-byte sector format (BIN / IMG)
        sectorSize = 2352;
        type = 'bin';

        // Check for ISO-9660 PVD at sector 16 (0x9300 in 2352 format, data starts at offset 0x9318)
        const pvdOffset = 16 * 2352 + 24;
        if (pvdOffset + 40 < size) {
          const magic = String.fromCharCode(data[pvdOffset + 1], data[pvdOffset + 2], data[pvdOffset + 3], data[pvdOffset + 4], data[pvdOffset + 5]);
          if (magic === 'CD001') {
            volumeLabel = this.readAscii(data, pvdOffset + 40, 32).trim();
          }
        }
      } else if (size % 2048 === 0 && size >= 2048 * 16) {
        // Standard ISO format
        sectorSize = 2048;
        type = 'iso';

        // PVD at sector 16 (0x8000)
        const pvdOffset = 16 * 2048;
        if (pvdOffset + 40 < size) {
          const magic = String.fromCharCode(data[pvdOffset + 1], data[pvdOffset + 2], data[pvdOffset + 3], data[pvdOffset + 4], data[pvdOffset + 5]);
          if (magic === 'CD001') {
            volumeLabel = this.readAscii(data, pvdOffset + 40, 32).trim();
          }
        }
      } else {
        type = fileName.toLowerCase().endsWith('.cue') ? 'cue' : 'iso';
        sectorSize = 2048;
      }

      // Search for SYSTEM.CNF BOOT string (e.g., "BOOT = cdrom:\SLUS_xxx.xx;1")
      const searchEnd = Math.min(size, 2352 * 64);
      for (let i = 0; i < searchEnd - 20; i++) {
        if (
          (data[i] === 0x42 || data[i] === 0x62) && // 'B'
          (data[i+1] === 0x4F || data[i+1] === 0x6F) && // 'O'
          (data[i+2] === 0x4F || data[i+2] === 0x6F) && // 'O'
          (data[i+3] === 0x54 || data[i+3] === 0x74)    // 'T'
        ) {
          const line = this.readAscii(data, i, 64);
          const match = line.match(/BOOT\s*=\s*cdrom:\\?([^;\r\n]+)/i);
          if (match && match[1]) {
            executableName = match[1].trim();
            break;
          }
        }
      }
    }

    return {
      name: fileName,
      size,
      type,
      volumeLabel: volumeLabel || (type === 'ps-exe' ? 'PS-X Direct EXE' : 'PlayStation Game Disc'),
      executableName: executableName || (type === 'ps-exe' ? fileName : 'PSX.EXE'),
      sectorSize,
      totalSectors: Math.floor(size / sectorSize),
    };
  }

  private readAscii(data: Uint8Array, start: number, length: number): string {
    let str = '';
    const end = Math.min(data.length, start + length);
    for (let i = start; i < end; i++) {
      const c = data[i];
      if (c >= 32 && c <= 126) {
        str += String.fromCharCode(c);
      } else {
        str += ' ';
      }
    }
    return str;
  }



  /**
   * Advances CD-ROM cycles for command execution delay, sector reading cadence, & seek completion
   */
  public advanceCycles(cycles: number): void {
    // 1. Pending Command Execution Latency (10k-30k cycles)
    if (this.pendingCommandDelay > 0) {
      this.pendingCommandDelay -= cycles;
      if (this.pendingCommandDelay <= 0) {
        this.pendingCommandDelay = 0;
        const intFlag = this.pendingCommandInt;
        const resp = this.pendingCommandResponse;
        const post = this.pendingCommandPostAction;
        const cmdName = this.pendingCommandName;
        this.pendingCommandPostAction = undefined;

        // Overwrite/clear any stale INT5 or disc-status interrupt
        if (this.onTriggerIrq) {
          this.onTriggerIrq(false); // Pull down any stale IRQ line
        }

        // Force active interrupt to what the command generates (e.g. 3)
        this.interruptFlag = intFlag;

        // Force bit 2 (or set this.interruptEnable |= 7) so internal gate doesn't block it
        this.interruptEnable |= 7;

        // Push response bytes directly into responseFifo
        this.responseFifo = [...resp];

        // Assert CPU IRQ 2 (i_stat |= (1 << 2)) via onTriggerIrq(true)
        if (this.onTriggerIrq) {
          this.onTriggerIrq(true);
        }

        if (cmdName.includes('Test')) {
          console.log('[CD-ROM TEST COMPLETE] Pushed 4 bytes to FIFO, asserted INT3');
        } else {
          console.log(`[CD-ROM COMMAND COMPLETE] Pushed ${resp.length} bytes to FIFO, asserted INT${intFlag} for command "${cmdName}"`);
        }

        if (post) {
          post();
        }
      }
    }

    // 3. Seek Completion Cadence
    if (this.pendingSeekCycles > 0) {
      this.pendingSeekCycles -= cycles;
      if (this.pendingSeekCycles <= 0) {
        this.pendingSeekCycles = 0;
        this.isSeeking = false;
        this.status = this.getStatus();
        this.deliverInterrupt(2, [this.status]); // INT2 (Complete)
      }
    }

    // 4. Sector Read Cadence (1x: 75Hz ~451,584 cycles, 2x: 150Hz ~225,792 cycles)
    if (this.isReading && this.hasDisc) {
      const sectorSize = this.discInfo?.sectorSize || (this.discData?.length % 2352 === 0 ? 2352 : 2048);
      const totalSectors = this.discData ? Math.floor(this.discData.length / sectorSize) : 0;

      if (this.currentLba >= totalSectors) {
        this.isReading = false;
        const eodLog = `[CD-ROM READ END] Reached End-of-Disc (Sector LBA ${this.currentLba} >= ${totalSectors}). Stopping read.`;
        console.warn(eodLog);
        if (this.onLog) this.onLog('warn', eodLog);
      } else {
        this.readCyclesCountdown -= cycles;
        if (this.readCyclesCountdown <= 0) {
          // Deliver INT1 Data Ready when ready, ONLY if previous INT1 has been acknowledged
          if ((this.interruptFlag & 1) === 0) {
            if ((this.interruptFlag & 0x07) === 0 || this.readCyclesCountdown < -100000) {
              this.loadCurrentSectorIntoBuffer();
              this.status = this.getStatus();
              this.deliverInterrupt(1, [this.status]); // INT1 (Data Ready)

              // Assert CD-ROM DMA Request if listener is attached
              if (this.onDmaRequest) {
                this.onDmaRequest();
              }

              // Reset sector interval countdown (Do not increment currentLba until INT1 is ACKed)
              const sectorInterval = this.isDoubleSpeed ? 225792 : 451584;
              this.readCyclesCountdown = sectorInterval;
            }
          } else {
            // Wait for previous INT1 to be acknowledged
            this.readCyclesCountdown = 1000;
          }
        }
      }
    }
  }

  public readDataByte(): number {
    if (this.dataFifoIndex < this.dataFifo.length) {
      const val = this.dataFifo[this.dataFifoIndex++];
      this.pioBytesReadThisSector++;

      if (this.dataFifoIndex >= this.dataFifo.length) {
        const words = Math.floor(this.pioBytesReadThisSector / 4);
        const logMsg = `[CD-ROM PIO READ] Sector transfer complete via Port 2. Total words read: ${words} (${this.pioBytesReadThisSector} bytes). Data FIFO empty.`;
        console.log(logMsg);
        if (this.onLog) this.onLog('bios', logMsg);
        this.pioBytesReadThisSector = 0;
      }
      return val;
    }
    return 0x00;
  }

  public readDataHalfword(): number {
    const b0 = this.readDataByte();
    const b1 = this.readDataByte();
    return (b0 | (b1 << 8)) & 0xffff;
  }

  public readDataWord(): number {
    const b0 = this.readDataByte();
    const b1 = this.readDataByte();
    const b2 = this.readDataByte();
    const b3 = this.readDataByte();
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }

  /**
   * Reads 8-bit from CD-ROM registers (0x1F801800 - 0x1F801803)
   * Strict PlayStation Register Bank Mapping:
   * Bank 0: 1F801801 = Response FIFO (R), 1F801802 = Data FIFO (R), 1F801803 = Interrupt Enable IER (R)
   * Bank 1: 1F801801 = Response FIFO (R), 1F801802 = Interrupt Enable IER (R), 1F801803 = Interrupt Flag IFR (R)
   * Bank 2: 1F801801 = Response FIFO (R), 1F801802 = Data FIFO (R), 1F801803 = Audio Volume / Routing
   * Bank 3: 1F801801 = Response FIFO (R), 1F801802 = Interrupt Flag IFR (R), 1F801803 = Audio Volume
   */
  public readRegister(port: number): number {
    this.totalReads++;
    if (this.onActivity) {
      this.onActivity();
    }

    const realPort = port & 3;

    // Log CPU reads from Port 0 or Port 1 during Test command delay
    if (this.pendingCommandDelay > 0 && (realPort === 0 || realPort === 1)) {
      const logMsg = `[CD-ROM POLL] CPU read from Port ${realPort} while Command "${this.pendingCommandName}" is pending (Delay remaining: ${this.pendingCommandDelay} cycles). Port 0 Status bit 5 is ${this.responseFifo.length > 0 ? 1 : 0}`;
      console.log(logMsg);
      if (this.onLog) {
        this.onLog('bios', logMsg);
      }
    }

    switch (realPort) {
      case 0: {
        // 0x1F801800: Status register
        // Bit 0-1: Currently selected index (0..3)
        // Bit 2: ADPCM busy / empty (0)
        // Bit 3: Parameter FIFO empty (1 when empty, 0 when full)
        // Bit 4: Parameter FIFO writable (1 when ready to receive parameter)
        // Bit 5: Response FIFO not empty (1 when bytes available to read from Port 1)
        // Bit 6: Data FIFO not empty (1 when sector data ready for Port 2 / DMA3)
        // Bit 7: Busy (1 during internal execution / transmission busy)
        let stat = this.index & 0x03;
        if (this.parameterFifo.length === 0) {
          stat |= 0x08; // Bit 3: Parameter FIFO empty
        }
        if (this.parameterFifo.length < 16) {
          stat |= 0x10; // Bit 4: Parameter FIFO writable
        }
        if (this.responseFifo.length > 0) {
          stat |= 0x20; // Bit 5: Response FIFO not empty
        }
        if (this.dataFifoIndex < this.dataFifo.length) {
          stat |= 0x40; // Bit 6: Data FIFO not empty
          stat |= 0x20; // Bit 5: DRQSTS / Data Ready (user specified)
        }
        if (this.isReading || this.isSeeking || this.pendingCommandDelay > 0) {
          stat |= 0x80; // Bit 7: Busy
          stat |= 0x01; // Bit 0: BUSY (user specified)
        }
        return stat;
      }

      case 1: {
        // 0x1F801801: Response FIFO pop across all banks
        let resp = this.getStatus();
        if (this.responseFifo.length > 0) {
          resp = this.responseFifo.shift()!;
        }
        const hexVal = `0x${resp.toString(16).padStart(2, '0').toUpperCase()}`;
        const logMsg = `[CD-ROM READ] Port 1 (Response FIFO) Pop -> ${hexVal} (Remaining FIFO items: ${this.responseFifo.length})`;
        console.log(logMsg);
        if (this.onLog) {
          this.onLog('bios', logMsg);
        }
        return resp;
      }

      case 2: {
        // 0x1F801802:
        // Bank 0 & 2: Data FIFO pop
        // Bank 1: Interrupt Enable Register (IER)
        // Bank 3: Interrupt Flag Register (IFR)
        if (this.index === 1) {
          return this.interruptEnable & 0x1f;
        }
        if (this.index === 3) {
          let flag = 0xe0 | (this.interruptFlag & 0x07);
          if (this.parameterFifo.length === 0) flag |= 0x08;
          if (this.responseFifo.length > 0) flag |= 0x10;
          return flag;
        }
        // Bank 0 and Bank 2: Data FIFO read
        return this.readDataByte();
      }

      case 3: {
        // 0x1F801803:
        // Bank 0: Interrupt Enable Register (IER)
        // Bank 1: Interrupt Flag Register (IFR)
        // Bank 2: Audio Volume Left-to-Right
        // Bank 3: Audio Volume Right-to-Left
        if (this.index === 0) {
          return (this.interruptEnable & 0x1f) | 0xe0;
        }
        if (this.index === 1) {
          let flag = 0xe0 | (this.interruptFlag & 0x07);
          if (this.parameterFifo.length === 0) flag |= 0x08;
          if (this.responseFifo.length > 0) flag |= 0x10;
          return flag;
        }
        if (this.index === 2) {
          return this.volumeLeftToRight;
        }
        if (this.index === 3) {
          return this.volumeRightToLeft;
        }
        return 0;
      }
    }
    return 0;
  }

  /**
   * Writes 8-bit to CD-ROM registers (0x1F801800 - 0x1F801803)
   * Strict PlayStation Register Bank Mapping:
   * Bank 0: 1F801801 = Command (W), 1F801802 = Parameter (W), 1F801803 = Request / SMEN (W)
   * Bank 1: 1F801801 = Sound Map (W), 1F801802 = IER (W), 1F801803 = IFR Ack (W)
   * Bank 2: 1F801801 = Parameter (W), 1F801802 = Volume L-L (W), 1F801803 = Volume L-R (W)
   * Bank 3: 1F801801 = Apply Volume (W), 1F801802 = Volume R-R (W), 1F801803 = Volume R-L (W)
   */
  public writeRegister(port: number, val: number): void {
    val = val & 0xff;
    this.totalWrites++;
    if (this.onActivity) {
      this.onActivity();
    }

    switch (port & 3) {
      case 0: // 0x1F801800: Index select
        this.index = val & 3;
        break;

      case 1: // 0x1F801801:
        if (this.index === 0) {
          // Command register
          this.executeCommand(val);
        } else if (this.index === 2) {
          // Parameter FIFO
          this.parameterFifo.push(val);
        }
        break;

      case 2: // 0x1F801802:
        if (this.index === 0) {
          // Parameter FIFO
          this.parameterFifo.push(val);
        } else if (this.index === 1) {
          // Interrupt Enable Register (IER)
          this.interruptEnable = val & 0x1f;
          this.updateIrq();
        } else if (this.index === 2) {
          this.volumeLeftToLeft = val;
        } else if (this.index === 3) {
          this.volumeRightToRight = val;
        }
        break;

      case 3: {
        // 0x1F801803:
        const hexVal = `0x${val.toString(16).padStart(2, '0').toUpperCase()}`;
        const logMsg = `[CD-ROM WRITE] Port 3 (Index ${this.index}) Write: ${hexVal} (Current INT: ${this.interruptFlag})`;
        console.log(logMsg);
        if (this.onLog) {
          this.onLog('bios', logMsg);
        }

        // Port 3 Bank 0 Write (0x80 - Transfer Data to FIFO / BFRD)
        if (this.index === 0) {
          if ((val & 0x80) !== 0) {
            // Copy 2048-byte sector payload into active dataFifo buffer
            this.dataFifo = Array.from(this.sectorBuffer.subarray(0, this.sectorBufferLength));
            this.dataFifoIndex = 0;
            this.pioBytesReadThisSector = 0;
            const bfrdLog = `[CD-ROM BFRD] Port 3 Bank 0 Write 0x80: Transferred ${this.dataFifo.length} bytes (Sector LBA ${this.currentLba}) to Data FIFO (Port 0 Bit 6 = 1).`;
            console.log(bfrdLog);
            if (this.onLog) this.onLog('bios', bfrdLog);

            // Assert CD-ROM DMA request on BFRD
            if (this.onDmaRequest) {
              this.onDmaRequest();
            }
          } else {
            this.dataFifo = [];
            this.dataFifoIndex = 0;
          }
        } else {
          // Bit 7 on Bank 1..3: Clear response FIFO / SMEN
          if ((val & 0x80) !== 0) {
            this.responseFifo = [];
          }
        }

        // Bit 6: Clear parameter FIFO
        if ((val & 0x40) !== 0) {
          this.parameterFifo = [];
        }

        // Acknowledge interrupt flags (Bits 0..4 / 0..2) regardless of bank index
        const ackFlags = val & 0x1f;
        const wasInt1 = (this.interruptFlag & 1) !== 0;

        if (ackFlags !== 0) {
          this.interruptFlag &= ~ackFlags;
        }



        // When the BIOS writes 0x07 or 0x1F to Port 3 to acknowledge INT1:
        // Advance to next sector (currentLba++) and schedule next periodic INT1 pulse (~225,792 cycles for 2x mode)
        if (wasInt1 && (ackFlags & 1) !== 0) {
          this.cyclesSinceLastInt1 = 0;
          if (this.isReading && !this.isSeeking && this.hasDisc) {
            this.currentLba++;
            const sectorInterval = this.isDoubleSpeed ? 225792 : 451584;
            this.readCyclesCountdown = sectorInterval;
            const ackLog = `[CD-ROM INT1 ACK] INT1 Acknowledged. Advancing to Sector LBA ${this.currentLba} in ${sectorInterval} cycles (${this.isDoubleSpeed ? '2x' : '1x'}).`;
            console.log(ackLog);
            if (this.onLog) this.onLog('bios', ackLog);
          }
        }

        // If active interrupt has been cleared, deliver next queued interrupt
        if ((this.interruptFlag & 0x07) === 0) {
          this.interruptFlag = 0;
          if (this.interruptQueue.length > 0) {
            const next = this.interruptQueue.shift()!;
            this.interruptFlag = next.flag;
            this.responseFifo = [...next.response];
            const logMsg = `[CD-ROM INT${next.flag} Delivered] Delivered queued INT${next.flag} with response: [${next.response.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(', ')}]`;
            console.log(logMsg);
            if (this.onLog) this.onLog('bios', logMsg);
          }
        }

        if (this.index === 2) {
          this.volumeLeftToRight = val;
        } else if (this.index === 3) {
          this.volumeRightToLeft = val;
        }

        this.updateIrq();
        break;
      }
    }
  }

  /**
   * Schedules a command with authentic hardware execution latency (~10,000-30,000 CPU cycles)
   */
  private scheduleCommandResponse(cmdName: string, intFlag: number, response: number[], delayCycles: number = 15000, postAction?: () => void): void {
    this.pendingCommandDelay = delayCycles;
    this.pendingCommandInt = intFlag;
    this.pendingCommandResponse = response;
    this.pendingCommandName = cmdName;
    this.pendingCommandPostAction = postAction;
  }

  /**
   * Executes a CD-ROM command received in Port 0x1F801801 (Index 0)
   */
  private executeCommand(cmd: number): void {
    const cmdName = CdRom.COMMAND_NAMES[cmd] || `Unknown_0x${cmd.toString(16).padStart(2, '0')}`;
    const params = [...this.parameterFifo];
    this.parameterFifo = []; // clear parameter FIFO

    this.commandHistory.push({
      cmd,
      name: cmdName,
      params,
      time: Date.now(),
    });

    const currentStatus = this.getStatus();

    switch (cmd) {
      case 0x01: // Getstat
        {
          let statusByte = currentStatus;
          if (this.hasDisc) {
            statusByte = 0x02; // Force Motor Spun Up (0x02)
          }
          this.scheduleCommandResponse('Getstat', 3, [statusByte], 10000);
        }
        break;

      case 0x02: // Setloc (Minutes, Seconds, Sector in BCD / Hex)
        if (params.length >= 3) {
          this.seekMinute = this.bcdToDec(params[0]);
          this.seekSecond = this.bcdToDec(params[1]);
          this.seekSector = this.bcdToDec(params[2]);
          // Calculate LBA: (M * 60 + S) * 75 + F - 150
          this.currentLba = (this.seekMinute * 60 + this.seekSecond) * 75 + this.seekSector - 150;
          if (this.currentLba < 0) this.currentLba = 0;
          const logMsg = `[CD-ROM Setloc] Target Location: ${this.seekMinute.toString().padStart(2, '0')}:${this.seekSecond.toString().padStart(2, '0')}:${this.seekSector.toString().padStart(2, '0')} -> Target LBA ${this.currentLba}`;
          console.log(logMsg);
          if (this.onLog) this.onLog('bios', logMsg);
        }
        this.scheduleCommandResponse('Setloc', 3, [currentStatus], 12000);
        break;

      case 0x06: // ReadN (Read without retry)
      case 0x1b: // ReadS (Read with retry)
        if (!this.hasDisc) {
          this.scheduleCommandResponse(cmdName, 5, [0x14], 15000); // Shell Open + Error
        } else {
          this.scheduleCommandResponse(cmdName, 3, [this.getStatus()], 15000, () => {
            this.isReading = true;
            this.readCyclesCountdown = this.isDoubleSpeed ? 225792 : 451584;
            const logMsg = `[CD-ROM ${cmdName}] Reading initialized at Target Sector LBA ${this.currentLba} (${this.isDoubleSpeed ? '2x' : '1x'} speed).`;
            console.log(logMsg);
            if (this.onLog) this.onLog('bios', logMsg);
          });
        }
        break;

      case 0x07: // MotorOn
        this.isMotorOn = true;
        this.scheduleCommandResponse('MotorOn', 3, [this.getStatus()], 20000);
        break;

      case 0x08: // Stop
        this.isMotorOn = false;
        this.isReading = false;
        this.scheduleCommandResponse('Stop', 3, [this.getStatus()], 20000);
        break;

      case 0x09: // Pause
        this.isReading = false;
        // First (INT3): Immediate acknowledge with [this.stat] (~10,000 cycles)
        this.scheduleCommandResponse('Pause', 3, [this.getStatus()], 10000, () => {
          // Second (INT2): Delivered upon BIOS acknowledging INT3 on Port 3 (or queued into interrupt FIFO)
          const pauseStat = this.getStatus();
          this.deliverInterrupt(2, [pauseStat]);
          const logMsg = `[CD-ROM Pause] Stage 1 (INT3) Delivered. Queued Stage 2 (INT2 Complete) Stat: 0x${pauseStat.toString(16).padStart(2, '0').toUpperCase()}.`;
          console.log(logMsg);
          if (this.onLog) this.onLog('bios', logMsg);
        });
        break;

      case 0x0a: // Init
        this.reset();
        this.scheduleCommandResponse('Init', 3, [this.getStatus()], 25000);
        break;

      case 0x0b: // Mute
      case 0x0c: // Demute
      case 0x0d: // Setfilter
        this.scheduleCommandResponse(cmdName, 3, [this.getStatus()], 12000);
        break;

      case 0x0e: // Setmode
        if (params.length > 0) {
          const mode = params[0];
          this.isDoubleSpeed = (mode & 0x80) !== 0;
          this.sectorSizeSetting = (mode & 0x20) !== 0 ? 2340 : 2048;
        }
        this.scheduleCommandResponse('Setmode', 3, [this.getStatus()], 12000);
        break;

      case 0x0f: // Getparam
        this.scheduleCommandResponse('Getparam', 3, [
          this.getStatus(),
          this.isDoubleSpeed ? 0x80 : 0x00,
          0x00,
          0x00,
          0x00
        ], 12000);
        break;

      case 0x10: // GetlocL (Returns subheader: MM, SS, FF, Mode, File, Channel, Submode, Coding)
        this.scheduleCommandResponse('GetlocL', 3, [
          this.decToBcd(this.seekMinute),
          this.decToBcd(this.seekSecond),
          this.decToBcd(this.seekSector),
          0x02, 0x00, 0x00, 0x08, 0x00
        ], 12000);
        break;

      case 0x11: // GetlocP (Subchannel Q info: Track, Index, MM, SS, FF, AMM, ASS, AFF)
        this.scheduleCommandResponse('GetlocP', 3, [
          0x01, 0x01,
          this.decToBcd(this.seekMinute),
          this.decToBcd(this.seekSecond),
          this.decToBcd(this.seekSector),
          this.decToBcd(this.seekMinute),
          this.decToBcd(this.seekSecond),
          this.decToBcd(this.seekSector),
        ], 12000);
        break;

      case 0x12: // SetSession
        this.scheduleCommandResponse('SetSession', 3, [this.getStatus()], 15000);
        break;

      case 0x13: // GetTN (First track, last track)
        this.scheduleCommandResponse('GetTN', 3, [this.getStatus(), 0x01, 0x01], 12000);
        break;

      case 0x14: // GetTD (Track start address)
        this.scheduleCommandResponse('GetTD', 3, [this.getStatus(), 0x00, 0x02], 12000); // 00:02:00
        break;

      case 0x15: // SeekL
      case 0x16: // SeekP
        this.isSeeking = true;
        this.scheduleCommandResponse(cmdName, 3, [this.getStatus()], 15000, () => {
          this.pendingSeekCycles = 30000;
        });
        break;

      case 0x19: // Test
        {
          const sub = params.length > 0 ? params[0] : 0x20;
          if (sub === 0x20 || params.length === 0) {
            // Firmware version: 0x94, 0x09, 0x19, 0xC0 (vC0 1994-09-19)
            this.scheduleCommandResponse('Test(0x20)', 3, [0x94, 0x09, 0x19, 0xc0], 15000);
          } else {
            this.scheduleCommandResponse('Test', 3, [this.getStatus()], 12000);
          }
        }
        break;

      case 0x1a: // GetID
        this.getIdCallCount++;
        if (this.hasDisc) {
          // Stage 1: Deliver INT3 acknowledge after ~15,000 cycles with single-byte status [0x02] (Motor Spun Up)
          this.scheduleCommandResponse('GetID', 3, [0x02], 15000, () => {
            // Stage 2: Queue INT2 with full 8-byte identification payload:
            // [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41] (stat, flags, type, atip, 'S', 'C', 'E', 'A')
            const idPayload = [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41];
            this.deliverInterrupt(2, idPayload);
            const logMsg = `[CD-ROM GetID] Stage 1 (INT3) Acknowledged. Queued Stage 2 (INT2) 8-byte payload: [${idPayload.map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase()).join(', ')}]`;
            console.log(logMsg);
            if (this.onLog) this.onLog('bios', logMsg);
          });
        } else {
          // No disc: Deliver INT3 then queue INT5 error
          this.scheduleCommandResponse('GetID(NoDisc)', 3, [this.getStatus()], 15000, () => {
            const noDiscPayload = [0x08, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
            this.deliverInterrupt(5, noDiscPayload);
            const logMsg = `[CD-ROM GetID] Stage 1 (INT3). Queued Stage 2 (INT5) NoDisc Error.`;
            console.log(logMsg);
            if (this.onLog) this.onLog('bios', logMsg);
          });
        }
        break;

      case 0x1c: // Reset
        this.reset();
        this.scheduleCommandResponse('Reset', 3, [this.getStatus()], 25000);
        break;

      case 0x1e: // ReadTOC
        this.scheduleCommandResponse('ReadTOC', 3, [this.getStatus()], 20000);
        break;

      default:
        this.scheduleCommandResponse(cmdName, 3, [this.getStatus()], 15000);
        break;
    }

    // Comprehensive Command Logging
    const hexCmd = `0x${cmd.toString(16).padStart(2, '0').toUpperCase()}`;
    const paramStr = params.map(p => `0x${p.toString(16).padStart(2, '0').toUpperCase()}`).join(', ');
    const respStr = this.pendingCommandResponse.map(r => `0x${r.toString(16).padStart(2, '0').toUpperCase()}`).join(', ');
    const logMsg = `[CD-ROM CMD] ${hexCmd} (${cmdName}) Params: [${paramStr}] -> Scheduled INT${this.pendingCommandInt} Response: [${respStr}] (Delay: ${this.pendingCommandDelay} cycles)`;
    console.log(logMsg);

    if (this.getIdCallCount >= 2 && cmd !== 0x1a) {
      const postGetIdMsg = `[CD-ROM POST-GETID COMMAND] Opcode: ${hexCmd} (${cmdName}), Params: [${paramStr}], Target LBA: ${this.currentLba}, Sector: ${this.seekMinute}:${this.seekSecond}:${this.seekSector}`;
      console.log(postGetIdMsg);
      if (this.onLog) {
        this.onLog('bios', postGetIdMsg);
      }
    }

    if (this.onLog) {
      this.onLog('bios', logMsg);
    }
  }

  /**
   * Reads the current sector from disc into data FIFO for CPU/DMA retrieval
   */
  public loadCurrentSectorIntoBuffer(): void {
    if (!this.discData || !this.discInfo) return;

    const sectorSize = this.discInfo.sectorSize;
    const offset = this.currentLba * sectorSize;

    if (offset < this.discData.length) {
      this.sectorsReadCount++;

      let userOffset = offset;
      let userLen = 2048;

      if (sectorSize === 2352) {
        // Mode 2 Form 1 / Mode 1 sector: 2048 bytes payload starts at offset 0x18
        if (this.sectorSizeSetting === 2340) {
          userOffset = offset + 12;
          userLen = 2340;
        } else if (this.sectorSizeSetting === 2352) {
          userOffset = offset;
          userLen = 2352;
        } else {
          userOffset = offset + 0x18;
          userLen = 2048;
        }
      } else {
        // Standard ISO 2048 byte sectors
        userOffset = offset;
        userLen = 2048;
      }

      const actualLen = Math.min(userLen, this.discData.length - userOffset);
      if (this.sectorBuffer.length < actualLen) {
        this.sectorBuffer = new Uint8Array(actualLen);
      }
      this.sectorBuffer.set(this.discData.subarray(userOffset, userOffset + actualLen));
      this.sectorBufferLength = actualLen;

      // Copy to data FIFO immediately when buffered so that Port 0 Bit 6 (DRQSTS) is asserted
      this.dataFifo = Array.from(this.sectorBuffer.subarray(0, actualLen));
      this.dataFifoIndex = 0;
      this.pioBytesReadThisSector = 0;
      this.cyclesSinceLastInt1 = 0;

      const logMsg = `[CD-ROM READ] INT1 Data Ready: Sector LBA ${this.currentLba} buffered (${actualLen} bytes). Ready for Port 3 Bank 0 0x80 (BFRD) / DMA3.`;
      console.log(logMsg);
      if (this.onLog) {
        this.onLog('bios', logMsg);
      }
    }
  }

  private bcdToDec(val: number): number {
    return ((val >> 4) * 10) + (val & 0x0f);
  }

  private decToBcd(val: number): number {
    return (((Math.floor(val / 10) % 10) << 4) | (val % 10)) >>> 0;
  }
}

