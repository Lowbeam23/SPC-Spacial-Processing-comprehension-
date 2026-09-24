/**
 * PS1 Emulator Type Definitions
 */

export enum BootMode {
  BIOS_DASHBOARD = 'BIOS_DASHBOARD',
  HLE_GAME_RUNNER = 'HLE_GAME_RUNNER',
}

export type ExecutionMode = 'jit' | 'interpreter' | 'hybrid';
export type EmulationStatus = 'stopped' | 'running' | 'paused' | 'error';

export type LogType = 'system' | 'bios' | 'tty' | 'disasm' | 'error' | 'warn' | 'gpu' | 'gte';

export interface ConsoleLog {
  id: string;
  timestamp: number;
  type: LogType;
  message: string;
  pc?: number;
  details?: string;
  count?: number;
}

export interface BiosInfo {
  name: string;
  size: number;
  versionString?: string;
  isOfficial?: boolean;
  checksum?: string;
  loadedAt: number;
}

export interface VirtualDiscTrack {
  trackNumber: number;
  offset: number;
  sectorSize: number;
  type: string;
}

export interface VirtualDisc {
  name: string;
  buffer: ArrayBuffer;
  data: Uint8Array;
  sectorSize: number;
  totalSectors: number;
  cueSheet?: string;
  primaryExecutable?: string;
  systemCnf?: string;
  volumeLabel?: string;
  tracks?: VirtualDiscTrack[];
}

export interface ParsedExecutable {
  entryPc: number;
  loadAddr: number;
  loadSize: number;
  data: Uint8Array;
  initialSp?: number;
  initialGp?: number;
  bssAddr?: number;
  bssSize?: number;
}

export interface DiscInfo {
  name: string;
  size: number;
  type: 'iso' | 'bin' | 'cue' | 'ps-exe' | 'unknown';
  volumeLabel?: string;
  executableName?: string;
  sectorSize: number;
  totalSectors: number;
}

export interface CdromState {
  hasDisc: boolean;
  discInfo: DiscInfo | null;
  isMotorOn: boolean;
  isReading: boolean;
  status: number;
  sectorsReadCount: number;
}

export interface CpuState {
  pc: number;
  nextPc: number;
  regs: Uint32Array; // 32 general purpose registers
  hi: number;
  lo: number;
  // COP0
  sr: number; // Status register ($12)
  cause: number; // Cause register ($13)
  epc: number; // Exception program counter ($14)
  badVAddr: number; // Bad Virtual Address ($8)
  cycles: number;
  instructionsExecuted: number;
  inDelaySlot: boolean;
}

export interface DisassembledInstruction {
  pc: number;
  opcode: number;
  hex: string;
  assembly: string;
  description?: string;
}

export interface GpuState {
  status: number;
  displayMode: string;
  width: number;
  height: number;
  vblank: boolean;
  framesRendered: number;
  readyForCommands: boolean;
  readyForDma: boolean;
  gp0WriteCount?: number;
  gp1WriteCount?: number;
  dma2PacketCount?: number;
  vblankIrqCount?: number;
  totalVramNonZero?: number;
  displayNonZero?: number;
  displayStartX?: number;
  displayStartY?: number;
  displayDisabled?: boolean;
  vramFirst16WordsHex?: string;
}

export const MIPS_REGISTER_NAMES = [
  '$zero', '$at', '$v0', '$v1',
  '$a0', '$a1', '$a2', '$a3',
  '$t0', '$t1', '$t2', '$t3',
  '$t4', '$t5', '$t6', '$t7',
  '$s0', '$s1', '$s2', '$s3',
  '$s4', '$s5', '$s6', '$s7',
  '$t8', '$t9', '$k0', '$k1',
  '$gp', '$sp', '$fp', '$ra'
] as const;
