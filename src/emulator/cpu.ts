/**
 * PlayStation 1 MIPS R3000A CPU Core (32-bit RISC)
 * Compliant Little-Endian execution with accurate exception handling,
 * delay-slot pipelining, and COP0 system control.
 */

import { Memory } from './memory';
import { Gte } from './gte';
import { CpuState, MIPS_REGISTER_NAMES } from '../types';
import { disassemble } from './disassembler';
import { rateLimitLog, logWarnRateLimited, logErrorRateLimited } from './logger';
import { HleBiosDispatcher } from './hleBios';

export type SyscallCallback = (pc: number, func: string, args: number[]) => void;
export type InstructionCallback = (pc: number, opcode: number, disasm: string) => void;
export type ErrorCallback = (error: string, pc: number, opcode: number) => void;

// Lookup tables for MIPS Little-Endian unaligned memory access
const LWL_MASKS = [0x00ffffff, 0x0000ffff, 0x000000ff, 0x00000000];
const LWL_SHIFTS = [24, 16, 8, 0];

const LWR_MASKS = [0x00000000, 0xff000000, 0xffff0000, 0xffffff00];
const LWR_SHIFTS = [0, 8, 16, 24];

const SWL_MASKS = [0xffffff00, 0xffff0000, 0xff000000, 0x00000000];
const SWL_SHIFTS = [24, 16, 8, 0];

const SWR_MASKS = [0x00000000, 0x000000ff, 0x0000ffff, 0x00ffffff];
const SWR_SHIFTS = [0, 8, 16, 24];

export class Cpu {
  public debugLogging: boolean = false;
  public halted: boolean = false;
  public regs: Uint32Array = new Uint32Array(32);
  public r32: Int32Array = new Int32Array(this.regs.buffer);
  public gte: Gte = new Gte();
  public get registers(): Uint32Array {
    return this.regs;
  }

  /**
   * Coprocessor 2 (GTE) usability check.
   * In MIPS COP0 Status register, bit 30 is CU2 (Coprocessor 2 Usable).
   * If (Status & 0x40000000) === 0, physical hardware throws a Coprocessor Unusable exception,
   * but for homebrew execution make sure the instructions can execute cleanly without halting.
   */
  public isCop2Usable(): boolean {
    return true;
  }
  public pc: number = 0xbfc00000; // Reset vector (PS1 BIOS Entry)
  public nextPc: number = 0xbfc00004;
  public hi: number = 0;
  public lo: number = 0;
  public lastExceptionPc: number = 0;
  public consecutiveExceptionCount: number = 0;

  // Full COP0 Register Bank (32 registers)
  public cop0Regs: Uint32Array = (() => {
    const arr = new Uint32Array(32);
    arr[12] = 0x10900000;
    arr[15] = 0x00000002;
    return arr;
  })();

  // Single Source of Truth for COP0 registers:
  // Status Register ($12): Boot with BEV=1, TS=1 (0x10900000)
  public get sr(): number {
    return this.cop0Regs[12] >>> 0;
  }
  public set sr(val: number) {
    const uval = val >>> 0;
    this.cop0Regs[12] = uval;
    this.memory.isCacheIsolated = (uval & 0x00010000) !== 0;
  }

  // Cause Register ($13)
  public get cause(): number {
    return this.cop0Regs[13] >>> 0;
  }
  public set cause(val: number) {
    this.cop0Regs[13] = val >>> 0;
  }

  // Exception PC ($14)
  public get epc(): number {
    return this.cop0Regs[14] >>> 0;
  }
  public set epc(val: number) {
    this.cop0Regs[14] = val >>> 0;
  }

  // Bad Virtual Address ($8)
  public get badVAddr(): number {
    return this.cop0Regs[8] >>> 0;
  }
  public set badVAddr(val: number) {
    this.cop0Regs[8] = val >>> 0;
  }

  // Processor ID ($15): MIPS R3000A
  public get prid(): number {
    return this.cop0Regs[15] >>> 0;
  }
  public set prid(val: number) {
    this.cop0Regs[15] = val >>> 0;
  }

  // Emulation bookkeeping
  public cycles: number = 0;
  public instructionsExecuted: number = 0;
  public inDelaySlot: boolean = false;
  public branchPending: boolean = false;
  public branchTarget: number = 0;

  public memory: Memory;

  // Error tracking (Errors are NEVER hidden)
  public lastError: string | null = null;
  public errorCount: number = 0;

  // Diagnostics and stall detection
  public _rfeHits: number = 0;
  public _epilogueReturnHits: number = 0;
  public _trap1aa4Hits: number = 0;
  public lastSyscallPc: number = -1;
  public lastSyscallA0: number = -1;
  public _rfeOpcodeHits: number = 0;
  public _syscallAdvanceHits: number = 0;
  public _syscallCount: number = 0;
  public hasLoggedSplashExit: boolean = false;
  public instructionsSinceLastException: number = 0;
  public exceptionTriggeredInStep: boolean = false;
  public skipDelaySlot: boolean = false;
  public interruptInhibitInstructions: number = 0;
  public justReturnedFromException: boolean = false;
  public _hasLoggedMaskedIrq: boolean = false;
  public _hasLoggedCdRomIrqPending: boolean = false;
  public _hasLoggedSpinlock: boolean = false;
  public _hasLoggedAE418: boolean = false;
  public _hasLoggedS0Target: boolean = false;
  public _hasLoggedAE3E0Prologue: boolean = false;
  public _hasLoggedAD8F8: boolean = false;
  public _hasLoggedAD9A0: boolean = false;
  public _hasLoggedAD9A0_val: boolean = false;
  public _hasLoggedAD9C0: boolean = false;
  public _hasLoggedB27C0: boolean = false;
  public _hasLoggedAA484: boolean = false;
  public _hasLogged3C398: boolean = false;
  public _hasLoggedTarget3C398: boolean = false;
  public _hasLoggedC8FA8: boolean = false;
  public _hasLoggedExitC8FD4: boolean = false;
  public _vramWaitFrames: number = 0;
  public _loggedExit: boolean = false;
  public lastLoggedVblank: number = -1;
  public postSyscallTraceRemaining: number = 0;
  public gteOpCount: number = 0;
  public syscallTrapCount: number = 0;
  public biosVectorTrapCount: number = 0;
  public hleBiosEnabled: boolean = false;
  public executionHistory: { pc: number; opcode: number }[] = [];

  /**
   * Sanitizes PC jump/branch targets.
   * If an address is in KUSEG (0x00000000..0x7FFFFFFF), ensure it stays within 2MB physical RAM (addr & 0x001FFFFF).
   */
  public sanitizeJumpTarget(target: number): number {
    target = target >>> 0;
    const physical = target & 0x1FFFFFFF;
    if (target < 0x80000000) {
      target = (target & 0x001fffff) >>> 0;
    } else if (physical < 0x00800000) {
      // PS1 RAM is 2MB. Keep execution in KSEG0 standard segment (0x80000000)
      target = (0x80000000 | (physical & 0x001fffff)) >>> 0;
    } else if (physical < 0x1f000000) {
      target = ((target & 0xe0000000) | (physical & 0x001fffff)) >>> 0;
    }
    return target >>> 0;
  }

  /**
   * Validates if a virtual address is mapped to executable memory (RAM or BIOS ROM).
   */
  public isInstructionFetchMapped(vaddr: number): boolean {
    const paddr = (vaddr & 0x1fffffff) >>> 0;
    if (paddr < 0x1f000000) {
      if (vaddr < 0x80000000) {
        return vaddr < 0x00200000;
      }
      return true;
    }
    if (paddr >= 0x1f800000 && paddr < 0x1f800400) {
      return true; // Fast Scratchpad/D-Cache execution mapping
    }
    if (paddr >= 0x1fc00000 && paddr < 0x1fc80000) {
      return true;
    }
    return false;
  }

  public setReg(regIndex: number, val: number): void {
    if (regIndex > 0 && regIndex < 32) {
      this.regs[regIndex] = val >>> 0;
    }
  }

  public getReg(regIndex: number): number {
    if (regIndex >= 0 && regIndex < 32) {
      return this.regs[regIndex] >>> 0;
    }
    return 0;
  }

  public get cop0() {
    const self = this;
    return {
      get status(): any {
        const val = self.cop0Regs[12] >>> 0;
        return {
          valueOf() { return val; },
          toString() { return val.toString(); },
          get bev(): number { return (val & (1 << 22)) !== 0 ? 1 : 0; },
          set bev(b: number) {
            if (b) {
              self.cop0Regs[12] = (self.cop0Regs[12] | (1 << 22)) >>> 0;
            } else {
              self.cop0Regs[12] = (self.cop0Regs[12] & ~(1 << 22)) >>> 0;
            }
          }
        };
      },
      set status(val: any) {
        const numVal = typeof val === 'number' ? val : Number(val);
        const uval = (numVal || 0) >>> 0;
        self.cop0Regs[12] = uval;
        self.memory.isCacheIsolated = (uval & 0x00010000) !== 0;
      },
      get cause(): number { return self.cop0Regs[13] >>> 0; },
      set cause(val: number) {
        self.cop0Regs[13] = val >>> 0;
      },
      get epc(): number { return self.cop0Regs[14] >>> 0; },
      set epc(val: number) {
        self.cop0Regs[14] = val >>> 0;
      },
      get badVAddr(): number { return self.cop0Regs[8] >>> 0; },
      set badVAddr(val: number) {
        self.cop0Regs[8] = val >>> 0;
      }
    };
  }

  // RFE opcode (COP0 function 0x10):
  public executeRfe(): void {
    const statusBefore = this.cop0Regs[12];
    const mode = statusBefore & 0x3F;
    // Shift mode bits (bits 5-0) right by 2:
    // [KUc, IEc] <- [KUp, IEp] <- [KUo, IEo]
    const newMode = ((mode >> 2) & 0x0F) | (mode & 0x30);
    const newStatus = ((statusBefore & ~0x3F) | newMode) >>> 0;
    this.cop0Regs[12] = newStatus;
    this.memory.isCacheIsolated = (this.cop0Regs[12] & 0x00010000) !== 0;

    const iecRestored = newStatus & 1;
    const rfeMsg = `[CPU RFE] Executing return from exception | Status Before: 0x${statusBefore.toString(16).toUpperCase()} -> Status After: 0x${newStatus.toString(16).toUpperCase()} (IEc restored to ${iecRestored})`;
    rateLimitLog('cpu_rfe_exec', 'warn', rfeMsg, 5);
    if (this.memory.onLog) {
      this.memory.onLog('bios', rfeMsg, this.pc);
    }
  }

  // Debug callbacks
  public onSyscall?: SyscallCallback;
  public onInstruction?: InstructionCallback;
  public onTty?: (char: string) => void;
  public onError?: ErrorCallback;

  constructor(memory: Memory) {
    this.memory = memory;
    this.reset();
  }

  public reset(): void {
    this.halted = false;
    this.regs.fill(0);
    this.cop0Regs.fill(0);
    if (this.gte) {
      this.gte.reset();
    }
    this.pc = 0xbfc00000;
    this.nextPc = 0xbfc00004;
    this.hi = 0;
    this.lo = 0;
    this.cop0Regs[12] = 0x10900000; // Initialize Status Register ($12): Boot with BEV=1, TS=1
    this.cop0Regs[15] = 0x00000002; // Processor ID ($15): MIPS R3000A
    this.memory.isCacheIsolated = false;
    this.cycles = 0;
    this.instructionsExecuted = 0;
    this.inDelaySlot = false;
    this.branchPending = false;
    this.branchTarget = 0;
    this.lastError = null;
    this.errorCount = 0;
    this._rfeHits = 0;
    this._epilogueReturnHits = 0;
    this._trap1aa4Hits = 0;
    this._rfeOpcodeHits = 0;
    this._syscallAdvanceHits = 0;
    this.lastSyscallPc = -1;
    this.lastSyscallA0 = -1;
    this._syscallCount = 0;
    this.hasLoggedSplashExit = false;
    this.instructionsSinceLastException = 0;
    this.exceptionTriggeredInStep = false;
    this.interruptInhibitInstructions = 0;
    this.justReturnedFromException = false;
    this._hasLoggedMaskedIrq = false;
    this._hasLoggedCdRomIrqPending = false;
    this.lastLoggedVblank = -1;
    this.postSyscallTraceRemaining = 0;
    this.gteOpCount = 0;
    this.syscallTrapCount = 0;
    this.biosVectorTrapCount = 0;
    this.hleBiosEnabled = false;
    this.executionHistory = [];

    this.memory.isCacheIsolated = false;
  }

  public read32(addr: number): number {
    return this.memory.read32(addr);
  }

  public getState(): CpuState {
    return {
      pc: this.pc,
      nextPc: this.nextPc,
      regs: new Uint32Array(this.regs),
      hi: this.hi,
      lo: this.lo,
      sr: this.sr,
      cause: this.cause,
      epc: this.epc,
      badVAddr: this.badVAddr,
      cycles: this.cycles,
      instructionsExecuted: this.instructionsExecuted,
      inDelaySlot: this.inDelaySlot,
    };
  }

  public reportError(message: string, pc: number, opcode: number = 0): void {
    this.lastError = message;
    this.errorCount++;
    const k0Hex = `0x${(this.regs[26] >>> 0).toString(16).toUpperCase()}`;
    const raHex = `0x${(this.regs[31] >>> 0).toString(16).toUpperCase()}`;
    const epcHex = `0x${(this.cop0Regs[14] >>> 0).toString(16).toUpperCase()}`;
    const fullMsg = `[CPU Error] PC: 0x${pc.toString(16).toUpperCase()} | $k0: ${k0Hex} | $ra: ${raHex} | EPC: ${epcHex} | inDelaySlot: ${this.inDelaySlot} - ${message}`;
    logErrorRateLimited(`cpu_err_${pc}_${opcode}`, fullMsg);
    if (this.memory.onLog) {
      this.memory.onLog('error', fullMsg, pc);
    }
    if (this.onError) {
      this.onError(message, pc, opcode);
    }
  }

  /**
   * Dispatches a MIPS Exception
   * ExcCode:
   *  0 = Int (Hardware Interrupt)
   *  4 = AdEL (Address Error on Load)
   *  5 = AdES (Address Error on Store)
   *  8 = Sys (Syscall)
   *  9 = Bp (Breakpoint)
   * 10 = RI (Reserved Instruction / Unknown Opcode)
   * 12 = Ov (Arithmetic Overflow)
   */
  public triggerException(causeExc: number, currentPc: number, wasDelaySlot: boolean = false, badVAddr: number = 0): void {
    this.instructionsSinceLastException = 0;
    if (causeExc === 10) {
      const k0Hex = `0x${(this.regs[26] >>> 0).toString(16).toUpperCase()}`;
      const raHex = `0x${(this.regs[31] >>> 0).toString(16).toUpperCase()}`;
      const epcHex = `0x${(this.cop0Regs[14] >>> 0).toString(16).toUpperCase()}`;
      const diag = `[RESERVED INSTRUCTION EXCEPTION] PC: 0x${currentPc.toString(16).toUpperCase()} | $k0: ${k0Hex} | $ra: ${raHex} | EPC: ${epcHex} | inDelaySlot: ${wasDelaySlot}`;
      logWarnRateLimited(`cpu_exc10_${currentPc}`, diag);
    }

    // 1. Record EPC and Branch Delay flag in Cause
    if (wasDelaySlot) {
      this.epc = (currentPc - 4) >>> 0;
      this.cause = (this.cause | 0x80000000) >>> 0;
    } else {
      // In MIPS I, for both syscalls and hardware interrupts, EPC is the current PC
      this.epc = currentPc >>> 0;
      this.cause = (this.cause & ~0x80000000) >>> 0;
    }
    this.cop0Regs[14] = this.epc >>> 0;

    // Validate EPC bounds: RAM or BIOS
    const epcMasked = (this.epc & 0x1fffffff) >>> 0;
    const isRam = epcMasked < 0x00200000;
    const isBios = epcMasked >= 0x1fc00000 && epcMasked < 0x1fc80000;
    if (!isRam && !isBios) {
      const err = `[EXCEPTION EPC OUT OF RANGE] EPC: 0x${this.epc.toString(16).toUpperCase()} at current PC: 0x${currentPc.toString(16).toUpperCase()} (wasDelaySlot: ${wasDelaySlot}, CauseExc: ${causeExc})`;
      logWarnRateLimited(`epc_out_of_range_${this.epc}`, err);
    }

    // 2. Set ExcCode (bits 6..2 of Cause) and set IP2 (bit 10) on hardware interrupt
    this.cause = ((this.cause & ~0x7c) | ((causeExc & 0x1f) << 2)) >>> 0;
    if (causeExc === 0) {
      // Set interrupt pending bit 10 (IP2) and ExCode 0 (Int)
      this.cause = (this.cause | (1 << 10)) >>> 0;
    }
    this.cop0Regs[13] = this.cause >>> 0;
    this.badVAddr = badVAddr >>> 0;
    this.cop0Regs[8] = this.badVAddr >>> 0;

    // 3. Shift mode bits in SR: preserve upper bits: (sr & ~0x3F) | ((mode << 2) & 0x3F)
    let currentSr = this.cop0Regs[12];
    if (currentSr === 0) {
      // Ensure currentSr is NOT 0 when an exception fires (e.g. Syscall)
      // Retain boot default status register with BEV=1 (0x10900000)
      currentSr = 0x10900000;
      this.cop0Regs[12] = currentSr;
    }
    const statusBefore = currentSr;
    const iecBefore = statusBefore & 1;

    // Shift mode bits (bits 5-0): push [KUc, IEc] -> [KUp, IEp] -> [KUo, IEo]
    const mode = currentSr & 0x3F;
    const newMode = (mode << 2) & 0x3F;
    this.cop0Regs[12] = (((currentSr & ~0x3F) | newMode)) >>> 0;
    this.memory.isCacheIsolated = (this.cop0Regs[12] & 0x00010000) !== 0;

    // 4. Jump to exception vector based on COP0 Status Register BEV Bit (bit 22)
    const bev = (this.cop0Regs[12] & (1 << 22)) !== 0;
    const targetVector = bev ? 0xBFC00180 : 0x80000080;
    this.pc = targetVector;
    this.nextPc = (this.pc + 4) >>> 0;
    this.inDelaySlot = false;
    this.branchPending = false;
    this.exceptionTriggeredInStep = true;

    const isSamePc = (this.lastExceptionPc === currentPc);
    if (isSamePc) {
      this.consecutiveExceptionCount++;
    } else {
      this.lastExceptionPc = currentPc;
      this.consecutiveExceptionCount = 1;
    }

    if (this.debugLogging || this.consecutiveExceptionCount <= 1) {
      const entryKey = `cpu_exc_entry_${causeExc}_${currentPc}`;
      const entryMsg = `[CPU EXCEPTION] Entry | PC: 0x${currentPc.toString(16).toUpperCase()} | Cause: 0x${this.cause.toString(16).toUpperCase()} | Status Before: 0x${statusBefore.toString(16).toUpperCase()} (IEc=${iecBefore})`;
      if (rateLimitLog(entryKey, 'warn', entryMsg, 3)) {
        if (this.memory.onLog && this.debugLogging) {
          this.memory.onLog('bios', entryMsg, currentPc);
        }
      }
    }
  }

  /**
   * Directly clears a pending interrupt line in COP0 Cause register.
   * bit: 0-7, where bit 2 is IP2 (Bit 10 of Cause)
   */
  public clearInterruptPending(bit: number): void {
    const shift = 8 + bit;
    this.cause = (this.cause & ~(1 << shift)) >>> 0;
    this.cop0Regs[13] = (this.cop0Regs[13] & ~(1 << shift)) >>> 0;
  }

  /**
   * Directly sets a pending interrupt line in COP0 Cause register.
   * bit: 0-7, where bit 2 is IP2 (Bit 10 of Cause)
   */
  public setInterruptPending(bit: number): void {
    const shift = 8 + bit;
    this.cause = (this.cause | (1 << shift)) >>> 0;
    this.cop0Regs[13] = (this.cop0Regs[13] | (1 << shift)) >>> 0;
  }

  /**
   * Directly asserts or deasserts IP2 in COP0 Cause register (Bit 10)
   */
  public assertHardwareInterrupt(asserted: boolean): void {
    if (asserted) {
      this.setInterruptPending(2);
    } else {
      this.clearInterruptPending(2);
    }
  }

  /**
   * Signal CPU hardware interrupt if (iStat & iMask) !== 0 and COP0 status IEc is 1
   */
  public signalHardwareInterrupt(): boolean {
    return this.checkInterrupts();
  }

  /**
   * Check and service hardware interrupts against I_STAT and I_MASK
   * Returns true if a hardware interrupt exception was triggered
   */
  public checkInterrupts(): boolean {
    const iec = (this.cop0Regs[12] & 0x1) !== 0;
    const hardwarePending = (this.memory.iStat & this.memory.iMask) !== 0;
    const im2Enabled = (this.cop0Regs[12] & 0x0400) !== 0;

    const cdromPending = (this.memory.iStat & (1 << 2)) !== 0;
    if (cdromPending && !this._hasLoggedCdRomIrqPending) {
      this._hasLoggedCdRomIrqPending = true;
      console.log('[IRQ CHECK] I_STAT: ' + this.memory.iStat.toString(16) + ' | I_MASK: ' + this.memory.iMask.toString(16) + ' | COP0 Status: ' + this.cop0.status.toString(16));
    }

    // Set/clear Bit 10 (IP2) in Cause Register (cop0Regs[13]) to reflect hardware IRQ pin
    if (hardwarePending) {
      this.cop0Regs[13] = (this.cop0Regs[13] | (1 << 10)) >>> 0;
    } else {
      this.cop0Regs[13] = (this.cop0Regs[13] & ~(1 << 10)) >>> 0;
    }

    // Do NOT trigger an external interrupt if the CPU is in a branch delay slot
    if (this.interruptInhibitInstructions > 0 || this.inDelaySlot || this.branchPending) {
      return false; // Inhibit latch or delay slot
    }

    // If master interrupt enable is set and hardware IP2 interrupt line is unmasked:
    if (iec && hardwarePending && im2Enabled) {
      this.triggerException(0x00, this.pc, this.inDelaySlot); // Exception code 0 = Interrupt
      return true;
    }

    return false;
  }

  /**
   * Determine instruction cycle cost:
   * - ALU operations: 1-2 cycles
   * - Memory operations (Load/Store): 2-3 cycles
   * - Multiplications: 4 cycles
   * - Divisions: 6 cycles
   * - Branches/Jumps: 2 cycles
   */
  public static getInstructionCycles(opcode: number): number {
    const op = (opcode >>> 26) & 0x3f;
    switch (op) {
      // Memory Load operations (2-3 cycles per memory access)
      case 0x20: // LB
      case 0x21: // LH
      case 0x22: // LWL
      case 0x23: // LW
      case 0x24: // LBU
      case 0x25: // LHU
      case 0x26: // LWR
      // Memory Store operations (2-3 cycles per memory access)
      case 0x28: // SB
      case 0x29: // SH
      case 0x2a: // SWL
      case 0x2b: // SW
      case 0x2e: // SWR
      case 0x32: // LWC2
      case 0x38: // SWC2
        return 3;

      // ALU operations with immediate (1-2 cycles)
      case 0x08: // ADDI
      case 0x09: // ADDIU
      case 0x0a: // SLTI
      case 0x0b: // SLTIU
      case 0x0c: // ANDI
      case 0x0d: // ORI
      case 0x0e: // XORI
      case 0x0f: // LUI
        return 2;

      // Branches and Jumps (2 cycles)
      case 0x01: // BCOND
      case 0x02: // J
      case 0x03: // JAL
      case 0x04: // BEQ
      case 0x05: // BNE
      case 0x06: // BLEZ
      case 0x07: // BGTZ
        return 2;

      // SPECIAL opcodes
      case 0x00: {
        const funct = opcode & 0x3f;
        switch (funct) {
          case 0x18: // MULT
          case 0x19: // MULTU
            return 4;
          case 0x1a: // DIV
          case 0x1b: // DIVU
            return 6;
          case 0x0c: // SYSCALL
            return 4;
          default:
            // ALU register operations (ADDU, SUBU, AND, OR, SLL, SRL, etc.): 1-2 cycles
            return 2;
        }
      }

      // Coprocessor operations
      case 0x10: // COP0
      case 0x12: // COP2 (GTE)
        return 2;

      default:
        return 2;
    }
  }

  /**
   * Execute a single instruction using the interpreter
   */
  public step(): number {
    // Check hardware interrupts before executing
    if (this.checkInterrupts()) {
      return 2;
    }

    this.instructionsSinceLastException++;
    const startingInhibit = this.interruptInhibitInstructions;

    // Always sanitize PC when fetching in KSEG0 (0x80000000..0x9FFFFFFF)
    // or KSEG1 (0xA0000000..0xBFFFFFFF):
    let physicalPc = this.pc & 0x1FFFFFFF;
    if (physicalPc < 0x00800000) {
      // PS1 RAM is 2MB (0x00000000 - 0x001FFFFF). Mirror wrap:
      physicalPc = physicalPc & 0x001FFFFF;
      // Keep PC in KSEG0 (0x80000000) for standard execution:
      this.pc = (0x80000000 | physicalPc) >>> 0;
    }

    const currentPc = this.pc;
    this.memory.currentCpuPc = currentPc;

    // Direct BIOS 80/A0/B0/C0 vector dispatch - STRICTLY GUARDED by hleBiosEnabled
    // When running Branch A (Authentic BIOS), low-RAM vectors are handled naturally by Sony ROM without any interception
    if (this.hleBiosEnabled && physicalPc === 0x80) {
      const causeExc = (this.cop0Regs[13] >>> 2) & 0x1f;
      if (causeExc === 0) {
        // Hardware Interrupt: Handle device request and clear I_STAT before returning to EPC
        if ((this.memory.iStat & 1) !== 0) {
          this.memory.deliverVblankEvent();
        }
        this.memory.writeIStat(0);
        this.executeRfe();
        const returnEpc = this.cop0Regs[14] >>> 0;
        this.pc = returnEpc;
        this.nextPc = (returnEpc + 4) >>> 0;
        this.inDelaySlot = false;
        this.branchPending = false;
        return 4;
      } else {
        // Software Trap / Syscall / Unhandled Instruction: Add 4 to EPC before executing rfe or returning
        const returnEpc = ((this.cop0Regs[14] >>> 0) + 4) >>> 0;
        this.cop0Regs[14] = returnEpc;
        this.epc = returnEpc;
        this.executeRfe();
        this.pc = returnEpc;
        this.nextPc = (returnEpc + 4) >>> 0;
        this.inDelaySlot = false;
        this.branchPending = false;
        return 4;
      }
    }

    if (this.hleBiosEnabled && (physicalPc === 0xa0 || physicalPc === 0xb0 || physicalPc === 0xc0)) {
      const res = HleBiosDispatcher.dispatchVector(physicalPc, this, this.memory);
      const returnRa = this.regs[31] >>> 0;
      if (this.debugLogging && this.memory.onLog) {
        const logMsg = `[HLE BIOS VECTOR 0x${physicalPc.toString(16).toUpperCase()}] Service 0x${res.fnId.toString(16).toUpperCase()} (${res.serviceName}) from ${res.sourceReg}=0x${res.fnId.toString(16).toUpperCase()} -> JR $ra (0x${returnRa.toString(16).toUpperCase()}), $v0=0x${this.regs[2].toString(16).toUpperCase()}`;
        this.memory.onLog('bios', logMsg, currentPc);
      }
      if (returnRa !== 0) {
        this.pc = returnRa;
        this.nextPc = (returnRa + 4) >>> 0;
        this.inDelaySlot = false;
        this.branchPending = false;
        return 4;
      } else {
        this.reportError(`[BIOS VECTOR TRAP] Fetched from vector 0x${physicalPc.toString(16).toUpperCase()} with $ra=0x0`, currentPc);
        this.halted = true;
        return 4;
      }
    }

    if (this.pc === 0x800AD8F8 && !this._hasLoggedAD8F8) {
      this._hasLoggedAD8F8 = true;
      const header = '=== DISASSEMBLY OF INITIATING FUNCTION 0x800AD8F8 ===';
      console.log(header);
      if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
      for (let addr = 0x800AD8F8; addr <= 0x800AD938; addr += 4) {
        const word = this.memory.read32(addr);
        let asm = 'unknown';
        try {
          asm = disassemble(addr, word).assembly;
        } catch {
          asm = 'unknown';
        }
        const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
        console.log(line);
        if (this.memory.onLog) this.memory.onLog('bios', line, addr);
      }
    }

    if (this.pc === 0x800AD9A0) {
      if (!this._hasLoggedAD9A0) {
        this._hasLoggedAD9A0 = true;
        const header = '=== DISASSEMBLY AT 0x800AD990 - 0x800AD9C0 ===';
        console.log(header);
        if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
        for (let addr = 0x800AD990; addr <= 0x800AD9C0; addr += 4) {
          const word = this.memory.read32(addr);
          let asm = 'unknown';
          try {
            asm = disassemble(addr, word).assembly;
          } catch {
            asm = 'unknown';
          }
          const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
          console.log(line);
          if (this.memory.onLog) this.memory.onLog('bios', line, addr);
        }
      }

      if (!this._hasLoggedAD9A0_val) {
        this._hasLoggedAD9A0_val = true;
        const busyVal = this.memory.read32(0x80127114);
        const msg = `[CD BUSY CHECK] memory[0x80127114] = 0x${busyVal.toString(16).toUpperCase()}`;
        console.log(msg);
        if (this.memory.onLog) {
          this.memory.onLog('bios', msg, this.pc);
        }
      }
    }

    if (this.pc === 0x800AD9C0 && !this._hasLoggedAD9C0) {
      this._hasLoggedAD9C0 = true;
      const header = '=== DISASSEMBLY AT 0x800AD9C0 - 0x800AD9E0 ===';
      console.log(header);
      if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
      for (let addr = 0x800AD9C0; addr <= 0x800AD9E0; addr += 4) {
        const word = this.memory.read32(addr);
        let asm = 'unknown';
        try {
          asm = disassemble(addr, word).assembly;
        } catch {
          asm = 'unknown';
        }
        const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
        console.log(line);
        if (this.memory.onLog) this.memory.onLog('bios', line, addr);
      }
    }

    if (this.pc === 0x800B27C0 && !this._hasLoggedB27C0) {
      this._hasLoggedB27C0 = true;
      const header = '=== DISASSEMBLY OF GPU SYNC LOOP (0x800B27B8 - 0x800B27D8) ===';
      console.log(header);
      if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
      for (let addr = 0x800B27B8; addr <= 0x800B27D8; addr += 4) {
        const word = this.memory.read32(addr);
        let asm = 'unknown';
        try {
          asm = disassemble(addr, word).assembly;
        } catch {
          asm = 'unknown';
        }
        const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
        console.log(line);
        if (this.memory.onLog) this.memory.onLog('bios', line, addr);
      }
    }

    if (this.pc === 0x800AA484 && !this._hasLoggedAA484) {
      this._hasLoggedAA484 = true;
      const header = '=== DISASSEMBLY OF MAIN LOOP (0x800AA478 - 0x800AA4B0) ===';
      console.log(header);
      if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
      for (let addr = 0x800AA478; addr <= 0x800AA4B0; addr += 4) {
        const word = this.memory.read32(addr);
        let asm = 'unknown';
        try {
          asm = disassemble(addr, word).assembly;
        } catch {
          asm = 'unknown';
        }
        const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
        console.log(line);
        if (this.memory.onLog) this.memory.onLog('bios', line, addr);
      }
    }

    if (this.pc === 0x8003C398) {
      if (!this._hasLogged3C398) {
        this._hasLogged3C398 = true;
        const header = '=== DISASSEMBLY OF FUNCTION AROUND 0x8003C340 - 0x8003C3E0 ===';
        console.log(header);
        if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
        for (let addr = 0x8003C340; addr <= 0x8003C3E0; addr += 4) {
          const word = this.memory.read32(addr);
          let asm = 'unknown';
          try {
            asm = disassemble(addr, word).assembly;
          } catch {
            asm = 'unknown';
          }
          const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
          console.log(line);
          if (this.memory.onLog) this.memory.onLog('bios', line, addr);
        }

        const sp = this.regs[29] >>> 0;
        const savedRa = this.memory.read32(sp + 64);
        const stackMsg = `[FUNCTION 0x8003C380 CALLER] $sp: 0x${sp.toString(16).toUpperCase()} | Return RA at 64($sp): 0x${savedRa.toString(16).toUpperCase()}`;
        console.log(stackMsg);
        if (this.memory.onLog) this.memory.onLog('bios', stackMsg, this.pc);
      }

      const baseReg = this.regs[3] >>> 0; // $v1 = reg 3
      const targetAddr = (baseReg + -30404) >>> 0;
      if (!this._hasLoggedTarget3C398) {
        this._hasLoggedTarget3C398 = true;
        const msg = `[VRAM PRE-DISPATCH] $s0/$v1: 0x${baseReg.toString(16).toUpperCase()} | Target Polled Address: 0x${targetAddr.toString(16).toUpperCase()} | Current Value: 0x${this.memory.read32(targetAddr).toString(16).toUpperCase()}`;
        console.log(msg);
        if (this.memory.onLog) {
          this.memory.onLog('bios', msg, this.pc);
        }
      }
    }

    if (this.pc === 0x800C8FA8 && !this._hasLoggedC8FA8) {
      this._hasLoggedC8FA8 = true;
      const header = '=== DISASSEMBLY OF GPU BLIT LOOP (0x800C8FA0 - 0x800C8FD0) ===';
      console.log(header);
      if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
      for (let addr = 0x800C8FA0; addr <= 0x800C8FD0; addr += 4) {
        const word = this.memory.read32(addr);
        let asm = 'unknown';
        try {
          asm = disassemble(addr, word).assembly;
        } catch {
          asm = 'unknown';
        }
        const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
        console.log(line);
        if (this.memory.onLog) this.memory.onLog('bios', line, addr);
      }

      const v0Hex = (this.regs[2] >>> 0).toString(16).toUpperCase();
      const v1Hex = (this.regs[3] >>> 0).toString(16).toUpperCase();
      const a0Hex = (this.regs[4] >>> 0).toString(16).toUpperCase();
      const a1Hex = (this.regs[5] >>> 0).toString(16).toUpperCase();
      const t0Hex = (this.regs[8] >>> 0).toString(16).toUpperCase();
      const raHex = (this.regs[31] >>> 0).toString(16).toUpperCase();
      const regMsg = `[REGS AT 0x800C8FA8] $v0: 0x${v0Hex} | $v1: 0x${v1Hex} | $a0: 0x${a0Hex} | $a1: 0x${a1Hex} | $t0: 0x${t0Hex} | $ra: 0x${raHex}`;
      console.log(regMsg);
      if (this.memory.onLog) this.memory.onLog('bios', regMsg, this.pc);
    }

    if (this.pc > 0x800C8FD4 && this.pc < 0x800C9500 && !this._hasLoggedExitC8FD4) {
      this._hasLoggedExitC8FD4 = true;
      const msg = `[MAIN LOOP ADVANCED] CPU unlocked from 0x800C8FD0! New PC: 0x${this.pc.toString(16).toUpperCase()} | $ra: 0x${(this.regs[31] >>> 0).toString(16).toUpperCase()}`;
      console.log(msg);
      if (this.memory.onLog) {
        this.memory.onLog('bios', msg, this.pc);
      }
    }

    if (this.pc === 0x800CC3A8) {
      if (!this._hasLoggedSpinlock) {
        this._hasLoggedSpinlock = true;
        const valD000 = this.memory.read32(0x8012D000);
        const val404C = this.memory.read32(0x800E404C);
        const msg = `[SPINLOCK CHECK] v0: 0x${(this.regs[2] >>> 0).toString(16)}, v1 (0x8012D000): 0x${(valD000 >>> 0).toString(16)}, mem[0x800E404C]: 0x${(val404C >>> 0).toString(16)}`;
        console.log(msg);
        if (this.memory.onLog) {
          this.memory.onLog('bios', msg, this.pc);
        }
      }
    }

    if (this.pc === 0x800AE418) {
      if (!this._hasLoggedAE418) {
        this._hasLoggedAE418 = true;
        const header = '=== DISASSEMBLY AT 0x800AE410 - 0x800AE430 ===';
        console.log(header);
        if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
        for (let addr = 0x800AE410; addr <= 0x800AE430; addr += 4) {
          const word = this.memory.read32(addr);
          let asm = 'unknown';
          try {
            asm = disassemble(addr, word).assembly;
          } catch {
            asm = 'unknown';
          }
          const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
          console.log(line);
          if (this.memory.onLog) this.memory.onLog('bios', line, addr);
        }
      }

      if (!this._hasLoggedS0Target) {
        this._hasLoggedS0Target = true;
        const s0 = this.regs[16] >>> 0;
        const targetAddr = (s0 + 0x7A58) >>> 0;
        const currentVal = this.memory.read32(targetAddr);
        const msg = `[COMPLETION FLAG POLL] $s0: 0x${s0.toString(16).toUpperCase()}, Target Address: 0x${targetAddr.toString(16).toUpperCase()}, Current Value: 0x${currentVal.toString(16).toUpperCase()}`;
        console.log(msg);
        if (this.memory.onLog) this.memory.onLog('bios', msg, this.pc);
      }

      if (!this._hasLoggedAE3E0Prologue) {
        this._hasLoggedAE3E0Prologue = true;
        const header = '=== FUNCTION PROLOGUE DISASSEMBLY (0x800AE3E0 - 0x800AE410) ===';
        console.log(header);
        if (this.memory.onLog) this.memory.onLog('bios', header, this.pc);
        for (let addr = 0x800AE3E0; addr <= 0x800AE410; addr += 4) {
          const word = this.memory.read32(addr);
          let asm = 'unknown';
          try {
            asm = disassemble(addr, word).assembly;
          } catch {
            asm = 'unknown';
          }
          const line = `  0x${addr.toString(16).toUpperCase()}: 0x${word.toString(16).padStart(8, '0').toUpperCase()} -> ${asm}`;
          console.log(line);
          if (this.memory.onLog) this.memory.onLog('bios', line, addr);
        }
      }
    }

    if ((this.pc & 0xffffff00) !== 0x800ae400 && this.memory._cdWaitFrames > 5 && !this._loggedExit) {
      this._loggedExit = true;
      const msg = `[ENGINE UNLOCKED] Jumped to PC: 0x${this.pc.toString(16).toUpperCase()} | $ra: 0x${(this.regs[31] >>> 0).toString(16).toUpperCase()}`;
      console.log(msg);
      if (this.memory.onLog) {
        this.memory.onLog('bios', msg, this.pc);
      }
    }

    // Boundary Guard: Check if current PC is in unmapped address space before instruction fetch
    if (!this.isInstructionFetchMapped(currentPc)) {
      const raHex = `0x${(this.regs[31] >>> 0).toString(16).toUpperCase()}`;
      const spHex = `0x${(this.regs[29] >>> 0).toString(16).toUpperCase()}`;
      const v0Hex = `0x${(this.regs[2] >>> 0).toString(16).toUpperCase()}`;
      const pcHex = `0x${currentPc.toString(16).toUpperCase()}`;

      const historyLines = this.executionHistory.slice(-5).map((h, i) => {
        const hPc = `0x${h.pc.toString(16).toUpperCase()}`;
        const hOp = `0x${h.opcode.toString(16).padStart(8, '0').toUpperCase()}`;
        let disasm = '';
        try {
          disasm = disassemble(h.pc, h.opcode).assembly;
        } catch {
          disasm = 'unknown';
        }
        return `  [${i + 1}] PC: ${hPc} | Opcode: ${hOp} | ${disasm}`;
      }).join('\n');

      const crashLog = `[CRASH: UNMAPPED PC INSTRUCTION FETCH]\n` +
        `Attempted to fetch instruction from unmapped address: ${pcHex}\n` +
        `Registers: $ra: ${raHex} | $sp: ${spHex} | $v0: ${v0Hex}\n` +
        `Previous executed instructions:\n${historyLines || '  (No history recorded)'}`;

      this.reportError(crashLog, currentPc);
      if (this.memory.onLog) {
        this.memory.onLog('error', crashLog, currentPc);
      }
      this.halted = true;
      return 0;
    }

    // Fetch instruction
    const opcode = this.memory.read32(currentPc);
    const stepCycles = Cpu.getInstructionCycles(opcode);

    // Track execution history (up to last 20 instructions)
    if (this.executionHistory.length >= 20) {
      this.executionHistory.shift();
    }
    this.executionHistory.push({ pc: currentPc, opcode });

    if (this.onInstruction) {
      const dis = disassemble(currentPc, opcode);
      this.onInstruction(currentPc, opcode, dis.assembly);
    }

    // Determine next PC
    const wasDelaySlot = this.inDelaySlot;
    let nextPc: number;
    if (wasDelaySlot) {
      nextPc = this.sanitizeJumpTarget(this.branchTarget);
    } else {
      nextPc = (currentPc + 4) >>> 0;
      if (nextPc < 0x80000000 && nextPc >= 0x00200000) {
        nextPc = (nextPc & 0x001fffff) >>> 0;
      }
    }

    this.exceptionTriggeredInStep = false;

    // Execute opcode
    this.executeOpcode(opcode, currentPc, wasDelaySlot);

    if (!this.exceptionTriggeredInStep) {
      if (this.skipDelaySlot) {
        this.skipDelaySlot = false;
        this.inDelaySlot = false;
        this.branchPending = false;
        this.pc = (currentPc + 8) >>> 0;
        this.nextPc = (currentPc + 12) >>> 0;
      } else if (wasDelaySlot) {
        // Exiting the branch delay slot upon reaching the jump target
        this.inDelaySlot = false;
        this.branchPending = false;
        this.pc = this.sanitizeJumpTarget(nextPc);
        this.nextPc = (this.pc + 4) >>> 0;
      } else if (this.branchPending) {
        // Branch was scheduled: next instruction executes inside the delay slot
        this.inDelaySlot = true;
        this.pc = nextPc;
        this.nextPc = this.sanitizeJumpTarget(this.branchTarget);
      } else {
        this.inDelaySlot = false;
        this.pc = nextPc;
        this.nextPc = (nextPc + 4) >>> 0;
      }
    }

    // Register $zero ($0) is hardwired to 0
    this.regs[0] = 0;

    if (startingInhibit > 0) {
      this.interruptInhibitInstructions = startingInhibit - 1;
    }

    this.instructionsExecuted++;
    this.cycles += stepCycles;
    return stepCycles;
  }

  private triggerBranch(target: number): void {
    this.branchPending = true;
    this.branchTarget = this.sanitizeJumpTarget(target);
  }

  public executeOpcode(opcode: number, currentPc: number, wasDelaySlot: boolean = false): void {
    const op = (opcode >>> 26) & 0x3f;
    const rs = (opcode >>> 21) & 0x1f;
    const rt = (opcode >>> 16) & 0x1f;
    const rd = (opcode >>> 11) & 0x1f;
    const shamt = (opcode >>> 6) & 0x1f;
    const funct = opcode & 0x3f;
    const imm16 = opcode & 0xffff;
    const simm16 = (imm16 << 16) >> 16;
    const target = (opcode & 0x03ffffff) << 2;

    switch (op) {
      case 0x00: // SPECIAL
        this.executeSpecial(funct, rs, rt, rd, shamt, currentPc, wasDelaySlot, opcode);
        break;

      case 0x01: // BCOND / REGIMM branch variants
        {
          const bTarget = (currentPc + 4 + (simm16 << 2)) >>> 0;
          const isGez = (rt & 0x01) !== 0;     // Bit 0 = Greater than or Equal to Zero
          const isLink = (rt & 0x10) !== 0;    // Bit 4 = And Link ($ra)
          const isLikely = (rt & 0x02) !== 0;  // Bit 1 = Likely branch variant

          const val = this.regs[rs] | 0;
          const condition = isGez ? (val >= 0) : (val < 0);

          if (isLink) {
            this.regs[31] = (currentPc + 8) >>> 0; // Link to $ra
          }

          if (condition) {
            this.triggerBranch(bTarget);
          } else if (isLikely) {
            // If Branch Likely condition is FALSE, skip the delay slot:
            this.skipDelaySlot = true;
          }
        }
        break;

      case 0x02: // J
        {
          const jumpPc = (currentPc + 4) >>> 0;
          const segment = jumpPc & 0xf0000000;
          this.triggerBranch((segment | target) >>> 0);
        }
        break;

      case 0x03: // JAL
        {
          this.regs[31] = (currentPc + 8) >>> 0;
          const jumpPc = (currentPc + 4) >>> 0;
          const segment = jumpPc & 0xf0000000;
          this.triggerBranch((segment | target) >>> 0);
        }
        break;

      case 0x04: // BEQ
        if (this.regs[rs] === this.regs[rt]) {
          this.triggerBranch((currentPc + 4 + (simm16 << 2)) >>> 0);
        }
        break;

      case 0x05: // BNE
        if (this.regs[rs] !== this.regs[rt]) {
          this.triggerBranch((currentPc + 4 + (simm16 << 2)) >>> 0);
        }
        break;

      case 0x06: // BLEZ
        if ((this.regs[rs] | 0) <= 0) {
          this.triggerBranch((currentPc + 4 + (simm16 << 2)) >>> 0);
        }
        break;

      case 0x07: // BGTZ
        if ((this.regs[rs] | 0) > 0) {
          this.triggerBranch((currentPc + 4 + (simm16 << 2)) >>> 0);
        }
        break;

      case 0x08: // ADDI
      case 0x09: // ADDIU
        this.regs[rt] = (this.regs[rs] + simm16) >>> 0;
        break;

      case 0x0a: // SLTI
        this.regs[rt] = ((this.regs[rs] | 0) < simm16) ? 1 : 0;
        break;

      case 0x0b: // SLTIU
        this.regs[rt] = (this.regs[rs] >>> 0 < (simm16 >>> 0)) ? 1 : 0;
        break;

      case 0x0c: // ANDI
        this.regs[rt] = (this.regs[rs] & imm16) >>> 0;
        break;

      case 0x0d: // ORI
        this.regs[rt] = (this.regs[rs] | imm16) >>> 0;
        break;

      case 0x0e: // XORI
        this.regs[rt] = (this.regs[rs] ^ imm16) >>> 0;
        break;

      case 0x0f: // LUI
        this.regs[rt] = (imm16 << 16) >>> 0;
        break;

      case 0x10: // COP0
        this.executeCop0(rs, rt, rd, funct, opcode, currentPc, wasDelaySlot);
        break;

      case 0x12: // COP2 (GTE)
        this.gteOpCount++;
        if ((opcode & 0x02000000) !== 0) {
          // GTE command (RTPS, NCLIP, etc.)
          if (this.gte) {
            this.gte.executeCommand(opcode);
          }
        } else {
          switch (rs) {
            case 0x00: // MFC2 rt, rd (Move from GTE data register)
              this.regs[rt] = this.gte ? this.gte.readData(rd) : 0;
              this.regs[0] = 0;
              break;
            case 0x02: // CFC2 rt, rd (Move from GTE control register)
              this.regs[rt] = this.gte ? this.gte.readCtrl(rd) : 0;
              this.regs[0] = 0;
              break;
            case 0x04: // MTC2 rt, rd (Move to GTE data register)
              if (this.gte) {
                this.gte.writeData(rd, this.regs[rt]);
              }
              break;
            case 0x06: // CTC2 rt, rd (Move to GTE control register)
              if (this.gte) {
                this.gte.writeCtrl(rd, this.regs[rt]);
              }
              break;
          }
        }
        break;

      case 0x13: // COP3 stub
        break; // Silent NOP

      case 0x14: // BEQL
        {
          const bTarget = (currentPc + 4 + (simm16 << 2)) >>> 0;
          if (this.regs[rs] === this.regs[rt]) {
            this.triggerBranch(bTarget);
          } else {
            this.skipDelaySlot = true;
          }
        }
        break;

      case 0x15: // BNEL
        {
          const bTarget = (currentPc + 4 + (simm16 << 2)) >>> 0;
          if (this.regs[rs] !== this.regs[rt]) {
            this.triggerBranch(bTarget);
          } else {
            this.skipDelaySlot = true;
          }
        }
        break;

      case 0x16: // BLEZL
        {
          const bTarget = (currentPc + 4 + (simm16 << 2)) >>> 0;
          if ((this.regs[rs] | 0) <= 0) {
            this.triggerBranch(bTarget);
          } else {
            this.skipDelaySlot = true;
          }
        }
        break;

      case 0x17: // BGTZL
        {
          const bTarget = (currentPc + 4 + (simm16 << 2)) >>> 0;
          if ((this.regs[rs] | 0) > 0) {
            this.triggerBranch(bTarget);
          } else {
            this.skipDelaySlot = true;
          }
        }
        break;

      case 0x18:
      case 0x19: { // DADD / DADDU fallback for 32-bit R3000A
        const rs = (opcode >>> 21) & 0x1f;
        const rt = (opcode >>> 16) & 0x1f;
        const rd = (opcode >>> 11) & 0x1f;
        if (rd !== 0) {
          this.regs[rd] = (this.regs[rs] + this.regs[rt]) | 0;
        }
        break;
      }

      case 0x1a: // LDL - Fallback to 32-bit LWL
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = (((this.regs[rt] & LWL_MASKS[byteOffset]) | ((mem << LWL_SHIFTS[byteOffset]) >>> 0))) >>> 0;
          }
        }
        break;

      case 0x1b: // LDR - Fallback to 32-bit LWR
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = (((this.regs[rt] & LWR_MASKS[byteOffset]) | (mem >>> LWR_SHIFTS[byteOffset]))) >>> 0;
          }
        }
        break;

      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f: { // Unallocated extensions fallback
        const warning = `[CPU] Encountered unallocated extension opcode 0x${op.toString(16).toUpperCase()} (raw 0x${opcode.toString(16).padStart(8, '0').toUpperCase()}) at PC 0x${currentPc.toString(16).toUpperCase()} - treating as fallback NOP`;
        console.warn(warning);
        if (this.memory.onLog) {
          this.memory.onLog('warn', warning, currentPc);
        }
        break;
      }

      case 0x20: // LB
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.memory.read8(addr);
          if (rt !== 0) {
            this.regs[rt] = ((val << 24) >> 24) >>> 0;
          }
        }
        break;

      case 0x21: // LH
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.memory.read16(addr);
          if (rt !== 0) {
            this.regs[rt] = ((val << 16) >> 16) >>> 0;
          }
        }
        break;

      case 0x22: // LWL (Load Word Left - Little Endian)
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = (((this.regs[rt] & LWL_MASKS[byteOffset]) | ((mem << LWL_SHIFTS[byteOffset]) >>> 0))) >>> 0;
          }
        }
        break;

      case 0x23: // LW
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const loadedVal = this.memory.read32(addr) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = loadedVal;
          }
        }
        break;

      case 0x24: // LBU
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.memory.read8(addr) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = val;
          }
        }
        break;

      case 0x25: // LHU
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.memory.read16(addr) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = val;
          }
        }
        break;

      case 0x26: // LWR (Load Word Right - Little Endian)
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = (((this.regs[rt] & LWR_MASKS[byteOffset]) | (mem >>> LWR_SHIFTS[byteOffset]))) >>> 0;
          }
        }
        break;

      case 0x28: // SB
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.regs[rt] & 0xff;
          this.memory.write8(addr, val);
        }
        break;

      case 0x29: // SH
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.regs[rt] & 0xffff;
          this.memory.write16(addr, val);
        }
        break;

      case 0x2a: // SWL (Store Word Left - Little Endian)
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          const val = (((mem & SWL_MASKS[byteOffset]) | (this.regs[rt] >>> SWL_SHIFTS[byteOffset]))) >>> 0;
          this.memory.write32(aligned, val);
        }
        break;

      case 0x2b: // SW
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.regs[rt] >>> 0;
          this.memory.write32(addr, val);
        }
        break;

      case 0x2c: // SDL (Store Doubleword Left) - Fallback to 32-bit SWL
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          const val = (((mem & SWL_MASKS[byteOffset]) | (this.regs[rt] >>> SWL_SHIFTS[byteOffset]))) >>> 0;
          this.memory.write32(aligned, val);
        }
        break;

      case 0x2d: // SDR (Store Doubleword Right) - Fallback to 32-bit SWR
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          const val = (((mem & SWR_MASKS[byteOffset]) | ((this.regs[rt] << SWR_SHIFTS[byteOffset]) >>> 0))) >>> 0;
          this.memory.write32(aligned, val);
        }
        break;

      case 0x2e: // SWR (Store Word Right - Little Endian)
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const aligned = addr & ~3;
          const byteOffset = addr & 3;
          const mem = this.memory.read32(aligned) >>> 0;
          const val = (((mem & SWR_MASKS[byteOffset]) | ((this.regs[rt] << SWR_SHIFTS[byteOffset]) >>> 0))) >>> 0;
          this.memory.write32(aligned, val);
        }
        break;

      case 0x32: { // LWC2 rt, offset(rs) - Load Word Coprocessor 2 (GTE)
        const instr = opcode;
        const rs = (instr >> 21) & 0x1F;
        const rt = (instr >> 16) & 0x1F; // GTE register index (0-31)
        const imm = (instr << 16) >> 16; // Sign-extend 16-bit offset
        const addr = (this.regs[rs] + imm) >>> 0;
        const val = this.memory.read32(addr);
        if (this.gte) {
          this.gte.writeDataRegister(rt, val);
        }
        break;
      }

      case 0x33: { // LWC3 load stub
        break; // Non-fatal NOP
      }

      case 0x36:
      case 0x3a: { // LDC2 rt, offset(rs)
        const instr = opcode;
        const rs = (instr >> 21) & 0x1F;
        const rt = (instr >> 16) & 0x1F;
        const imm = (instr << 16) >> 16;
        const addr = (this.regs[rs] + imm) >>> 0;
        const val0 = this.memory.read32(addr);
        const val1 = this.memory.read32((addr + 4) >>> 0);
        if (this.gte) {
          this.gte.writeDataRegister(rt, val0);
          this.gte.writeDataRegister((rt + 1) & 0x1F, val1);
        }
        break;
      }

      case 0x37: // LD (Load Doubleword) - Fallback to 32-bit LW
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const loadedVal = this.memory.read32(addr) >>> 0;
          if (rt !== 0) {
            this.regs[rt] = loadedVal;
          }
        }
        break;

      case 0x38: { // SWC2 rt, offset(rs) - Store Word Coprocessor 2 (GTE)
        const instr = opcode;
        const rs = (instr >> 21) & 0x1F;
        const rt = (instr >> 16) & 0x1F; // GTE register index (0-31)
        const imm = (instr << 16) >> 16; // Sign-extend 16-bit offset
        const addr = (this.regs[rs] + imm) >>> 0;
        const val = this.gte ? this.gte.readDataRegister(rt) : 0;
        this.memory.write32(addr, val);
        break;
      }

      case 0x3b: { // SWC3 / COP3 store or GTE macro alias
        const instr = opcode;
        const rs = (instr >> 21) & 0x1F;
        const rt = (instr >> 16) & 0x1F;
        const imm = (instr << 16) >> 16;
        const addr = (this.regs[rs] + imm) >>> 0;
        // Perform memory write if GTE data register or silent NOP:
        const val = this.gte ? this.gte.readDataRegister(rt) : 0;
        this.memory.write32(addr, val);
        break;
      }

      case 0x3c: { // SDC2 rt, offset(rs)
        const instr = opcode;
        const rs = (instr >> 21) & 0x1F;
        const rt = (instr >> 16) & 0x1F;
        const imm = (instr << 16) >> 16;
        const addr = (this.regs[rs] + imm) >>> 0;
        const val0 = this.gte ? this.gte.readDataRegister(rt) : 0;
        const val1 = this.gte ? this.gte.readDataRegister((rt + 1) & 0x1F) : 0;
        this.memory.write32(addr, val0);
        this.memory.write32((addr + 4) >>> 0, val1);
        break;
      }

      case 0x3f: // SD (Store Doubleword) - Fallback to 32-bit SW
        {
          const base = (opcode >>> 21) & 0x1f;
          const rt = (opcode >>> 16) & 0x1f;
          const offset = (opcode << 16) >> 16;
          const addr = ((this.regs[base] + offset) >>> 0);
          const val = this.regs[rt] >>> 0;
          this.memory.write32(addr, val);
        }
        break;

      default: {
        const warning = `[CPU] Unhandled opcode 0x${op.toString(16).padStart(2, '0')} (raw 0x${opcode.toString(16).padStart(8, '0')}) at PC 0x${currentPc.toString(16).toUpperCase()} - treating as NOP`;
        console.warn(warning);
        if (this.memory.onLog) {
          this.memory.onLog('warn', warning, currentPc);
        }
        break;
      }
    }
  }

  private executeSpecial(funct: number, rs: number, rt: number, rd: number, shamt: number, currentPc: number, wasDelaySlot: boolean, opcode: number): void {
    switch (funct) {
      case 0x00: // SLL / NOP
        this.regs[rd] = (this.regs[rt] << shamt) >>> 0;
        break;
      case 0x01: // SPECIAL funct 0x01: Compiler-generated branch hint / NOP
        if (this.memory.onLog) {
          this.memory.onLog(
            'warn',
            `[SPECIAL 0x01] Unhandled funct at PC: 0x${currentPc.toString(16).toUpperCase()} (treated as NOP branch hint)`,
            currentPc
          );
        }
        break;
      case 0x02: // SRL
        this.regs[rd] = (this.regs[rt] >>> shamt) >>> 0;
        break;
      case 0x03: // SRA
        this.regs[rd] = (((this.regs[rt] | 0) >> shamt)) >>> 0;
        break;
      case 0x04: // SLLV
        this.regs[rd] = (this.regs[rt] << (this.regs[rs] & 0x1f)) >>> 0;
        break;
      case 0x06: // SRLV
        this.regs[rd] = (this.regs[rt] >>> (this.regs[rs] & 0x1f)) >>> 0;
        break;
      case 0x07: // SRAV
        this.regs[rd] = (((this.regs[rt] | 0) >> (this.regs[rs] & 0x1f))) >>> 0;
        break;
      case 0x08: // JR
        if (this.regs[rs] === 0) {
          const recoveryRa = this.regs[31] >>> 0;
          if (recoveryRa !== 0 && recoveryRa !== currentPc) {
            if (this.memory.onLog) {
              this.memory.onLog('warn', `[MIPS RECOVERY] JR $0 encountered at PC: 0x${currentPc.toString(16).toUpperCase()} - recovering via $ra (0x${recoveryRa.toString(16).toUpperCase()})`, currentPc);
            }
            this.triggerBranch(recoveryRa);
            return;
          }
          this.reportError(`[NULL DEREFERENCE] Attempted JR to 0x0 from $r${rs}. $ra=0x${this.regs[31].toString(16)}, $t9=0x${this.regs[25].toString(16)}, $k0=0x${this.regs[26].toString(16)}, $k1=0x${this.regs[27].toString(16)}`, currentPc);
          this.halted = true;
          return;
        }
        this.triggerBranch(this.regs[rs] >>> 0);
        break;
      case 0x09: // JALR
        if (this.regs[rs] === 0) {
          const recoveryRa = this.regs[31] >>> 0;
          this.regs[rd] = (currentPc + 8) >>> 0;
          if (recoveryRa !== 0 && recoveryRa !== currentPc) {
            if (this.memory.onLog) {
              this.memory.onLog('warn', `[MIPS RECOVERY] JALR $0 encountered at PC: 0x${currentPc.toString(16).toUpperCase()} - returning via $ra (0x${recoveryRa.toString(16).toUpperCase()})`, currentPc);
            }
            this.triggerBranch(recoveryRa);
            return;
          }
          this.reportError(`[NULL DEREFERENCE] Attempted JALR to 0x0 from $r${rs}. $ra=0x${this.regs[31].toString(16)}, $t9=0x${this.regs[25].toString(16)}, $k0=0x${this.regs[26].toString(16)}, $k1=0x${this.regs[27].toString(16)}`, currentPc);
          this.halted = true;
          return;
        }
        this.regs[rd] = (currentPc + 8) >>> 0;
        this.triggerBranch(this.regs[rs] >>> 0);
        break;
      case 0x0a: // MOVZ rd, rs, rt (rd = rs if rt == 0)
        if (rd !== 0 && this.regs[rt] === 0) {
          this.regs[rd] = this.regs[rs];
        }
        break;
      case 0x0c: // SYSCALL
        {
          const a0 = this.regs[4] >>> 0;
          const a1 = this.regs[5] >>> 0;
          const a2 = this.regs[6] >>> 0;
          const a3 = this.regs[7] >>> 0;
          const t1 = this.regs[9] >>> 0;
          const ra = this.regs[31] >>> 0;

          if (this.onSyscall) {
            this.onSyscall(currentPc, 'syscall', [a0, a1, a2, a3]);
          }

          // Trigger trace for next 20 instructions around stall/syscall
          this.postSyscallTraceRemaining = 20;

          const bev = (this.cop0Regs[12] & (1 << 22)) !== 0;
          const targetVector = bev ? 0xbfc00180 : 0x80000080;
          const vectorFirstInstr = this.memory.read32(targetVector);
          const hasInstalledVector = bev || (vectorFirstInstr !== 0 && vectorFirstInstr !== 0xffffffff && vectorFirstInstr !== 0x0000000c && vectorFirstInstr !== 0x401a7000);

          if (!hasInstalledVector && this.hleBiosEnabled) {
            // Clean HLE fallback ONLY when running in Direct HLE mode (Branch B)
            const res = HleBiosDispatcher.dispatchSyscall(this, this.memory, currentPc);
            const logMsg = `[HLE SYSCALL] Code 0x${res.fnId.toString(16).toUpperCase()} (${res.serviceName}) from ${res.sourceReg}=0x${res.fnId.toString(16).toUpperCase()} -> $v0=0x${this.regs[2].toString(16).toUpperCase()}`;
            if (this.memory.onLog) {
              this.memory.onLog('bios', logMsg, currentPc);
            }

            // Advance PC past the SYSCALL instruction and increment EPC to avoid infinite exception loop
            this.epc = (currentPc + 4) >>> 0;
            this.cop0Regs[14] = (currentPc + 4) >>> 0;
            this.pc = (currentPc + 4) >>> 0;
            this.nextPc = (this.pc + 4) >>> 0;
            this.inDelaySlot = false;
            this.branchPending = false;
            this.exceptionTriggeredInStep = true;
            this.executeRfe();
            break;
          }

          this.triggerException(8, currentPc, wasDelaySlot);
          break;
        }
      case 0x0d: // BREAK
        {
          const bev = (this.cop0Regs[12] & (1 << 22)) !== 0;
          const targetVector = bev ? 0xbfc00180 : 0x80000080;
          const vectorFirstInstr = this.memory.read32(targetVector);
          const hasInstalledVector = bev || (vectorFirstInstr !== 0 && vectorFirstInstr !== 0xffffffff && vectorFirstInstr !== 0x401a7000);

          if (!hasInstalledVector) {
            if (this.memory.onLog) {
              this.memory.onLog('warn', `[MIPS BREAK] Handled BREAK opcode at PC: 0x${currentPc.toString(16).toUpperCase()} - skipping to next instruction`, currentPc);
            }
            this.pc = (currentPc + 4) >>> 0;
            this.nextPc = (this.pc + 4) >>> 0;
            this.inDelaySlot = false;
            this.branchPending = false;
            this.exceptionTriggeredInStep = true;
          } else {
            this.triggerException(9, currentPc, wasDelaySlot);
          }
        }
        break;
      case 0x10: // MFHI
        this.regs[rd] = this.hi >>> 0;
        break;
      case 0x11: // MTHI
        this.hi = this.regs[rs] >>> 0;
        break;
      case 0x12: // MFLO
        this.regs[rd] = this.lo >>> 0;
        break;
      case 0x13: // MTLO
        this.lo = this.regs[rs] >>> 0;
        break;
      case 0x18: // MULT
        {
          const a = BigInt(this.regs[rs] | 0);
          const b = BigInt(this.regs[rt] | 0);
          const res = a * b;
          this.lo = Number(BigInt.asUintN(32, res)) >>> 0;
          this.hi = Number(BigInt.asUintN(32, res >> 32n)) >>> 0;
        }
        break;
      case 0x19: // MULTU
        {
          const a = BigInt(this.regs[rs] >>> 0);
          const b = BigInt(this.regs[rt] >>> 0);
          const res = a * b;
          this.lo = Number(BigInt.asUintN(32, res)) >>> 0;
          this.hi = Number(BigInt.asUintN(32, res >> 32n)) >>> 0;
        }
        break;
      case 0x1a: // DIV
        {
          const num = this.regs[rs] | 0;
          const den = this.regs[rt] | 0;
          if (den === 0) {
            this.hi = num >>> 0;
            this.lo = (num < 0 ? 1 : 0xffffffff) >>> 0;
          } else if (num === -0x80000000 && den === -1) {
            this.lo = 0x80000000 >>> 0;
            this.hi = 0;
          } else {
            this.lo = ((num / den) | 0) >>> 0;
            this.hi = ((num % den) | 0) >>> 0;
          }
        }
        break;
      case 0x1b: // DIVU
        {
          const num = this.regs[rs] >>> 0;
          const den = this.regs[rt] >>> 0;
          if (den === 0) {
            this.hi = num >>> 0;
            this.lo = 0xffffffff;
          } else {
            this.lo = Math.floor(num / den) >>> 0;
            this.hi = (num % den) >>> 0;
          }
        }
        break;
      case 0x1f: {
        // MIPS hint / SDK barrier or undefined special op - safe to treat as NOP
        break;
      }
      case 0x20: // ADD
      case 0x21: // ADDU
        this.regs[rd] = (this.regs[rs] + this.regs[rt]) >>> 0;
        break;
      case 0x22: // SUB
      case 0x23: // SUBU
        this.regs[rd] = (this.regs[rs] - this.regs[rt]) >>> 0;
        break;
      case 0x24: // AND
        this.regs[rd] = (this.regs[rs] & this.regs[rt]) >>> 0;
        break;
      case 0x25: // OR
        this.regs[rd] = (this.regs[rs] | this.regs[rt]) >>> 0;
        break;
      case 0x26: // XOR
        this.regs[rd] = (this.regs[rs] ^ this.regs[rt]) >>> 0;
        break;
      case 0x27: // NOR
        this.regs[rd] = (~(this.regs[rs] | this.regs[rt])) >>> 0;
        break;
      case 0x28: // SPECIAL funct 0x28
        // Treat as NOP or log and skip gracefully to allow pipeline recovery
        if (this.memory.onLog) {
          this.memory.onLog('warn', `[SPECIAL 0x28 NOP] Skipped special funct 0x28 at PC: 0x${currentPc.toString(16).toUpperCase()}`, currentPc);
        }
        break;
      case 0x2a: // SLT
        this.regs[rd] = ((this.regs[rs] | 0) < (this.regs[rt] | 0)) ? 1 : 0;
        break;
      case 0x2b: // SLTU
        this.regs[rd] = (this.regs[rs] >>> 0 < this.regs[rt] >>> 0) ? 1 : 0;
        break;
      case 0x30:
      case 0x38:
      case 0x39:
      case 0x3a: // funct 0x3a (unassigned MIPS I slot / 64-bit DSRA) - clean non-fatal NOP
      case 0x3b:
      case 0x3c:
      case 0x3d:
      case 0x3e:
      case 0x3f:
        // Silent NOPs to allow clean pipeline execution
        break;
      default: {
        const warning = `[CPU SPECIAL] Unimplemented funct 0x${funct.toString(16)} at PC: 0x${currentPc.toString(16).toUpperCase()} - treating as NOP`;
        console.warn(warning);
        if (this.memory.onLog) {
          this.memory.onLog('warn', warning, currentPc);
        }
        break;
      }
    }
  }

  private executeCop0(rs: number, rt: number, rd: number, funct: number, opcode: number, currentPc: number, wasDelaySlot: boolean): void {
    if (rs === 0x00) { // MFC0: Move From Coprocessor 0 (rt = COP0[rd])
      let val = 0;
      switch (rd) {
        case 3: val = this.cop0Regs[3]; break; // BPC
        case 5: val = this.cop0Regs[5]; break; // BDA
        case 6: val = this.cop0Regs[6]; break; // TAR
        case 7: val = this.cop0Regs[7]; break; // DCIC
        case 8: val = this.badVAddr; break;
        case 9: val = this.cop0Regs[9]; break; // BDAM
        case 11: val = this.cop0Regs[11]; break; // BPCM
        case 12: val = this.cop0Regs[12]; break; // Status Register (SR)
        case 13: val = this.cop0Regs[13]; break; // Cause Register
        case 14: val = this.cop0Regs[14]; break; // Exception PC (EPC)
        case 15: val = this.prid; break; // Processor ID (PRID)
        default:
          val = this.cop0Regs[rd] || 0;
          break;
      }
      this.regs[rt] = val >>> 0;
      this.regs[0] = 0;
    } else if (rs === 0x02) { // CFC0: Move Control From Coprocessor 0
      this.regs[rt] = (this.cop0Regs[rd] || 0) >>> 0;
      this.regs[0] = 0;
    } else if (rs === 0x04) { // MTC0: Move To Coprocessor 0 (COP0[rd] = CPU general register this.regs[rt])
      const val = this.regs[rt] >>> 0;
      this.cop0Regs[rd] = val;
      switch (rd) {
        case 3: this.cop0Regs[3] = val; break;
        case 5: this.cop0Regs[5] = val; break;
        case 6: this.cop0Regs[6] = val; break;
        case 7: this.cop0Regs[7] = val; break;
        case 8:
          this.badVAddr = val;
          this.cop0Regs[8] = val;
          break;
        case 9: this.cop0Regs[9] = val; break;
        case 11: this.cop0Regs[11] = val; break;
        case 12: // Status Register (SR)
          this.cop0Regs[12] = val >>> 0;
          this.memory.isCacheIsolated = (this.cop0Regs[12] & 0x00010000) !== 0;
          this.checkInterrupts();
          break;
        case 13: // Cause Register
          // Software interrupt bits 8, 9 writable
          this.cop0Regs[13] = (((this.cop0Regs[13] & ~0x0300) | (val & 0x0300))) >>> 0;
          break;
        case 14: // Exception PC (EPC)
          this.cop0Regs[14] = val;
          break;
        default:
          this.cop0Regs[rd] = val;
          break;
      }
    } else if (rs === 0x06) { // CTC0: Move Control To Coprocessor 0
      const val = this.regs[rt] >>> 0;
      this.cop0Regs[rd] = val;
      if (rd === 12) {
        this.memory.isCacheIsolated = (this.cop0Regs[12] & 0x00010000) !== 0;
        this.checkInterrupts();
      }
    } else if ((rs === 0x10 && funct === 0x10) || opcode === 0x42000010 || (opcode & 0x0200003F) === 0x02000010 || (funct === 0x10 && (opcode & 0xFE000000) === 0x42000000)) { // RFE (Return From Exception)
      this.justReturnedFromException = true;
      this.interruptInhibitInstructions = 0;
      this.executeRfe();
    } else {
      const warning = `[COP0] Unhandled COP0 operation rs=0x${rs.toString(16)} funct=0x${funct.toString(16)} (instruction 0x${opcode.toString(16).padStart(8, '0')}) at PC: 0x${currentPc.toString(16).toUpperCase()} - treating as NOP`;
      console.warn(warning);
      if (this.memory.onLog) {
        this.memory.onLog('warn', warning, currentPc);
      }
    }
  }

  public fastForwardSplash(): void {
    const counterAddr = 0x801FFD4C;
    this.memory.write32(counterAddr, 0x0001);
    this.regs[24] = 0x0001; // $t8
    this.regs[25] = 0x0001; // $t9
  }
}