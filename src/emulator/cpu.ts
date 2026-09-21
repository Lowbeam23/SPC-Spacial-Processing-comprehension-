/**
 * PlayStation 1 MIPS R3000A CPU Core (32-bit RISC)
 * Compliant Little-Endian execution with accurate exception handling,
 * delay-slot pipelining, and COP0 system control.
 */

import { Memory } from './memory';
import { Gte } from './gte';
import { CpuState, MIPS_REGISTER_NAMES } from '../types';
import { disassemble } from './disassembler';
import { logWarnRateLimited, logErrorRateLimited } from './logger';

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
  public lastLoggedVblank: number = -1;
  public postSyscallTraceRemaining: number = 0;
  public gteOpCount: number = 0;
  public syscallTrapCount: number = 0;
  public biosVectorTrapCount: number = 0;
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

  public get cop0() {
    const self = this;
    return {
      get status(): number { return self.cop0Regs[12] >>> 0; },
      set status(val: number) {
        const uval = val >>> 0;
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
    const status = this.cop0Regs[12];
    const mode = status & 0x3F;
    this.cop0Regs[12] = (((status & ~0x0F) | (mode >> 2))) >>> 0;
    this.memory.isCacheIsolated = (this.cop0Regs[12] & 0x00010000) !== 0;
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

    // If master interrupt enable is set and any motherboard IRQ is unmasked:
    if (iec && hardwarePending && (im2Enabled || (this.cop0Regs[12] & 0xFF00) === 0)) {
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

    if (currentPc === 0x80069570 || currentPc === 0x80069574) {
      const opc = this.memory.read32(currentPc);
      let disasm = '';
      try {
        disasm = disassemble(currentPc, opc).assembly;
      } catch {
        disasm = 'unknown';
      }
      const printReg = (num: number) => `0x${(this.regs[num] >>> 0).toString(16).padStart(8, '0').toUpperCase()}`;
      const logMsg = `[JUMP SITE DIAGNOSTIC at 0x${currentPc.toString(16).toUpperCase()}]:\n` +
        `  Instruction: ${disasm} (Opcode: 0x${opc.toString(16).padStart(8, '0').toUpperCase()})\n` +
        `  $v0: ${printReg(2)} | $v1: ${printReg(3)}\n` +
        `  $a0: ${printReg(4)} | $a1: ${printReg(5)} | $a2: ${printReg(6)} | $a3: ${printReg(7)}\n` +
        `  $t0: ${printReg(8)} | $t1: ${printReg(9)} | $t2: ${printReg(10)} | $t3: ${printReg(11)}\n` +
        `  $t4: ${printReg(12)} | $t5: ${printReg(13)} | $t6: ${printReg(14)} | $t7: ${printReg(15)}\n` +
        `  $t8: ${printReg(24)} | $t9: ${printReg(25)}\n` +
        `  $s0: ${printReg(16)} | $s1: ${printReg(17)} | $s2: ${printReg(18)} | $s3: ${printReg(19)}\n` +
        `  $gp: ${printReg(28)} | $sp: ${printReg(29)} | $fp: ${printReg(30)} | $ra: ${printReg(31)}`;
      
      console.log(logMsg);
      if (this.memory.onLog) {
        this.memory.onLog('system', logMsg, currentPc);
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
              this.regs[rt] = this.gte ? this.gte.readDataRegister(rd) : 0;
              this.regs[0] = 0;
              break;
            case 0x02: // CFC2 rt, rd (Move from GTE control register)
              this.regs[rt] = this.gte ? this.gte.readControlRegister(rd) : 0;
              this.regs[0] = 0;
              break;
            case 0x04: // MTC2 rt, rd (Move to GTE data register)
              if (this.gte) {
                this.gte.writeDataRegister(rd, this.regs[rt]);
              }
              break;
            case 0x06: // CTC2 rt, rd (Move to GTE control register)
              if (this.gte) {
                this.gte.writeControlRegister(rd, this.regs[rt]);
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

      case 0x32: { // LWC2 rt, offset(rs)
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

      case 0x33: { // LWC3 load stub
        break; // Non-fatal NOP
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
        this.triggerBranch(this.regs[rs] >>> 0);
        break;
      case 0x09: // JALR
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
          const v0 = this.regs[2];
          const a0 = this.regs[4];
          const a1 = this.regs[5];
          const a2 = this.regs[6];
          const a3 = this.regs[7];
          const t1 = this.regs[9];
          const ra = this.regs[31] >>> 0;

          if (this.onSyscall) {
            this.onSyscall(currentPc, 'syscall', [a0, a1, a2, a3]);
          }

          // Trigger trace for next 20 instructions around stall/syscall
          this.postSyscallTraceRemaining = 20;

          // Check if this is a BIOS syscall dispatcher / kernel vector call
          // (e.g. at 0xA004E45C / physical 0x0004E45C with $ra: 0xE10 for Event/Thread management,
          // or standard MIPS syscalls: EnterCriticalSection, ExitCriticalSection, ChangeThread)
          const maskedPc = (currentPc & 0x1fffffff) >>> 0;
          const isBiosSyscallDispatcher =
            maskedPc === 0x0004e45c ||
            currentPc === 0xa004e45c ||
            ra === 0x0e10 ||
            (ra >= 0x00000b00 && ra <= 0x00001200);

          const bev = (this.cop0Regs[12] & (1 << 22)) !== 0;
          const targetVector = bev ? 0xbfc00180 : 0x80000080;
          const vectorFirstInstr = this.memory.read32(targetVector);
          const hasInstalledVector = vectorFirstInstr !== 0 && vectorFirstInstr !== 0xffffffff;

          if (isBiosSyscallDispatcher || !hasInstalledVector || a0 === 1 || a0 === 2 || a0 === 3) {
            // Clean return from syscall dispatcher
            if (a0 === 1) {
              // EnterCriticalSection: disable interrupts, return previous SR in $v0
              const oldSr = this.cop0Regs[12];
              this.cop0Regs[12] &= ~1;
              this.regs[2] = (oldSr & 1);
            } else if (a0 === 2) {
              // ExitCriticalSection: enable interrupts
              this.cop0Regs[12] |= 1;
              this.regs[2] = 1;

              // Check if this is actually a TestEvent/CheckEvent event polling syscall
              if (a3 === 0x2a) {
                let resolvedEvAddr = 0;
                const a1_masked = a1 & 0x1fffff;
                if (a1_masked >= 0x80 && a1_masked < 0x200000 - 24) {
                  resolvedEvAddr = a1_masked;
                }
                const eventTablePtr = this.memory.read32(0x00000080) & 0x1fffff;
                if (!resolvedEvAddr && eventTablePtr >= 0x80 && eventTablePtr < 0x200000 - 24) {
                  if (a1 >= 0 && a1 < 32) {
                    // Try 32-byte stride first
                    resolvedEvAddr = eventTablePtr + a1 * 32;
                    if (this.memory.read32(resolvedEvAddr) === 0) {
                      resolvedEvAddr = eventTablePtr + a1 * 20;
                    }
                  } else {
                    // Scan the event table for a matching event using both strides
                    for (let i = 0; i < 32; i++) {
                      const addr32 = eventTablePtr + i * 32;
                      if (addr32 < 0x200000 - 24 && this.memory.read32(addr32) === a1) {
                        resolvedEvAddr = addr32;
                        break;
                      }
                      const addr20 = eventTablePtr + i * 20;
                      if (addr20 < 0x200000 - 24 && this.memory.read32(addr20) === a1) {
                        resolvedEvAddr = addr20;
                        break;
                      }
                    }
                  }
                }

                if (resolvedEvAddr) {
                  const evClass = this.memory.read32(resolvedEvAddr);
                  const isCdrom = (evClass === 0xF0000003) || (evClass === 0xF4000003) || ((evClass & 0xFF) === 3);
                  const isTimer = (evClass === 0xF0000001) || (evClass === 0xF4000001) || ((evClass & 0xFF) === 1);
                  if (isCdrom || isTimer) {
                    this.regs[2] = 1; // Return 1 in $v0
                    this.memory.write32(resolvedEvAddr + 4, 0); // Mark status as processed (status = 0)
                    console.log(`[SYSCALL 0x2A] TestEvent matched ${isCdrom ? 'CD-ROM' : 'Timer'} event at 0x${resolvedEvAddr.toString(16)}. Returning 1 and status=0.`);
                  }
                }
              }
            } else if (a0 === 3) {
              // ChangeThreadSubFunction
              this.regs[2] = 0;
            } else {
              // Event / Thread management syscall at 0xA004E45C / 0xE10
              this.regs[2] = 1; // Return success in $v0
            }

            // Restore / preserve $ra so return cleanly reaches caller
            if (ra === 0x0e10) {
              this.regs[31] = 0x0e10;
            }

            // Advance PC past the SYSCALL instruction (PC = EPC + 4) so it does not loop
            this.epc = currentPc >>> 0;
            this.cop0Regs[14] = (currentPc + 4) >>> 0;
            this.pc = (currentPc + 4) >>> 0;
            this.nextPc = (this.pc + 4) >>> 0;
            this.inDelaySlot = false;
            this.branchPending = false;
            this.exceptionTriggeredInStep = true;

            if (this.memory.onLog) {
              this.memory.onLog(
                'bios',
                `[BIOS SYSCALL DISPATCHER] Clean return from syscall at 0x${currentPc.toString(16).toUpperCase()} (EPC: 0x${this.epc.toString(16).toUpperCase()}, $ra: 0x${this.regs[31].toString(16).toUpperCase()}, $a0: 0x${a0.toString(16)}, $v0: 0x${this.regs[2].toString(16)}) -> resumed at PC: 0x${this.pc.toString(16).toUpperCase()}`,
                currentPc
              );
            }
            break;
          }

          this.triggerException(8, currentPc, wasDelaySlot);
          break;
        }
      case 0x0d: // BREAK
        this.triggerException(9, currentPc, wasDelaySlot);
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
      case 0x3d:
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
