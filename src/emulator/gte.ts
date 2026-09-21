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

  constructor() {
    this.dataU32 = new Uint32Array(this.dataBuffer);
    this.dataI32 = new Int32Array(this.dataBuffer);
    this.ctrlU32 = new Uint32Array(this.ctrlBuffer);
    this.ctrlI32 = new Int32Array(this.ctrlBuffer);
  }

  public reset(): void {
    this.dataU32.fill(0);
    this.ctrlU32.fill(0);
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

  // Backwards compatibility methods
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
   * Main GTE Command Dispatcher
   * Unrolled and optimized for raw speed inside the execution loop.
   */
  public executeCommand(command: number): void {
    // Clear the error flags register (Control Reg 31)
    this.ctrlU32[31] = 0;

    const op = command & 0x3f;

    switch (op) {
      case 0x01: // RTPS: Perspective Transform of Vector 0
        this.opRTPS();
        break;

      case 0x30: // RTPT: Perspective Transform of Triple Vectors (V0, V1, V2)
        this.opRTPT();
        break;

      case 0x06: // NCLIP: Normal Clipping (Triangle Backface Cull Check)
        this.opNCLIP();
        break;

      case 0x2d: // AVSZ3: Average of 3 Z values
        this.opAVSZ3();
        break;

      case 0x2e: // AVSZ4: Average of 4 Z values
        this.opAVSZ4();
        break;

      case 0x12: // MVMVA: Multiply Vector by Matrix and Vector Add
        this.opMVMVA(command);
        break;

      case 0x1b: // NCDS
      case 0x1c: // CDP
      case 0x1e: // NCDT
        break;

      default:
        break;
    }
  }

  /**
   * RTPS: Perspective Transformation of Single Vector (V0 -> SXY2)
   */
  private opRTPS(): void {
    // 1. Unpack Rotation Matrix R (16-bit signed fixed-point 1.3.12 values)
    const r11 = (this.ctrlI32[0] << 16) >> 16;
    const r12 = this.ctrlI32[0] >> 16;
    const r13 = (this.ctrlI32[1] << 16) >> 16;
    const r21 = this.ctrlI32[1] >> 16;
    const r22 = (this.ctrlI32[2] << 16) >> 16;
    const r23 = this.ctrlI32[2] >> 16;
    const r31 = (this.ctrlI32[3] << 16) >> 16;
    const r32 = this.ctrlI32[3] >> 16;
    const r33 = (this.ctrlI32[4] << 16) >> 16;

    // 2. Unpack Translation Vector TR (32-bit signed ints)
    const trx = this.ctrlI32[5];
    const try_ = this.ctrlI32[6];
    const trz = this.ctrlI32[7];

    // 3. Unpack Vector 0 (VXY0: reg 0, VZ0: reg 1)
    const vx = (this.dataI32[0] << 16) >> 16;
    const vy = this.dataI32[0] >> 16;
    const vz = (this.dataI32[1] << 16) >> 16;

    // 4. Matrix Multiplication with Float Acceleration
    const macX = (r11 * vx + r12 * vy + r13 * vz) / 4096.0 + trx;
    const macY = (r21 * vx + r22 * vy + r23 * vz) / 4096.0 + try_;
    const macZ = (r31 * vx + r32 * vy + r33 * vz) / 4096.0 + trz;

    // Shift Depth FIFO: SZ0 -> SZ1 -> SZ2 -> SZ3
    this.dataU32[16] = this.dataU32[17]; // SZ0 = SZ1
    this.dataU32[17] = this.dataU32[18]; // SZ1 = SZ2
    this.dataU32[18] = this.dataU32[19]; // SZ2 = SZ3

    // Clamp and store current Z to SZ3 (reg 19)
    const szVal = Math.max(0, Math.min(0xffff, Math.floor(macZ))) | 0;
    this.dataU32[19] = szVal;

    // 5. Perspective Projection
    const h = this.ctrlU32[26];     // Distance to screen
    const ofx = this.ctrlI32[24];   // Screen Offset X (16.16)
    const ofy = this.ctrlI32[25];   // Screen Offset Y (16.16)

    // Shift Screen XY FIFO: SXY0 -> SXY1 -> SXY2
    this.dataU32[12] = this.dataU32[13]; // SXY0 = SXY1
    this.dataU32[13] = this.dataU32[14]; // SXY1 = SXY2

    let sx = 0;
    let sy = 0;

    if (szVal > 0) {
      // Direct fast floating-point perspective divide
      const ratio = h / szVal;
      sx = Math.floor((macX * ratio) + (ofx / 65536.0));
      sy = Math.floor((macY * ratio) + (ofy / 65536.0));
    }

    // Clamp to 16-bit signed screen boundaries
    sx = Math.max(-1024, Math.min(1023, sx));
    sy = Math.max(-1024, Math.min(1023, sy));

    // Store transformed point into SXY2 (reg 14: bits 0-15 = SX, bits 16-31 = SY)
    this.dataU32[14] = ((sy & 0xffff) << 16) | (sx & 0xffff);
  }

  /**
   * RTPT: Perspective Transformation of Triple Vectors (V0, V1, V2)
   * High-traffic opcode for 3D triangle meshes.
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
    const r33 = (this.ctrlI32[4] << 16) >> 16;

    const trx = this.ctrlI32[5];
    const try_ = this.ctrlI32[6];
    const trz = this.ctrlI32[7];

    const h = this.ctrlU32[26];
    const ofx = this.ctrlI32[24];
    const ofy = this.ctrlI32[25];

    // Process V0, V1, and V2 across a tight unrolled sequence
    for (let i = 0; i < 3; i++) {
      const regVXY = i * 2;
      const regVZ = i * 2 + 1;

      const vx = (this.dataI32[regVXY] << 16) >> 16;
      const vy = this.dataI32[regVXY] >> 16;
      const vz = (this.dataI32[regVZ] << 16) >> 16;

      const macX = (r11 * vx + r12 * vy + r13 * vz) / 4096.0 + trx;
      const macY = (r21 * vx + r22 * vy + r23 * vz) / 4096.0 + try_;
      const macZ = (r31 * vx + r32 * vy + r33 * vz) / 4096.0 + trz;

      // Depth FIFO shift
      this.dataU32[16] = this.dataU32[17];
      this.dataU32[17] = this.dataU32[18];
      this.dataU32[18] = this.dataU32[19];

      const szVal = Math.max(0, Math.min(0xffff, Math.floor(macZ))) | 0;
      this.dataU32[19] = szVal;

      // Screen XY FIFO shift
      this.dataU32[12] = this.dataU32[13];
      this.dataU32[13] = this.dataU32[14];

      let sx = 0;
      let sy = 0;

      if (szVal > 0) {
        const ratio = h / szVal;
        sx = Math.floor((macX * ratio) + (ofx / 65536.0));
        sy = Math.floor((macY * ratio) + (ofy / 65536.0));
      }

      sx = Math.max(-1024, Math.min(1023, sx));
      sy = Math.max(-1024, Math.min(1023, sy));

      this.dataU32[14] = ((sy & 0xffff) << 16) | (sx & 0xffff);
    }
  }

  /**
   * NCLIP: 2D Normal Backface Clipping Check
   * Computes the cross product of (SXY0, SXY1, SXY2) to cull back-facing polygons.
   */
  private opNCLIP(): void {
    const sx0 = (this.dataI32[12] << 16) >> 16;
    const sy0 = this.dataI32[12] >> 16;

    const sx1 = (this.dataI32[13] << 16) >> 16;
    const sy1 = this.dataI32[13] >> 16;

    const sx2 = (this.dataI32[14] << 16) >> 16;
    const sy2 = this.dataI32[14] >> 16;

    // 2D Cross Product: (sx0 * sy1 + sx1 * sy2 + sx2 * sy0) - (sx0 * sy2 + sx1 * sy0 + sx2 * sy1)
    const nclip = (sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1));

    // Store result into MAC0 (Data Register 24)
    this.dataI32[24] = nclip | 0;
  }

  /**
   * AVSZ3: Average of 3 Z values (SZ1, SZ2, SZ3)
   * Writes the average to OTZ (Data Register 7) for Ordering Table insertion.
   */
  private opAVSZ3(): void {
    const z1 = this.dataU32[17];
    const z2 = this.dataU32[18];
    const z3 = this.dataU32[19];

    const avg = Math.floor((z1 + z2 + z3) / 3);
    this.dataU32[7] = Math.max(0, Math.min(0xffff, avg)) >>> 0;
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
    const r33 = (this.ctrlI32[4] << 16) >> 16;

    const trx = this.ctrlI32[5];
    const try_ = this.ctrlI32[6];
    const trz = this.ctrlI32[7];

    const vecIdx = (command >>> 15) & 3;
    let vx = 0;
    let vy = 0;
    let vz = 0;

    if (vecIdx === 0) {
      vx = (this.dataI32[0] << 16) >> 16;
      vy = this.dataI32[0] >> 16;
      vz = (this.dataI32[1] << 16) >> 16;
    } else if (vecIdx === 1) {
      vx = (this.dataI32[2] << 16) >> 16;
      vy = this.dataI32[2] >> 16;
      vz = (this.dataI32[3] << 16) >> 16;
    } else if (vecIdx === 2) {
      vx = (this.dataI32[4] << 16) >> 16;
      vy = this.dataI32[4] >> 16;
      vz = (this.dataI32[5] << 16) >> 16;
    } else {
      vx = (this.dataI32[9] << 16) >> 16;
      vy = (this.dataI32[10] << 16) >> 16;
      vz = (this.dataI32[11] << 16) >> 16;
    }

    const mac1 = (r11 * vx + r12 * vy + r13 * vz) / 4096.0 + trx;
    const mac2 = (r21 * vx + r22 * vy + r23 * vz) / 4096.0 + try_;
    const mac3 = (r31 * vx + r32 * vy + r33 * vz) / 4096.0 + trz;

    this.dataI32[25] = Math.floor(mac1) | 0; // MAC1
    this.dataI32[26] = Math.floor(mac2) | 0; // MAC2
    this.dataI32[27] = Math.floor(mac3) | 0; // MAC3

    this.dataI32[9] = Math.max(-32768, Math.min(32767, Math.floor(mac1))) | 0;  // IR1
    this.dataI32[10] = Math.max(-32768, Math.min(32767, Math.floor(mac2))) | 0; // IR2
    this.dataI32[11] = Math.max(-32768, Math.min(32767, Math.floor(mac3))) | 0; // IR3
  }

  /**
   * AVSZ4: Average of 4 Z values (SZ0, SZ1, SZ2, SZ3)
   * Writes the average to OTZ (Data Register 7) for quad ordering.
   */
  private opAVSZ4(): void {
    const z0 = this.dataU32[16];
    const z1 = this.dataU32[17];
    const z2 = this.dataU32[18];
    const z3 = this.dataU32[19];

    const avg = Math.floor((z0 + z1 + z2 + z3) / 4);
    this.dataU32[7] = Math.max(0, Math.min(0xffff, avg)) >>> 0;
  }
}

export { RageGTE as Gte };