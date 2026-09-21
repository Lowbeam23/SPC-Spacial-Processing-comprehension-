/**
 * MIPS Dynamic Recompiler (JIT) with Line-by-Line Backup Interpreter
 */

import { Cpu } from './cpu';
import { Memory } from './memory';
import { disassemble } from './disassembler';

export interface CompiledBlock {
  pc: number;
  instructionCount: number;
  cycleCount: number;
  fn: (cpu: Cpu, mem: Memory) => number; // returns next PC
  jsCode: string;
}

export class Recompiler {
  private blockCache: Map<number, CompiledBlock> = new Map();
  private ramBlocks: (CompiledBlock | undefined)[] = new Array(524288);
  private biosBlocks: (CompiledBlock | undefined)[] = new Array(131072);
  public blocksCompiled: number = 0;
  public jitHits: number = 0;
  public fallbackHits: number = 0;

  // Track RAM block address range bounds to avoid cache iteration on BSS/data RAM writes
  private ramBlockCount: number = 0;
  private minRamBlockAddr: number = 0xFFFFFFFF;
  private maxRamBlockAddr: number = 0x00000000;

  // Compilation rate tracking (blocks generated per second)
  public blocksCompiledPerSec: number = 0;
  private blocksCompiledCurrentSec: number = 0;
  private lastSecTimestamp: number = Date.now();
  private compileLogCount: number = 0;

  private blockExitLogCount: number = 0;

  public clearCache(): void {
    this.blockCache.clear();
    this.ramBlocks.fill(undefined);
    this.biosBlocks.fill(undefined);
    this.ramBlockCount = 0;
    this.minRamBlockAddr = 0xFFFFFFFF;
    this.maxRamBlockAddr = 0x00000000;
    this.blocksCompiled = 0;
    this.blocksCompiledPerSec = 0;
    this.blocksCompiledCurrentSec = 0;
    this.lastSecTimestamp = Date.now();
    this.jitHits = 0;
    this.fallbackHits = 0;
    this.compileLogCount = 0;
    this.blockExitLogCount = 0;
  }

  private recalculateRamBlockBounds(): void {
    let min = 0xFFFFFFFF;
    let max = 0;
    let count = 0;
    for (const [blockKey, block] of this.blockCache.entries()) {
      if (blockKey < 0x00200000) {
        count++;
        if (blockKey < min) min = blockKey;
        const end = blockKey + block.instructionCount * 4;
        if (end > max) max = end;
      }
    }
    this.ramBlockCount = count;
    this.minRamBlockAddr = min;
    this.maxRamBlockAddr = max;
  }

  /**
   * Invalidate cached blocks overlapping the given physical address.
   * Strictly restricts invalidation to executable RAM space (0x00000000..0x001FFFFF).
   * Fast O(1) exit when no RAM blocks exist or writes fall outside cached RAM block range.
   */
  public invalidationsSecCounter: number = 0;
  private lastInvalidationLogTime: number = performance.now();

  public checkInvalidationLogger(): void {
    // const now = performance.now();
    // if (now - this.lastInvalidationLogTime >= 1000) {
    //   console.log(`[JIT INVALIDATIONS/SEC]: ${this.invalidationsSecCounter}`);
    //   this.invalidationsSecCounter = 0;
    //   this.lastInvalidationLogTime = now;
    // }
  }

  public invalidateAddress(vaddr: number, length: number = 4): void {
    const physAddr = (vaddr & 0x001FFFFF) >>> 0;
    if (this.ramBlockCount === 0) {
      return;
    }

    const startIdx = physAddr >>> 2;
    const endIdx = (physAddr + length + 3) >>> 2;
    let deletedAny = false;
    for (let i = startIdx; i < endIdx && i < 524288; i++) {
      if (this.ramBlocks[i]) {
        this.ramBlocks[i] = undefined;
        deletedAny = true;
      }
    }

    if (deletedAny) {
      this.invalidationsSecCounter++;
    }
  }

  /**
   * Execute instructions starting at cpu.pc
   * Returns cycles executed
   */
  public stepBlock(cpu: Cpu, memory: Memory, forceInterpreter: boolean = false): number {
    // Check pending hardware interrupts before executing block
    if (cpu.checkInterrupts()) {
      return 2;
    }

    if (forceInterpreter) {
      this.fallbackHits++;
      return cpu.step();
    }

    const pc = cpu.pc >>> 0;
    if (pc === 0 || (pc & 0x1FFFFFFF) === 0) {
      if (!cpu.halted) {
        cpu.halted = true;
        console.error(`[JUMP TO ZERO TRAP HALT] Attempted step at PC: 0x0`);
      }
      return 0;
    }

    if (!cpu.isInstructionFetchMapped(pc)) {
      return cpu.step();
    }

    const physKey = (pc & 0x1FFFFFFF) >>> 0;
    let block: CompiledBlock | undefined;

    if (physKey < 0x00200000) {
      block = this.ramBlocks[physKey >>> 2];
    } else if (physKey >= 0x1FC00000 && physKey < 0x1FC80000) {
      block = this.biosBlocks[(physKey - 0x1FC00000) >>> 2];
    } else {
      block = this.blockCache.get(physKey);
    }

    if (!block) {
      block = this.compileBlock(pc, memory);
      if (block) {
        if (physKey < 0x00200000) {
          this.ramBlocks[physKey >>> 2] = block;
          this.ramBlockCount++;
        } else if (physKey >= 0x1FC00000 && physKey < 0x1FC80000) {
          this.biosBlocks[(physKey - 0x1FC00000) >>> 2] = block;
        } else {
          this.blockCache.set(physKey, block);
        }
        this.blocksCompiled++;
      }
    }

    if (block) {
      try {
        this.jitHits++;
        const nextPc = (block.fn(cpu, memory)) >>> 0;

        // Fall back to interpreter if block execution returned an invalid target or 0xFFFFFFFF
        if (nextPc === 0xFFFFFFFF || nextPc === 0) {
          if (nextPc === 0) {
            if (!cpu.halted) {
              cpu.halted = true;
              const ra = cpu.regs[31] >>> 0;
              const k0 = cpu.regs[26] >>> 0;
              const k1 = cpu.regs[27] >>> 0;
              const epc = cpu.cop0Regs[14] >>> 0;
              console.error(`[JUMP TO ZERO TRAP HALT] Block at 0x${pc.toString(16)} returned nextPc: 0x0 | ra: 0x${ra.toString(16)} | k0: 0x${k0.toString(16)} | k1: 0x${k1.toString(16)} | EPC: 0x${epc.toString(16)}`);
              if (ra >= 0x80000000 && ra < 0x80200000) {
                console.error(`[JUMP TO ZERO DIAGNOSTIC] Code near $ra (0x${ra.toString(16)}):`);
                for (let addr = ra - 16; addr <= ra + 8; addr += 4) {
                  const op = memory.read32(addr);
                  console.error(`  0x${addr.toString(16)}: 0x${op.toString(16).padStart(8, '0')}`);
                }
              }
            }
            return 0;
          }
          this.fallbackHits++;
          return cpu.step();
        }

        let virtPc = nextPc;
        if (virtPc < 0x80000000) {
          virtPc = (virtPc & 0x001FFFFF) >>> 0;
        }
        const physAddr = (virtPc & 0x1FFFFFFF) >>> 0;
        // Keep cpu.pc strictly in virtual address space (0xBFCxxxxx for BIOS or 0x80xxxxxx for KSEG0)
        if (physAddr >= 0x1FC00000 && physAddr <= 0x1FC7FFFF) {
          virtPc = (physAddr | 0xA0000000) >>> 0;
        } else if (physAddr < 0x00200000 && virtPc < 0x80000000) {
          virtPc = (physAddr | 0x80000000) >>> 0;
        }

        cpu.pc = virtPc;
        cpu.nextPc = (virtPc + 4) >>> 0;
        cpu.regs[0] = 0; // enforce $zero = 0
        cpu.instructionsExecuted += block.instructionCount;
        const cyclesToReturn = Math.max(block.cycleCount, block.instructionCount, 1);
        cpu.cycles += cyclesToReturn;

        const physExecuted = (pc & 0x1FFFFFFF) >>> 0;
        // if (physExecuted === 0x1FC00290 || physExecuted === 0x1FC002A0 || this.blockExitLogCount < 20) {
        //   this.blockExitLogCount++;
        //   console.log(`[BLOCK EXIT] executed PC: 0x${pc.toString(16)}, next PC set to: 0x${cpu.pc.toString(16)}`);
        // }

        return cyclesToReturn;
      } catch (err) {
        // Fallback safely to interpreter if compiled block hits an error
        this.fallbackHits++;
        return cpu.step();
      }
    } else {
      // Fallback: Line-by-line interpreter
      this.fallbackHits++;
      return cpu.step();
    }
  }

  /**
   * Translates a sequence of MIPS instructions into a compiled JS function
   */
  public compileBlock(startPc: number, memory: Memory): CompiledBlock | null {
    const physStart = startPc & 0x1FFFFFFF;
    if ((physStart >= 0x0005A080 && physStart <= 0x0005A08C) ||
        (physStart >= 0x0005A760 && physStart <= 0x0005A790) ||
        (physStart >= 0x000045C0 && physStart <= 0x000045D8)) {
      return null;
    }

    // if (startPc > 0xbfc00328 && startPc < 0xbfc10000) {
    //   console.log(`[POST-BSS COMPILE] PC: 0x${startPc.toString(16)}`);
    // }

    const lines: string[] = [];
    lines.push('const r = cpu.r32;');
    lines.push('const m = mem;');
    lines.push('const ram = m.ram;');
    lines.push('const ram32 = m.ram32;');
    lines.push('r[0] = 0;');

    let currentPc = startPc >>> 0;
    // Normalize currentPc to virtual space if passed a physical BIOS address
    if (currentPc < 0x80000000) {
      const phys = (currentPc & 0x1FFFFFFF) >>> 0;
      if (phys >= 0x1FC00000 && phys <= 0x1FC7FFFF) {
        currentPc = (phys | 0xA0000000) >>> 0;
      }
    }

    let instructionCount = 0;
    let totalCycles = 0;
    const maxInstructions = 48; // Max block length
    let terminated = false;
    let nextTargetExpression: string | null = null;

    while (instructionCount < maxInstructions && !terminated) {
      const physCurrent = (currentPc & 0x1FFFFFFF) >>> 0;
      if (physCurrent >= 0x000045C0 && physCurrent <= 0x000045D8) {
        return null;
      }

      const opcode = memory.read32(currentPc);
      instructionCount++;
      totalCycles += Cpu.getInstructionCycles(opcode);

      const op = (opcode >>> 26) & 0x3f;
      const rs = (opcode >>> 21) & 0x1f;
      const rt = (opcode >>> 16) & 0x1f;
      const rd = (opcode >>> 11) & 0x1f;
      const shamt = (opcode >>> 6) & 0x1f;
      const funct = opcode & 0x3f;
      const imm16 = opcode & 0xffff;
      const simm16 = (imm16 << 16) >> 16;
      const target = (opcode & 0x03ffffff) << 2;

      // Handle simple instructions
      switch (op) {
        case 0x00: // SPECIAL
          switch (funct) {
            case 0x00: // SLL / NOP
              if (opcode !== 0) {
                lines.push(`r[${rd}] = (r[${rt}] << ${shamt}) >>> 0;`);
              }
              break;
            case 0x01: // SPECIAL funct 0x01: Compiler-generated branch hint / NOP
              break;
            case 0x02: // SRL
              lines.push(`r[${rd}] = (r[${rt}] >>> ${shamt}) >>> 0;`);
              break;
            case 0x03: // SRA
              lines.push(`r[${rd}] = ((r[${rt}] | 0) >> ${shamt}) >>> 0;`);
              break;
            case 0x04: // SLLV
              lines.push(`r[${rd}] = (r[${rt}] << (r[${rs}] & 0x1f)) >>> 0;`);
              break;
            case 0x06: // SRLV
              lines.push(`r[${rd}] = (r[${rt}] >>> (r[${rs}] & 0x1f)) >>> 0;`);
              break;
            case 0x07: // SRAV
              lines.push(`r[${rd}] = ((r[${rt}] | 0) >> (r[${rs}] & 0x1f)) >>> 0;`);
              break;
            case 0x08: // JR
              {
                // Capture target register value BEFORE executing delay slot
                lines.push(`let target_${instructionCount} = r[${rs}] >>> 0;`);
                lines.push(`if (target_${instructionCount} < 0x80000000) { target_${instructionCount} = (target_${instructionCount} & 0x001FFFFF) >>> 0; }`);
                lines.push(`else if ((target_${instructionCount} & 0x1FFFFFFF) >= 0x1FC00000 && (target_${instructionCount} & 0x1FFFFFFF) <= 0x1FC7FFFF) { target_${instructionCount} = ((target_${instructionCount} & 0x1FFFFFFF) | 0xA0000000) >>> 0; }`);
                totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
                nextTargetExpression = `target_${instructionCount}`;
                terminated = true;
                instructionCount++;
              }
              break;
            case 0x09: // JALR
              {
                // Capture target register value BEFORE link register assignment & delay slot
                lines.push(`let target_${instructionCount} = r[${rs}] >>> 0;`);
                lines.push(`if (target_${instructionCount} < 0x80000000) { target_${instructionCount} = (target_${instructionCount} & 0x001FFFFF) >>> 0; }`);
                lines.push(`else if ((target_${instructionCount} & 0x1FFFFFFF) >= 0x1FC00000 && (target_${instructionCount} & 0x1FFFFFFF) <= 0x1FC7FFFF) { target_${instructionCount} = ((target_${instructionCount} & 0x1FFFFFFF) | 0xA0000000) >>> 0; }`);
                if (rd !== 0) {
                  lines.push(`r[${rd}] = ${(currentPc + 8) >>> 0};`);
                }
                totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
                nextTargetExpression = `target_${instructionCount}`;
                terminated = true;
                instructionCount++;
              }
              break;
            case 0x0c: // SYSCALL
              lines.push(`cpu.executeOpcode(${opcode}, ${currentPc});`);
              nextTargetExpression = `cpu.pc`;
              terminated = true;
              break;
            case 0x0d: // BREAK
              lines.push(`cpu.triggerException(9, ${currentPc});`);
              nextTargetExpression = `cpu.pc`;
              terminated = true;
              break;
            case 0x10: // MFHI
              lines.push(`r[${rd}] = cpu.hi;`);
              break;
            case 0x11: // MTHI
              lines.push(`cpu.hi = r[${rs}] >>> 0;`);
              break;
            case 0x12: // MFLO
              lines.push(`r[${rd}] = cpu.lo;`);
              break;
            case 0x13: // MTLO
              lines.push(`cpu.lo = r[${rs}] >>> 0;`);
              break;
            case 0x18: // MULT
              lines.push(`{ const prod = BigInt(r[${rs}] | 0) * BigInt(r[${rt}] | 0); cpu.lo = Number(prod & 0xFFFFFFFFn) >>> 0; cpu.hi = Number((prod >> 32n) & 0xFFFFFFFFn) >>> 0; }`);
              break;
            case 0x19: // MULTU
              lines.push(`{ const prod = BigInt(r[${rs}] >>> 0) * BigInt(r[${rt}] >>> 0); cpu.lo = Number(prod & 0xFFFFFFFFn) >>> 0; cpu.hi = Number((prod >> 32n) & 0xFFFFFFFFn) >>> 0; }`);
              break;
            case 0x1a: // DIV
              lines.push(`{ const s1 = r[${rs}] | 0; const s2 = r[${rt}] | 0; if (s2 !== 0) { cpu.lo = (s1 / s2) | 0; cpu.hi = (s1 % s2) | 0; } }`);
              break;
            case 0x1b: // DIVU
              lines.push(`{ const u1 = r[${rs}] >>> 0; const u2 = r[${rt}] >>> 0; if (u2 !== 0) { cpu.lo = Math.floor(u1 / u2) >>> 0; cpu.hi = (u1 % u2) >>> 0; } }`);
              break;
            case 0x20: // ADD
            case 0x21: // ADDU
              lines.push(`r[${rd}] = (r[${rs}] + r[${rt}]) >>> 0;`);
              break;
            case 0x22: // SUB
            case 0x23: // SUBU
              lines.push(`r[${rd}] = (r[${rs}] - r[${rt}]) >>> 0;`);
              break;
            case 0x24: // AND
              lines.push(`r[${rd}] = (r[${rs}] & r[${rt}]) >>> 0;`);
              break;
            case 0x25: // OR
              lines.push(`r[${rd}] = (r[${rs}] | r[${rt}]) >>> 0;`);
              break;
            case 0x26: // XOR
              lines.push(`r[${rd}] = (r[${rs}] ^ r[${rt}]) >>> 0;`);
              break;
            case 0x27: // NOR
              lines.push(`r[${rd}] = (~(r[${rs}] | r[${rt}])) >>> 0;`);
              break;
            case 0x2a: // SLT
              {
                const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
                const valT = rt === 0 ? '0' : `(r[${rt}] | 0)`;
                lines.push(`r[${rd}] = (${valS} < ${valT}) ? 1 : 0;`);
                if (rd === 0) lines.push('r[0] = 0;');
              }
              break;
            case 0x2b: // SLTU
              {
                const valS = rs === 0 ? '0' : `(r[${rs}] >>> 0)`;
                const valT = rt === 0 ? '0' : `(r[${rt}] >>> 0)`;
                lines.push(`r[${rd}] = (${valS} < ${valT}) ? 1 : 0;`);
                if (rd === 0) lines.push('r[0] = 0;');
              }
              break;
            default:
              // Complex or unsupported opcode: abort block compilation, use line-by-line
              return null;
          }
          break;

        case 0x01: // BCOND (BLTZ, BGEZ, BLTZAL, BGEZAL)
          {
            let branchTarget = ((currentPc + 4 + (simm16 << 2)) >>> 0);
            if (branchTarget < 0x80000000) {
              branchTarget = (branchTarget & 0x001FFFFF) >>> 0;
            }
            const fallthrough = (currentPc + 8) >>> 0;
            const bcondType = rt;
            const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
            if (bcondType === 0x00) { // BLTZ
              lines.push(`const taken_${instructionCount} = (${valS} < 0);`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else if (bcondType === 0x01) { // BGEZ
              lines.push(`const taken_${instructionCount} = (${valS} >= 0);`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else if (bcondType === 0x10) { // BLTZAL
              lines.push(`const taken_${instructionCount} = (${valS} < 0);`);
              lines.push(`r[31] = ${fallthrough};`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else if (bcondType === 0x11) { // BGEZAL
              lines.push(`const taken_${instructionCount} = (${valS} >= 0);`);
              lines.push(`r[31] = ${fallthrough};`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else {
              return null;
            }
          }
          break;

        case 0x02: // J
          {
            let jumpTarget = (((currentPc + 4) & 0xf0000000) | target) >>> 0;
            if (jumpTarget < 0x80000000) {
              jumpTarget = (jumpTarget & 0x001FFFFF) >>> 0;
            }
            totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
            nextTargetExpression = `${jumpTarget}`;
            terminated = true;
            instructionCount++;
          }
          break;

        case 0x03: // JAL
          {
            let jumpTarget = (((currentPc + 4) & 0xf0000000) | target) >>> 0;
            if (jumpTarget < 0x80000000) {
              jumpTarget = (jumpTarget & 0x001FFFFF) >>> 0;
            }
            lines.push(`r[31] = ${(currentPc + 8) >>> 0};`);
            totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
            nextTargetExpression = `${jumpTarget}`;
            terminated = true;
            instructionCount++;
          }
          break;

        case 0x04: // BEQ
          {
            let branchTarget = ((currentPc + 4 + (simm16 << 2)) >>> 0);
            if (branchTarget < 0x80000000) {
              branchTarget = (branchTarget & 0x001FFFFF) >>> 0;
            }
            const fallthrough = (currentPc + 8) >>> 0;
            const valS = rs === 0 ? '0' : `r[${rs}]`;
            const valT = rt === 0 ? '0' : `r[${rt}]`;
            lines.push(`const taken_${instructionCount} = (${valS} === ${valT});`);
            totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
            nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
            terminated = true;
            instructionCount++;
          }
          break;

        case 0x05: // BNE
          {
            let branchTarget = ((currentPc + 4 + (simm16 << 2)) >>> 0);
            if (branchTarget < 0x80000000) {
              branchTarget = (branchTarget & 0x001FFFFF) >>> 0;
            }
            const fallthrough = (currentPc + 8) >>> 0;
            const valS = rs === 0 ? '0' : `r[${rs}]`;
            const valT = rt === 0 ? '0' : `r[${rt}]`;
            lines.push(`const taken_${instructionCount} = (${valS} !== ${valT});`);
            totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
            nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
            terminated = true;
            instructionCount++;
          }
          break;

        case 0x06: // BLEZ
          {
            let branchTarget = ((currentPc + 4 + (simm16 << 2)) >>> 0);
            if (branchTarget < 0x80000000) {
              branchTarget = (branchTarget & 0x001FFFFF) >>> 0;
            }
            const fallthrough = (currentPc + 8) >>> 0;
            const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
            lines.push(`const taken_${instructionCount} = (${valS} <= 0);`);
            totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
            nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
            terminated = true;
            instructionCount++;
          }
          break;

        case 0x07: // BGTZ
          {
            let branchTarget = ((currentPc + 4 + (simm16 << 2)) >>> 0);
            if (branchTarget < 0x80000000) {
              branchTarget = (branchTarget & 0x001FFFFF) >>> 0;
            }
            const fallthrough = (currentPc + 8) >>> 0;
            const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
            lines.push(`const taken_${instructionCount} = (${valS} > 0);`);
            totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
            nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
            terminated = true;
            instructionCount++;
          }
          break;

        case 0x08: // ADDI
        case 0x09: // ADDIU
          lines.push(`r[${rt}] = (r[${rs}] + ${simm16}) >>> 0;`);
          if (rt === 0) lines.push('r[0] = 0;');
          break;

        case 0x0a: // SLTI
          {
            const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
            lines.push(`r[${rt}] = (${valS} < ${simm16}) ? 1 : 0;`);
            if (rt === 0) lines.push('r[0] = 0;');
          }
          break;

        case 0x0b: // SLTIU
          {
            const valS = rs === 0 ? '0' : `(r[${rs}] >>> 0)`;
            lines.push(`r[${rt}] = (${valS} < ${simm16 >>> 0}) ? 1 : 0;`);
            if (rt === 0) lines.push('r[0] = 0;');
          }
          break;

        case 0x0c: // ANDI
          lines.push(`r[${rt}] = (r[${rs}] & ${imm16}) >>> 0;`);
          break;

        case 0x0d: // ORI
          lines.push(`r[${rt}] = (r[${rs}] | ${imm16}) >>> 0;`);
          break;

        case 0x0e: // XORI
          lines.push(`r[${rt}] = (r[${rs}] ^ ${imm16}) >>> 0;`);
          break;

        case 0x0f: // LUI
          lines.push(`r[${rt}] = ${(imm16 << 16) >>> 0};`);
          break;

        case 0x20: // LB
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const val = ram[addr & 0x001FFFFF]; r[${rt}] = ((val << 24) >> 24) >>> 0; } else { const val = m.read8(addr >>> 0); r[${rt}] = ((val << 24) >> 24) >>> 0; } }`);
          if (rt === 0) lines.push('r[0] = 0;');
          break;

        case 0x21: // LH
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; const val = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)); r[${rt}] = ((val << 16) >> 16) >>> 0; } else { const val = m.read16(addr >>> 0); r[${rt}] = ((val << 16) >> 16) >>> 0; } }`);
          if (rt === 0) lines.push('r[0] = 0;');
          break;

        case 0x23: // LW
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram32[(addr & 0x001FFFFF) >>> 2]; } else { r[${rt}] = m.read32(addr >>> 0) >>> 0; } }`);
          if (rt === 0) lines.push('r[0] = 0;');
          break;

        case 0x24: // LBU
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram[addr & 0x001FFFFF]; } else { r[${rt}] = m.read8(addr >>> 0) >>> 0; } }`);
          if (rt === 0) lines.push('r[0] = 0;');
          break;

        case 0x25: // LHU
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; r[${rt}] = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)) >>> 0; } else { r[${rt}] = m.read16(addr >>> 0) >>> 0; } }`);
          if (rt === 0) lines.push('r[0] = 0;');
          break;

        case 0x28: // SB
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram[addr & 0x001FFFFF] = r[${rt}] & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 1); } } else { m.write8(addr >>> 0, r[${rt}] & 0xff); } }`);
          break;

        case 0x29: // SH
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { const off = addr & 0x001FFFFF; ram[off] = r[${rt}] & 0xff; ram[(off + 1) & 0x1fffff] = (r[${rt}] >>> 8) & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 2); } } else { m.write16(addr >>> 0, r[${rt}] & 0xffff); } }`);
          break;

        case 0x2b: // SW
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram32[(addr & 0x001FFFFF) >>> 2] = r[${rt}]; if (m.recompiler) m.recompiler.invalidateAddress(addr, 4); } } else { m.write32(addr >>> 0, r[${rt}]); } }`);
          break;

        case 0x10: // COP0 (MTC0, MFC0, RFE)
        case 0x12: // COP2 (GTE)
        case 0x32: // LWC2 (GTE Load)
        case 0x36: // SWC2 (GTE Store)
        case 0x3a: // SWC2 alias
          lines.push(`cpu.executeOpcode(${opcode}, ${currentPc});`);
          break;

        default:
          // Uncompiled opcode (COP, SYSCALL, etc.) -> exit block compilation
          return null;
      }

      currentPc = (currentPc + 4) >>> 0;
    }

    if (!terminated) {
      nextTargetExpression = `${currentPc >>> 0}`;
    }

    lines.push('r[0] = 0;');
    lines.push(`return ${nextTargetExpression};`);

    const fullCode = lines.join('\n');
    try {
      // Create dynamically recompiled function
      const fn = new Function('cpu', 'mem', fullCode) as (cpu: Cpu, mem: Memory) => number;

      // if (this.compileLogCount < 5) {
      //   this.compileLogCount++;
      //   console.log(`[DYNAREC COMPILE] PC: 0x${startPc.toString(16)}, Block Length: ${instructionCount}`);
      // }

      // const physStart = (startPc & 0x1FFFFFFF) >>> 0;
      // if (physStart === 0x1FC00290 || physStart === 0x00000290 || startPc === 0xBFC00290) {
      //   console.log(`[DYNAREC BLOCK 0x290 GENERATED CODE]\n${fullCode}`);
      // }

      return {
        pc: startPc,
        instructionCount,
        cycleCount: totalCycles,
        fn,
        jsCode: fullCode,
      };
    } catch {
      return null;
    }
  }

  private emitDelaySlot(slotPc: number, memory: Memory, lines: string[]): number {
    const opcode = memory.read32(slotPc);
    if (opcode === 0) return 1; // NOP

    const op = (opcode >>> 26) & 0x3f;
    const rs = (opcode >>> 21) & 0x1f;
    const rt = (opcode >>> 16) & 0x1f;
    const rd = (opcode >>> 11) & 0x1f;
    const shamt = (opcode >>> 6) & 0x1f;
    const funct = opcode & 0x3f;
    const imm16 = opcode & 0xffff;
    const simm16 = (imm16 << 16) >> 16;

    if (op === 0x00) {
      if (funct === 0x20 || funct === 0x21) {
        lines.push(`r[${rd}] = (r[${rs}] + r[${rt}]) >>> 0; // delay slot add/addu`);
      } else if (funct === 0x22 || funct === 0x23) {
        lines.push(`r[${rd}] = (r[${rs}] - r[${rt}]) >>> 0; // delay slot sub/subu`);
      } else if (funct === 0x00) {
        lines.push(`r[${rd}] = (r[${rt}] << ${shamt}) >>> 0; // delay slot sll`);
      } else if (funct === 0x02) {
        lines.push(`r[${rd}] = (r[${rt}] >>> ${shamt}) >>> 0; // delay slot srl`);
      } else if (funct === 0x03) {
        lines.push(`r[${rd}] = ((r[${rt}] | 0) >> ${shamt}) >>> 0; // delay slot sra`);
      } else if (funct === 0x24) {
        lines.push(`r[${rd}] = (r[${rs}] & r[${rt}]) >>> 0; // delay slot and`);
      } else if (funct === 0x25) {
        lines.push(`r[${rd}] = (r[${rs}] | r[${rt}]) >>> 0; // delay slot or`);
      } else if (funct === 0x26) {
        lines.push(`r[${rd}] = (r[${rs}] ^ r[${rt}]) >>> 0; // delay slot xor`);
      } else if (funct === 0x27) {
        lines.push(`r[${rd}] = (~(r[${rs}] | r[${rt}])) >>> 0; // delay slot nor`);
      } else if (funct === 0x2a) {
        lines.push(`r[${rd}] = ((r[${rs}] | 0) < (r[${rt}] | 0)) ? 1 : 0; // delay slot slt`);
      } else if (funct === 0x2b) {
        lines.push(`r[${rd}] = (r[${rs}] >>> 0 < r[${rt}] >>> 0) ? 1 : 0; // delay slot sltu`);
      } else {
        lines.push(`cpu.executeOpcode(${opcode}, ${slotPc}, true); // delay slot fallback`);
      }
    } else if (op === 0x08 || op === 0x09) {
      lines.push(`r[${rt}] = (r[${rs}] + ${simm16}) >>> 0; // delay slot addi/addiu`);
    } else if (op === 0x0a) {
      lines.push(`r[${rt}] = ((r[${rs}] | 0) < ${simm16}) ? 1 : 0; // delay slot slti`);
    } else if (op === 0x0b) {
      lines.push(`r[${rt}] = (r[${rs}] >>> 0 < ${simm16 >>> 0}) ? 1 : 0; // delay slot sltiu`);
    } else if (op === 0x0c) {
      lines.push(`r[${rt}] = (r[${rs}] & ${imm16}) >>> 0; // delay slot andi`);
    } else if (op === 0x0d) {
      lines.push(`r[${rt}] = (r[${rs}] | ${imm16}) >>> 0; // delay slot ori`);
    } else if (op === 0x0e) {
      lines.push(`r[${rt}] = (r[${rs}] ^ ${imm16}) >>> 0; // delay slot xori`);
    } else if (op === 0x0f) {
      lines.push(`r[${rt}] = ${(imm16 << 16) >>> 0}; // delay slot lui`);
    } else if (op === 0x20) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const val = ram[addr & 0x001FFFFF]; r[${rt}] = ((val << 24) >> 24) >>> 0; } else { const val = m.read8(addr >>> 0); r[${rt}] = ((val << 24) >> 24) >>> 0; } } // delay slot lb`);
    } else if (op === 0x21) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; const val = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)); r[${rt}] = ((val << 16) >> 16) >>> 0; } else { const val = m.read16(addr >>> 0); r[${rt}] = ((val << 16) >> 16) >>> 0; } } // delay slot lh`);
    } else if (op === 0x23) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram32[(addr & 0x001FFFFF) >>> 2]; } else { r[${rt}] = m.read32(addr >>> 0) >>> 0; } } // delay slot lw`);
    } else if (op === 0x24) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram[addr & 0x001FFFFF]; } else { r[${rt}] = m.read8(addr >>> 0) >>> 0; } } // delay slot lbu`);
    } else if (op === 0x25) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; r[${rt}] = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)) >>> 0; } else { r[${rt}] = m.read16(addr >>> 0) >>> 0; } } // delay slot lhu`);
    } else if (op === 0x28) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram[addr & 0x001FFFFF] = r[${rt}] & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 1); } } else { m.write8(addr >>> 0, r[${rt}] & 0xff); } } // delay slot sb`);
    } else if (op === 0x29) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { const off = addr & 0x001FFFFF; ram[off] = r[${rt}] & 0xff; ram[(off + 1) & 0x1fffff] = (r[${rt}] >>> 8) & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 2); } } else { m.write16(addr >>> 0, r[${rt}] & 0xffff); } } // delay slot sh`);
    } else if (op === 0x2b) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram32[(addr & 0x001FFFFF) >>> 2] = r[${rt}]; if (m.recompiler) m.recompiler.invalidateAddress(addr, 4); } } else { m.write32(addr >>> 0, r[${rt}]); } } // delay slot sw`);
    } else if (op === 0x10) {
      lines.push(`cpu.executeOpcode(${opcode}, ${slotPc}, true); // delay slot COP0`);
    } else {
      lines.push(`cpu.executeOpcode(${opcode}, ${slotPc}, true); // delay slot fallback`);
    }

    return Cpu.getInstructionCycles(opcode);
  }
}
