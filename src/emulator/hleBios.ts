/**
 * PlayStation 1 HLE BIOS & Kernel Dispatcher
 *
 * Implements standard PsyQ BIOS routines, A0/B0/C0 vector tables,
 * and MIPS Syscall services for Branch B Fast-Boot.
 */

import { Cpu } from './cpu';
import { Memory } from './memory';

export interface HleCallResult {
  handled: boolean;
  serviceName: string;
  sourceReg: string;
  fnId: number;
  returnVal?: number;
}

interface HleBiosEvent {
  handle: number;
  classVal: number;
  specVal: number;
  modeVal: number;
  funcVal: number;
  status: number;
  enabled: boolean;
}

export class HleBiosDispatcher {
  private static events: Map<number, HleBiosEvent> = new Map();
  // A0 Table function names
  private static readonly A0_NAMES: Record<number, string> = {
    0x00: 'FileOpen',
    0x01: 'FileSeek',
    0x02: 'FileRead',
    0x03: 'FileWrite',
    0x04: 'FileClose',
    0x13: 'setjmp',
    0x14: 'longjmp',
    0x2a: 'memcpy',
    0x2b: 'memset',
    0x39: 'InitGeom',
    0x3c: 'getchar',
    0x3e: 'putchar',
    0x3f: 'puts',
    0x40: 'SystemError',
    0x44: 'FlushCache',
    0x70: '_bu_init',
    0x71: '_96_init',
    0x72: 'CdInit',
    0x9f: 'SetMem',
  };

  // B0 Table function names
  private static readonly B0_NAMES: Record<number, string> = {
    0x00: 'alloc',
    0x01: 'free',
    0x07: 'DeliverEvent',
    0x08: 'OpenEvent',
    0x09: 'CloseEvent',
    0x0a: 'WaitEvent',
    0x0b: 'TestEvent',
    0x0c: 'EnableEvent',
    0x0d: 'DisableEvent',
    0x17: 'ReturnFromException',
    0x18: 'SetDefaultExitFromException',
    0x19: 'SetCustomExitFromException',
    0x32: 'FileOpen',
    0x33: 'FileSeek',
    0x34: 'FileRead',
    0x35: 'FileWrite',
    0x36: 'FileClose',
    0x3d: 'std_in_getchar',
    0x3e: 'std_out_putchar',
    0x3f: 'std_out_puts',
    0x4b: 'CdInit',
    0x56: 'GetKernelInfo',
    0x5b: 'ChangeClearPAD',
  };

  // C0 Table function names
  private static readonly C0_NAMES: Record<number, string> = {
    0x00: 'EnqueueTimerAndVblankIrqs',
    0x01: 'EnqueueSysAndVblankIrqs',
    0x02: 'EnqueueSysAndVblankAndCdromIrqs',
    0x07: 'InstallExceptionJmpBuf',
    0x0a: 'ChangeClearRCnt',
    0x12: 'InitCard',
    0x13: 'StartCard',
    0x14: 'StopCard',
    0x1c: '_96_CdInit',
  };

  // Syscall function names
  private static readonly SYSCALL_NAMES: Record<number, string> = {
    0x00: 'NoFunction',
    0x01: 'EnterCriticalSection',
    0x02: 'ExitCriticalSection',
    0x03: 'ChangeThreadSubFunction',
  };

  private static loggedServicesSet = new Set<string>();

  /**
   * Helper to log clear human-readable game requests for hardware/BIOS functions
   */
  private static logGameRequest(serviceName: string, memory: Memory): void {
    if (!memory.onLog) return;
    const lower = serviceName.toLowerCase();
    let category = '';

    if (lower.includes('pad') || lower.includes('card')) {
      category = 'game needs controller / joypad';
    } else if (lower.includes('spu') || lower.includes('sound') || serviceName === '_96_init') {
      category = 'game needs SPU / sound';
    } else if (lower.includes('cd') || lower.includes('file')) {
      category = 'game needs CD-ROM';
    } else if (lower.includes('graph') || lower.includes('geom') || lower.includes('gpu')) {
      category = 'game needs GPU / display';
    } else if (lower.includes('event')) {
      category = 'game requested kernel event';
    } else if (lower.includes('alloc') || lower.includes('free') || lower.includes('setmem')) {
      category = 'game requested memory allocation';
    } else {
      category = 'game requested BIOS function';
    }

    const logKey = `${category}:${serviceName}`;
    if (!this.loggedServicesSet.has(logKey)) {
      this.loggedServicesSet.add(logKey);
      memory.onLog('bios', `[Game Request] ${category} -> ${serviceName}`);
    }
  }

  /**
   * Delivers a kernel event to registered HLE event descriptors
   */
  public static deliverEvent(evClass: number, evSpec: number = 0): number {
    let deliveredCount = 0;
    for (const ev of this.events.values()) {
      if ((ev.classVal === evClass || (ev.classVal & 0xff) === (evClass & 0xff)) &&
          (ev.specVal === evSpec || ev.specVal === 0)) {
        ev.status = 0x1000;
        deliveredCount++;
      }
    }
    return deliveredCount > 0 ? deliveredCount : 1;
  }

  /**
   * Dispatches an A0, B0, or C0 vector call
   */
  public static dispatchVector(vector: number, cpu: Cpu, memory: Memory): HleCallResult {
    const v = vector & 0xff;
    const a0 = cpu.regs[4] >>> 0;
    const a1 = cpu.regs[5] >>> 0;
    const a2 = cpu.regs[6] >>> 0;
    const a3 = cpu.regs[7] >>> 0;
    const t1 = cpu.regs[9] >>> 0;

    let fnId = 0;
    let sourceReg = '$t1';
    let serviceName = 'Unknown';
    let retVal = 1;

    if (v === 0xa0) {
      fnId = t1 !== 0 ? t1 : a0;
      sourceReg = t1 !== 0 ? '$t1' : '$a0';
      serviceName = this.A0_NAMES[fnId] || `A0_0x${fnId.toString(16).toUpperCase()}`;

      switch (fnId) {
        case 0x13: // setjmp
          retVal = 0;
          break;
        case 0x14: // longjmp
          retVal = a1 ? a1 : 1;
          break;
        case 0x29: // VSync
          {
            const vblankTicks = memory.read32(0x00000070) || memory.vblankCount || 1;
            retVal = vblankTicks >>> 0;
          }
          break;
        case 0x2a: // memcpy
          if (a0 && a1 && a2 > 0) {
            for (let i = 0; i < a2; i++) {
              memory.write8((a0 + i) >>> 0, memory.read8((a1 + i) >>> 0));
            }
          }
          retVal = a0;
          break;
        case 0x2b: // memset
          if (a0 && a2 > 0) {
            for (let i = 0; i < a2; i++) {
              memory.write8((a0 + i) >>> 0, a1 & 0xff);
            }
          }
          retVal = a0;
          break;
        case 0x39: // InitGeom
          retVal = 0;
          break;
        case 0x3e: // putchar
          if (memory.onTtyChar) {
            memory.onTtyChar(String.fromCharCode(a0 & 0xff));
          }
          retVal = a0;
          break;
        case 0x3f: // puts
          {
            let str = '';
            for (let i = 0; i < 256; i++) {
              const ch = memory.read8((a0 + i) >>> 0);
              if (ch === 0) break;
              str += String.fromCharCode(ch);
            }
            if (memory.onLog) {
              memory.onLog('bios', `[TTY OUT] ${str}`);
            }
            retVal = 0;
          }
          break;
        case 0x40: // SystemError / ResetGraph
          retVal = 0;
          break;
        case 0x44: // FlushCache
          retVal = 0;
          break;
        case 0x70: // _bu_init
        case 0x71: // _96_init
          retVal = 0;
          break;
        case 0x72: // CdInit
          retVal = 1;
          break;
        case 0x9f: // SetMem
          retVal = 0;
          break;
        default:
          retVal = 1;
          break;
      }
    } else if (v === 0xb0) {
      fnId = t1 !== 0 ? t1 : a0;
      sourceReg = t1 !== 0 ? '$t1' : '$a0';
      serviceName = this.B0_NAMES[fnId] || `B0_0x${fnId.toString(16).toUpperCase()}`;

      switch (fnId) {
        case 0x07: // DeliverEvent
          retVal = HleBiosDispatcher.deliverEvent(a0, a1);
          break;
        case 0x08: // OpenEvent
          {
            const handle = (0xf0000000 | ((a0 & 0xff) << 16) | ((a1 & 0xff) << 8) | ((this.events.size + 1) & 0xff)) >>> 0;
            this.events.set(handle, {
              handle,
              classVal: a0,
              specVal: a1,
              modeVal: a2,
              funcVal: a3,
              status: 0x1000,
              enabled: true,
            });
            retVal = handle;
          }
          break;
        case 0x09: // CloseEvent
          this.events.delete(a0);
          retVal = 1;
          break;
        case 0x0a: // WaitEvent
        case 0x0b: // TestEvent
          if (a0 === 0xffffffff) {
            retVal = 1;
          } else {
            const ev = this.events.get(a0);
            if (ev) {
              if (ev.status === 0x1000 || ev.enabled) {
                ev.status = 0;
                retVal = 1;
              } else {
                retVal = 0;
              }
            } else {
              retVal = 1;
            }
          }
          break;
        case 0x0c: // EnableEvent
          {
            const ev = this.events.get(a0);
            if (ev) {
              ev.enabled = true;
              ev.status = 0x1000;
            }
            retVal = 1;
          }
          break;
        case 0x0d: // DisableEvent
          {
            const ev = this.events.get(a0);
            if (ev) {
              ev.enabled = false;
            }
            retVal = 1;
          }
          break;
        case 0x17: // ReturnFromException
          cpu.executeRfe();
          retVal = 0;
          break;
        case 0x18: // SetDefaultExitFromException
        case 0x19: // SetCustomExitFromException
          retVal = 0;
          break;
        case 0x3e: // std_out_putchar
          if (memory.onTtyChar) {
            memory.onTtyChar(String.fromCharCode(a0 & 0xff));
          }
          retVal = a0;
          break;
        case 0x3f: // std_out_puts
          {
            let str = '';
            for (let i = 0; i < 256; i++) {
              const ch = memory.read8((a0 + i) >>> 0);
              if (ch === 0) break;
              str += String.fromCharCode(ch);
            }
            if (memory.onLog) {
              memory.onLog('bios', `[TTY OUT] ${str}`);
            }
            retVal = 0;
          }
          break;
        case 0x4b: // CdInit / CdReset
          retVal = 1;
          break;
        case 0x5b: // ChangeClearPAD
          retVal = 0;
          break;
        default:
          retVal = 1;
          break;
      }
    } else if (v === 0xc0) {
      fnId = a0 !== 0 ? a0 : t1;
      sourceReg = a0 !== 0 ? '$a0' : '$t1';
      serviceName = this.C0_NAMES[fnId] || `C0_0x${fnId.toString(16).toUpperCase()}`;

      switch (fnId) {
        case 0x00: // EnqueueTimerAndVblankIrqs
        case 0x01: // EnqueueSysAndVblankIrqs
        case 0x02: // EnqueueSysAndVblankAndCdromIrqs
        case 0x07: // InstallExceptionJmpBuf
        case 0x0a: // ChangeClearRCnt
        case 0x12: // InitCard
        case 0x13: // StartCard
        case 0x14: // StopCard
          retVal = 0;
          break;
        case 0x1c: // _96_CdInit
          retVal = 1;
          break;
        default:
          retVal = 0;
          break;
      }
    }

    this.logGameRequest(serviceName, memory);
    cpu.regs[2] = retVal >>> 0; // Set $v0
    return {
      handled: true,
      serviceName,
      sourceReg,
      fnId,
      returnVal: retVal,
    };
  }

  /**
   * Dispatches a raw MIPS Syscall
   */
  public static dispatchSyscall(cpu: Cpu, memory: Memory, currentPc: number): HleCallResult {
    const a0 = cpu.regs[4] >>> 0;
    const a1 = cpu.regs[5] >>> 0;
    const a2 = cpu.regs[6] >>> 0;
    const a3 = cpu.regs[7] >>> 0;
    const t1 = cpu.regs[9] >>> 0;

    let fnId = a0;
    let sourceReg = '$a0';
    let serviceName = this.SYSCALL_NAMES[fnId] || `Syscall_0x${fnId.toString(16).toUpperCase()}`;
    let retVal = 1;

    switch (fnId) {
      case 0x00: // NoFunction / Dummy Syscall Exit
        retVal = 0;
        break;
      case 0x01: // EnterCriticalSection: disable CPU hardware interrupts
        cpu.cop0Regs[12] = (cpu.cop0Regs[12] & ~1) >>> 0;
        retVal = 1;
        break;
      case 0x02: // ExitCriticalSection: enable CPU hardware interrupts
        cpu.cop0Regs[12] = (cpu.cop0Regs[12] | 1) >>> 0;
        retVal = 1;
        break;
      case 0x03: // ChangeThreadSubFunction
        retVal = 0;
        break;
      default:
        // Check if $t1 or $a0 holds another standard service code
        if (t1 !== 0 && t1 !== a0) {
          sourceReg = '$t1';
          fnId = t1;
          serviceName = this.B0_NAMES[fnId] || this.A0_NAMES[fnId] || `Syscall_t1_0x${fnId.toString(16).toUpperCase()}`;
        }
        retVal = 1;
        break;
    }

    this.logGameRequest(serviceName, memory);
    cpu.regs[2] = retVal >>> 0; // Set $v0
    return {
      handled: true,
      serviceName,
      sourceReg,
      fnId,
      returnVal: retVal,
    };
  }
}
