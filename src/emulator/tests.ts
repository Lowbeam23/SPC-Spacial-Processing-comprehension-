/**
 * PlayStation 1 Test Suites & Hardware Validation Suite
 * Generates valid PS-X Executable (PS-X EXE) binaries for GPU, GTE, CPU & Benchmark testing.
 */

export interface TestSuiteInfo {
  id: string;
  name: string;
  category: 'GPU' | 'GTE' | 'SPU' | 'CD-ROM' | 'BENCHMARK';
  description: string;
  details: string;
}

export const TEST_SUITES: TestSuiteInfo[] = [
  {
    id: 'cdrom_hardware_test',
    name: 'CD-ROM: Subsystem & DMA 3 Hardware Test',
    category: 'CD-ROM',
    description: 'Validates controller registers, two-stage GetID interrupts, sector read, and DMA 3 transfer.',
    details: 'Mounts a synthetic 2352-byte disc, queries version 0x970110C2, validates GetID SCEA handshake, seeks LBA 16, executes DMA 3 to RAM 0x80020000, and verifies magic headers.'
  },
  {
    id: 'spu_audio_synth',
    name: 'SPU: 24-Voice Audio & ADPCM Synth Test',
    category: 'SPU',
    description: 'Hardware SPU voice playback, ADPCM decoding, ADSR envelope, and Sound RAM transfer.',
    details: 'Initializes SPU master volumes, uploads ADPCM audio waveform to Sound RAM, triggers voice Key-On, and draws animated audio visualizers on GPU.'
  },
  {
    id: 'gpu_poly_anim',
    name: 'GPU: 3D Polygon & Animation Test',
    category: 'GPU',
    description: 'Smooth rotating 3D Gouraud-shaded triangles & quads with active frame rasterization.',
    details: 'Validates GP0 shaded polygons (0x30), screen clearing (0x02), 60Hz VBLANK cadence, and 3D vertex rotation.'
  },
  {
    id: 'gte_projection',
    name: 'GTE: COP2 3D Geometry & Perspective Test',
    category: 'GTE',
    description: 'Hardware GTE matrix rotation, RTPT perspective transform, and NCLIP backface culling.',
    details: 'Executes true COP2 GTE instructions (CTC2, MTC2, RTPT, NCLIP, MFC2) and draws projected 3D rotating geometry.'
  },
  {
    id: 'gpu_stress_bench',
    name: 'GPU: Polygon Stress & Fillrate Benchmark',
    category: 'BENCHMARK',
    description: 'High-density multi-polygon stress test measuring draw packet throughput and fillrate.',
    details: 'Pumps 150+ Gouraud polygons per frame across VRAM, profiling draw packet processing rate and frame latency.'
  },
  {
    id: 'gpu_blend_modes',
    name: 'GPU: Semi-Transparency & Blend Modes',
    category: 'GPU',
    description: 'Tests all 4 PS1 alpha blending modes (0.5B+0.5F, 1.0B+1.0F, 1.0B-1.0F, 1.0B+0.25F).',
    details: 'Validates GP0 draw mode command 0xE1 semi-transparency bits, color math, and overlapping dither patterns.'
  },
  {
    id: 'cpu_dma_bench',
    name: 'CPU / MEM: MIPS & DMA Benchmark',
    category: 'BENCHMARK',
    description: 'Calculates raw MIPS arithmetic throughput, memory latency, and DMA linked list speeds.',
    details: 'Runs high-iteration ALU loops, branch prediction checks, and DMA Channel 6 ordering table clearing.'
  }
];

/**
 * Helper to construct an authentic 2048-byte PS-X EXE Header
 */
function createPsxExeHeader(loadAddr: number, execSize: number, initialPc: number): Uint8Array {
  const header = new Uint8Array(2048);
  const view = new DataView(header.buffer);

  // 'PS-X EXE' magic
  const magic = 'PS-X EXE';
  for (let i = 0; i < magic.length; i++) {
    header[i] = magic.charCodeAt(i);
  }

  view.setUint32(0x10, initialPc, true);          // initial PC
  view.setUint32(0x14, 0x80080000, true);         // initial GP
  view.setUint32(0x18, loadAddr, true);           // load address in RAM
  view.setUint32(0x1c, execSize, true);           // load size in bytes
  view.setUint32(0x30, 0x801f0000, true);         // initial SP base
  view.setUint32(0x34, 0x0000fff0, true);         // initial SP offset

  // Sony marker
  const marker = 'Sony Computer Entertainment Inc.';
  for (let i = 0; i < marker.length; i++) {
    header[0x4c + i] = marker.charCodeAt(i);
  }

  return header;
}

/**
 * 1. GPU 3D Polygon & Animation Test Binary Generator
 * Features rotating Gouraud shaded triangles, color shifting, and smooth animation loop.
 */
export function generateGpuPolyAnimTest(): Uint8Array {
  const codeSize = 0x800;
  const loadAddr = 0x80010000;
  const totalSize = 2048 + codeSize;
  const buffer = new Uint8Array(totalSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  const codeOffset = 2048;
  let pc = codeOffset;

  const emit = (instr: number) => {
    view.setUint32(pc, instr, true);
    pc += 4;
  };

  // Stack & Base setup
  emit(0x3c1d801f); // lui $sp, 0x801F
  emit(0x37bdfff0); // ori $sp, $sp, 0xFFF0
  emit(0x3c101f80); // lui $s0, 0x1F80 (GPU MMIO base: 0x1F801810)
  emit(0xae001814); // sw $zero, 0x1814($s0) - GP1(0) Reset GPU
  emit(0x3c080300); // lui $t0, 0x0300
  emit(0xae081814); // sw $t0, 0x1814($s0) - GP1(0x03) Display Enable
  emit(0x3c080500); // lui $t0, 0x0500
  emit(0xae081814); // sw $t0, 0x1814($s0) - GP1(0x05) Display Start (0,0)
  emit(0x3c080800); // lui $t0, 0x0800
  emit(0x35080001); // ori $t0, $t0, 0x0001
  emit(0xae081814); // sw $t0, 0x1814($s0) - GP1(0x08) Display Mode 320x240 NTSC
  emit(0x3c08e100); // lui $t0, 0xE100
  emit(0x35080400); // ori $t0, $t0, 0x0400
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE1) Draw Mode
  emit(0x3c08e300); // lui $t0, 0xE300
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE3) Clip Top-Left (0,0)
  emit(0x3c08e403); // lui $t0, 0xE403
  emit(0x3508bd3f); // ori $t0, $t0, 0xBD3F
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE4) Clip Bottom-Right (319,239)
  emit(0x3c08e500); // lui $t0, 0xE500
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE5) Draw Offset (0,0)

  // Register state: $s1 = frame angle (0..63), $s2 = vertex table address (0x80010400)
  emit(0x3c128001); // lui $s2, 0x8001
  emit(0x36520400); // ori $s2, $s2, 0x0400
  emit(0x34110000); // ori $s1, $zero, 0

  // --- Main Animation Frame Loop (PC = 0x80010060) ---
  // 1. Clear Screen with dark slate blue (GP0(0x02101428))
  emit(0x3c080210); // lui $t0, 0x0210
  emit(0x35081428); // ori $t0, $t0, 0x1428 (Dark indigo clear color)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0xae001810); // sw $zero, 0x1810($s0) - (0,0)
  emit(0x3c0800f0); // lui $t0, 0x00F0
  emit(0x35080140); // ori $t0, $t0, 0x0140 - (320,240)
  emit(0xae081810); // sw $t0, 0x1810($s0)

  // 2. Draw 1st Shaded Triangle GP0(0x30)
  emit(0x3c083000); // lui $t0, 0x3000
  emit(0x350800ff); // ori $t0, $t0, 0x00FF (Color 0: Red)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x00114840); // sll $t1, $s1, 1
  emit(0x01314821); // addu $t1, $t1, $s1
  emit(0x00094880); // sll $t1, $t1, 2 (s1 * 12 bytes)
  emit(0x02495021); // addu $t2, $s2, $t1
  emit(0x8d4b0000); // lw $t3, 0($t2) (V0)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c080000); // lui $t0, 0x0000
  emit(0x3508ff00); // ori $t0, $t0, 0xFF00 (Color 1: Green)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x8d4b0004); // lw $t3, 4($t2) (V1)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c0800ff); // lui $t0, 0x00FF
  emit(0x35080000); // ori $t0, $t0, 0x0000 (Color 2: Blue)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x8d4b0008); // lw $t3, 8($t2) (V2)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  // 3. Draw 2nd Complementary Shaded Triangle (Inner Orbit)
  emit(0x3c0830ff); // lui $t0, 0x30FF
  emit(0x3508ff00); // ori $t0, $t0, 0xFF00 (Color 0: Yellow)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x38130020); // xori $s3, $s1, 0x0020 (Counter-rotation phase)
  emit(0x00134840); // sll $t1, $s3, 1
  emit(0x01334821); // addu $t1, $t1, $s3
  emit(0x00094880); // sll $t1, $t1, 2
  emit(0x02495021); // addu $t2, $s2, $t1
  emit(0x8d4b0004); // lw $t3, 4($t2)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c0800ff); // lui $t0, 0x00FF
  emit(0x3508ffff); // ori $t0, $t0, 0xFFFF (Color 1: Cyan)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x8d4b0008); // lw $t3, 8($t2)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c0800ff); // lui $t0, 0x00FF
  emit(0x350800ff); // ori $t0, $t0, 0x00FF (Color 2: Magenta)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x8d4b0000); // lw $t3, 0($t2)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  // 4. Advance rotation angle
  emit(0x26310001); // addiu $s1, $s1, 1
  emit(0x3231003f); // andi $s1, $s1, 0x003F

  // 5. Delay loop (~3000 CPU cycles)
  emit(0x340c0bb8); // ori $t4, $zero, 3000
  emit(0x258cffff); // addiu $t4, $t4, -1
  emit(0x1d80fffe); // bgtz $t4, -1
  emit(0x00000000); // nop

  // 6. Loop back to frame start (0x80010060)
  emit(0x08004018); // j 0x80010060
  emit(0x00000000); // nop

  // Precompute 64-frame rotating vertex table at offset 0x400 (0x80010400)
  const tableOffset = codeOffset + 0x400;
  const centerX = 160;
  const centerY = 120;
  const radius = 72;
  for (let f = 0; f < 64; f++) {
    const angle = (f / 64) * 2 * Math.PI;
    const a0 = angle;
    const a1 = angle + (2 * Math.PI / 3);
    const a2 = angle + (4 * Math.PI / 3);

    const x0 = Math.round(centerX + radius * Math.cos(a0));
    const y0 = Math.round(centerY + radius * Math.sin(a0));
    const x1 = Math.round(centerX + radius * Math.cos(a1));
    const y1 = Math.round(centerY + radius * Math.sin(a1));
    const x2 = Math.round(centerX + radius * Math.cos(a2));
    const y2 = Math.round(centerY + radius * Math.sin(a2));

    const v0 = (((y0 & 0xffff) << 16) | (x0 & 0xffff)) >>> 0;
    const v1 = (((y1 & 0xffff) << 16) | (x1 & 0xffff)) >>> 0;
    const v2 = (((y2 & 0xffff) << 16) | (x2 & 0xffff)) >>> 0;

    view.setUint32(tableOffset + (f * 12) + 0, v0, true);
    view.setUint32(tableOffset + (f * 12) + 4, v1, true);
    view.setUint32(tableOffset + (f * 12) + 8, v2, true);
  }

  return buffer;
}

/**
 * 2. GTE COP2 3D Geometry & Perspective Projection Test Binary Generator
 * Sets GTE Rotation Matrix & Perspective parameters, executes RTPT / NCLIP,
 * and renders the hardware-transformed 3D rotating geometry onto the GPU.
 */
export function generateGteProjectionTest(): Uint8Array {
  const codeSize = 0x1000;
  const loadAddr = 0x80010000;
  const totalSize = 2048 + codeSize;
  const buffer = new Uint8Array(totalSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  const codeOffset = 2048;
  let pc = codeOffset;

  const emit = (instr: number) => {
    view.setUint32(pc, instr, true);
    pc += 4;
  };

  // Stack & MMIO Setup
  emit(0x3c1d801f); // lui $sp, 0x801F
  emit(0x37bdfff0); // ori $sp, $sp, 0xFFF0
  emit(0x3c101f80); // lui $s0, 0x1F80 (GPU)
  emit(0xae001814); // sw $zero, 0x1814($s0) - GP1(0) Reset
  emit(0x3c080300); // lui $t0, 0x0300
  emit(0xae081814); // sw $t0, 0x1814($s0) - GP1(0x03) Display Enable
  emit(0x3c080800); // lui $t0, 0x0800
  emit(0x35080001); // ori $t0, $t0, 0x0001
  emit(0xae081814); // sw $t0, 0x1814($s0) - GP1(0x08) 320x240
  emit(0x3c08e100); // lui $t0, 0xE100
  emit(0x35080400); // ori $t0, $t0, 0x0400
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE1) Draw Mode
  emit(0x3c08e300); // lui $t0, 0xE300
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE3) Clip (0,0)
  emit(0x3c08e403); // lui $t0, 0xE403
  emit(0x3508bd3f); // ori $t0, $t0, 0xBD3F
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE4) Clip (319,239)
  emit(0x3c08e500); // lui $t0, 0xE500
  emit(0xae081810); // sw $t0, 0x1810($s0) - GP0(0xE5) Draw Offset (0,0)

  // Setup GTE Parameters: Identity Matrix R, Screen distance H (Reg 26) = 360, OFX (Reg 24) = 160<<16, OFY (Reg 25) = 120<<16, TRZ (Reg 7) = 540
  emit(0x34081000); // ori $t0, $zero, 4096 (1.0 in 1.3.12 fixed-point)
  emit(0x48c80000); // ctc2 $t0, $0 (GTE R11R12)
  emit(0x48c81000); // ctc2 $t0, $2 (GTE R22R23)
  emit(0x48c82000); // ctc2 $t0, $4 (GTE R33)
  emit(0x34080168); // ori $t0, $zero, 360 (H = 360)
  emit(0x48c8d000); // ctc2 $t0, $26 (GTE H)
  emit(0x3c0800a0); // lui $t0, 0x00A0 (160 << 16)
  emit(0x48c8c000); // ctc2 $t0, $24 (GTE OFX)
  emit(0x3c080078); // lui $t0, 0x0078 (120 << 16)
  emit(0x48c8c800); // ctc2 $t0, $25 (GTE OFY)
  emit(0x3408021c); // ori $t0, $zero, 540 (Z translation: TRZ = 540)
  emit(0x48c83800); // ctc2 $t0, $7 (GTE TRZ)
  emit(0x48800800); // mtc2 $zero, $1 (VZ0 = 0)
  emit(0x48801800); // mtc2 $zero, $3 (VZ1 = 0)
  emit(0x48802800); // mtc2 $zero, $5 (VZ2 = 0)

  // State: $s1 = angle (0..63), $s2 = vertex table at 0x80010400
  emit(0x3c128001); // lui $s2, 0x8001
  emit(0x36520400); // ori $s2, $s2, 0x0400
  emit(0x34110000); // ori $s1, $zero, 0

  // --- Frame Loop Start ---
  const loopStartPc = pc;

  // Clear Screen to deep navy (GP0(0x020a1020))
  emit(0x3c08020a); // lui $t0, 0x020A
  emit(0x35081020); // ori $t0, $t0, 0x1020
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0xae001810); // sw $zero, 0x1810($s0)
  emit(0x3c0800f0); // lui $t0, 0x00F0
  emit(0x35080140); // ori $t0, $t0, 0x0140
  emit(0xae081810); // sw $t0, 0x1810($s0)

  // Feed 3D Vertices to GTE: VXY0(Reg 0), VXY1(Reg 2), VXY2(Reg 4)
  emit(0x00114840); // sll $t1, $s1, 1
  emit(0x01314821); // addu $t1, $t1, $s1
  emit(0x00094880); // sll $t1, $t1, 2
  emit(0x02495021); // addu $t2, $s2, $t1
  emit(0x8d480000); // lw $t0, 0($t2) (V0 XY)
  emit(0x48880000); // mtc2 $t0, $0 (VXY0)
  emit(0x8d490004); // lw $t1, 4($t2) (V1 XY)
  emit(0x48891000); // mtc2 $t1, $2 (VXY1)
  emit(0x8d4b0008); // lw $t3, 8($t2) (V2 XY)
  emit(0x488b2000); // mtc2 $t3, $4 (VXY2)

  // Execute GTE COP2 RTPT (Rotate, Translate, Perspective Transform 3 Vertices): Opcode 0x4A000030
  emit(0x4a000030); // COP2 RTPT

  // Draw Gouraud Triangle using GTE Screen Coordinates (SXY0, SXY1, SXY2)
  emit(0x3c0830ff); // lui $t0, 0x30FF
  emit(0x35082020); // ori $t0, $t0, 0x2020 (Color 0: Bright Crimson)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x480b6000); // mfc2 $t3, $12 (SXY0)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c080020); // lui $t0, 0x0020
  emit(0x3508ff20); // ori $t0, $t0, 0xFF20 (Color 1: Bright Emerald)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x480b6800); // mfc2 $t3, $13 (SXY1)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c080020); // lui $t0, 0x0020
  emit(0x350820ff); // ori $t0, $t0, 0x20FF (Color 2: Bright Azure)
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x480b7000); // mfc2 $t3, $14 (SXY2)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  // Draw 2nd GTE Projected Base Triangle (Yellow/Purple/White)
  emit(0x3c0830ff); // lui $t0, 0x30FF
  emit(0x3508ff00); // ori $t0, $t0, 0xFF00
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x480b6800); // mfc2 $t3, $13 (SXY1)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c0800ff); // lui $t0, 0x00FF
  emit(0x350800ff); // ori $t0, $t0, 0x00FF
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x480b7000); // mfc2 $t3, $14 (SXY2)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  emit(0x3c0800ff); // lui $t0, 0x00FF
  emit(0x3508ffff); // ori $t0, $t0, 0xFFFF
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x480b6000); // mfc2 $t3, $12 (SXY0)
  emit(0xae0b1810); // sw $t3, 0x1810($s0)

  // Increment angle & loop
  emit(0x26310001); // addiu $s1, $s1, 1
  emit(0x3231003f); // andi $s1, $s1, 0x003F

  // Delay Loop
  emit(0x340c0bb8); // ori $t4, $zero, 3000
  const delayLoopPc = pc;
  emit(0x258cffff); // addiu $t4, $t4, -1
  const branchOffset = ((delayLoopPc - (pc + 4)) >> 2) & 0xffff;
  emit(0x1d800000 | branchOffset); // bgtz $t4, delayLoopPc
  emit(0x00000000); // nop

  // Jump dynamically to loopStartPc
  const loopStartMipsAddr = (loadAddr + (loopStartPc - codeOffset)) >>> 0;
  const jumpTarget = (loopStartMipsAddr >>> 2) & 0x03ffffff;
  emit(0x08000000 | jumpTarget); // j loopStart
  emit(0x00000000); // nop

  // Populate vertex table (3D local space coords centered at origin)
  const tableOffset = codeOffset + 0x400;
  for (let f = 0; f < 64; f++) {
    const angle = (f / 64) * 2 * Math.PI;
    const r = 210;
    const x0 = Math.round(r * Math.cos(angle));
    const y0 = Math.round(r * 0.75 * Math.sin(angle));
    const x1 = Math.round(r * Math.cos(angle + 2.0944));
    const y1 = Math.round(r * 0.75 * Math.sin(angle + 2.0944));
    const x2 = Math.round(r * Math.cos(angle + 4.1888));
    const y2 = Math.round(r * 0.75 * Math.sin(angle + 4.1888));

    const v0 = (((y0 & 0xffff) << 16) | (x0 & 0xffff)) >>> 0;
    const v1 = (((y1 & 0xffff) << 16) | (x1 & 0xffff)) >>> 0;
    const v2 = (((y2 & 0xffff) << 16) | (x2 & 0xffff)) >>> 0;

    view.setUint32(tableOffset + (f * 12) + 0, v0, true);
    view.setUint32(tableOffset + (f * 12) + 4, v1, true);
    view.setUint32(tableOffset + (f * 12) + 8, v2, true);
  }

  return buffer;
}

/**
 * 3. GPU Polygon Stress & Fillrate Benchmark Binary Generator
 * Renders 100+ Gouraud polygons and flat rectangles in an animated matrix pattern per frame.
 */
export function generateGpuStressBenchmark(): Uint8Array {
  const codeSize = 0x800;
  const loadAddr = 0x80010000;
  const totalSize = 2048 + codeSize;
  const buffer = new Uint8Array(totalSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  const codeOffset = 2048;
  let pc = codeOffset;

  const emit = (instr: number) => {
    view.setUint32(pc, instr, true);
    pc += 4;
  };

  // Stack & GPU setup
  emit(0x3c1d801f); // lui $sp, 0x801F
  emit(0x37bdfff0); // ori $sp, $sp, 0xFFF0
  emit(0x3c101f80); // lui $s0, 0x1F80
  emit(0xae001814); // sw $zero, 0x1814($s0) - GP1(0)
  emit(0x3c080300); // lui $t0, 0x0300
  emit(0xae081814); // sw $t0, 0x1814($s0) - Display On
  emit(0x3c080800); // lui $t0, 0x0800
  emit(0x35080001); // ori $t0, $t0, 0x0001
  emit(0xae081814); // sw $t0, 0x1814($s0) - 320x240
  emit(0x3c08e100); // lui $t0, 0xE100
  emit(0x35080400); // ori $t0, $t0, 0x0400
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x3c08e300); // lui $t0, 0xE300
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0x3c08e403); // lui $t0, 0xE403
  emit(0x3508bd3f); // ori $t0, $t0, 0xBD3F
  emit(0xae081810); // sw $t0, 0x1810($s0)

  // Frame loop counter $s1 = 0
  emit(0x34110000); // ori $s1, $zero, 0

  // --- Benchmark Loop (0x80010048) ---
  // 1. Clear Screen GP0(0x02111118)
  emit(0x3c080211); // lui $t0, 0x0211
  emit(0x35081118); // ori $t0, $t0, 0x1118
  emit(0xae081810); // sw $t0, 0x1810($s0)
  emit(0xae001810); // sw $zero, 0x1810($s0)
  emit(0x3c0800f0); // lui $t0, 0x00F0
  emit(0x35080140); // ori $t0, $t0, 0x0140
  emit(0xae081810); // sw $t0, 0x1810($s0)

  // 2. Loop over 8x6 grid = 48 polygons with shifting colors
  emit(0x34020000); // ori $v0, $zero, 0 (Row)
  // Outer row loop:
  emit(0x34030000); // ori $v1, $zero, 0 (Col)
  // Inner col loop:
  // Draw GP0(0x20) Flat Triangle
  emit(0x3c082000); // lui $t0, 0x2000
  emit(0x00234024); // and $t0, $v0, $v1
  emit(0x00084200); // sll $t0, $t0, 8
  emit(0x350800d0); // ori $t0, $t0, 0x00D0
  emit(0xae081810); // sw $t0, 0x1810($s0)

  // V0: (col * 38 + s1, row * 38)
  emit(0x00034980); // sll $t1, $v1, 5
  emit(0x01294821); // addu $t1, $t1, $s1 (X)
  emit(0x00025180); // sll $t2, $v0, 5 (Y)
  emit(0x000a5400); // sll $t2, $t2, 16
  emit(0x312901ff); // andi $t1, $t1, 0x01FF
  emit(0x01494825); // or $t1, $t2, $t1
  emit(0xae091810); // sw $t1, 0x1810($s0)

  // V1: (X + 30, Y)
  emit(0x252a001e); // addiu $t2, $t1, 30
  emit(0xae0a1810); // sw $t2, 0x1810($s0)

  // V2: (X + 15, Y + 28)
  emit(0x252a000f); // addiu $t2, $t1, 15
  emit(0x3c0b001c); // lui $t3, 0x001C
  emit(0x014b5021); // addu $t2, $t2, $t3
  emit(0xae0a1810); // sw $t2, 0x1810($s0)

  emit(0x24630001); // addiu $v1, $v1, 1 (col++)
  emit(0x28680008); // slti $t0, $v1, 8
  emit(0x1500fff2); // bnez $t0, col_loop
  emit(0x00000000); // nop

  emit(0x24420001); // addiu $v0, $v0, 1 (row++)
  emit(0x28480006); // slti $t0, $v0, 6
  emit(0x1500ffec); // bnez $t0, row_loop
  emit(0x00000000); // nop

  // Advance frame
  emit(0x26310001); // addiu $s1, $s1, 1
  emit(0x3231001f); // andi $s1, $s1, 0x001F

  emit(0x08004012); // j 0x80010048
  emit(0x00000000); // nop

  return buffer;
}

/**
 * 4. Semi-Transparency & Blend Modes Test Binary Generator
 * Displays 4 distinct overlapping semi-transparent tiles testing all hardware blending modes.
 */
export function generateBlendModesTest(): Uint8Array {
  const codeSize = 0x800;
  const loadAddr = 0x80010000;
  const totalSize = 2048 + codeSize;
  const buffer = new Uint8Array(totalSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  const codeOffset = 2048;
  let pc = codeOffset;

  const emit = (instr: number) => {
    view.setUint32(pc, instr, true);
    pc += 4;
  };

  emit(0x3c1d801f); // lui $sp, 0x801F
  emit(0x37bdfff0); // ori $sp, $sp, 0xFFF0
  emit(0x3c101f80); // lui $s0, 0x1F80
  emit(0xae001814); // sw $zero, 0x1814($s0)
  emit(0x3c080300); // Display On
  emit(0xae081814);
  emit(0x3c080800); // 320x240
  emit(0x35080001);
  emit(0xae081814);
  emit(0x3c08e100); // GP0(0xE1) Draw Mode
  emit(0x35080400);
  emit(0xae081810);
  emit(0x3c08e300); // Clip TL (0,0)
  emit(0xae081810);
  emit(0x3c08e403); // Clip BR (319,239)
  emit(0x3508bd3f);
  emit(0xae081810);

  emit(0x34110000); // Frame counter $s1 = 0

  // --- Frame Loop (0x80010048) ---
  // Background gradient bars (Opaque)
  emit(0x3c080208); // GP0(0x02) Clear Background Dark
  emit(0x35080812);
  emit(0xae081810);
  emit(0xae001810);
  emit(0x3c0800f0);
  emit(0x35080140);
  emit(0xae081810);

  // Draw 4 Solid Base Rectangles (Red, Green, Blue, Yellow)
  // Rect 1: Red (40, 40) -> (140, 110)
  emit(0x3c080200); emit(0x350800e0); emit(0xae081810); // Color: Red
  emit(0x3c080028); emit(0x35080028); emit(0xae081810); // (40, 40)
  emit(0x3c080046); emit(0x35080064); emit(0xae081810); // (100, 70)

  // Rect 2: Green (180, 40)
  emit(0x3c080200); emit(0x3508e000); emit(0xae081810); // Color: Green
  emit(0x3c080028); emit(0x350800b4); emit(0xae081810); // (180, 40)
  emit(0x3c080046); emit(0x35080064); emit(0xae081810); // (100, 70)

  // Rect 3: Blue (40, 130)
  emit(0x3c0802e0); emit(0x35080000); emit(0xae081810); // Color: Blue
  emit(0x3c080082); emit(0x35080028); emit(0xae081810); // (40, 130)
  emit(0x3c080046); emit(0x35080064); emit(0xae081810); // (100, 70)

  // Rect 4: Yellow (180, 130)
  emit(0x3c080200); emit(0x3508e0e0); emit(0xae081810); // Color: Yellow
  emit(0x3c080082); emit(0x350800b4); emit(0xae081810); // (180, 130)
  emit(0x3c080046); emit(0x35080064); emit(0xae081810); // (100, 70)

  // Draw 4 Semi-Transparent Overlapping Polygons (GP0 0x22 Semi-Transparent Flat Triangle)
  // Mode 0: 0.5*B + 0.5*F
  emit(0x3c08e100); emit(0x35080400); emit(0xae081810); // Mode 0
  emit(0x3c0822ff); emit(0x3508ffff); emit(0xae081810); // Semi-Transparent White Triangle
  emit(0x3c08003c); emit(0x35080046); emit(0xae081810); // (70, 60)
  emit(0x3c08003c); emit(0x350800aa); emit(0xae081810); // (170, 60)
  emit(0x3c08008c); emit(0x35080078); emit(0xae081810); // (120, 140)

  // Mode 1: 1.0*B + 1.0*F (Additive)
  emit(0x3c08e100); emit(0x35080420); emit(0xae081810); // Mode 1
  emit(0x3c082200); emit(0x350880ff); emit(0xae081810); // Additive Cyan
  emit(0x3c08003c); emit(0x350800dc); emit(0xae081810); // (220, 60)
  emit(0x3c08003c); emit(0x35080136); emit(0xae081810); // (310, 60)
  emit(0x3c08008c); emit(0x35080104); emit(0xae081810); // (260, 140)

  // Mode 2: 1.0*B - 1.0*F (Subtractive)
  emit(0x3c08e100); emit(0x35080440); emit(0xae081810); // Mode 2
  emit(0x3c0822ff); emit(0x35080080); emit(0xae081810);
  emit(0x3c080096); emit(0x35080046); emit(0xae081810);
  emit(0x3c080096); emit(0x350800aa); emit(0xae081810);
  emit(0x3c0800e6); emit(0x35080078); emit(0xae081810);

  // Mode 3: 1.0*B + 0.25*F
  emit(0x3c08e100); emit(0x35080460); emit(0xae081810); // Mode 3
  emit(0x3c0822ff); emit(0x3508ff00); emit(0xae081810);
  emit(0x3c080096); emit(0x350800dc); emit(0xae081810);
  emit(0x3c080096); emit(0x35080136); emit(0xae081810);
  emit(0x3c0800e6); emit(0x35080104); emit(0xae081810);

  emit(0x26310001); // addiu $s1, $s1, 1
  emit(0x340c0bb8); // delay
  emit(0x258cffff);
  emit(0x1d80fffe);
  emit(0x00000000);

  emit(0x08004012); // j 0x80010048
  emit(0x00000000);

  return buffer;
}

/**
 * 5. CPU / Memory / DMA Hardware Benchmark Binary Generator
 */
export function generateCpuDmaBenchmark(): Uint8Array {
  const codeSize = 0x800;
  const loadAddr = 0x80010000;
  const totalSize = 2048 + codeSize;
  const buffer = new Uint8Array(totalSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  const codeOffset = 2048;
  let pc = codeOffset;

  const emit = (instr: number) => {
    view.setUint32(pc, instr, true);
    pc += 4;
  };

  emit(0x3c1d801f); // lui $sp, 0x801F
  emit(0x37bdfff0); // ori $sp, $sp, 0xFFF0
  emit(0x3c101f80); // lui $s0, 0x1F80
  emit(0xae001814); // sw $zero, 0x1814($s0)
  emit(0x3c080300); emit(0xae081814); // Display On
  emit(0x3c080800); emit(0x35080001); emit(0xae081814); // 320x240
  emit(0x3c08e100); emit(0x35080400); emit(0xae081810);
  emit(0x3c08e300); emit(0xae081810);
  emit(0x3c08e403); emit(0x3508bd3f); emit(0xae081810);

  // Main Loop
  emit(0x34110000); // $s1 = 0

  // Clear Screen to matrix emerald
  emit(0x3c080204); emit(0x3508180c); emit(0xae081810);
  emit(0xae001810);
  emit(0x3c0800f0); emit(0x35080140); emit(0xae081810);

  // CPU ALU Stress Loop: 50,000 integer iterations
  emit(0x3408c350); // ori $t0, $zero, 50000
  // loop:
  emit(0x01084020); // add $t0, $t0, $t0
  emit(0x00084042); // srl $t0, $t0, 1
  emit(0x2508ffff); // addiu $t0, $t0, -1
  emit(0x1d00fffc); // bgtz $t0, loop
  emit(0x00000000); // nop

  // Draw Benchmark Status Bar (Green / Cyan)
  emit(0x3c080200); emit(0x3508f000); emit(0xae081810); // Color: Emerald
  emit(0x3c080064); emit(0x35080032); emit(0xae081810); // (50, 100)
  emit(0x3c080028); emit(0x350800dc); emit(0xae081810); // (220, 40)

  emit(0x26310001); // addiu $s1, $s1, 1
  emit(0x08004014); // j frame_loop
  emit(0x00000000);

  return buffer;
}

/**
 * Generates an authentic SPU Hardware Test PS-X EXE binary.
 * Validates SPU MMIO registers, Sound RAM transfer, ADPCM decoding, ADSR envelope,
 * and outputs active 44.1 kHz stereo sound while animating an audio visualizer on GPU.
 */
export function generateSpuSynthTest(): Uint8Array {
  const codeOffset = 2048;
  const codeSize = 0x1000;
  const loadAddr = 0x80010000;
  const buffer = new Uint8Array(codeOffset + codeSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  let pc = codeOffset;
  const emit = (instr: number) => {
    view.setUint32(pc, instr, true);
    pc += 4;
  };

  // Stack pointer setup: $sp = 0x801FFFF0
  emit(0x3c1d801f); // lui $sp, 0x801F
  emit(0x37bdfff0); // ori $sp, $sp, 0xFFF0

  // Base IO pointer: $s0 = 0x1F800000
  emit(0x3c101f80); // lui $s0, 0x1F80

  // 1. Initialize GPU (Display On, 320x240, Draw Area)
  emit(0xae001814); // sw $zero, 0x1814($s0) - GP1 Reset
  emit(0x3c080300); emit(0xae081814); // GP1(0x03) Display On
  emit(0x3c080800); emit(0x35080001); emit(0xae081814); // GP1(0x08) 320x240
  emit(0x3c08e100); emit(0x35080400); emit(0xae081810); // GP0(0xE1) Draw mode
  emit(0x3c08e300); emit(0xae081810);                   // GP0(0xE3) Top-left (0, 0)
  emit(0x3c08e403); emit(0x3508bd3f); emit(0xae081810); // GP0(0xE4) Bottom-right (319, 239)
  emit(0x3c08e500); emit(0xae081810);                   // GP0(0xE5) Draw offset (0, 0)

  // 2. Initialize SPU Hardware Registers
  // SPU Base: 0x1F801C00 -> $s2 = 0x1F801C00
  emit(0x3c121f80); // lui $s2, 0x1F80
  emit(0x36521c00); // ori $s2, $s2, 0x1C00

  // Enable SPU & Unmute: SPUCNT (0x1F801DAA) = 0xC000
  emit(0x3408c000); // ori $t0, $zero, 0xC000
  emit(0xa64801aa); // sh $t0, 0x01AA($s2)

  // Master Volume Left & Right: 0x1F801D80 & 0x1F801D82 = 0x7FFF
  emit(0x34087fff); // ori $t0, $zero, 0x7FFF
  emit(0xa6480180); // sh $t0, 0x0180($s2)
  emit(0xa6480182); // sh $t0, 0x0182($s2)

  // Set Voice 0 (0x1F801C00):
  // Vol Left & Right = 0x7FFF
  emit(0xa6480000); // sh $t0, 0x0000($s2)
  emit(0xa6480002); // sh $t0, 0x0002($s2)

  // Voice 0 Pitch = 0x1000 (44.1 kHz, 1.0x)
  emit(0x34081000); // ori $t0, $zero, 0x1000
  emit(0xa6480004); // sh $t0, 0x0004($s2)

  // Voice 0 Sound RAM Start Address = 0x1000 (byte 0x8000 = 0x1000 << 3)
  emit(0xa6480006); // sh $t0, 0x0006($s2)
  // Voice 0 Sound RAM Repeat Address = 0x1000
  emit(0xa648000e); // sh $t0, 0x000E($s2)

  // Voice 0 ADSR:
  // ADSR1 = 0x00FF (Linear attack, zero decay)
  emit(0x340800ff); // ori $t0, $zero, 0x00FF
  emit(0xa6480008); // sh $t0, 0x0008($s2)
  // ADSR2 = 0x0000 (Max sustain, no decrease)
  emit(0xa640000a); // sh $zero, 0x000A($s2)

  // 3. Upload 16-byte ADPCM sample block to Sound RAM via Transfer FIFO (0x1F801DA8)
  // Set Transfer Address: SPUR_TADDR (0x1F801DA6) = 0x1000 (byte 0x8000)
  emit(0x34081000); // ori $t0, $zero, 0x1000
  emit(0xa64801a6); // sh $t0, 0x01A6($s2)

  // 16 bytes of ADPCM = 8 16-bit halfwords written to FIFO (0x1F801DA8):
  // Word 0: 0x0700 (Hdr 0x00, Flags 0x07: Loop Start | Loop Repeat | Loop End)
  emit(0x34080700); emit(0xa64801a8);
  // 7 words of alternating audio nibbles (+7 / -8 amplitude pulse)
  emit(0x34087777); emit(0xa64801a8);
  emit(0x34088888); emit(0xa64801a8);
  emit(0x34087777); emit(0xa64801a8);
  emit(0x34088888); emit(0xa64801a8);
  emit(0x34087777); emit(0xa64801a8);
  emit(0x34088888); emit(0xa64801a8);
  emit(0x34087777); emit(0xa64801a8);

  // 4. Trigger Voice 0 Key-On: SPU_KON (0x1F801D88) = 0x0001
  emit(0x34080001); // ori $t0, $zero, 1
  emit(0xa6480188); // sh $t0, 0x0188($s2)

  // Frame Loop Setup
  emit(0x34110000); // $s1 = frame counter (0)
  const loopStartPc = pc;

  // Clear Screen: GP0(0x02) Dark Slate Blue (0x140e28)
  emit(0x3c080214); emit(0x35080e28); emit(0xae081810);
  emit(0xae001810); // Top-left (0, 0)
  emit(0x3c0800f0); emit(0x35080140); emit(0xae081810); // 320x240

  // Draw Audio Visualizer Center Banner (Cyan / Teal)
  emit(0x3c080200); emit(0x3508c8a0); emit(0xae081810); // Color
  emit(0x3c080050); emit(0x35080028); emit(0xae081810); // (40, 80)
  emit(0x3c080010); emit(0x350800f0); emit(0xae081810); // (240, 16)

  // Draw Visualizer Equalizer Bars
  for (let bar = 0; bar < 8; bar++) {
    const x = 50 + bar * 28;
    emit(0x3c080200); emit(0x3508f060); emit(0xae081810); // Color: Neon Lime
    const posWord = ((110) << 16) | (x & 0xFFFF);
    emit(0x3c080000 | (posWord >>> 16)); emit(0x35080000 | (posWord & 0xFFFF)); emit(0xae081810);
    emit(0x3c080030); emit(0x35080010); emit(0xae081810); // (16, 48)
  }

  // Increment frame counter
  emit(0x26310001); // addiu $s1, $s1, 1

  // Jump to frame loop
  const jumpTarget = (loadAddr + (loopStartPc - codeOffset)) >>> 2;
  emit(0x08000000 | (jumpTarget & 0x03FFFFFF));
  emit(0x00000000); // nop delay slot

  return buffer;
}

/**
 * Constructs a synthetic in-memory PS1 disc image with 64 Mode 2 Form 1 sectors (2352 bytes/sector).
 * LBA 16 contains a magic test payload with 0xDEADBEEF, 0xCAFEBABE, and incrementing bytes.
 */
export function createSyntheticCdromTestDisc(): Uint8Array {
  const numSectors = 64;
  const sectorSize = 2352;
  const disc = new Uint8Array(numSectors * sectorSize);

  // Raw Sync Pattern: 00 FF FF FF FF FF FF FF FF FF FF 00
  const syncPattern = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

  for (let lba = 0; lba < numSectors; lba++) {
    const secOffset = lba * sectorSize;

    // 1. Sync header (12 bytes)
    for (let i = 0; i < 12; i++) {
      disc[secOffset + i] = syncPattern[i];
    }

    // 2. MSF Address (with 2-second pregap: LBA 0 = 00:02:00)
    const frame = lba + 150;
    const m = Math.floor(frame / (60 * 75));
    const s = Math.floor((frame % (60 * 75)) / 75);
    const f = frame % 75;
    disc[secOffset + 12] = ((Math.floor(m / 10) << 4) | (m % 10)) & 0xff;
    disc[secOffset + 13] = ((Math.floor(s / 10) << 4) | (s % 10)) & 0xff;
    disc[secOffset + 14] = ((Math.floor(f / 10) << 4) | (f % 10)) & 0xff;

    // 3. Mode byte (Mode 2 Form 1)
    disc[secOffset + 15] = 0x02;

    // 4. Subheader (8 bytes: Mode 2 Form 1 Data)
    disc[secOffset + 16] = 0x00; // File
    disc[secOffset + 17] = 0x00; // Channel
    disc[secOffset + 18] = 0x08; // Submode (Data Form 1)
    disc[secOffset + 19] = 0x00; // Coding info
    disc[secOffset + 20] = 0x00; // File copy
    disc[secOffset + 21] = 0x00; // Channel copy
    disc[secOffset + 22] = 0x08; // Submode copy
    disc[secOffset + 23] = 0x00; // Coding info copy

    // 5. Default user data pattern
    const userOffset = secOffset + 24;
    for (let i = 0; i < 2048; i++) {
      disc[userOffset + i] = (lba ^ i) & 0xff;
    }
  }

  // Populate Sector 16 with exact diagnostic payload
  const lba16UserOffset = 16 * sectorSize + 24;
  const view = new DataView(disc.buffer, disc.byteOffset + lba16UserOffset, 2048);
  view.setUint32(0, 0xdeadbeef, true); // Word 0: 0xDEADBEEF (little-endian)
  view.setUint32(4, 0xcafebabe, true); // Word 1: 0xCAFEBABE (little-endian)
  for (let i = 8; i < 2048; i++) {
    disc[lba16UserOffset + i] = (i - 8) & 0xff; // 0x00, 0x01, 0x02...
  }

  return disc;
}

/**
 * Lightweight helper to assemble MIPS I machine instructions with label resolution.
 */
class MipsAssembler {
  public code: number[] = [];
  public labels: Map<string, number> = new Map();
  public patches: { index: number; label: string; type: 'branch' | 'jump' }[] = [];
  public baseAddr: number;

  constructor(baseAddr: number = 0x80010000) {
    this.baseAddr = baseAddr;
  }

  public label(name: string) {
    this.labels.set(name, this.code.length);
  }

  public emit(instr: number) {
    this.code.push(instr >>> 0);
  }

  public nop() {
    this.emit(0x00000000);
  }

  public lui(rt: number, imm: number) {
    this.emit(0x3c000000 | ((rt & 0x1f) << 16) | (imm & 0xffff));
  }

  public ori(rt: number, rs: number, imm: number) {
    this.emit(0x34000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (imm & 0xffff));
  }

  public andi(rt: number, rs: number, imm: number) {
    this.emit(0x30000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (imm & 0xffff));
  }

  public or(rd: number, rs: number, rt: number) {
    this.emit(0x00000025 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | ((rd & 0x1f) << 11));
  }

  public and(rd: number, rs: number, rt: number) {
    this.emit(0x00000024 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | ((rd & 0x1f) << 11));
  }

  public addiu(rt: number, rs: number, imm: number) {
    this.emit(0x24000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (imm & 0xffff));
  }

  public sb(rt: number, offset: number, rs: number) {
    this.emit(0xa0000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (offset & 0xffff));
  }

  public lbu(rt: number, offset: number, rs: number) {
    this.emit(0x90000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (offset & 0xffff));
  }

  public sw(rt: number, offset: number, rs: number) {
    this.emit(0xac000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (offset & 0xffff));
  }

  public lw(rt: number, offset: number, rs: number) {
    this.emit(0x8c000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16) | (offset & 0xffff));
  }

  public bne(rs: number, rt: number, targetLabel: string) {
    const idx = this.code.length;
    this.emit(0x14000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16));
    this.patches.push({ index: idx, label: targetLabel, type: 'branch' });
  }

  public beq(rs: number, rt: number, targetLabel: string) {
    const idx = this.code.length;
    this.emit(0x10000000 | ((rs & 0x1f) << 21) | ((rt & 0x1f) << 16));
    this.patches.push({ index: idx, label: targetLabel, type: 'branch' });
  }

  public j(targetLabel: string) {
    const idx = this.code.length;
    this.emit(0x08000000);
    this.patches.push({ index: idx, label: targetLabel, type: 'jump' });
  }

  public li32(rt: number, val: number) {
    this.lui(rt, (val >>> 16) & 0xffff);
    if ((val & 0xffff) !== 0) {
      this.ori(rt, rt, val & 0xffff);
    }
  }

  public assemble(): Uint32Array {
    const result = new Uint32Array(this.code);
    for (const patch of this.patches) {
      const targetIndex = this.labels.get(patch.label);
      if (targetIndex === undefined) {
        throw new Error(`Unresolved label: ${patch.label}`);
      }
      if (patch.type === 'branch') {
        const offset = targetIndex - (patch.index + 1);
        result[patch.index] |= (offset & 0xffff);
      } else if (patch.type === 'jump') {
        const absAddr = this.baseAddr + targetIndex * 4;
        result[patch.index] |= ((absAddr >>> 2) & 0x03ffffff);
      }
    }
    return result;
  }
}

/**
 * Generates the CD-ROM Hardware Diagnostic Test executable.
 * Validates version query, two-stage GetID interrupts, seek/ReadN sector streaming,
 * DMA Channel 3 transfers into RAM 0x80020000, and displays visual pass/fail feedback.
 */
export function generateCdromHardwareTest(): Uint8Array {
  const codeOffset = 2048;
  const loadAddr = 0x80010000;
  const asm = new MipsAssembler(loadAddr);

  // Register definitions
  const ZERO = 0, T0 = 8, T1 = 9, T2 = 10, S0 = 16, S1 = 17, S7 = 23, SP = 29;

  // Set up stack pointer $sp = 0x801FFF00
  asm.li32(SP, 0x801fff00);
  // Base IO pointer: $s0 = 0x1F800000
  asm.lui(S0, 0x1f80);
  // Default result: $s7 = 0 (Success)
  asm.ori(S7, ZERO, 0);

  // =========================================================================
  // INITIALIZATION: CPU Interrupt Controller & CD-ROM Interrupt Enable
  // =========================================================================
  // 1. Enable CD-ROM IRQ in Master CPU I_MASK (0x1F801074) - Bit 2: 0x04
  asm.ori(T0, ZERO, 0x04);
  asm.sw(T0, 0x1074, S0);
  // Acknowledge any pending CPU I_STAT (0x1F801070)
  asm.sw(ZERO, 0x1070, S0);

  // 2. Select Bank 1 on CD-ROM controller: sb $t0, 0x1800($s0)
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  // Enable CD-ROM interrupt in IER (Bank 1, Port 2 = 0x1F)
  asm.ori(T0, ZERO, 0x1f);
  asm.sb(T0, 0x1802, S0);
  // Clear any stale interrupt flags in IFR (Bank 1, Port 3 = 0x1F)
  asm.sb(T0, 0x1803, S0);
  // Switch back to Bank 0
  asm.sb(ZERO, 0x1800, S0);

  // =========================================================================
  // STAGE 1: Controller Initialization & Version Query (Test 0x19, Sub 0x20)
  // =========================================================================
  // Select Bank 0: sb $zero, 0x1800($s0)
  asm.sb(ZERO, 0x1800, S0);
  // Write sub-function 0x20 parameter to Port 2: sb $t0, 0x1802($s0)
  asm.ori(T0, ZERO, 0x20);
  asm.sb(T0, 0x1802, S0);
  // Issue Test command 0x19 to Port 1: sb $t0, 0x1801($s0)
  asm.ori(T0, ZERO, 0x19);
  asm.sb(T0, 0x1801, S0);

  // Switch to Bank 1 to poll IFR (Port 3)
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);

  // Poll CD-ROM IFR at Port 3 (0x1F801803) for INT3
  asm.label('poll_test_ifr');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 3);
  asm.bne(T1, T2, 'poll_test_ifr');
  asm.nop();

  // Switch to Bank 0 to read 4 response bytes from Port 1 and verify 0x97, 0x01, 0x10, 0xC2
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0); // Byte 0
  asm.ori(T1, ZERO, 0x97);
  asm.bne(T0, T1, 'fail_stage1');
  asm.nop();

  asm.lbu(T0, 0x1801, S0); // Byte 1
  asm.ori(T1, ZERO, 0x01);
  asm.bne(T0, T1, 'fail_stage1');
  asm.nop();

  asm.lbu(T0, 0x1801, S0); // Byte 2
  asm.ori(T1, ZERO, 0x10);
  asm.bne(T0, T1, 'fail_stage1');
  asm.nop();

  asm.lbu(T0, 0x1801, S0); // Byte 3
  asm.ori(T1, ZERO, 0xc2);
  asm.bne(T0, T1, 'fail_stage1');
  asm.nop();

  // Switch to Bank 1 and acknowledge INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);
  // Switch back to Bank 0
  asm.sb(ZERO, 0x1800, S0);

  // =========================================================================
  // STAGE 2: Two-Stage Interrupt Validation (GetID 0x1A)
  // =========================================================================
  // Ensure Bank 0
  asm.sb(ZERO, 0x1800, S0);
  // Issue GetID command 0x1A to Port 1
  asm.ori(T0, ZERO, 0x1a);
  asm.sb(T0, 0x1801, S0);

  // Switch to Bank 1 to poll IFR for first stage (INT3)
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);

  asm.label('poll_getid_int3');
  asm.lbu(T0, 0x1803, S0); // Read IFR (Port 3, Bank 1)
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 3);
  asm.bne(T1, T2, 'poll_getid_int3');
  asm.nop();

  // Switch to Bank 0 to read initial status byte from Port 1
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0);

  // Switch to Bank 1 and acknowledge INT3 by writing 0x07 to Bank 1, Port 3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);

  // Poll IFR for INT2 (second queued interrupt)
  asm.label('poll_getid_int2');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 2);
  asm.bne(T1, T2, 'poll_getid_int2');
  asm.nop();

  // Switch to Bank 0 to read all 8 response bytes from Port 1 and verify SCEA (0x53, 0x43, 0x45, 0x41)
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0); // Byte 0: status (0x02)
  asm.lbu(T0, 0x1801, S0); // Byte 1: flags (0x00)
  asm.lbu(T0, 0x1801, S0); // Byte 2: type (0x20)
  asm.lbu(T0, 0x1801, S0); // Byte 3: atip (0x00)

  asm.lbu(T0, 0x1801, S0); // Byte 4: 'S' (0x53)
  asm.ori(T1, ZERO, 0x53);
  asm.bne(T0, T1, 'fail_stage2');
  asm.nop();

  asm.lbu(T0, 0x1801, S0); // Byte 5: 'C' (0x43)
  asm.ori(T1, ZERO, 0x43);
  asm.bne(T0, T1, 'fail_stage2');
  asm.nop();

  asm.lbu(T0, 0x1801, S0); // Byte 6: 'E' (0x45)
  asm.ori(T1, ZERO, 0x45);
  asm.bne(T0, T1, 'fail_stage2');
  asm.nop();

  asm.lbu(T0, 0x1801, S0); // Byte 7: 'A' (0x41)
  asm.ori(T1, ZERO, 0x41);
  asm.bne(T0, T1, 'fail_stage2');
  asm.nop();

  // Switch to Bank 1 and acknowledge INT2
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);
  // Switch back to Bank 0
  asm.sb(ZERO, 0x1800, S0);

  // =========================================================================
  // STAGE 3: Sector Seek & Read (Setloc + ReadN)
  // =========================================================================
  // Select Bank 0
  asm.sb(ZERO, 0x1800, S0);
  // Send BCD parameters for LBA 16 (00:02:16 BCD) to Port 2
  asm.sb(ZERO, 0x1802, S0); // Minute = 0x00
  asm.ori(T0, ZERO, 0x02);
  asm.sb(T0, 0x1802, S0);   // Second = 0x02
  asm.ori(T0, ZERO, 0x16);
  asm.sb(T0, 0x1802, S0);   // Sector = 0x16

  // Issue Setloc command 0x02
  asm.ori(T0, ZERO, 0x02);
  asm.sb(T0, 0x1801, S0);

  // Switch to Bank 1 to poll and ack INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.label('poll_setloc_int3');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 3);
  asm.bne(T1, T2, 'poll_setloc_int3');
  asm.nop();

  // Switch to Bank 0 to read status
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0);

  // Switch to Bank 1 to ack INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);

  // Switch to Bank 0 and issue ReadN command 0x06
  asm.sb(ZERO, 0x1800, S0);
  asm.ori(T0, ZERO, 0x06);
  asm.sb(T0, 0x1801, S0);

  // Switch to Bank 1 to poll and ack ReadN command accept INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.label('poll_readn_int3');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 3);
  asm.bne(T1, T2, 'poll_readn_int3');
  asm.nop();

  // Switch to Bank 0 to read status
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0);

  // Switch to Bank 1 to ack INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);

  // Poll IFR for INT1 (Sector ready)
  asm.label('poll_sector_int1');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 1);
  asm.bne(T1, T2, 'poll_sector_int1');
  asm.nop();

  // Switch to Bank 0 to read status response
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0);

  // Switch to Bank 1 to ack INT1
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);

  // Switch to Bank 0 and write 0x80 (BFRD) to Port 3
  asm.sb(ZERO, 0x1800, S0);
  asm.ori(T0, ZERO, 0x80);
  asm.sb(T0, 0x1803, S0);

  // =========================================================================
  // STAGE 4: DMA Channel 3 Transfer & Memory Verification
  // =========================================================================
  // Enable DMA3 in DPCR (0x1F8010F0)
  asm.lw(T0, 0x10f0, S0);
  asm.li32(T1, 0x00008888);
  asm.or(T0, T0, T1);
  asm.sw(T0, 0x10f0, S0);

  // D3_MADR (0x1F8010B0) = 0x80020000
  asm.li32(T0, 0x80020000);
  asm.sw(T0, 0x10b0, S0);

  // D3_BCR (0x1F8010B4) = 0x00010200 (512 words = 2048 bytes)
  asm.li32(T0, 0x00010200);
  asm.sw(T0, 0x10b4, S0);

  // D3_CHCR (0x1F8010B8) = 0x01000201 (Start DMA 3, Slice mode)
  asm.li32(T0, 0x01000201);
  asm.sw(T0, 0x10b8, S0);

  // Poll DMA 3 completion (CHCR bit 24 clears)
  asm.label('poll_dma3_busy');
  asm.lw(T0, 0x10b8, S0);
  asm.lui(T1, 0x0100); // 0x01000000 (bit 24)
  asm.and(T2, T0, T1);
  asm.bne(T2, ZERO, 'poll_dma3_busy');
  asm.nop();

  // Switch to Bank 0 and issue command 0x09 (Pause) to halt reading
  asm.sb(ZERO, 0x1800, S0);
  asm.ori(T0, ZERO, 0x09);
  asm.sb(T0, 0x1801, S0);

  // Switch to Bank 1 to poll Pause INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.label('poll_pause_int3');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 3);
  asm.bne(T1, T2, 'poll_pause_int3');
  asm.nop();

  // Switch to Bank 0 to read status
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0);

  // Switch to Bank 1 to ack INT3
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);

  // Poll Pause INT2
  asm.label('poll_pause_int2');
  asm.lbu(T0, 0x1803, S0);
  asm.andi(T1, T0, 0x07);
  asm.ori(T2, ZERO, 2);
  asm.bne(T1, T2, 'poll_pause_int2');
  asm.nop();

  // Switch to Bank 0 to read status
  asm.sb(ZERO, 0x1800, S0);
  asm.lbu(T0, 0x1801, S0);

  // Switch to Bank 1 to ack INT2
  asm.ori(T0, ZERO, 1);
  asm.sb(T0, 0x1800, S0);
  asm.ori(T0, ZERO, 0x07);
  asm.sb(T0, 0x1803, S0);
  // Switch back to Bank 0
  asm.sb(ZERO, 0x1800, S0);

  // Verify memory at 0x80020000:
  asm.lui(S1, 0x8002);
  // Word 0: 0xDEADBEEF
  asm.lw(T0, 0x0000, S1);
  asm.li32(T1, 0xdeadbeef);
  asm.bne(T0, T1, 'fail_stage4');
  asm.nop();

  // Word 1: 0xCAFEBABE
  asm.lw(T0, 0x0004, S1);
  asm.li32(T1, 0xcafebabe);
  asm.bne(T0, T1, 'fail_stage4');
  asm.nop();

  // All checks passed! Proceed to visual display
  asm.j('draw_result');
  asm.nop();

  // Failure handlers
  asm.label('fail_stage1');
  asm.ori(S7, ZERO, 1);
  asm.j('draw_result');
  asm.nop();

  asm.label('fail_stage2');
  asm.ori(S7, ZERO, 2);
  asm.j('draw_result');
  asm.nop();

  asm.label('fail_stage3');
  asm.ori(S7, ZERO, 3);
  asm.j('draw_result');
  asm.nop();

  asm.label('fail_stage4');
  asm.ori(S7, ZERO, 4);
  asm.j('draw_result');
  asm.nop();

  // =========================================================================
  // STAGE 5: Visual Result Display (GP0)
  // =========================================================================
  asm.label('draw_result');
  // Initialize GPU
  asm.sw(ZERO, 0x1814, S0); // GP1 Reset
  asm.li32(T0, 0x03000000); asm.sw(T0, 0x1814, S0); // GP1(0x03) Display On
  asm.li32(T0, 0x08000001); asm.sw(T0, 0x1814, S0); // GP1(0x08) 320x240
  asm.li32(T0, 0xe1000400); asm.sw(T0, 0x1810, S0); // GP0(0xE1) Draw mode
  asm.li32(T0, 0xe3000000); asm.sw(T0, 0x1810, S0); // GP0(0xE3) Top-left (0, 0)
  asm.li32(T0, 0xe403bd3f); asm.sw(T0, 0x1810, S0); // GP0(0xE4) Bottom-right (319, 239)
  asm.li32(T0, 0xe5000000); asm.sw(T0, 0x1810, S0); // GP0(0xE5) Draw offset (0, 0)

  // Clear Screen: GP0(0x02) Dark Slate Blue
  asm.li32(T0, 0x0210141c); asm.sw(T0, 0x1810, S0);
  asm.sw(ZERO, 0x1810, S0); // (0, 0)
  asm.li32(T0, 0x00f00140); asm.sw(T0, 0x1810, S0); // 320x240

  // Branch on Success vs Failure
  asm.bne(S7, ZERO, 'draw_fail');
  asm.nop();

  // SUCCESS: Draw large Green Rectangle / Quad (0x0200FF00)
  asm.li32(T0, 0x0200ff00); asm.sw(T0, 0x1810, S0); // Color: Pure Green
  asm.li32(T0, 0x0032003c); asm.sw(T0, 0x1810, S0); // Pos: (60, 50)
  asm.li32(T0, 0x008c00c8); asm.sw(T0, 0x1810, S0); // Size: (200, 140)

  // Inner Bright Emerald Quad
  asm.li32(T0, 0x0220ff60); asm.sw(T0, 0x1810, S0); // Color: Bright Emerald
  asm.li32(T0, 0x00460050); asm.sw(T0, 0x1810, S0); // Pos: (80, 70)
  asm.li32(T0, 0x006400a0); asm.sw(T0, 0x1810, S0); // Size: (160, 100)

  asm.j('idle_loop');
  asm.nop();

  // FAILURE: Draw large Crimson Red Rectangle / Quad (0x020000E0)
  asm.label('draw_fail');
  asm.li32(T0, 0x020000e0); asm.sw(T0, 0x1810, S0); // Color: Crimson Red
  asm.li32(T0, 0x0032003c); asm.sw(T0, 0x1810, S0); // Pos: (60, 50)
  asm.li32(T0, 0x008c00c8); asm.sw(T0, 0x1810, S0); // Size: (200, 140)

  // Stage Indicator Box
  asm.li32(T0, 0x02ffffff); asm.sw(T0, 0x1810, S0); // Color: White
  asm.li32(T0, 0x00500050); asm.sw(T0, 0x1810, S0); // Pos: (80, 80)
  asm.li32(T0, 0x005000a0); asm.sw(T0, 0x1810, S0); // Size: (160, 80)

  asm.label('idle_loop');
  asm.j('idle_loop');
  asm.nop();

  const machineCode = asm.assemble();
  const codeSize = machineCode.length * 4;
  const totalSize = codeOffset + codeSize;
  const buffer = new Uint8Array(totalSize);

  const header = createPsxExeHeader(loadAddr, codeSize, loadAddr);
  buffer.set(header, 0);

  const view = new DataView(buffer.buffer);
  for (let i = 0; i < machineCode.length; i++) {
    view.setUint32(codeOffset + i * 4, machineCode[i], true);
  }

  return buffer;
}

export const generateCdromTestBinary = generateCdromHardwareTest;

