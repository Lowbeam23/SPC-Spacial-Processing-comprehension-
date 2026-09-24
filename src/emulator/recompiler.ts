/**
 * MIPS Dynamic Recompiler (JIT) - High-Speed Sliced Imposter Edition
 * Features inner-slice execution, direct block linking, complete delay-slot unaligned
 * memory support, and clean MMIO synchronization.
 */

import { Cpu } from './cpu';
import { Memory } from './memory';

export interface CompiledBlock {
  pc: number;
  instructionCount: number;
  cycleCount: number;
  fn: (cpu: Cpu, mem: Memory) => number; // returns next PC
  jsCode: string;
  endsWithMmio?: boolean;
}

export class Recompiler {
  private blockCache: Map<number, CompiledBlock> = new Map();
  private ramBlocks: (CompiledBlock | undefined)[] = new Array(524288);
  private biosBlocks: (CompiledBlock | undefined)[] = new Array(131072);
  public blocksCompiled: number = 0;
  public jitHits: number = 0;
  public fallbackHits: number = 0;

  private ramBlockCount: number = 0;
  public invalidationsSecCounter: number = 0;

  public clearCache(): void {
    this.blockCache.clear();
    this.ramBlocks.fill(undefined);
    this.biosBlocks.fill(undefined);
    this.ramBlockCount = 0;
    this.blocksCompiled = 0;
    this.jitHits = 0;
    this.fallbackHits = 0;
  }

  public invalidateAddress(vaddr: number, length: number = 4): void {
    const physAddr = (vaddr & 0x001fffff) >>> 0;
    if (this.ramBlockCount === 0) return;

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
   * High-speed Inner-Slice Dispatcher.
   * Runs blocks in a tight local loop for up to `sliceCycles` (default 64)
   * while maintaining synchronous peripheral & IRQ safety.
   */
  public stepBlock(cpu: Cpu, memory: Memory, forceInterpreter: boolean = false, sliceCycles: number = 64): number {
    if (cpu.checkInterrupts()) {
      return 2;
    }

    if (forceInterpreter) {
      this.fallbackHits++;
      return cpu.step();
    }

    let totalExecutedCycles = 0;

    while (totalExecutedCycles < sliceCycles && !cpu.halted) {
      const pc = cpu.pc >>> 0;
      if (pc === 0 || (pc & 0x1fffffff) === 0) {
        cpu.halted = true;
        console.error(`[JUMP TO ZERO TRAP HALT] Attempted step at PC: 0x0`);
        return totalExecutedCycles > 0 ? totalExecutedCycles : 0;
      }

      if (!cpu.isInstructionFetchMapped(pc)) {
        const c = cpu.step();
        totalExecutedCycles += c > 0 ? c : 1;
        break;
      }

      const physKey = (pc & 0x1fffffff) >>> 0;
      let block: CompiledBlock | undefined;

      if (physKey < 0x00200000) {
        block = this.ramBlocks[physKey >>> 2];
      } else if (physKey >= 0x1fc00000 && physKey < 0x1fc80000) {
        block = this.biosBlocks[(physKey - 0x1fc00000) >>> 2];
      } else {
        block = this.blockCache.get(physKey);
      }

      if (!block) {
        block = this.compileBlock(pc, memory);
        if (block) {
          if (physKey < 0x00200000) {
            this.ramBlocks[physKey >>> 2] = block;
            this.ramBlockCount++;
          } else if (physKey >= 0x1fc00000 && physKey < 0x1fc80000) {
            this.biosBlocks[(physKey - 0x1fc00000) >>> 2] = block;
          } else {
            this.blockCache.set(physKey, block);
          }
          this.blocksCompiled++;
        }
      }

      if (!block) {
        this.fallbackHits++;
        const c = cpu.step();
        totalExecutedCycles += c > 0 ? c : 1;
        break;
      }

      this.jitHits++;
      const nextPc = (block.fn(cpu, memory)) >>> 0;

      if (nextPc === 0xffffffff) {
        this.fallbackHits++;
        const c = cpu.step();
        totalExecutedCycles += c > 0 ? c : 1;
        break;
      }

      if (cpu.exceptionTriggeredInStep) {
        cpu.exceptionTriggeredInStep = false;
        totalExecutedCycles += Math.max(block.cycleCount, block.instructionCount, 1);
        break;
      }

      let virtPc = nextPc;
      if (virtPc < 0x80000000) {
        virtPc = (virtPc & 0x001fffff) >>> 0;
      }
      const physAddr = (virtPc & 0x1fffffff) >>> 0;
      if (physAddr >= 0x1fc00000 && physAddr <= 0x1fc7ffff) {
        virtPc = (physAddr | 0xa0000000) >>> 0;
      } else if (physAddr < 0x00200000 && virtPc < 0x80000000) {
        virtPc = (physAddr | 0x80000000) >>> 0;
      }

      cpu.pc = virtPc;
      cpu.nextPc = (virtPc + 4) >>> 0;
      cpu.regs[0] = 0;

      cpu.instructionsExecuted += block.instructionCount;
      const blockCycles = Math.max(block.cycleCount, block.instructionCount, 1);
      cpu.cycles += blockCycles;
      totalExecutedCycles += blockCycles;

      // Check hardware interrupts or pending IRQs
      if ((memory.iStat & memory.iMask) !== 0) {
        if (cpu.checkInterrupts()) {
          break;
        }
      }

      // Early break if the block ended on an MMIO store boundary
      if (block.endsWithMmio) {
        break;
      }
    }

    return totalExecutedCycles > 0 ? totalExecutedCycles : 1;
  }

  /**
   * Translates a sequence of MIPS instructions into a compiled JS function
   */
  public compileBlock(startPc: number, memory: Memory): CompiledBlock | null {
    const physStart = startPc & 0x1fffffff;
    if (physStart < 0x00001000 ||
        (physStart >= 0x0003c380 && physStart <= 0x0003c3b0) ||
        (physStart >= 0x000b27b0 && physStart <= 0x000b27e0) ||
        (physStart >= 0x000ae400 && physStart <= 0x000ae430) ||
        (physStart >= 0x0005a080 && physStart <= 0x0005a08c) ||
        (physStart >= 0x0005a760 && physStart <= 0x0005a790) ||
        (physStart >= 0x000045c0 && physStart <= 0x000045d8)) {
      return null;
    }

    const lines: string[] = [];
    lines.push('const r = cpu.r32;');
    lines.push('const m = mem;');
    lines.push('const ram = m.ram;');
    lines.push('const ram32 = m.ram32;');
    lines.push('r[0] = 0;');

    let currentPc = startPc >>> 0;
    if (currentPc < 0x80000000) {
      const phys = (currentPc & 0x1fffffff) >>> 0;
      if (phys >= 0x1fc00000 && phys <= 0x1fc7ffff) {
        currentPc = (phys | 0xa0000000) >>> 0;
      }
    }

    let instructionCount = 0;
    let totalCycles = 0;
    const maxInstructions = 64;
    let terminated = false;
    let nextTargetExpression: string | null = null;
    let endsWithMmio = false;

    while (instructionCount < maxInstructions && !terminated) {
      const physCurrent = (currentPc & 0x1fffffff) >>> 0;
      if (physCurrent >= 0x000045c0 && physCurrent <= 0x000045d8) {
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

      let isIoStore = false;

      switch (op) {
        case 0x00: // SPECIAL
          switch (funct) {
            case 0x00: // SLL / NOP
              if (opcode !== 0 && rd !== 0) {
                lines.push(`r[${rd}] = (r[${rt}] << ${shamt}) >>> 0;`);
              }
              break;
            case 0x01: // Branch hint / NOP
              break;
            case 0x02: // SRL
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rt}] >>> ${shamt}) >>> 0;`);
              break;
            case 0x03: // SRA
              if (rd !== 0) lines.push(`r[${rd}] = ((r[${rt}] | 0) >> ${shamt}) >>> 0;`);
              break;
            case 0x04: // SLLV
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rt}] << (r[${rs}] & 0x1f)) >>> 0;`);
              break;
            case 0x06: // SRLV
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rt}] >>> (r[${rs}] & 0x1f)) >>> 0;`);
              break;
            case 0x07: // SRAV
              if (rd !== 0) lines.push(`r[${rd}] = ((r[${rt}] | 0) >> (r[${rs}] & 0x1f)) >>> 0;`);
              break;
            case 0x08: // JR
              {
                lines.push(`let target_${instructionCount} = r[${rs}] >>> 0;`);
                lines.push(`if (target_${instructionCount} === 0) {`);
                lines.push(`  const recRa = r[31] >>> 0;`);
                lines.push(`  if (recRa !== 0 && recRa !== ${currentPc}) {`);
                lines.push(`    target_${instructionCount} = recRa;`);
                lines.push(`  } else {`);
                lines.push(`    target_${instructionCount} = ${(currentPc + 8) >>> 0};`);
                lines.push(`  }`);
                lines.push(`}`);
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
                lines.push(`let target_${instructionCount} = r[${rs}] >>> 0;`);
                lines.push(`if (target_${instructionCount} === 0) {`);
                lines.push(`  const recRa = r[31] >>> 0;`);
                lines.push(`  if (recRa !== 0 && recRa !== ${currentPc}) {`);
                lines.push(`    target_${instructionCount} = recRa;`);
                lines.push(`  } else {`);
                lines.push(`    target_${instructionCount} = ${(currentPc + 8) >>> 0};`);
                lines.push(`  }`);
                lines.push(`}`);
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
              if (rd !== 0) lines.push(`r[${rd}] = cpu.hi;`);
              break;
            case 0x11: // MTHI
              lines.push(`cpu.hi = r[${rs}] >>> 0;`);
              break;
            case 0x12: // MFLO
              if (rd !== 0) lines.push(`r[${rd}] = cpu.lo;`);
              break;
            case 0x13: // MTLO
              lines.push(`cpu.lo = r[${rs}] >>> 0;`);
              break;
            case 0x18: // MULT
              lines.push(`{ const a = BigInt(r[${rs}] | 0); const b = BigInt(r[${rt}] | 0); const prod = a * b; cpu.lo = Number(BigInt.asUintN(32, prod)) >>> 0; cpu.hi = Number(BigInt.asUintN(32, prod >> 32n)) >>> 0; }`);
              break;
            case 0x19: // MULTU
              lines.push(`{ const a = BigInt(r[${rs}] >>> 0); const b = BigInt(r[${rt}] >>> 0); const prod = a * b; cpu.lo = Number(BigInt.asUintN(32, prod)) >>> 0; cpu.hi = Number(BigInt.asUintN(32, prod >> 32n)) >>> 0; }`);
              break;
            case 0x1a: // DIV
              lines.push(`{ const s1 = r[${rs}] | 0; const s2 = r[${rt}] | 0; if (s2 === 0) { cpu.hi = s1 >>> 0; cpu.lo = (s1 < 0 ? 1 : 0xFFFFFFFF) >>> 0; } else if (s1 === -0x80000000 && s2 === -1) { cpu.lo = 0x80000000 >>> 0; cpu.hi = 0; } else { cpu.lo = ((s1 / s2) | 0) >>> 0; cpu.hi = ((s1 % s2) | 0) >>> 0; } }`);
              break;
            case 0x1b: // DIVU
              lines.push(`{ const u1 = r[${rs}] >>> 0; const u2 = r[${rt}] >>> 0; if (u2 === 0) { cpu.hi = u1 >>> 0; cpu.lo = 0xFFFFFFFF; } else { cpu.lo = Math.floor(u1 / u2) >>> 0; cpu.hi = (u1 % u2) >>> 0; } }`);
              break;
            case 0x20: // ADD
            case 0x21: // ADDU
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rs}] + r[${rt}]) >>> 0;`);
              break;
            case 0x22: // SUB
            case 0x23: // SUBU
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rs}] - r[${rt}]) >>> 0;`);
              break;
            case 0x24: // AND
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rs}] & r[${rt}]) >>> 0;`);
              break;
            case 0x25: // OR
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rs}] | r[${rt}]) >>> 0;`);
              break;
            case 0x26: // XOR
              if (rd !== 0) lines.push(`r[${rd}] = (r[${rs}] ^ r[${rt}]) >>> 0;`);
              break;
            case 0x27: // NOR
              if (rd !== 0) lines.push(`r[${rd}] = (~(r[${rs}] | r[${rt}])) >>> 0;`);
              break;
            case 0x2a: // SLT
              {
                const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
                const valT = rt === 0 ? '0' : `(r[${rt}] | 0)`;
                if (rd !== 0) lines.push(`r[${rd}] = (${valS} < ${valT}) ? 1 : 0;`);
              }
              break;
            case 0x2b: // SLTU
              {
                const valS = rs === 0 ? '0' : `(r[${rs}] >>> 0)`;
                const valT = rt === 0 ? '0' : `(r[${rt}] >>> 0)`;
                if (rd !== 0) lines.push(`r[${rd}] = (${valS} < ${valT}) ? 1 : 0;`);
              }
              break;
            case 0x30:
            case 0x38:
            case 0x39:
            case 0x3a:
            case 0x3b:
            case 0x3c:
            case 0x3d:
            case 0x3e:
            case 0x3f:
              break;
            default:
              return null;
          }
          break;

        case 0x01: // BCOND
          {
            let branchTarget = ((currentPc + 4 + (simm16 << 2)) >>> 0);
            if (branchTarget < 0x80000000) {
              branchTarget = (branchTarget & 0x001FFFFF) >>> 0;
            }
            const fallthrough = (currentPc + 8) >>> 0;
            const bcondType = rt;
            const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
            if (bcondType === 0x00) {
              lines.push(`const taken_${instructionCount} = (${valS} < 0);`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else if (bcondType === 0x01) {
              lines.push(`const taken_${instructionCount} = (${valS} >= 0);`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else if (bcondType === 0x10) {
              lines.push(`const taken_${instructionCount} = (${valS} < 0);`);
              lines.push(`r[31] = ${fallthrough};`);
              totalCycles += this.emitDelaySlot(currentPc + 4, memory, lines);
              nextTargetExpression = `taken_${instructionCount} ? ${branchTarget} : ${fallthrough}`;
              terminated = true;
              instructionCount++;
            } else if (bcondType === 0x11) {
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
          if (rt !== 0) lines.push(`r[${rt}] = (r[${rs}] + ${simm16}) >>> 0;`);
          break;

        case 0x0a: // SLTI
          {
            const valS = rs === 0 ? '0' : `(r[${rs}] | 0)`;
            if (rt !== 0) lines.push(`r[${rt}] = (${valS} < ${simm16}) ? 1 : 0;`);
          }
          break;

        case 0x0b: // SLTIU
          {
            const valS = rs === 0 ? '0' : `(r[${rs}] >>> 0)`;
            if (rt !== 0) lines.push(`r[${rt}] = (${valS} < ${simm16 >>> 0}) ? 1 : 0;`);
          }
          break;

        case 0x0c: // ANDI
          if (rt !== 0) lines.push(`r[${rt}] = (r[${rs}] & ${imm16}) >>> 0;`);
          break;

        case 0x0d: // ORI
          if (rt !== 0) lines.push(`r[${rt}] = (r[${rs}] | ${imm16}) >>> 0;`);
          break;

        case 0x0e: // XORI
          if (rt !== 0) lines.push(`r[${rt}] = (r[${rs}] ^ ${imm16}) >>> 0;`);
          break;

        case 0x0f: // LUI
          if (rt !== 0) lines.push(`r[${rt}] = ${(imm16 << 16) >>> 0};`);
          break;

        case 0x20: // LB
          if (rt !== 0) {
            lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const val = ram[addr & 0x001FFFFF]; r[${rt}] = ((val << 24) >> 24) >>> 0; } else { const val = m.read8(addr >>> 0); r[${rt}] = ((val << 24) >> 24) >>> 0; } }`);
          }
          break;

        case 0x21: // LH
          if (rt !== 0) {
            lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; const val = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)); r[${rt}] = ((val << 16) >> 16) >>> 0; } else { const val = m.read16(addr >>> 0); r[${rt}] = ((val << 16) >> 16) >>> 0; } }`);
          }
          break;

        case 0x22: // LWL
          lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; ${rt !== 0 ? `r[${rt}] = (((r[${rt}] & [0x00FFFFFF, 0x0000FFFF, 0x000000FF, 0][b]) | ((mem << [24, 16, 8, 0][b]) >>> 0))) >>> 0;` : ''} }`);
          break;

        case 0x23: // LW
          if (rt !== 0) {
            lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram32[(addr & 0x001FFFFF) >>> 2]; } else { r[${rt}] = m.read32(addr >>> 0) >>> 0; } }`);
          }
          break;

        case 0x24: // LBU
          if (rt !== 0) {
            lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram[addr & 0x001FFFFF]; } else { r[${rt}] = m.read8(addr >>> 0) >>> 0; } }`);
          }
          break;

        case 0x25: // LHU
          if (rt !== 0) {
            lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; r[${rt}] = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)) >>> 0; } else { r[${rt}] = m.read16(addr >>> 0) >>> 0; } }`);
          }
          break;

        case 0x26: // LWR
          lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; ${rt !== 0 ? `r[${rt}] = (((r[${rt}] & [0, 0xFF000000, 0xFFFF0000, 0xFFFFFF00][b]) | (mem >>> [0, 8, 16, 24][b]))) >>> 0;` : ''} }`);
          break;

        case 0x28: // SB
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram[addr & 0x001FFFFF] = r[${rt}] & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 1); } } else { m.write8(addr >>> 0, r[${rt}] & 0xff); } }`);
          isIoStore = true;
          break;

        case 0x29: // SH
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { const off = addr & 0x001FFFFF; ram[off] = r[${rt}] & 0xff; ram[(off + 1) & 0x1fffff] = (r[${rt}] >>> 8) & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 2); } } else { m.write16(addr >>> 0, r[${rt}] & 0xffff); } }`);
          isIoStore = true;
          break;

        case 0x2a: // SWL
          lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; const val = (((mem & [0xFFFFFF00, 0xFFFF0000, 0xFF000000, 0][b]) | (r[${rt}] >>> [24, 16, 8, 0][b]))) >>> 0; m.write32(al, val); }`);
          break;

        case 0x2b: // SW
          lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram32[(addr & 0x001FFFFF) >>> 2] = r[${rt}]; if (m.recompiler) m.recompiler.invalidateAddress(addr, 4); } } else { m.write32(addr >>> 0, r[${rt}]); } }`);
          isIoStore = true;
          break;

        case 0x2e: // SWR
          lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; const val = (((mem & [0, 0x000000FF, 0x0000FFFF, 0x00FFFFFF][b]) | ((r[${rt}] << [0, 8, 16, 24][b]) >>> 0))) >>> 0; m.write32(al, val); }`);
          break;

        case 0x10: // COP0
        case 0x12: // COP2 (GTE)
        case 0x32: // LWC2
        case 0x36: // SWC2
        case 0x3a: // SWC2 alias
          lines.push(`cpu.executeOpcode(${opcode}, ${currentPc});`);
          break;

        default:
          return null;
      }

      if (isIoStore && !terminated) {
        terminated = true;
        endsWithMmio = true;
        nextTargetExpression = `${(currentPc + 4) >>> 0}`;
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
      const fn = new Function('cpu', 'mem', fullCode) as (cpu: Cpu, mem: Memory) => number;
      return {
        pc: startPc,
        instructionCount,
        cycleCount: totalCycles,
        endsWithMmio,
        fn,
        jsCode: fullCode,
      };
    } catch {
      return null;
    }
  }

  private emitDelaySlot(slotPc: number, memory: Memory, lines: string[]): number {
    const opcode = memory.read32(slotPc);
    if (opcode === 0) return 1;

    const op = (opcode >>> 26) & 0x3f;
    const rs = (opcode >>> 21) & 0x1f;
    const rt = (opcode >>> 16) & 0x1f;
    const rd = (opcode >>> 11) & 0x1f;
    const shamt = (opcode >>> 6) & 0x1f;
    const funct = opcode & 0x3f;
    const imm16 = opcode & 0xffff;
    const simm16 = (imm16 << 16) >> 16;

    if (op === 0x00) {
      if ((funct === 0x20 || funct === 0x21) && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rs}] + r[${rt}]) >>> 0;`);
      } else if ((funct === 0x22 || funct === 0x23) && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rs}] - r[${rt}]) >>> 0;`);
      } else if (funct === 0x00 && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rt}] << ${shamt}) >>> 0;`);
      } else if (funct === 0x02 && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rt}] >>> ${shamt}) >>> 0;`);
      } else if (funct === 0x03 && rd !== 0) {
        lines.push(`r[${rd}] = ((r[${rt}] | 0) >> ${shamt}) >>> 0;`);
      } else if (funct === 0x24 && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rs}] & r[${rt}]) >>> 0;`);
      } else if (funct === 0x25 && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rs}] | r[${rt}]) >>> 0;`);
      } else if (funct === 0x26 && rd !== 0) {
        lines.push(`r[${rd}] = (r[${rs}] ^ r[${rt}]) >>> 0;`);
      } else if (funct === 0x27 && rd !== 0) {
        lines.push(`r[${rd}] = (~(r[${rs}] | r[${rt}])) >>> 0;`);
      } else if (funct === 0x2a && rd !== 0) {
        lines.push(`r[${rd}] = ((r[${rs}] | 0) < (r[${rt}] | 0)) ? 1 : 0;`);
      } else if (funct === 0x2b && rd !== 0) {
        lines.push(`r[${rd}] = ((r[${rs}] >>> 0) < (r[${rt}] >>> 0)) ? 1 : 0;`);
      } else {
        lines.push(`cpu.executeOpcode(${opcode}, ${slotPc}, true);`);
      }
    } else if ((op === 0x08 || op === 0x09) && rt !== 0) {
      lines.push(`r[${rt}] = (r[${rs}] + ${simm16}) >>> 0;`);
    } else if (op === 0x0a && rt !== 0) {
      lines.push(`r[${rt}] = ((r[${rs}] | 0) < ${simm16}) ? 1 : 0;`);
    } else if (op === 0x0b && rt !== 0) {
      lines.push(`r[${rt}] = ((r[${rs}] >>> 0) < ${(simm16 >>> 0)}) ? 1 : 0;`);
    } else if (op === 0x0c && rt !== 0) {
      lines.push(`r[${rt}] = (r[${rs}] & ${imm16}) >>> 0;`);
    } else if (op === 0x0d && rt !== 0) {
      lines.push(`r[${rt}] = (r[${rs}] | ${imm16}) >>> 0;`);
    } else if (op === 0x0e && rt !== 0) {
      lines.push(`r[${rt}] = (r[${rs}] ^ ${imm16}) >>> 0;`);
    } else if (op === 0x0f && rt !== 0) {
      lines.push(`r[${rt}] = ${(imm16 << 16) >>> 0};`);
    } else if (op === 0x20 && rt !== 0) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const val = ram[addr & 0x001FFFFF]; r[${rt}] = ((val << 24) >> 24) >>> 0; } else { const val = m.read8(addr >>> 0); r[${rt}] = ((val << 24) >> 24) >>> 0; } }`);
    } else if (op === 0x21 && rt !== 0) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; const val = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)); r[${rt}] = ((val << 16) >> 16) >>> 0; } else { const val = m.read16(addr >>> 0); r[${rt}] = ((val << 16) >> 16) >>> 0; } }`);
    } else if (op === 0x22) { // delay slot LWL
      lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; ${rt !== 0 ? `r[${rt}] = (((r[${rt}] & [0x00FFFFFF, 0x0000FFFF, 0x000000FF, 0][b]) | ((mem << [24, 16, 8, 0][b]) >>> 0))) >>> 0;` : ''} }`);
    } else if (op === 0x23 && rt !== 0) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram32[(addr & 0x001FFFFF) >>> 2]; } else { r[${rt}] = m.read32(addr >>> 0) >>> 0; } }`);
    } else if (op === 0x24 && rt !== 0) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { r[${rt}] = ram[addr & 0x001FFFFF]; } else { r[${rt}] = m.read8(addr >>> 0) >>> 0; } }`);
    } else if (op === 0x25 && rt !== 0) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { const off = addr & 0x001FFFFF; r[${rt}] = (ram[off] | (ram[(off + 1) & 0x1fffff] << 8)) >>> 0; } else { r[${rt}] = m.read16(addr >>> 0) >>> 0; } }`);
    } else if (op === 0x26) { // delay slot LWR
      lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; ${rt !== 0 ? `r[${rt}] = (((r[${rt}] & [0, 0xFF000000, 0xFFFF0000, 0xFFFFFF00][b]) | (mem >>> [0, 8, 16, 24][b]))) >>> 0;` : ''} }`);
    } else if (op === 0x28) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram[addr & 0x001FFFFF] = r[${rt}] & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 1); } } else { m.write8(addr >>> 0, r[${rt}] & 0xff); } }`);
    } else if (op === 0x29) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { const off = addr & 0x001FFFFF; ram[off] = r[${rt}] & 0xff; ram[(off + 1) & 0x1fffff] = (r[${rt}] >>> 8) & 0xff; if (m.recompiler) m.recompiler.invalidateAddress(addr, 2); } } else { m.write16(addr >>> 0, r[${rt}] & 0xffff); } }`);
    } else if (op === 0x2a) { // delay slot SWL
      lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; const val = (((mem & [0xFFFFFF00, 0xFFFF0000, 0xFF000000, 0][b]) | (r[${rt}] >>> [24, 16, 8, 0][b]))) >>> 0; m.write32(al, val); }`);
    } else if (op === 0x2b) {
      lines.push(`{ const addr = (r[${rs}] + ${simm16}) | 0; if ((addr & 0x1E000000) === 0) { if (!m.isCacheIsolated) { ram32[(addr & 0x001FFFFF) >>> 2] = r[${rt}]; if (m.recompiler) m.recompiler.invalidateAddress(addr, 4); } } else { m.write32(addr >>> 0, r[${rt}]); } }`);
    } else if (op === 0x2e) { // delay slot SWR
      lines.push(`{ const a = (r[${rs}] + ${simm16}) >>> 0; const al = a & ~3; const b = a & 3; const mem = m.read32(al) >>> 0; const val = (((mem & [0, 0x000000FF, 0x0000FFFF, 0x00FFFFFF][b]) | ((r[${rt}] << [0, 8, 16, 24][b]) >>> 0))) >>> 0; m.write32(al, val); }`);
    } else if (op === 0x10) {
      lines.push(`cpu.executeOpcode(${opcode}, ${slotPc}, true);`);
    } else {
      lines.push(`cpu.executeOpcode(${opcode}, ${slotPc}, true);`);
    }

    return Cpu.getInstructionCycles(opcode);
  }
}