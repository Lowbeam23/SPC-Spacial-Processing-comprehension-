/**
 * PlayStation 1 Geometry Transformation Engine (GTE) Coprocessor 2
 * Provides 32 Data Registers and 32 Control Registers for 3D vector and matrix math
 */

export class Gte {
  // 32 Data Registers (VXY0..2, VZ0..2, RGBC, OTZ, IR0..3, SXY0..2, SXYP, SZ0..3, RGB0..2, RES1, MAC0..3, IRGB, ORGB, LZCS, LZCR)
  public dataRegisters: Uint32Array = new Uint32Array(32);

  // 32 Control Registers (R11R12, R13R21, R22R23, R31R32, R33, TRX..Z, L11..L33, RBK..BBK, LR1..LB3, RFC..BFC, OFX, OFY, H, DQA, DQB, ZSF3, ZSF4, FLAG)
  public controlRegisters: Uint32Array = new Uint32Array(32);

  public readDataRegister(reg: number): number {
    return this.dataRegisters[reg & 0x1f] >>> 0;
  }

  public writeDataRegister(reg: number, val: number): void {
    this.dataRegisters[reg & 0x1f] = val >>> 0;
  }

  public readControlRegister(reg: number): number {
    return this.controlRegisters[reg & 0x1f] >>> 0;
  }

  public writeControlRegister(reg: number, val: number): void {
    this.controlRegisters[reg & 0x1f] = val >>> 0;
  }

  /**
   * Executes a Coprocessor 2 / GTE command
   */
  public executeCommand(command: number): void {
    const cmd = command & 0x3f;
    // Clear error flags in FLAG register (Control Reg 31)
    this.controlRegisters[31] = 0;
  }

  public reset(): void {
    this.dataRegisters.fill(0);
    this.controlRegisters.fill(0);
  }
}
