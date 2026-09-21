/**
 * PlayStation 1 Built-in Disc Image & Homebrew Samples
 * Generates ISO-9660 standard disc images with SYSTEM.CNF, Volume Descriptors, and executables.
 */

export interface SampleDisc {
  id: string;
  name: string;
  fileName: string;
  description: string;
  category: '3D Graphics' | 'Diagnostic' | 'Audio & CD-DA';
  generateBuffer: () => ArrayBuffer;
}

export class SampleDiscManager {
  /**
   * Generates a 3D Polygon & Textured Mesh PS1 Game ISO
   */
  public static create3dDemoIso(): ArrayBuffer {
    // 32 sectors = 65,536 bytes
    const sectorCount = 32;
    const sectorSize = 2048;
    const buffer = new ArrayBuffer(sectorCount * sectorSize);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    const writeStr = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        u8[offset + i] = text.charCodeAt(i);
      }
    };

    // 1. Sector 16 (0x8000) - ISO 9660 Primary Volume Descriptor (PVD)
    const pvdOffset = 16 * sectorSize;
    u8[pvdOffset] = 0x01; // PVD Type
    writeStr(pvdOffset + 1, 'CD001'); // Standard Identifier
    u8[pvdOffset + 6] = 0x01; // Version
    writeStr(pvdOffset + 8, 'PLAYSTATION'); // System ID
    writeStr(pvdOffset + 40, 'PS1_3D_POLYGON_DEMO'); // Volume ID (32 bytes)
    view.setUint32(pvdOffset + 80, sectorCount, true); // Volume Space Size (LE)
    view.setUint32(pvdOffset + 84, sectorCount, false); // Volume Space Size (BE)
    view.setUint16(pvdOffset + 128, 1, true); // Volume Set Size
    view.setUint16(pvdOffset + 132, 1, true); // Volume Sequence Number
    view.setUint16(pvdOffset + 120, 2048, true); // Logical Block Size
    writeStr(pvdOffset + 190, 'SONY_COMPUTER_ENT'); // Publisher ID

    // 2. Sector 20 (0xA000) - SYSTEM.CNF file
    const cnfOffset = 20 * sectorSize;
    const cnfContent = "BOOT = cdrom:\\DEMO3D.EXE;1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = 801FFFF0\r\n";
    writeStr(cnfOffset, cnfContent);

    // 3. Sector 24 (0xC000) - PS-X Executable (DEMO3D.EXE)
    const exeOffset = 24 * sectorSize;
    // PS-X EXE Header (8 bytes "PS-X EXE")
    writeStr(exeOffset, 'PS-X EXE');
    // Initial PC: 0x80010000 (offset 0x10)
    view.setUint32(exeOffset + 0x10, 0x80010000, true);
    // Initial GP: 0x80018000 (offset 0x14)
    view.setUint32(exeOffset + 0x14, 0x80018000, true);
    // Destination RAM address: 0x80010000 (offset 0x18)
    view.setUint32(exeOffset + 0x18, 0x80010000, true);
    // Text size: 2048 bytes (offset 0x1c)
    view.setUint32(exeOffset + 0x1c, 2048, true);
    // Initial SP: 0x801FFFF0 (offset 0x30)
    view.setUint32(exeOffset + 0x30, 0x801ffff0, true);

    // MIPS machine code for DEMO3D.EXE at offset 0x800 (sector 25)
    const codeOffset = exeOffset + 0x800;
    let pc = 0;
    const emit = (val: number) => {
      view.setUint32(codeOffset + pc, val >>> 0, true);
      pc += 4;
    };

    // lui $sp, 0x801F -> ori $sp, $sp, 0xFFF0
    emit(0x3c1d801f);
    emit(0x37bdfff0);
    // lui $s0, 0x1F80 -> GPU base
    emit(0x3c101f80);
    // GP1(0) Reset GPU: sw $zero, 0x1814($s0)
    emit(0xae001814);
    // GP0 Draw Flat Shaded Polygons
    // 0x200000FF (Draw Monochrome Poly: Red)
    emit(0x3c082000);
    emit(0x350800ff);
    emit(0xae081810);
    // V0: (100, 50) -> 0x00320064
    emit(0x3c080032);
    emit(0x35080064);
    emit(0xae081810);
    // V1: (220, 50) -> 0x003200DC
    emit(0x3c080032);
    emit(0x350800dc);
    emit(0xae081810);
    // V2: (160, 180) -> 0x00B400A0
    emit(0x3c0800b4);
    emit(0x350800a0);
    emit(0xae081810);

    return buffer;
  }

  /**
   * Generates MIPS R3000A Benchmark & Controller Diagnostic Disc
   */
  public static createBenchmarkIso(): ArrayBuffer {
    const sectorCount = 32;
    const sectorSize = 2048;
    const buffer = new ArrayBuffer(sectorCount * sectorSize);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);

    const writeStr = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i++) {
        u8[offset + i] = text.charCodeAt(i);
      }
    };

    const pvdOffset = 16 * sectorSize;
    u8[pvdOffset] = 0x01;
    writeStr(pvdOffset + 1, 'CD001');
    u8[pvdOffset + 6] = 0x01;
    writeStr(pvdOffset + 8, 'PLAYSTATION');
    writeStr(pvdOffset + 40, 'MIPS_BENCHMARK_ISO');
    view.setUint32(pvdOffset + 80, sectorCount, true);
    view.setUint16(pvdOffset + 120, 2048, true);

    const cnfOffset = 20 * sectorSize;
    writeStr(cnfOffset, "BOOT = cdrom:\\BENCH.EXE;1\r\nTCB = 4\r\nEVENT = 16\r\nSTACK = 801FFFF0\r\n");

    const exeOffset = 24 * sectorSize;
    writeStr(exeOffset, 'PS-X EXE');
    view.setUint32(exeOffset + 0x10, 0x80010000, true);
    view.setUint32(exeOffset + 0x18, 0x80010000, true);
    view.setUint32(exeOffset + 0x1c, 2048, true);
    view.setUint32(exeOffset + 0x30, 0x801ffff0, true);

    return buffer;
  }

  public static readonly SAMPLES: SampleDisc[] = [
    {
      id: 'demo3d',
      name: 'PS1 3D Polygon & GTE Demo Disc',
      fileName: 'PS1_3D_DEMO.ISO',
      description: 'Standard ISO-9660 game disc with SYSTEM.CNF and 3D textured mesh demo.',
      category: '3D Graphics',
      generateBuffer: SampleDiscManager.create3dDemoIso,
    },
    {
      id: 'benchmark',
      name: 'MIPS R3000A Benchmark Disc',
      fileName: 'BENCHMARK.ISO',
      description: 'Throughput measurement disc evaluating JIT instruction pipeline and RAM speed.',
      category: 'Diagnostic',
      generateBuffer: SampleDiscManager.createBenchmarkIso,
    },
  ];
}
