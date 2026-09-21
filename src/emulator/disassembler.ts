/**
 * MIPS R3000A Disassembler for PS1
 */

import { MIPS_REGISTER_NAMES, DisassembledInstruction } from '../types';

export function disassemble(pc: number, opcode: number): DisassembledInstruction {
  const hex = opcode.toString(16).padStart(8, '0').toUpperCase();
  const op = (opcode >>> 26) & 0x3f;
  const rs = (opcode >>> 21) & 0x1f;
  const rt = (opcode >>> 16) & 0x1f;
  const rd = (opcode >>> 11) & 0x1f;
  const shamt = (opcode >>> 6) & 0x1f;
  const funct = opcode & 0x3f;
  const imm16 = opcode & 0xffff;
  const simm16 = (imm16 << 16) >> 16; // sign extended
  const target = (opcode & 0x03ffffff) << 2;

  const regS = MIPS_REGISTER_NAMES[rs] || `$${rs}`;
  const regT = MIPS_REGISTER_NAMES[rt] || `$${rt}`;
  const regD = MIPS_REGISTER_NAMES[rd] || `$${rd}`;

  let assembly = 'UNKNOWN';
  let description = '';

  if (opcode === 0) {
    return { pc, opcode, hex, assembly: 'nop', description: 'No operation' };
  }

  switch (op) {
    case 0x00: // SPECIAL
      switch (funct) {
        case 0x00:
          assembly = `sll ${regD}, ${regT}, ${shamt}`;
          description = `Shift ${regT} left by ${shamt}`;
          break;
        case 0x01:
          assembly = `hint/nop (funct 0x01)`;
          description = `Compiler branch hint / NOP`;
          break;
        case 0x02:
          assembly = `srl ${regD}, ${regT}, ${shamt}`;
          description = `Shift ${regT} right logical by ${shamt}`;
          break;
        case 0x03:
          assembly = `sra ${regD}, ${regT}, ${shamt}`;
          description = `Shift ${regT} right arithmetic by ${shamt}`;
          break;
        case 0x04:
          assembly = `sllv ${regD}, ${regT}, ${regS}`;
          break;
        case 0x06:
          assembly = `srlv ${regD}, ${regT}, ${regS}`;
          break;
        case 0x07:
          assembly = `srav ${regD}, ${regT}, ${regS}`;
          break;
        case 0x08:
          assembly = `jr ${regS}`;
          description = `Jump to address in ${regS}`;
          break;
        case 0x09:
          assembly = `jalr ${regD}, ${regS}`;
          description = `Jump to ${regS} and link in ${regD}`;
          break;
        case 0x0c:
          assembly = 'syscall';
          description = 'System call exception';
          break;
        case 0x0d:
          assembly = 'break';
          description = 'Breakpoint exception';
          break;
        case 0x10:
          assembly = `mfhi ${regD}`;
          break;
        case 0x11:
          assembly = `mthi ${regS}`;
          break;
        case 0x12:
          assembly = `mflo ${regD}`;
          break;
        case 0x13:
          assembly = `mtlo ${regS}`;
          break;
        case 0x18:
          assembly = `mult ${regS}, ${regT}`;
          break;
        case 0x19:
          assembly = `multu ${regS}, ${regT}`;
          break;
        case 0x1a:
          assembly = `div ${regS}, ${regT}`;
          break;
        case 0x1b:
          assembly = `divu ${regS}, ${regT}`;
          break;
        case 0x20:
          assembly = `add ${regD}, ${regS}, ${regT}`;
          break;
        case 0x21:
          assembly = `addu ${regD}, ${regS}, ${regT}`;
          break;
        case 0x22:
          assembly = `sub ${regD}, ${regS}, ${regT}`;
          break;
        case 0x23:
          assembly = `subu ${regD}, ${regS}, ${regT}`;
          break;
        case 0x24:
          assembly = `and ${regD}, ${regS}, ${regT}`;
          break;
        case 0x25:
          assembly = `or ${regD}, ${regS}, ${regT}`;
          break;
        case 0x26:
          assembly = `xor ${regD}, ${regS}, ${regT}`;
          break;
        case 0x27:
          assembly = `nor ${regD}, ${regS}, ${regT}`;
          break;
        case 0x2a:
          assembly = `slt ${regD}, ${regS}, ${regT}`;
          break;
        case 0x2b:
          assembly = `sltu ${regD}, ${regS}, ${regT}`;
          break;
        default:
          assembly = `special.0x${funct.toString(16).padStart(2, '0')}`;
          break;
      }
      break;

    case 0x01: // BCOND (BLTZ, BGEZ)
      switch (rt) {
        case 0x00:
          assembly = `bltz ${regS}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
          break;
        case 0x01:
          assembly = `bgez ${regS}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
          break;
        case 0x10:
          assembly = `bltzal ${regS}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
          break;
        case 0x11:
          assembly = `bgezal ${regS}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
          break;
        default:
          assembly = `bcond.0x${rt.toString(16)}`;
          break;
      }
      break;

    case 0x02: // J
      assembly = `j 0x${(((pc + 4) & 0xf0000000) | target).toString(16)}`;
      description = 'Direct jump';
      break;
    case 0x03: // JAL
      assembly = `jal 0x${(((pc + 4) & 0xf0000000) | target).toString(16)}`;
      description = 'Jump and link ($ra = PC+8)';
      break;
    case 0x04: // BEQ
      assembly = `beq ${regS}, ${regT}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
      break;
    case 0x05: // BNE
      assembly = `bne ${regS}, ${regT}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
      break;
    case 0x06: // BLEZ
      assembly = `blez ${regS}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
      break;
    case 0x07: // BGTZ
      assembly = `bgtz ${regS}, 0x${((pc + 4 + (simm16 << 2)) >>> 0).toString(16)}`;
      break;
    case 0x08: // ADDI
      assembly = `addi ${regT}, ${regS}, ${simm16}`;
      break;
    case 0x09: // ADDIU
      assembly = `addiu ${regT}, ${regS}, ${simm16}`;
      break;
    case 0x0a: // SLTI
      assembly = `slti ${regT}, ${regS}, ${simm16}`;
      break;
    case 0x0b: // SLTIU
      assembly = `sltiu ${regT}, ${regS}, ${simm16}`;
      break;
    case 0x0c: // ANDI
      assembly = `andi ${regT}, ${regS}, 0x${imm16.toString(16)}`;
      break;
    case 0x0d: // ORI
      assembly = `ori ${regT}, ${regS}, 0x${imm16.toString(16)}`;
      break;
    case 0x0e: // XORI
      assembly = `xori ${regT}, ${regS}, 0x${imm16.toString(16)}`;
      break;
    case 0x0f: // LUI
      assembly = `lui ${regT}, 0x${imm16.toString(16)}`;
      break;
    case 0x10: // COP0
      if (rs === 0x00) {
        assembly = `mfc0 ${regT}, $c0_${rd}`;
      } else if (rs === 0x04) {
        assembly = `mtc0 ${regT}, $c0_${rd}`;
      } else if (funct === 0x10) {
        assembly = 'rfe';
      } else {
        assembly = `cop0 0x${opcode.toString(16)}`;
      }
      break;
    case 0x12: // COP2 (GTE)
      assembly = `cop2 0x${opcode.toString(16)}`;
      break;
    case 0x20: // LB
      assembly = `lb ${regT}, ${simm16}(${regS})`;
      break;
    case 0x21: // LH
      assembly = `lh ${regT}, ${simm16}(${regS})`;
      break;
    case 0x22: // LWL
      assembly = `lwl ${regT}, ${simm16}(${regS})`;
      break;
    case 0x23: // LW
      assembly = `lw ${regT}, ${simm16}(${regS})`;
      break;
    case 0x24: // LBU
      assembly = `lbu ${regT}, ${simm16}(${regS})`;
      break;
    case 0x25: // LHU
      assembly = `lhu ${regT}, ${simm16}(${regS})`;
      break;
    case 0x26: // LWR
      assembly = `lwr ${regT}, ${simm16}(${regS})`;
      break;
    case 0x28: // SB
      assembly = `sb ${regT}, ${simm16}(${regS})`;
      break;
    case 0x29: // SH
      assembly = `sh ${regT}, ${simm16}(${regS})`;
      break;
    case 0x2a: // SWL
      assembly = `swl ${regT}, ${simm16}(${regS})`;
      break;
    case 0x2b: // SW
      assembly = `sw ${regT}, ${simm16}(${regS})`;
      break;
    case 0x2e: // SWR
      assembly = `swr ${regT}, ${simm16}(${regS})`;
      break;
    case 0x32: // LWC2
      assembly = `lwc2 ${regT}, ${simm16}(${regS})`;
      break;
    case 0x3a: // SWC2
      assembly = `swc2 ${regT}, ${simm16}(${regS})`;
      break;
    default:
      assembly = `unknown (0x${op.toString(16).padStart(2, '0')})`;
      break;
  }

  return { pc, opcode, hex, assembly, description };
}
