/**
 * PlayStation 1 CD-ROM Controller Subsystem (0x1F801800 - 0x1F801803) & Disc Image Parser
 * Compliant Register Bank dispatching, authentic BFRD DMA transfer handshake,
 * and reliable ISO-9660 / Raw Mode 2 Form 1/2 streaming.
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

  // Track Buffer (holds sector after INT1, moved to dataFifo via BFRD 0x80)
  public trackBuffer: Uint8Array = new Uint8Array(2352);
  public trackBufferLength: number = 2048;
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

  // Callbacks
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

  public getStatus(): number {
    if (!this.hasDisc || this.isShellOpen) {
      return 0x10; // Bit 4: Shell open; Motor (bit 1), Read (bit 5), and Seek (bit 6) must be strictly 0
    }
    let stat = 0;
    if (this.isMotorOn) {
      stat |= 0x02; // Bit 1: Motor on
    }
    if (this.isReading) {
      stat |= 0x20; // Bit 5: Read in progress
    }
    if (this.isSeeking) {
      stat |= 0x40; // Bit 6: Seek in progress
    }
    return stat;
  }

  public updateIrq(): void {
    const isAsserted = (this.interruptFlag & this.interruptEnable) !== 0;
    if (this.onTriggerIrq) {
      this.onTriggerIrq(isAsserted);
    }
  }

  public deliverInterrupt(flag: number, response: number[]): void {
    if (this.interruptFlag !== 0) {
      this.interruptQueue.push({ flag, response });
      return;
    }
    this.interruptFlag = flag & 0x07;
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
    this.trackBufferLength = 2048;
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
      this.status = 0x02;
    } else {
      this.isShellOpen = true;
      this.isMotorOn = false;
      this.status = 0x10;
    }
    this.updateIrq();
  }

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
    this.status = 0x02;
    this.interruptFlag = 0;

    const info = this.inspectDisc(this.discData, fileName);
    this.discInfo = info;
    this.parseExeHeader();
    this.pendingLidCycles = 0;

    const exeDetails = this.exeHeader
      ? ` | Initial PC: 0x${this.exeHeader.initial_pc.toString(16).toUpperCase()}, LoadAddr: 0x${this.exeHeader.load_addr.toString(16).toUpperCase()}`
      : '';
    const logMsg = `CD-ROM: Mounted "${info.name}" (${(info.size / (1024 * 1024)).toFixed(2)} MB, ${info.type.toUpperCase()}). Sectors: ${info.totalSectors.toLocaleString()}${exeDetails}`;
    console.log(`[CD-ROM MOUNT] ${logMsg}`);
    if (this.onLog) this.onLog('system', logMsg);

    return info;
  }

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
  }

  public parseExeHeader(): PsxExeHeader | null {
    if (!this.discData || this.discData.length < 2048) {
      this.exeHeader = null;
      return null;
    }

    const data = this.discData;
    let headerOffset = -1;

    if (
      data[0] === 0x50 && data[1] === 0x53 && data[2] === 0x2D && data[3] === 0x58 &&
      data[4] === 0x20 && data[5] === 0x45 && data[6] === 0x58 && data[7] === 0x45
    ) {
      headerOffset = 0;
    }

    const sectorSize = this.discInfo?.sectorSize || (data.length % 2352 === 0 ? 2352 : 2048);

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

    if (headerOffset === -1 || headerOffset + 0x38 > data.length) {
      this.exeHeader = null;
      return null;
    }

    const view = new DataView(data.buffer, data.byteOffset + headerOffset, Math.min(2048, data.length - headerOffset));
    this.exeHeader = {
      initial_pc: view.getUint32(0x10, true) >>> 0,
      initial_gp: view.getUint32(0x14, true) >>> 0,
      load_addr: view.getUint32(0x18, true) >>> 0,
      load_size: view.getUint32(0x1c, true) >>> 0,
      initial_sp_base: view.getUint32(0x30, true) >>> 0,
      initial_sp_offset: view.getUint32(0x34, true) >>> 0,
      headerOffset,
      bss_addr: view.getUint32(0x38, true) >>> 0,
      bss_size: view.getUint32(0x3c, true) >>> 0,
    };

    return this.exeHeader;
  }

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
      return { load_addr, data: payload };
    } else {
      const srcStart = headerOffset + 2048;
      const chunkLen = Math.min(load_size, this.discData.length - srcStart);
      if (chunkLen > 0) {
        payload.set(this.discData.subarray(srcStart, srcStart + chunkLen), 0);
      }
      return { load_addr, data: payload };
    }
  }

  public inspectDisc(data: Uint8Array, fileName: string): DiscInfo {
    const size = data.length;
    let type: DiscInfo['type'] = 'unknown';
    let sectorSize = 2048;
    let volumeLabel = '';
    let executableName = '';

    const isPsExe = data.length >= 8 &&
      data[0] === 0x50 && data[1] === 0x53 && data[2] === 0x2D && data[3] === 0x58 &&
      data[4] === 0x20 && data[5] === 0x45 && data[6] === 0x58 && data[7] === 0x45;

    if (isPsExe) {
      type = 'ps-exe';
      sectorSize = 2048;
      volumeLabel = 'PS-X Direct Executable';
      executableName = fileName;
    } else {
      if (size % 2352 === 0 && size >= 2352 * 16) {
        sectorSize = 2352;
        type = 'bin';
        const pvdOffset = 16 * 2352 + 24;
        if (pvdOffset + 40 < size) {
          const magic = String.fromCharCode(data[pvdOffset + 1], data[pvdOffset + 2], data[pvdOffset + 3], data[pvdOffset + 4], data[pvdOffset + 5]);
          if (magic === 'CD001') {
            volumeLabel = this.readAscii(data, pvdOffset + 40, 32).trim();
          }
        }
      } else if (size % 2048 === 0 && size >= 2048 * 16) {
        sectorSize = 2048;
        type = 'iso';
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

      const searchEnd = Math.min(size, 2352 * 64);
      for (let i = 0; i < searchEnd - 20; i++) {
        if (
          (data[i] === 0x42 || data[i] === 0x62) &&
          (data[i+1] === 0x4F || data[i+1] === 0x6F) &&
          (data[i+2] === 0x4F || data[i+2] === 0x6F) &&
          (data[i+3] === 0x54 || data[i+3] === 0x74)
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
      str += (c >= 32 && c <= 126) ? String.fromCharCode(c) : ' ';
    }
    return str;
  }

  public advanceCycles(cycles: number): void {
    // 1. Pending Command Latency
    if (this.pendingCommandDelay > 0) {
      this.pendingCommandDelay -= cycles;
      if (this.pendingCommandDelay <= 0) {
        this.pendingCommandDelay = 0;
        const intFlag = this.pendingCommandInt;
        const resp = this.pendingCommandResponse;
        const post = this.pendingCommandPostAction;
        this.pendingCommandPostAction = undefined;

        this.deliverInterrupt(intFlag, resp);

        if (post) {
          post();
        }
      }
    }

    // 2. Pending Seek Latency
    if (this.pendingSeekCycles > 0) {
      this.pendingSeekCycles -= cycles;
      if (this.pendingSeekCycles <= 0) {
        this.pendingSeekCycles = 0;
        this.isSeeking = false;
        this.status = this.getStatus();
        this.deliverInterrupt(2, [this.status]);
      }
    }

    // 3. Sector Read Timing & Interrupt Delivery
    if (this.isReading && this.hasDisc) {
      const sectorSize = this.discInfo?.sectorSize || (this.discData?.length % 2352 === 0 ? 2352 : 2048);
      const totalSectors = this.discData ? Math.floor(this.discData.length / sectorSize) : 0;

      if (this.currentLba >= totalSectors) {
        this.isReading = false;
      } else {
        this.readCyclesCountdown -= cycles;
        if (this.readCyclesCountdown <= 0) {
          if (this.interruptFlag === 0) {
            this.loadCurrentSectorIntoBuffer();
            this.status = this.getStatus();
            this.deliverInterrupt(1, [this.status]);

            // Advance LBA immediately upon sector delivery
            this.currentLba++;
            const sectorInterval = this.isDoubleSpeed ? 225792 : 451584;
            this.readCyclesCountdown = sectorInterval;
          } else {
            // Keep spinning until CPU/BIOS clears previous interrupt
            this.readCyclesCountdown = 5000;
          }
        }
      }
    }
  }

  public readDataByte(): number {
    if (this.dataFifoIndex < this.dataFifo.length) {
      const val = this.dataFifo[this.dataFifoIndex++];
      this.pioBytesReadThisSector++;
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

  public readRegister(port: number): number {
    this.totalReads++;
    if (this.onActivity) this.onActivity();

    const realPort = port & 3;

    switch (realPort) {
      case 0: {
        // Status Register
        let stat = this.index & 0x03;
        if (this.parameterFifo.length === 0) stat |= 0x08;
        if (this.parameterFifo.length < 16) stat |= 0x10;
        if (this.responseFifo.length > 0) stat |= 0x20;
        if (this.dataFifoIndex < this.dataFifo.length) stat |= 0x40;
        if (this.isReading || this.isSeeking || this.pendingCommandDelay > 0) stat |= 0x80;
        return stat;
      }

      case 1: {
        // Response FIFO
        let resp = this.getStatus();
        if (this.responseFifo.length > 0) {
          resp = this.responseFifo.shift()!;
        }
        return resp;
      }

      case 2: {
        // Bank 0, 2: Data FIFO | Bank 1: IER | Bank 3: IFR
        if (this.index === 1) return this.interruptEnable & 0x1f;
        if (this.index === 3) return 0xe0 | (this.interruptFlag & 0x07);
        return this.readDataByte();
      }

      case 3: {
        // Bank 0: IER | Bank 1: IFR | Bank 2: Vol L->R | Bank 3: Vol R->L
        if (this.index === 0) return (this.interruptEnable & 0x1f) | 0xe0;
        if (this.index === 1) return (this.interruptFlag & 0x07) | 0xe0;
        if (this.index === 2) return this.volumeLeftToRight;
        if (this.index === 3) return this.volumeRightToLeft;
        return 0;
      }
    }
    return 0;
  }

  public writeRegister(port: number, val: number): void {
    val = val & 0xff;
    this.totalWrites++;
    if (this.onActivity) this.onActivity();

    switch (port & 3) {
      case 0: // Index select
        this.index = val & 3;
        break;

      case 1:
        if (this.index === 0) {
          this.executeCommand(val);
        } else if (this.index === 2) {
          this.parameterFifo.push(val);
        }
        break;

      case 2:
        if (this.index === 0) {
          this.parameterFifo.push(val);
        } else if (this.index === 1) {
          this.interruptEnable = val & 0x1f;
          this.updateIrq();
        } else if (this.index === 2) {
          this.volumeLeftToLeft = val;
        } else if (this.index === 3) {
          this.volumeRightToRight = val;
        }
        break;

      case 3: {
        // Port 3 Dispatcher
        if (this.index === 0) {
          // Bank 0: SMEN / Request Register
          if ((val & 0x80) !== 0) {
            // BFRD: Transfer sector trackBuffer into the readable Data FIFO
            this.dataFifo = Array.from(this.trackBuffer.subarray(0, this.trackBufferLength));
            this.dataFifoIndex = 0;
            this.pioBytesReadThisSector = 0;

            if (this.onDmaRequest) {
              this.onDmaRequest();
            }
          } else {
            this.dataFifo = [];
            this.dataFifoIndex = 0;
          }
        } else if (this.index === 1) {
          // Bank 1: Interrupt Flag Register (IFR) Acknowledge
          const ackMask = val & 0x1f;
          if (ackMask !== 0) {
            this.interruptFlag &= ~ackMask;
          }

          // Reset parameter FIFO if bit 6 requested
          if ((val & 0x40) !== 0) {
            this.parameterFifo = [];
          }

          // If active interrupt was completely cleared, deliver next queued interrupt
          if ((this.interruptFlag & 0x07) === 0) {
            this.interruptFlag = 0;
            if (this.interruptQueue.length > 0) {
              const next = this.interruptQueue.shift()!;
              this.interruptFlag = next.flag & 0x07;
              this.responseFifo = [...next.response];
            }
          }

          this.updateIrq();
        } else if (this.index === 2) {
          this.volumeLeftToRight = val;
        } else if (this.index === 3) {
          this.volumeRightToLeft = val;
        }
        break;
      }
    }
  }

  private scheduleCommandResponse(cmdName: string, intFlag: number, response: number[], delayCycles: number = 15000, postAction?: () => void): void {
    this.pendingCommandDelay = delayCycles;
    this.pendingCommandInt = intFlag;
    this.pendingCommandResponse = response;
    this.pendingCommandName = cmdName;
    this.pendingCommandPostAction = postAction;
  }

  private executeCommand(cmd: number): void {
    const cmdName = CdRom.COMMAND_NAMES[cmd] || `Unknown_0x${cmd.toString(16).padStart(2, '0')}`;
    const params = [...this.parameterFifo];
    this.parameterFifo = [];

    this.commandHistory.push({
      cmd,
      name: cmdName,
      params,
      time: Date.now(),
    });

    const currentStatus = this.getStatus();

    switch (cmd) {
      case 0x01: // Getstat
        this.scheduleCommandResponse('Getstat', 3, [this.getStatus()], 10000);
        break;

      case 0x02: // Setloc
        if (params.length >= 3) {
          this.seekMinute = this.bcdToDec(params[0]);
          this.seekSecond = this.bcdToDec(params[1]);
          this.seekSector = this.bcdToDec(params[2]);
          this.currentLba = (this.seekMinute * 60 + this.seekSecond) * 75 + this.seekSector - 150;
          if (this.currentLba < 0) this.currentLba = 0;
        }
        this.scheduleCommandResponse('Setloc', 3, [currentStatus], 12000);
        break;

      case 0x06: // ReadN
      case 0x1b: // ReadS
        if (!this.hasDisc) {
          this.scheduleCommandResponse(cmdName, 5, [0x14], 15000);
        } else {
          this.scheduleCommandResponse(cmdName, 3, [this.getStatus()], 15000, () => {
            this.isReading = true;
            this.readCyclesCountdown = this.isDoubleSpeed ? 225792 : 451584;
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
        this.scheduleCommandResponse('Pause', 3, [this.getStatus()], 10000, () => {
          this.deliverInterrupt(2, [this.getStatus()]);
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
          0x00, 0x00, 0x00
        ], 12000);
        break;

      case 0x10: // GetlocL
        this.scheduleCommandResponse('GetlocL', 3, [
          this.decToBcd(this.seekMinute),
          this.decToBcd(this.seekSecond),
          this.decToBcd(this.seekSector),
          0x02, 0x00, 0x00, 0x08, 0x00
        ], 12000);
        break;

      case 0x11: // GetlocP
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

      case 0x13: // GetTN
        this.scheduleCommandResponse('GetTN', 3, [this.getStatus(), 0x01, 0x01], 12000);
        break;

      case 0x14: // GetTD
        this.scheduleCommandResponse('GetTD', 3, [this.getStatus(), 0x00, 0x02], 12000);
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
            this.scheduleCommandResponse('Test(0x20)', 3, [0x94, 0x09, 0x19, 0xc0], 15000);
          } else {
            this.scheduleCommandResponse('Test', 3, [this.getStatus()], 12000);
          }
        }
        break;

      case 0x1a: // GetID
        this.getIdCallCount++;
        if (this.hasDisc) {
          this.scheduleCommandResponse('GetID', 3, [0x02], 15000, () => {
            this.deliverInterrupt(2, [0x02, 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, 0x41]);
          });
        } else {
          this.scheduleCommandResponse('GetID(NoDisc)', 3, [this.getStatus()], 15000, () => {
            this.deliverInterrupt(5, [0x08, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
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
  }

  public loadCurrentSectorIntoBuffer(): void {
    if (!this.discData || !this.discInfo) return;

    const sectorSize = this.discInfo.sectorSize;
    const offset = this.currentLba * sectorSize;

    if (offset < this.discData.length) {
      this.sectorsReadCount++;

      let userOffset = offset;
      let userLen = 2048;

      if (sectorSize === 2352) {
        if (this.sectorSizeSetting === 2340) {
          userOffset = offset + 12;
          userLen = 2340;
        } else if (this.sectorSizeSetting === 2352) {
          userOffset = offset;
          userLen = 2352;
        } else {
          // Standard Mode 2 Form 1 data starts at 0x18 (24 bytes)
          userOffset = offset + 0x18;
          userLen = 2048;
        }
      } else {
        userOffset = offset;
        userLen = 2048;
      }

      const actualLen = Math.min(userLen, this.discData.length - userOffset);
      if (this.trackBuffer.length < actualLen) {
        this.trackBuffer = new Uint8Array(actualLen);
      }
      this.trackBuffer.set(this.discData.subarray(userOffset, userOffset + actualLen));
      this.trackBufferLength = actualLen;

      // Keep sectorBuffer synced for backward compatibility
      if (this.sectorBuffer.length < actualLen) {
        this.sectorBuffer = new Uint8Array(actualLen);
      }
      this.sectorBuffer.set(this.trackBuffer.subarray(0, actualLen));
      this.sectorBufferLength = actualLen;
    }
  }

  private bcdToDec(val: number): number {
    return ((val >> 4) * 10) + (val & 0x0f);
  }

  private decToBcd(val: number): number {
    return (((Math.floor(val / 10) % 10) << 4) | (val % 10)) >>> 0;
  }
}