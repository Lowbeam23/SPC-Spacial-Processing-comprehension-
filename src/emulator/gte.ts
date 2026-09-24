/**
 * Rage GTE - High-Performance Float-Accelerated Coprocessor 2 for PS1
 * Built specifically for V8 JIT inlining and zero garbage collection overhead.
 */
export class RageGTE {
  // Underlying memory buffers (32 registers * 4 bytes = 128 bytes each)
  private readonly dataBuffer = new ArrayBuffer(128);
  private readonly ctrlBuffer = new ArrayBuffer(128);

  // Overlapping typed views for zero-cost bit casting
  public dataU32: Uint32Array;
  public dataI32: Int32Array;
  public ctrlU32: Uint32Array;
  public ctrlI32: Int32Array;

  // Diagnostic logging hooks
  public onDiagnostic?: (msg: string) => void;
  public lastDiagnostic: string = '';
  public diagnosticCount: number = 0;

  constructor() {
    this.dataU32 = new Uint32Array(this.dataBuffer);
    this.dataI32 = new Int32Array(this.dataBuffer);
    this.ctrlU32 = new Uint32Array(this.ctrlBuffer);
    this.ctrlI32 = new Int32Array(this.ctrlBuffer);
    this.reset();
  }

  public reset(): void {
    this.dataU32.fill(0);
    this.ctrlU32.fill(0);

    // Default GTE State (Identity Matrix: R11=4096, R22=4096, R33=4096)
    // Hardware layout: 16-bit packed signed fixed-point (1.3.12)
    // Reg 0: R12 (high 16) | R11 (low 16)
    this.ctrlI32[0] = 4096;
    // Reg 1: R21 (high 16) | R13 (low 16)
    this.ctrlI32[1] = 0;
    // Reg 2: R23 (high 16) | R22 (low 16)
    this.ctrlI32[2] = 4096;
    // Reg 3: R32 (high 16) | R31 (low 16)
    this.ctrlI32[3] = 0;
    // Reg 4: Mirror 4096 across both halves to guarantee R33 is valid
    this.ctrlI32[4] = (4096 << 16) | 4096;

    // Translation Vector
    this.ctrlI32[5] = 0;   // TRX
    this.ctrlI32[6] = 0;   // TRY
    this.ctrlI32[7] = 450; // TRZ = 450 (comfortable perspective depth)

    // Screen Center and Projection
    this.ctrlI32[24] = 160 << 16; // OFX (160.0 in 16.16)
    this.ctrlI32[25] = 120 << 16; // OFY (120.0 in 16.16)
    this.ctrlU32[26] = 256;       // H (Screen distance = 256)
  }

  // --- COP2 Register Accessors (Inlined by JIT) ---
  public readData(reg: number): number {
    return this.dataU32[reg & 0x1f] >>> 0;
  }

  public writeData(reg: number, val: number): void {
    this.dataU32[reg & 0x1f] = val >>> 0;
  }

  public readCtrl(reg: number): number {
    return this.ctrlU32[reg & 0x1f] >>> 0;
  }

  public writeCtrl(reg: number, val: number): void {
    this.ctrlU32[reg & 0x1f] = val >>> 0;
  }

  public readDataRegister(reg: number): number {
    return this.readData(reg);
  }

  public writeDataRegister(reg: number, val: number): void {
    this.writeData(reg, val);
  }

  public readControlRegister(reg: number): number {
    return this.readCtrl(reg);
  }

  public writeControlRegister(reg: number, val: number): void {
    this.writeCtrl(reg, val);
  }

  public get dataRegisters(): Uint32Array {
    return this.dataU32;
  }

  public get controlRegisters(): Uint32Array {
    return this.ctrlU32;
  }

  /**
   * Helper: Extracts (X, Y, Z) for a given vector index (0, 1, 2)
   * PS1 GTE hardware stores VXY (X in low 16, Y in high 16) and VZ (Z in low 16).
   */
  private extractVector(vecIdx: number): { vx: number; vy: number; vz: number } {
    const regVXY = vecIdx * 2;
    const regVZ = vecIdx * 2 + 1;

    const vx = (this.dataI32[regVXY] << 16) >> 16;
    const vy = this.dataI32[regVXY] >> 16;
    const vz = (this.dataI32[regVZ] << 16) >> 16;

    return { vx, vy, vz };
  }

  /**
   * Main GTE Command Dispatcher
   */
  public executeCommand(command: number): void {
    this.ctrlU32[31] = 0; // Clear FLAG register

    const op = command & 0x3f;

    switch (op) {
      case 0x01: // RTPS: Single Vector Perspective Transform
        this.opRTPS();
        break;

      case 0x30: // RTPT: Triple Vector Perspective Transform
        this.opRTPT();
        break;

      case 0x06: // NCLIP: Normal Clipping
        this.opNCLIP();
        break;

      case 0x2d: // AVSZ3: Average 3 Z values
        this.opAVSZ3();
        break;

      case 0x2e: // AVSZ4: Average 4 Z values
        this.opAVSZ4();
        break;

      case 0x12: // MVMVA: Matrix-Vector Multiply Add
        this.opMVMVA(command);
        break;

      default:
        break;
    }
  }

  /**
   * RTPS: Perspective Transformation of Single Vector (V0 -> SXY2)
   */
  private opRTPS(): void {
    // 1. Unpack Rotation Matrix R (1.3.12 format)
    const r11 = (this.ctrlI32[0] << 16) >> 16;
    const r12 = this.ctrlI32[0] >> 16;
    const r13 = (this.ctrlI32[1] << 16) >> 16;
    const r21 = this.ctrlI32[1] >> 16;
    const r22 = (this.ctrlI32[2] << 16) >> 16;
    const r23 = this.ctrlI32[2] >> 16;
    const r31 = (this.ctrlI32[3] << 16) >> 16;
    const r32 = this.ctrlI32[3] >> 16;
    const r33 = (this.ctrlI32[4] << 16) >> 16 !== 0 ? ((this.ctrlI32[4] << 16) >> 16) : (this.ctrlI32[4] >> 16);

    // 2. Unpack Translation Vector TR
    const trx = this.ctrlI32[5];
    const try_ = this.ctrlI32[6];
    const trz = this.ctrlI32[7];

    // 3. Extract Vector 0
    const { vx, vy, vz } = this.extractVector(0);

    // 4. Matrix Multiply (divide accumulated matrix by 4096) + Translation Vector
    const macX = (r11 * vx + r12 * vy + r13 * vz) / 4096.0 + trx;
    const macY = (r21 * vx + r22 * vy + r23 * vz) / 4096.0 + try_;
    const macZ = (r31 * vx + r32 * vy + r33 * vz) / 4096.0 + trz;

    // Intermediate registers & MACs
    this.dataI32[25] = Math.floor(macX * 4096.0) | 0; // MAC1
    this.dataI32[26] = Math.floor(macY * 4096.0) | 0; // MAC2
    this.dataI32[27] = Math.floor(macZ * 4096.0) | 0; // MAC3
    this.dataI32[9]  = Math.max(-32768, Math.min(32767, Math.floor(macX))) | 0; // IR1
    this.dataI32[10] = Math.max(-32768, Math.min(32767, Math.floor(macY))) | 0; // IR2
    this.dataI32[11] = Math.max(-32768, Math.min(32767, Math.floor(macZ))) | 0; // IR3

    // Shift Depth FIFO: SZ0 <- SZ1 <- SZ2 <- SZ3
    this.dataU32[16] = this.dataU32[17];
    this.dataU32[17] = this.dataU32[18];
    this.dataU32[18] = this.dataU32[19];

    // Current Z depth clamped to 16-bit unsigned
    const szVal = Math.max(1, Math.min(0xffff, Math.floor(macZ))) | 0;
    this.dataU32[19] = szVal;
    this.dataU32[7]  = szVal; // OTZ

    // 5. Perspective Projection
    const h = this.ctrlU32[26] || 256;
    const ofxPixels = (this.ctrlI32[24] >> 16);
    const ofyPixels = (this.ctrlI32[25] >> 16);

    // Shift Screen XY FIFO: SXY0 <- SXY1 <- SXY2
    this.dataU32[12] = this.dataU32[13];
    this.dataU32[13] = this.dataU32[14];

    // Screen coordinates
    const sx = Math.max(-1024, Math.min(1023, Math.floor((macX * h) / szVal) + ofxPixels));
    const sy = Math.max(-1024, Math.min(1023, Math.floor((macY * h) / szVal) + ofyPixels));

    this.dataI32[24] = Math.floor(((macX * h) / szVal) * 65536.0 + this.ctrlI32[24]) | 0; // MAC0

    // Pack into SXY2 (bits 0-15: SX, bits 16-31: SY)
    this.dataU32[14] = ((sy & 0xffff) << 16) | (sx & 0xffff);
    this.dataU32[15] = this.dataU32[14]; // SXYP

    // Diagnostic log
    const diag = `[RTPS] In:(${vx},${vy},${vz}) -> Trans:(${macX.toFixed(1)},${macY.toFixed(1)},${macZ.toFixed(1)}) -> Screen:(${sx},${sy})`;
    this.lastDiagnostic = diag;
    if (this.diagnosticCount < 10) {
      this.diagnosticCount++;
      console.log(diag);
      if (this.onDiagnostic) this.onDiagnostic(diag);
    }
  }

  /**
   * RTPT: Perspective Transformation of Triple Vectors (V0, V1, V2)
   */
  private opRTPT(): void {
    const r11 = (this.ctrlI32[0] << 16) >> 16;
    const r12 = this.ctrlI32[0] >> 16;
    const r13 = (this.ctrlI32[1] << 16) >> 16;
    const r21 = this.ctrlI32[1] >> 16;
    const r22 = (this.ctrlI32[2] << 16) >> 16;
    const r23 = this.ctrlI32[2] >> 16;
    const r31 = (this.ctrlI32[3] << 16) >> 16;
    const r32 = this.ctrlI32[3] >> 16;
    const r33 = (this.ctrlI32[4] << 16) >> 16 !== 0 ? ((this.ctrlI32[4] << 16) >> 16) : (this.ctrlI32[4] >> 16);

    const trx = this.ctrlI32[5];
    const try_ = this.ctrlI32[6];
    const trz = this.ctrlI32[7];

    const h = this.ctrlU32[26] || 256;
    const ofxPixels = (this.ctrlI32[24] >> 16);
    const ofyPixels = (this.ctrlI32[25] >> 16);

    for (let i = 0; i < 3; i++) {
      const { vx, vy, vz } = this.extractVector(i);

      if (i === 0 && this.diagnosticCount < 10) {
        this.diagnosticCount++;
        console.log(`[RTPT V0 RAW] reg0=0x${(this.dataU32[0] >>> 0).toString(16)} -> vx=${vx}, vy=${vy}, vz=${vz}`);
      }

      const macX = (r11 * vx + r12 * vy + r13 * vz) / 4096.0 + trx;
      const macY = (r21 * vx + r22 * vy + r23 * vz) / 4096.0 + try_;
      const macZ = (r31 * vx + r32 * vy + r33 * vz) / 4096.0 + trz;

      // Depth FIFO shift
      this.dataU32[16] = this.dataU32[17];
      this.dataU32[17] = this.dataU32[18];
      this.dataU32[18] = this.dataU32[19];

      const szVal = Math.max(1, Math.min(0xffff, Math.floor(macZ))) | 0;
      this.dataU32[19] = szVal;
      this.dataU32[7]  = szVal;

      // SXY FIFO shift
      this.dataU32[12] = this.dataU32[13];
      this.dataU32[13] = this.dataU32[14];

      const sx = Math.max(-1024, Math.min(1023, Math.floor((macX * h) / szVal) + ofxPixels));
      const sy = Math.max(-1024, Math.min(1023, Math.floor((macY * h) / szVal) + ofyPixels));

      this.dataU32[14] = ((sy & 0xffff) << 16) | (sx & 0xffff);
      this.dataU32[15] = this.dataU32[14];
    }
  }

  /**
   * NCLIP: 2D Normal Backface Clipping Check
   */
  private opNCLIP(): void {
    const sx0 = (this.dataI32[12] << 16) >> 16;
    const sy0 = this.dataI32[12] >> 16;

    const sx1 = (this.dataI32[13] << 16) >> 16;
    const sy1 = this.dataI32[13] >> 16;

    const sx2 = (this.dataI32[14] << 16) >> 16;
    const sy2 = this.dataI32[14] >> 16;

    // 2D Cross product
    const nclip = (sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1));
    this.dataI32[24] = nclip | 0;
  }

  /**
   * AVSZ3: Average of 3 Z values
   */
  private opAVSZ3(): void {
    const z1 = this.dataU32[17];
    const z2 = this.dataU32[18];
    const z3 = this.dataU32[19];
    this.dataU32[7] = Math.max(0, Math.min(0xffff, Math.floor((z1 + z2 + z3) / 3))) >>> 0;
  }

  /**
   * AVSZ4: Average of 4 Z values
   */
  private opAVSZ4(): void {
    const z0 = this.dataU32[16];
    const z1 = this.dataU32[17];
    const z2 = this.dataU32[18];
    const z3 = this.dataU32[19];
    this.dataU32[7] = Math.max(0, Math.min(0xffff, Math.floor((z0 + z1 + z2 + z3) / 4))) >>> 0;
  }

  /**
   * MVMVA: Multiply Vector by Matrix and Vector Add
   */
  private opMVMVA(command: number): void {
    const r11 = (this.ctrlI32[0] << 16) >> 16;
    const r12 = this.ctrlI32[0] >> 16;
    const r13 = (this.ctrlI32[1] << 16) >> 16;
    const r21 = this.ctrlI32[1] >> 16;
    const r22 = (this.ctrlI32[2] << 16) >> 16;
    const r23 = this.ctrlI32[2] >> 16;
    const r31 = (this.ctrlI32[3] << 16) >> 16;
    const r32 = this.ctrlI32[3] >> 16;
    const r33 = (this.ctrlI32[4] << 16) >> 16 !== 0 ? ((this.ctrlI32[4] << 16) >> 16) : (this.ctrlI32[4] >> 16);

    const trx = this.ctrlI32[5];
    const try_ = this.ctrlI32[6];
    const trz = this.ctrlI32[7];

    const vecIdx = (command >>> 15) & 3;
    let vx = 0, vy = 0, vz = 0;

    if (vecIdx < 3) {
      const v = this.extractVector(vecIdx);
      vx = v.vx; vy = v.vy; vz = v.vz;
    } else {
      vx = this.dataI32[9];
      vy = this.dataI32[10];
      vz = this.dataI32[11];
    }

    const mac1 = (r11 * vx + r12 * vy + r13 * vz) / 4096.0 + trx;
    const mac2 = (r21 * vx + r22 * vy + r23 * vz) / 4096.0 + try_;
    const mac3 = (r31 * vx + r32 * vy + r33 * vz) / 4096.0 + trz;

    this.dataI32[25] = Math.floor(mac1) | 0;
    this.dataI32[26] = Math.floor(mac2) | 0;
    this.dataI32[27] = Math.floor(mac3) | 0;

    this.dataI32[9]  = Math.max(-32768, Math.min(32767, Math.floor(mac1))) | 0;
    this.dataI32[10] = Math.max(-32768, Math.min(32767, Math.floor(mac2))) | 0;
    this.dataI32[11] = Math.max(-32768, Math.min(32767, Math.floor(mac3))) | 0;
  }
}

export { RageGTE as Gte };