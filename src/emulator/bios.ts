/**
 * PS1 Low-Level Emulator (LLE) BIOS Inspector & Validator
 * Handles authentic Sony PlayStation 1 BIOS dumps (SCPH-1001, SCPH-7001, SCPH-5500, etc.)
 */

import { BiosInfo } from '../types';

export class BiosManager {
  /**
   * Analyzes an uploaded 512 KB BIOS ROM dump
   */
  public static inspectBios(data: Uint8Array, fileName: string): BiosInfo {
    const size = data.length;
    let versionString = 'PS1 System BIOS ROM (512 KB)';
    let isOfficial = false;

    // Search for Sony Computer Entertainment signature or version strings
    const ascii = BiosManager.getAsciiString(data, 0, Math.min(size, 0x80000));

    if (
      ascii.includes('Sony Computer Entertainment') ||
      ascii.includes('SONY COMPUTER') ||
      ascii.includes('SCPH-1001') ||
      ascii.includes('SCPH-7001') ||
      ascii.includes('SCPH-5500') ||
      ascii.includes('SCPH-9002') ||
      ascii.includes('PlayStation')
    ) {
      isOfficial = true;
      const match =
        ascii.match(/System ROM Version [\d.]+[ \w]*/i) ||
        ascii.match(/ROM Version [\d.]+[ \w]*/i) ||
        ascii.match(/SCPH-[\d]+/i);
      versionString = match ? match[0] : 'Sony PS1 Official System BIOS';
    } else if (ascii.includes('OpenBIOS') || ascii.includes('openbios')) {
      versionString = 'OpenBIOS (Open Source PS1 ROM)';
    } else if (ascii.includes('FreePSXBoot')) {
      versionString = 'FreePSXBoot Exploit Payload';
    }

    // Generate CRC/Checksum
    let checksum = 0;
    for (let i = 0; i < Math.min(size, 4096); i += 4) {
      checksum = (checksum + ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3])) >>> 0;
    }

    return {
      name: fileName,
      size,
      versionString,
      isOfficial,
      checksum: '0x' + checksum.toString(16).padStart(8, '0').toUpperCase(),
      loadedAt: Date.now(),
    };
  }

  private static getAsciiString(buffer: Uint8Array, start: number, length: number): string {
    let result = '';
    const end = Math.min(buffer.length, start + length);
    for (let i = start; i < end; i++) {
      const code = buffer[i];
      if (code >= 32 && code <= 126) {
        result += String.fromCharCode(code);
      } else if (code === 10 || code === 13) {
        result += ' ';
      }
    }
    return result;
  }
}

export const BIOS_A_CALL_NAMES: Record<number, string> = {
  0x00: 'FileOpen',
  0x01: 'FileSeek',
  0x02: 'FileRead',
  0x03: 'FileWrite',
  0x04: 'FileClose',
  0x05: 'FileIoctl',
  0x06: 'exit',
  0x07: 'FileGetC',
  0x08: 'FilePutC',
  0x09: 'todigit',
  0x0a: 'atof',
  0x0b: 'strtol',
  0x0c: 'strtoul',
  0x0d: 'abs',
  0x0e: 'labs',
  0x0f: 'atoi',
  0x10: 'atol',
  0x11: 'atob',
  0x12: 'setjmp',
  0x13: 'longjmp',
  0x14: 'strcat',
  0x15: 'strncat',
  0x16: 'strcmp',
  0x17: 'strncmp',
  0x18: 'strcpy',
  0x19: 'strncpy',
  0x1a: 'strlen',
  0x1b: 'index',
  0x1c: 'rindex',
  0x1d: 'strchr',
  0x1e: 'strrchr',
  0x1f: 'strpbrk',
  0x20: 'strspn',
  0x21: 'strcspn',
  0x22: 'strtok',
  0x23: 'strstr',
  0x24: 'toupper',
  0x25: 'tolower',
  0x26: 'bcopy',
  0x27: 'bzero',
  0x28: 'bcmp',
  0x29: 'memcpy',
  0x2a: 'memset',
  0x2b: 'memmove',
  0x2c: 'memcmp',
  0x2d: 'memchr',
  0x2e: 'rand',
  0x2f: 'srand',
  0x30: 'qsort',
  0x33: 'malloc',
  0x34: 'free',
  0x35: 'calloc',
  0x36: 'realloc',
  0x37: 'InitHeap',
  0x38: 'SystemError',
  0x39: 'InitGeom',
  0x3a: 'SetConf',
  0x3b: 'GetConf',
  0x3c: 'SetMem',
  0x3e: 'puts',
  0x3f: 'printf',
  0x40: 'format',
  0x41: 'load',
  0x42: 'exec',
  0x43: 'FlushCache',
  0x44: 'InstallInterruptHandler',
  0x45: 'GPU_cw',
  0x46: 'mem2vram',
  0x47: 'SendGPU',
  0x48: 'CdInit',
  0x49: 'CdRemove',
  0x4a: 'CdAsyncReadSector',
  0x4b: 'CdAsyncSeekL',
  0x4c: 'CdGetStatus',
  0x4d: 'CdReadSector',
  0x70: '_bu_init',
  0x71: 'ChangeClearPAD',
  0x72: 'ReturnFromException',
  0x96: 'AddCDROMDevice',
  0x97: 'AddMemCardDevice',
  0x98: 'AddNullDevice',
  0x99: 'WarmBoot',
  0x9c: 'SetGetCdromBootPath',
  0x9f: 'SetMem',
  0xa1: 'BootOrWarmBoot',
};

export const BIOS_B_CALL_NAMES: Record<number, string> = {
  0x00: 'alloc_kernel_memory',
  0x01: 'free_kernel_memory',
  0x02: 'init_timer',
  0x03: 'get_timer',
  0x04: 'enable_timer_irq',
  0x05: 'disable_timer_irq',
  0x06: 'restart_timer',
  0x07: 'DeliverEvent',
  0x08: 'OpenEvent',
  0x09: 'CloseEvent',
  0x0a: 'WaitEvent',
  0x0b: 'TestEvent',
  0x0c: 'EnableEvent',
  0x0d: 'DisableEvent',
  0x0e: 'OpenThread',
  0x0f: 'CloseThread',
  0x10: 'ChangeThread',
  0x12: 'InitPAD',
  0x13: 'StartPAD',
  0x14: 'StopPAD',
  0x15: 'OutPAD',
  0x16: 'NewPAD',
  0x17: 'ReturnFromException',
  0x18: 'SetDefaultExitCallback',
  0x20: 'UndeliverEvent',
  0x32: 'FileOpen',
  0x33: 'FileSeek',
  0x34: 'FileRead',
  0x35: 'FileWrite',
  0x36: 'FileClose',
  0x37: 'FileIoctl',
  0x38: 'exit',
  0x39: 'FileGetC',
  0x3a: 'FilePutC',
  0x3b: 'getchar',
  0x3c: 'putchar',
  0x3d: 'std_out_putchar',
  0x3e: 'puts',
  0x3f: 'printf',
  0x40: 'format',
  0x41: 'FileRename',
  0x42: 'FileDelete',
  0x43: 'FileUndel',
  0x44: 'FileFirstFile',
  0x45: 'FileNextFile',
  0x46: 'FileFormat',
  0x47: 'FileChmod',
  0x49: 'CdGetDiskType',
  0x4a: 'CdGetStatus',
  0x4b: 'CdAsyncSeekL',
  0x4c: 'CdAsyncSeekP',
  0x4d: 'CdAsyncGetStatus',
  0x4e: 'CdAsyncReadSector',
  0x50: 'CdAsyncSetMode',
  0x51: 'CdStop',
  0x54: 'CdInit',
  0x55: 'CdRemove',
  0x56: 'CdAsyncStatusAndSync',
  0x57: 'CdReadSector',
  0x58: 'CdSeekL',
  0x59: 'CdSeekP',
  0x5a: 'CdGetStatus',
  0x5b: 'ChangeClearRCnt',
  0x5c: 'SystemError',
};

export const BIOS_C_CALL_NAMES: Record<number, string> = {
  0x00: 'EnqueueTimerAndVblankIrqs',
  0x01: 'EnqueueSyscall',
  0x02: 'SysEnqIntRP',
  0x03: 'SysDeqIntRP',
  0x07: 'InstallExceptionHandlers',
  0x08: 'SysInitMemory',
  0x0a: 'ChangeClearPAD',
  0x0b: 'DevShutdown',
  0x0c: 'InitRCnt',
  0x0d: 'InitException',
  0x12: 'InstallDevices',
  0x13: 'InitPad',
  0x14: 'StartPad',
  0x15: 'StopPad',
  0x16: 'OutPad',
  0x1c: 'SetSp',
  0x1d: 'GetSp',
};

export const BIOS_SYSCALL_NAMES: Record<number, string> = {
  0x00: 'NoOperation',
  0x01: 'EnterCriticalSection',
  0x02: 'ExitCriticalSection',
  0x03: 'ChangeThreadSubFunction',
  0x04: 'DeliverEvent',
};

export const enum EventClass {
  VBLANK = 0xF0000001,
  GPU = 0xF0000002,
  CDROM = 0xF0000003,
  DMA = 0xF0000004,
  RTC0 = 0xF0000005,
  RTC1 = 0xF0000006,
  RTC2 = 0xF0000007,
  PAD = 0xF0000008,
  SPU = 0xF0000009,
  PIO = 0xF000000A,
  SIO = 0xF000000B,
  CARD = 0xF2000000,
  ROOT_COUNTER = 0xF2000001,
  EXCEPTION = 0xF4000001,
}

export const enum EventSpec {
  VBLANK = 0x0001,
  CDROM_COMP = 0x0002,
  CDROM_ACK = 0x0003,
  CDROM_DATA_READY = 0x0004,
  CDROM_END = 0x0005,
  DMA_COMP = 0x0004,
}

export const enum EventMode {
  INTR = 0x1000,   // Callback function mode
  NOINTR = 0x2000, // Status flag mode
}

export const enum EventStatus {
  UNUSED = 0x0000,
  WAIT = 0x1000,
  ACTIVE = 0x2000,
  ALREADY = 0x4000,
}

export interface BiosEvent {
  id: number;
  handle: number;
  class: number;
  spec: number;
  mode: number;
  func: number;
  status: EventStatus;
  occurred: boolean;
  count: number;
  ramAddress?: number;
}

export class BiosEventSystem {
  public static readonly MAX_EVENTS = 32;
  public events: BiosEvent[] = [];
  public isFastBootActive: boolean = false;
  public get isFastBoot(): boolean {
    return this.isFastBootActive;
  }
  public set isFastBoot(val: boolean) {
    this.isFastBootActive = val;
  }

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.events = [];
    this.isFastBootActive = false;
    for (let i = 0; i < BiosEventSystem.MAX_EVENTS; i++) {
      this.events.push({
        id: i,
        handle: (0xF1000000 | i) >>> 0,
        class: 0,
        spec: 0,
        mode: EventMode.NOINTR,
        func: 0,
        status: EventStatus.UNUSED,
        occurred: false,
        count: 0,
      });
    }

    // Pre-register standard system events
    this.initDefaultEvent(0, EventClass.VBLANK, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(1, EventClass.GPU, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(2, EventClass.CDROM, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(3, EventClass.DMA, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(4, EventClass.RTC0, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(5, EventClass.RTC1, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(6, EventClass.RTC2, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(7, EventClass.PAD, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(8, EventClass.SPU, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(9, EventClass.ROOT_COUNTER, 0x0001, EventMode.NOINTR);
    this.initDefaultEvent(10, EventClass.EXCEPTION, 0x0001, EventMode.NOINTR);
  }

  private initDefaultEvent(id: number, evClass: number, spec: number, mode: number): void {
    const ev = this.events[id];
    ev.class = evClass >>> 0;
    ev.spec = spec >>> 0;
    ev.mode = mode >>> 0;
    ev.func = 0;
    ev.status = EventStatus.ACTIVE;
    ev.occurred = false;
    ev.count = 0;
  }

  public getEvent(handle: number): BiosEvent | undefined {
    const uHandle = handle >>> 0;
    // Direct index 0..31
    if (uHandle < BiosEventSystem.MAX_EVENTS) {
      return this.events[uHandle];
    }
    // Handle prefixed with 0xF1xxxxxx or 0xF0xxxxxx
    if ((uHandle >>> 24) === 0xF1 || (uHandle >>> 24) === 0xF0) {
      const idx = uHandle & 0x1F;
      return this.events[idx];
    }
    // Search by matching class or handle
    return this.events.find(e => e.handle === uHandle || e.class === uHandle) || this.events[0];
  }

  public openEvent(evClass: number, spec: number, mode: number, func: number): number {
    const uClass = evClass >>> 0;
    const uSpec = spec >>> 0;
    const uMode = mode >>> 0;
    const uFunc = func >>> 0;

    // Check if an existing event matches exactly
    for (let i = 0; i < BiosEventSystem.MAX_EVENTS; i++) {
      const ev = this.events[i];
      if (ev.status !== EventStatus.UNUSED && ev.class === uClass && ev.spec === uSpec) {
        ev.mode = uMode;
        ev.func = uFunc;
        ev.status = EventStatus.ACTIVE;
        ev.occurred = false;
        return ev.handle;
      }
    }

    // Allocate first unused slot (prefer slots >= 11 to avoid clobbering default system events)
    let slot = -1;
    for (let i = 11; i < BiosEventSystem.MAX_EVENTS; i++) {
      if (this.events[i].status === EventStatus.UNUSED) {
        slot = i;
        break;
      }
    }
    if (slot === -1) {
      for (let i = 0; i < BiosEventSystem.MAX_EVENTS; i++) {
        if (this.events[i].status === EventStatus.UNUSED) {
          slot = i;
          break;
        }
      }
    }

    if (slot === -1) {
      // Table full, recycle slot 31
      slot = 31;
    }

    const ev = this.events[slot];
    ev.class = uClass;
    ev.spec = uSpec;
    ev.mode = uMode;
    ev.func = uFunc;
    ev.status = EventStatus.ACTIVE;
    ev.occurred = false;
    ev.count = 0;

    return ev.handle;
  }

  public closeEvent(handle: number): number {
    const ev = this.getEvent(handle);
    if (!ev) return 0;
    ev.status = EventStatus.UNUSED;
    ev.occurred = false;
    ev.class = 0;
    ev.spec = 0;
    return 1;
  }

  public enableEvent(handle: number): number {
    const ev = this.getEvent(handle);
    if (!ev) return 0;
    ev.status = EventStatus.ACTIVE;
    return 1;
  }

  public disableEvent(handle: number): number {
    const ev = this.getEvent(handle);
    if (!ev) return 0;
    ev.status = EventStatus.WAIT;
    return 1;
  }

  public waitEvent(handle: number): number {
    const ev = this.getEvent(handle);
    if (!ev) return 1;
    ev.status = EventStatus.ACTIVE;
    ev.occurred = false;
    return 1;
  }

  public testEvent(handle: number): number {
    const ev = this.getEvent(handle);
    if (!ev) return 0;
    if (ev.occurred || ev.status === EventStatus.ALREADY) {
      ev.occurred = false;
      ev.status = EventStatus.ACTIVE;
      return 1;
    }
    return 0;
  }

  public undeliverEvent(evClass: number, spec: number = 0): number {
    const uClass = evClass >>> 0;
    const uSpec = spec >>> 0;
    for (const ev of this.events) {
      if (ev.status === EventStatus.UNUSED) continue;
      if (ev.class === uClass && (uSpec === 0 || ev.spec === 0 || ev.spec === uSpec)) {
        ev.occurred = false;
        ev.status = EventStatus.ACTIVE;
      }
    }
    return 1;
  }

  public deliverEvent(evClass: number, spec: number = 0, cpu?: any, memory?: any): number {
    let deliveredCount = 0;
    const targetClass = evClass >>> 0;
    const targetSpec = spec >>> 0;

    for (const ev of this.events) {
      if (ev.status === EventStatus.UNUSED) continue;

      const classMatches =
        ev.class === targetClass ||
        (targetClass === EventClass.VBLANK && ev.class === EventClass.EXCEPTION) ||
        (targetClass === EventClass.EXCEPTION && ev.class === EventClass.VBLANK);

      const specMatches =
        targetSpec === 0 ||
        ev.spec === 0 ||
        ev.spec === targetSpec ||
        ((ev.spec & targetSpec) !== 0);

      if (classMatches && specMatches) {
        ev.occurred = true;
        ev.count++;
        ev.status = EventStatus.ALREADY;
        deliveredCount++;

        // If this event has a registered callback function (mode == 0x1000 / INTR), invoke it ONLY when in FastBoot!
        if (this.isFastBoot && ev.mode === EventMode.INTR && ev.func !== 0 && cpu && typeof cpu.executeCallback === 'function') {
          cpu.executeCallback(ev.func, ev.class, ev.spec);
        }
      }
    }

    if (this.isFastBoot && memory) {
      this.syncRamEvents(targetClass, targetSpec, memory);
    }

    return deliveredCount > 0 ? deliveredCount : 1;
  }

  public syncRamEvents(targetClass: number, targetSpec: number, memory: any): void {
    if (!this.isFastBoot || !memory) return;
    // 1. Scan kernel event descriptor array in RAM (0x0120 to 0x0400)
    for (let addr = 0x120; addr < 0x0400; addr += 28) {
      const val = memory.read32(addr) >>> 0;
      if (val === targetClass || (targetClass === EventClass.VBLANK && val === 0xF4000001)) {
        memory.write32(addr + 4, 0x4000);  // EvStALREADY
        memory.write32(addr + 12, 0x4000); // Triggered status
        const curCount = memory.read32(addr + 16) >>> 0;
        memory.write32(addr + 16, (curCount + 1) >>> 0);
      }
    }

    // 2. If CD-ROM event (INT2 complete or INT3 ack), update driver sync flags
    if (targetClass === EventClass.CDROM) {
      // If the SDK sync flag at 0x0005F5C8 holds a waiting token (0x01400008), signal completion
      const cdSyncVal = memory.read32(0x0005f5c8) >>> 0;
      if (cdSyncVal === 0x01400008) {
        memory.write32(0x0005f5c8, 0x00000000); // Signal completion to CdSync polling loop
      }
      // If 0x000931F6 has a pending CD wait code, clear it to 0
      const cdPortVal = memory.read16(0x000931f6) & 0xffff;
      if (cdPortVal !== 0) {
        memory.write16(0x000931f6, 0x0000);
      }
    }

    // 3. If VBLANK, increment kernel VSync variable at 0x70 (System Ticker)
    if (targetClass === EventClass.VBLANK || targetClass === EventClass.EXCEPTION) {
      const currentTicks = memory.read32(0x70) >>> 0;
      memory.write32(0x70, (currentTicks + 1) >>> 0);
    }
  }
}

export class FastBootKernelInitializer {
  /**
   * Pre-populates low RAM kernel dispatch tables, A/B/C call vectors, and exception handlers.
   * This provides an authentic running kernel environment when skipping the BIOS boot sequence.
   */
  public static initializeKernel(memory: any, cpu?: any): void {
    const ram = memory.ram;
    if (!ram || ram.length < 0x200000) return;

    // 1. Install General Exception Handler at 0x80000080
    // MIPS R3000A Exception Dispatcher:
    //   0x80: mfc0 $k1, $14          # EPC -> $k1 (0x401b7000)
    //   0x84: mfc0 $k0, $13          # Cause -> $k0 (0x401a6800)
    //   0x88: andi $k0, $k0, 0x007c  # ExcCode bits (0x334a007c)
    //   0x8c: bne  $k0, $zero, 4     # If software trap/syscall (ExcCode != 0): branch to 0x800000A0 (0x17400004)
    //   0x90: lui  $k0, 0xbf80       # Delay slot: $k0 = 0xBF800000 (0x3c1abf80)
    //   0x94: sw   $zero, 0x1070($k0)# Hardware int: Clear I_STAT at 0xBF801070 (0xaf401070)
    //   0x98: rfe                    # Return From Exception (0x42000010)
    //   0x9c: jr   $k1               # Jump back to EPC (0x03600008)
    //   0xa0: addiu $k1, $k1, 4      # Software trap: advance EPC + 4 (0x277b0004)
    //   0xa4: rfe                    # Return From Exception (0x42000010)
    //   0xa8: jr   $k1               # Jump back to EPC + 4 (0x03600008)
    //   0xac: nop                    # (0x00000000)
    memory.write32(0x80, 0x401b7000);
    memory.write32(0x84, 0x401a6800);
    memory.write32(0x88, 0x334a007c);
    memory.write32(0x8c, 0x17400004);
    memory.write32(0x90, 0x3c1abf80);
    memory.write32(0x94, 0xaf401070);
    memory.write32(0x98, 0x42000010);
    memory.write32(0x9c, 0x03600008);
    memory.write32(0xa0, 0x277b0004);
    memory.write32(0xa4, 0x42000010);
    memory.write32(0xa8, 0x03600008);
    memory.write32(0xac, 0x00000000);

    // 0x000000B0 (A-Call Entry): jr $ra; nop
    memory.write32(0xb0, 0x03e00008);
    memory.write32(0xb4, 0x00000000);

    // 0x000000C0 (B-Call Entry): jr $ra; nop
    memory.write32(0xc0, 0x03e00008);
    memory.write32(0xc4, 0x00000000);

    // 0x000000D0 (C-Call Entry): jr $ra; nop
    memory.write32(0xd0, 0x03e00008);
    memory.write32(0xd4, 0x00000000);

    // 3. Syscall Dispatch Table Pointers (0x00000100 - 0x00000180)
    // Point syscall vector pointers to 0x80000080
    for (let i = 0; i < 32; i++) {
      memory.write32(0x100 + i * 4, 0x80000080);
    }

    // 4. Populate A-Call Table at 0x00000200 (128 function pointer entries)
    // Points each entry i to a dedicated trampoline at 0x80000800 + i * 8
    // Trampoline sets $t1 = i and jumps to 0x800000B0:
    //   ori $t1, $zero, i (0x34090000 | (i & 0xffff))
    //   j 0x800000B0      (0x0800002c)
    for (let i = 0; i < 128; i++) {
      const stubAddr = (0x80000800 + i * 8) >>> 0;
      memory.write32(0x200 + i * 4, stubAddr);
      memory.write32((stubAddr & 0x001fffff), 0x34090000 | (i & 0xffff)); // ori $t1, $zero, i
      memory.write32((stubAddr & 0x001fffff) + 4, 0x0800002c);            // j 0x800000B0
    }

    // 5. Populate B-Call Table at 0x00000400 (128 function pointer entries)
    // Points each entry i to a dedicated trampoline at 0x80000C00 + i * 8
    // Trampoline sets $t1 = i and jumps to 0x800000C0:
    //   ori $t1, $zero, i (0x34090000 | (i & 0xffff))
    //   j 0x800000C0      (0x08000030)
    for (let i = 0; i < 128; i++) {
      const stubAddr = (0x80000C00 + i * 8) >>> 0;
      memory.write32(0x400 + i * 4, stubAddr);
      memory.write32((stubAddr & 0x001fffff), 0x34090000 | (i & 0xffff)); // ori $t1, $zero, i
      memory.write32((stubAddr & 0x001fffff) + 4, 0x08000030);            // j 0x800000C0
    }

    // 6. Populate C-Call Table at 0x00000600 (64 function pointer entries)
    // Points each entry i to a dedicated trampoline at 0x80001000 + i * 8
    // Trampoline sets $a0 = i and jumps to 0x800000D0:
    //   ori $a0, $zero, i (0x34040000 | (i & 0xffff))
    //   j 0x800000D0      (0x08000034)
    for (let i = 0; i < 64; i++) {
      const stubAddr = (0x80001000 + i * 8) >>> 0;
      memory.write32(0x600 + i * 4, stubAddr);
      memory.write32((stubAddr & 0x001fffff), 0x34040000 | (i & 0xffff)); // ori $a0, $zero, i
      memory.write32((stubAddr & 0x001fffff) + 4, 0x08000034);            // j 0x800000D0
    }

    // 7. Initialize Essential Low Kernel Variables
    memory.write32(0x60, 0x80000100); // Main Thread Control Block pointer
    memory.write32(0x70, 1);          // System VBLANK counter
    memory.write32(0x150, 0x00200000); // System RAM Size: 2 MB (2,097,152 bytes)
    memory.write32(0x160, 0x80000180); // System Configuration Block pointer

    // 8. Mirror Exception Handler to BIOS ROM area (0xBFC00180) if empty
    if (memory.bios && memory.bios.length >= 0x80000) {
      const bios = memory.bios;
      const isBiosEmpty = bios[0x180] === 0 && bios[0x181] === 0 && bios[0x182] === 0 && bios[0x183] === 0;
      if (isBiosEmpty) {
        const view = new DataView(bios.buffer, bios.byteOffset, bios.byteLength);
        view.setUint32(0x180, 0x401a7000, true); // mfc0 $k0, $14 (EPC)
        view.setUint32(0x184, 0x401b6800, true); // mfc0 $k1, $13 (Cause)
        view.setUint32(0x188, 0x337b007c, true); // andi $k1, $k1, 0x007c (ExcCode)
        view.setUint32(0x18c, 0x13600004, true); // beq $k1, $zero, +4 (If HW int, jump to lui)
        view.setUint32(0x190, 0x00000000, true); // nop (delay slot)
        view.setUint32(0x194, 0x275a0004, true); // addiu $k0, $k0, 4 (Advance EPC for Syscall)
        view.setUint32(0x198, 0x10000003, true); // b +3 (Jump over lui/sw to mtc0)
        view.setUint32(0x19c, 0x00000000, true); // nop (delay slot)
        view.setUint32(0x1a0, 0x3c1bbf80, true); // lui $k1, 0xbf80
        view.setUint32(0x1a4, 0xaf601070, true); // sw $zero, 0x1070($k1)
        view.setUint32(0x1a8, 0x409a7000, true); // mtc0 $k0, $14 (Save EPC)
        view.setUint32(0x1ac, 0x42000010, true); // rfe
        view.setUint32(0x1b0, 0x03400008, true); // jr $k0
        view.setUint32(0x1b4, 0x00000000, true); // nop (delay slot)
      }
    }

    // 9. If CPU & Memory are provided, configure Status Register COP0 and ensure I_MASK allows VBLANK
    if (cpu) {
      // Set Status Register: Enable interrupts in user/kernel mode, clear BEV so RAM vectors (0x80000080) are used
      cpu.cop0Regs[12] = 0x10000001; // Enable COP0 & interrupts, BEV = 0
    }

    if (memory.iMask === 0) {
      memory.iMask = 0x0001; // Enable VBLANK IRQ 0 by default
      memory.updateInterrupts();
    }

    if (memory.gpu) {
      memory.gpu.displayDisabled = false;
      memory.gpu.displayEnabled = true;
      memory.gpu.gpuStat &= ~(1 << 23);
    }
  }
}
