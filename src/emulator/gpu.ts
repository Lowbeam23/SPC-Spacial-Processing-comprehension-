/**
 * PlayStation 1 GPU Core (Sony PS1 Graphic Processing Unit)
 * Handles GP0 command list, GP1 status/control, DMA 2 transfers,
 * 1MB 15bpp BGR555 VRAM, batched vertex dispatch, and canvas display generation.
 */

import { GpuState } from '../types';
import { logWarnRateLimited } from './logger';

export const DITHER_MATRIX: number[] = [
  -4,  0, -3,  1,
   2, -2,  3, -1,
  -3,  1, -4,  0,
   3, -1,  2, -2
];

export function applyDither(val8: number, x: number, y: number, enabled: boolean): number {
  if (!enabled) {
    return Math.min(31, Math.max(0, val8 >> 3));
  }
  const d = DITHER_MATRIX[((y & 3) << 2) | (x & 3)];
  const v = val8 + d;
  const clamped = v < 0 ? 0 : v > 255 ? 255 : v;
  return clamped >> 3;
}

export function decodeCoord(val: number): number {
  // Sign-extend 11-bit integer (-1024 to +1023)
  const c = val & 0x7FF;
  return (c >= 0x400) ? (c - 0x800) : c;
}

export function signExtend11(val: number): number {
  return (val << 21) >> 21;
}

/**
 * Maps GP0 opcodes to their fixed packet word counts
 */
export function getGp0PacketLength(commandWord: number): number {
  let opcode = (commandWord >>> 24) & 0xff;
  if (opcode === 0 && (commandWord & 0xff) !== 0) {
    opcode = commandWord & 0xff;
  }

  // Environment & settings commands (1 word)
  if (opcode >= 0xe1 && opcode <= 0xe6) return 1;
  if (opcode === 0x02) return 3; // Fill Rect (cmd+color, X+Y, W+H)
  if (opcode >= 0x00 && opcode <= 0x1f) return 1; // Single-word NOPs and control (0x00..0x1F)

  // Polygons (0x20 - 0x3F)
  switch (opcode & 0xfc) {
    case 0x20: return 4;  // 0x20-0x23: 3-point flat triangle (C0, V0, V1, V2)
    case 0x24: return 7;  // 0x24-0x27: 3-point textured triangle (C0, V0, T0, V1, T1, V2, T2)
    case 0x28: return 5;  // 0x28-0x2B: 4-point flat quad (C0, V0, V1, V2, V3)
    case 0x2c: return 9;  // 0x2C-0x2F: 4-point textured quad (C0, V0, T0, V1, T1, V2, T2, V3, T3)
    case 0x30: return 6;  // 0x30-0x33: 3-point shaded triangle (C0, V0, C1, V1, C2, V2)
    case 0x34: return 9;  // 0x34-0x37: 3-point shaded textured triangle (C0, V0, T0, C1, V1, T1, C2, V2, T2)
    case 0x38: return 8;  // 0x38-0x3B: 4-point shaded quad (C0, V0, C1, V1, C2, V2, C3, V3)
    case 0x3c: return 12; // 0x3C-0x3F: 4-point shaded textured quad (C0, V0, T0, C1, V1, T1, C2, V2, T2, C3, V3, T3)
  }

  // Rectangles / Sprites (0x60 - 0x7F)
  if (opcode >= 0x60 && opcode <= 0x7f) {
    const isTextured = (opcode & 0x04) !== 0;
    const sizeType = (opcode >>> 3) & 0x3;
    let rectWords = 2; // cmd+color, coord
    if (isTextured) rectWords += 1; // UV+CLUT
    if (sizeType === 0) rectWords += 1; // Variable size (W+H)
    return rectWords;
  }

  // Lines (0x40 - 0x5F)
  if (opcode >= 0x40 && opcode <= 0x47) return 3;
  if (opcode >= 0x48 && opcode <= 0x4f) return 0xffff; // Polyline (variable length)
  if (opcode >= 0x50 && opcode <= 0x57) return 4;
  if (opcode >= 0x58 && opcode <= 0x5f) return 0xffff; // Polyline Gouraud (variable length)

  // VRAM transfer commands
  if (opcode >= 0x80 && opcode <= 0x9f) return 4; // Copy VRAM to VRAM
  if (opcode >= 0xa0 && opcode <= 0xdf) return 3; // CPU to VRAM / Image Transfer header

  return 1;
}

export class Gpu {
  private _width: number = 320;
  private _height: number = 240;

  public get width(): number {
    const stat = this.gpuStat;
    const hres2 = (stat >>> 16) & 0x01;
    const hres1 = (stat >>> 17) & 0x03;
    if (hres2 === 1) {
      return 368;
    }
    switch (hres1) {
      case 0: return 256;
      case 1: return 320;
      case 2: return 512;
      case 3: return 640;
    }
    return this._width || 320;
  }

  public set width(val: number) {
    this._width = val;
  }

  public get height(): number {
    return this._height || 240;
  }

  public set height(val: number) {
    this._height = val;
  }

  public get displayWidth(): number {
    return this.width || 320;
  }
  public set displayWidth(val: number) {
    this.width = val;
  }
  public get displayHeight(): number {
    return this.height || 240;
  }
  public set displayHeight(val: number) {
    this.height = val;
  }
  public hasLoggedVramActive: boolean = false;
  public hasSeenLowResLogo: boolean = false;
  public hasReachedGuiMode: boolean = false;
  public hasBootBenchmarked: boolean = false;
  public onBootBenchmark?: () => void;
  public hasLoggedFirstPixel: boolean = false;
  public hasLoggedCanvasPresented: boolean = false;
  public hasLoggedOpcodeA0: boolean = false;
  public hasLoggedOpcode64: boolean = false;
  public vram: Uint16Array = new Uint16Array(1024 * 512); // 1MB 15bpp BGR555 VRAM

  // One-frame diagnostic sniffer for DMA2 processing
  public hasLoggedDmaDiagnostic: boolean = false;
  public isRecordingDmaDiagnostic: boolean = false;
  public dmaOpcodeCounts: Map<number, number> = new Map();
  public dmaClipRejections: number = 0;
  public dmaTotalCommands: number = 0;
  public gouraud30Count: number = 0;
  public gouraud38Count: number = 0;
  public hasLoggedGouraudDiagnostic: boolean = false;

  // Display area in VRAM
  public displayStartX: number = 0;
  public displayStartY: number = 0;
  public get gpuStatDisplayStartX(): number {
    return this.displayStartX; // GP1(0x05) bits 0-9
  }
  public get gpuStatDisplayStartY(): number {
    return this.displayStartY; // GP1(0x05) bits 10-18
  }
  public isLoggingPaused: boolean = false;
  public debugLogging: boolean = false;

  public isVblankTriggered(): boolean {
    return this.vblank;
  }

  public present(): void {
    if (this.onFrame) {
      this.onFrame();
    } else {
      this.blitFrame();
    }
  }
  public displayHorizRange: number = 0x00c40200;
  public displayVertRange: number = 0x00040010;

  // Drawing area & Clipping window (GP0 E3h/E4h)
  public drawAreaX1: number = 0;
  public drawAreaY1: number = 0;
  public drawAreaX2: number = 1023;
  public drawAreaY2: number = 511;

  public get clipX1(): number { return this.drawAreaX1; }
  public get clipY1(): number { return this.drawAreaY1; }
  public get clipX2(): number { return this.drawAreaX2; }
  public get clipY2(): number { return this.drawAreaY2; }

  public get drawingAreaX1(): number { return this.drawAreaX1; }
  public set drawingAreaX1(val: number) { this.drawAreaX1 = val; }
  public get drawingAreaY1(): number { return this.drawAreaY1; }
  public set drawingAreaY1(val: number) { this.drawAreaY1 = val; }
  public get drawingAreaX2(): number { return this.drawAreaX2; }
  public set drawingAreaX2(val: number) { this.drawAreaX2 = val; }
  public get drawingAreaY2(): number { return this.drawAreaY2; }
  public set drawingAreaY2(val: number) { this.drawAreaY2 = val; }

  public get drawingAreaLeft(): number { return this.drawAreaX1; }
  public set drawingAreaLeft(val: number) { this.drawAreaX1 = val; }
  public get drawingAreaTop(): number { return this.drawAreaY1; }
  public set drawingAreaTop(val: number) { this.drawAreaY1 = val; }
  public get drawingAreaRight(): number { return this.drawAreaX2; }
  public set drawingAreaRight(val: number) { this.drawAreaX2 = val; }
  public get drawingAreaBottom(): number { return this.drawAreaY2; }
  public set drawingAreaBottom(val: number) { this.drawAreaY2 = val; }

  public get displayVramX(): number { return this.displayStartX; }
  public set displayVramX(val: number) { this.displayStartX = val & 0x3ff; }
  public get displayVramY(): number { return this.displayStartY; }
  public set displayVramY(val: number) { this.displayStartY = val & 0x1ff; }
  public gp1DisplayAreaSet: boolean = false;

  // Drawing offset (GP0 E5h)
  public drawOffsetX: number = 0;
  public drawOffsetY: number = 0;

  public get drawingOffsetX(): number { return this.drawOffsetX; }
  public set drawingOffsetX(val: number) { this.drawOffsetX = val; }
  public get drawingOffsetY(): number { return this.drawOffsetY; }
  public set drawingOffsetY(val: number) { this.drawOffsetY = val; }

  public debugDrawCount: number = 0;

  // Drawing mode flags (GP0 E1h)
  public drawMode: number = 0;
  public get currentTexpage(): number {
    return this.drawMode & 0xffff;
  }
  public set currentTexpage(val: number) {
    this.drawMode = (this.drawMode & ~0xffff) | (val & 0xffff);
  }
  public get texpage(): number {
    return this.drawMode & 0xffff;
  }
  public textureWindow: number = 0;
  public get texWindowMaskX(): number { return this.textureWindow & 0x1f; }
  public get texWindowMaskY(): number { return (this.textureWindow >>> 5) & 0x1f; }
  public get texWindowOffsetX(): number { return (this.textureWindow >>> 10) & 0x1f; }
  public get texWindowOffsetY(): number { return (this.textureWindow >>> 15) & 0x1f; }
  public maskBit: number = 0;
  public checkMaskBit: boolean = false;

  // GPU Status Register (GP1 response)
  // Default: 0x14002000 (Ready for GP0 command, Ready for VRAM read, Ready for DMA, Display enabled)
  public gpuStat: number = 0x14002000;
  public gpuReadValue: number = 0;

  public vblank: boolean = false;
  public framesRendered: number = 0;
  public displayDisabled: boolean = false; // Force default to enabled (displayDisabled = false) for debugging
  public displayEnabled: boolean = true;
  public gp1DisplayToggled: boolean = false;
  public targetCanvasCtx: CanvasRenderingContext2D | null = null;
  public currentScanline: number = 0;
  public currentField: number = 0; // 0 = even field, 1 = odd field
  public isInterlaced: boolean = false;
  public is24BitColor: boolean = false;

  public nextDisplayX: number = 0;
  public nextDisplayY: number = 0;
  public activeDisplayX: number = 0;
  public activeDisplayY: number = 0;

  public completedFrame: ImageData | null = null;
  public frameReady: boolean = false;

  public onVBlank(): void {
    this.activeDisplayX = this.nextDisplayX;
    this.activeDisplayY = this.nextDisplayY;
    this.extractFrame();
    this.frameReady = true;
  }

  public get displayX(): number { return this.activeDisplayX; }
  public get displayY(): number { return this.activeDisplayY; }

  public get isBlanked(): boolean {
    return this.displayDisabled;
  }

  public framePackets: number = 0;
  public blitFrameCount: number = 0;

  // Screen Presentation Diagnostic Tracking
  public lastLogDispW: number = -1;
  public lastLogDispH: number = -1;
  public lastLogStartX: number = -1;
  public lastLogStartY: number = -1;
  public lastLogNonZeroCount: number = -1;
  public lastLogTime: number = 0;
  public onScreenChange?: (message: string) => void;
  public blitCheckLoggedCount: number = 0;

  // Polygon opcode logger
  public polygonLogCount: number = 0;
  private diagnosticLoggedOnce: boolean = false;
  private hasLogged0x30Clip: boolean = false;
  private rect0x65LogCount: number = 0;
  private buttonQuadLogCount: number = 0;
  private zoneTrapLogCount: number = 0;
  private fillTrapLogCount: number = 0;

  // Batched vertex buffer: [x, y, r, g, b, a] for high-performance batching
  public vertexBuffer: Float32Array = new Float32Array(65536 * 6);
  public vertexCount: number = 0;

  // GP0 command FIFO & Packet state machine
  public gp0Buffer: number[] = [];
  public gp0WordsRemaining: number = 0;

  // Transfer state for GP0(0xA0) CPU-to-VRAM
  public transferDstX: number = 0;
  public transferDstY: number = 0;
  public transferWidth: number = 0;
  public transferHeight: number = 0;
  public transferCurX: number = 0;
  public transferCurY: number = 0;
  private _transferWordsRemaining: number = 0;

  // Transfer state for GP0(0xC0) VRAM-to-CPU
  public readDstX: number = 0;
  public readDstY: number = 0;
  public readWidth: number = 0;
  public readHeight: number = 0;
  public readCurX: number = 0;
  public readCurY: number = 0;
  public readWordsRemaining: number = 0;

  public get transferWordsRemaining(): number {
    return this._transferWordsRemaining;
  }

  public set transferWordsRemaining(val: number) {
    this._transferWordsRemaining = val;
  }
  public currentGp0Cmd: number = 0;

  public get transferX(): number { return this.transferDstX; }
  public set transferX(v: number) { this.transferDstX = v; }
  public get transferY(): number { return this.transferDstY; }
  public set transferY(v: number) { this.transferDstY = v; }
  public get transferW(): number { return this.transferWidth; }
  public set transferW(v: number) { this.transferWidth = v; }
  public get transferH(): number { return this.transferHeight; }
  public set transferH(v: number) { this.transferHeight = v; }
  public get transferCurrentX(): number { return this.transferCurX; }
  public set transferCurrentX(v: number) { this.transferCurX = v; }
  public get transferCurrentY(): number { return this.transferCurY; }
  public set transferCurrentY(v: number) { this.transferCurY = v; }
  public get transferTotalWords(): number {
    return this.transferWordsRemaining;
  }
  public set transferTotalWords(val: number) {
    this.transferWordsRemaining = val;
  }
  public isImageTransfer: boolean = false;

  /**
   * Called at the end of a DMA Channel 2 linked-list packet node.
   * On PS1 hardware, the GPU FIFO is a continuous stream across DMA nodes.
   */
  public endDmaPacket(): void {
    // Preserve FIFO stream across DMA node boundaries
  }

  // Reusable rendering canvas
  private offscreenCanvas?: HTMLCanvasElement;
  private offscreenCtx?: CanvasRenderingContext2D | null;
  private offscreenImgData?: ImageData;
  private imgDataBuf32?: Uint32Array;

  // Callbacks
  public onFrame?: () => void;
  public onLog?: (type: 'gpu' | 'warn' | 'error', msg: string) => void;

  constructor() {
    this.reset();
  }

  private checkGuiBootBenchmark(): void {
    if (!this.hasBootBenchmarked && this.hasSeenLowResLogo && this.displayWidth === 640 && (this.displayHeight === 480 || this.isInterlaced)) {
      this.hasBootBenchmarked = true;
      if (this.onBootBenchmark) {
        this.onBootBenchmark();
      }
    }
  }

  public reset(): void {
    this.vram.fill(0);
    this.gpuStat = 0x14002000;
    this.gpuReadValue = 0;
    this.width = 320;
    this.height = 240;
    this.displayStartX = 0;
    this.displayStartY = 0;
    this.nextDisplayX = 0;
    this.nextDisplayY = 0;
    this.activeDisplayX = 0;
    this.activeDisplayY = 0;
    this.displayHorizRange = 0x00c40200;
    this.displayVertRange = 0x00040010;
    this.drawAreaX1 = 0;
    this.drawAreaY1 = 0;
    this.drawAreaX2 = 1023;
    this.drawAreaY2 = 511;
    this.drawOffsetX = 0;
    this.drawOffsetY = 0;
    this.drawMode = 0;
    this.textureWindow = 0;
    this.maskBit = 0;
    this.displayDisabled = false;
    this.displayEnabled = true;
    this.gp1DisplayToggled = false;
    this.hasLoggedVramActive = false;
    this.hasSeenLowResLogo = false;
    this.hasReachedGuiMode = false;
    this.hasBootBenchmarked = false;
    this.hasLoggedFirstPixel = false;
    this.hasLoggedCanvasPresented = false;
    this.vblank = false;
    this.currentScanline = 0;
    this.currentField = 0;
    this.isInterlaced = false;
    this.is24BitColor = false;
    this.framesRendered = 0;
    this.polygonLogCount = 0;
    this.debugDrawCount = 0;
    this.vertexCount = 0;
    this.currentGp0Cmd = 0;
    this.gp0Buffer = [];
    this.gp0WordsRemaining = 0;
    this.transferWordsRemaining = 0;
    this.isImageTransfer = false;
    this.hasLoggedDmaDiagnostic = false;
    this.isRecordingDmaDiagnostic = false;
    this.dmaOpcodeCounts.clear();
    this.dmaClipRejections = 0;
    this.dmaTotalCommands = 0;
    this.gouraud30Count = 0;
    this.gouraud38Count = 0;
    this.hasLoggedGouraudDiagnostic = false;
    this.gp0CommandLogCount = 0;
  }

  public gp0CommandLogCount: number = 0;
  public totalDrawPacketsProcessed: number = 0;

  /**
   * Fast Bresenham line rasterizer with scissor clipping, dithering, and semi-transparency
   */
  private drawLine(
    x0: number, y0: number,
    x1: number, y1: number,
    r: number, g: number, b: number,
    isSemiTransparent: boolean = false
  ): void {
    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    let cx = x0;
    let cy = y0;

    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (this.drawMode >>> 5) & 0x03;

    while (true) {
      if (cx >= clipMinX && cx <= clipMaxX && cy >= clipMinY && cy <= clipMaxY) {
        let r8 = r, g8 = g, b8 = b;
        const rowOffset = (cy & 511) * 1024;
        if (isSemiTransparent) {
          const bg16 = this.vram[rowOffset + (cx & 1023)];
          const bgR = ((bg16 & 0x1f) << 3) | ((bg16 & 0x1f) >> 2);
          const bgG = (((bg16 >> 5) & 0x1f) << 3) | (((bg16 >> 5) & 0x1f) >> 2);
          const bgB = (((bg16 >> 10) & 0x1f) << 3) | (((bg16 >> 10) & 0x1f) >> 2);
          const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
          r8 = blended.r;
          g8 = blended.g;
          b8 = blended.b;
        }

        const r5 = applyDither(r8, cx, cy, dither);
        const g5 = applyDither(g8, cx, cy, dither);
        const b5 = applyDither(b8, cx, cy, dither);
        let bgr555 = (b5 << 10) | (g5 << 5) | r5;
        this.vram[rowOffset + (cx & 1023)] = bgr555;
      }

      if (cx === x1 && cy === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        cx += sx;
      }
      if (e2 < dx) {
        err += dx;
        cy += sy;
      }
    }
  }

  public getState(): GpuState {
    const statusVal = this.readStat();
    return {
      status: statusVal,
      displayMode: `${this.width}x${this.height} ${this.is24BitColor ? '24bpp' : '15bpp'}`,
      width: this.width,
      height: this.height,
      vblank: this.vblank,
      framesRendered: this.framesRendered,
      readyForCommands: (statusVal & (1 << 26)) !== 0,
      readyForDma: (statusVal & (1 << 28)) !== 0,
    };
  }

  // Read GPUREAD (0x1F801810)
  public readGpu(): number {
    if (this.readWordsRemaining > 0) {
      const p1 = this.vram[((this.readDstY + this.readCurY) & 511) * 1024 + ((this.readDstX + this.readCurX) & 1023)] & 0xffff;
      this.readCurX++;
      if (this.readCurX >= this.readWidth) {
        this.readCurX = 0;
        this.readCurY++;
      }
      const p2 = this.vram[((this.readDstY + this.readCurY) & 511) * 1024 + ((this.readDstX + this.readCurX) & 1023)] & 0xffff;
      this.readCurX++;
      if (this.readCurX >= this.readWidth) {
        this.readCurX = 0;
        this.readCurY++;
      }
      this.readWordsRemaining--;
      return ((p2 << 16) | p1) >>> 0;
    }
    return this.gpuReadValue;
  }

  // Read GPUSTAT (0x1F801814)
  // Bit 31: Interlace field (odd/even line in progressive, or odd/even field per frame in interlaced mode)
  public readStat(): number {
    this.gpuStat |= (1 << 26); // Ready for command
    this.gpuStat |= (1 << 27); // Ready for VRAM read
    this.gpuStat |= (1 << 28); // Ready for DMA block

    let stat = this.gpuStat;

    // Bit 19: Vertical Interlace / Field - toggles every VBLANK with currentField (0 = even, 1 = odd)
    if (this.currentField === 1) {
      stat |= (1 << 19);
    } else {
      stat &= ~(1 << 19);
    }

    // Bit 31: Interlace field calculation (toggles between odd and even field/frame)
    if (this.isInterlaced || (stat & (1 << 22)) !== 0 || (stat & (1 << 19)) !== 0) {
      if (this.currentField === 1) {
        stat = (stat | 0x80000000) >>> 0;
      } else {
        stat = (stat & 0x7fffffff) >>> 0;
      }
    } else {
      if (this.currentField === 1 || (this.currentScanline & 1) === 1) {
        stat = (stat | 0x80000000) >>> 0;
      } else {
        stat = (stat & 0x7fffffff) >>> 0;
      }
    }

    return stat >>> 0;
  }

  /**
   * Process a batched stream or linked-list packet from DMA Channel 2
   */
  public processDma(words: number[] | Uint32Array): void {
    this.processDmaBatch(Array.isArray(words) ? words : Array.from(words));
  }

  public totalGpuDrawMs: number = 0;
  public totalBlitMs: number = 0;

  public processDmaBatch(words: number[]): void {
    if (!words || words.length === 0) return;
    const t0 = performance.now();

    const isDiagFrame = !this.hasLoggedDmaDiagnostic;
    if (isDiagFrame) {
      this.isRecordingDmaDiagnostic = true;
    }

    for (let i = 0; i < words.length; i++) {
      this.sendGp0(words[i]);
    }

    if (isDiagFrame && this.isRecordingDmaDiagnostic) {
      this.isRecordingDmaDiagnostic = false;
      this.hasLoggedDmaDiagnostic = true;
    }
    this.totalGpuDrawMs += performance.now() - t0;
  }

  // Send GP0 command
  public sendGp0(data: number): void {
    const val = data >>> 0;

    // 1. TOP PRIORITY: If VRAM image transfer is active, bypass the command parser entirely
    if (this.transferWordsRemaining > 0) {
      this.writeCpuToVramWord(val);
      this.transferWordsRemaining--;
      if (this.transferWordsRemaining === 0) {
        this.isImageTransfer = false;
        this.framesRendered++;
        if (this.debugLogging) console.log('[GPU] Image transfer completed successfully');
      }
      return;
    }

    // 2. Otherwise, treat as command parameters
    if (this.gp0Buffer.length === 0) {
      this.currentGp0Cmd = (val >>> 24) & 0xFF;
      // Throttled / silenced command log
      // if (this.gp0CommandLogCount < 100) {
      //   this.gp0CommandLogCount++;
      //   console.log(`[GP0 COMMAND #${this.gp0CommandLogCount}] 0x${(val >>> 0).toString(16).padStart(8, '0').toUpperCase()} (Opcode: 0x${this.currentGp0Cmd.toString(16).padStart(2, '0').toUpperCase()})`);
      // }
    }
    this.gp0Buffer.push(val);

    // 3. Process 0xA0 Upload / 0xC0 Store setup
    if (this.currentGp0Cmd >= 0xA0 && this.currentGp0Cmd <= 0xBF) {
      if (this.gp0Buffer.length === 3) {
        const dst = this.gp0Buffer[1];
        const size = this.gp0Buffer[2];
        const width = size & 0xFFFF;
        const height = (size >>> 16) & 0xFFFF;

        this.transferDstX = dst & 0x3FF;
        this.transferDstY = (dst >>> 16) & 0x1FF;
        this.transferWidth = width;
        this.transferHeight = height;
        this.transferCurX = 0;
        this.transferCurY = 0;
        this.transferWordsRemaining = ((width * height) + 1) >>> 1;
        this.isImageTransfer = this.transferWordsRemaining > 0;

        if (this.debugLogging) console.log(`[0xA0 UPLOAD] Dest: (${this.transferDstX}, ${this.transferDstY}), Size: ${this.transferWidth}x${this.transferHeight}`);

        // Flush setup words so buffer is empty for subsequent image payload words
        this.gp0Buffer = [];
        this.gp0WordsRemaining = 0;
      }
      return;
    }

    if (this.currentGp0Cmd >= 0xC0 && this.currentGp0Cmd <= 0xDF) {
      if (this.gp0Buffer.length === 3) {
        const src = this.gp0Buffer[1];
        const size = this.gp0Buffer[2];
        const width = size & 0xFFFF;
        const height = (size >>> 16) & 0xFFFF;

        this.readDstX = src & 0x3FF;
        this.readDstY = (src >>> 16) & 0x1FF;
        this.readWidth = width;
        this.readHeight = height;
        this.readCurX = 0;
        this.readCurY = 0;
        this.readWordsRemaining = ((width * height) + 1) >>> 1;

        if (this.debugLogging) console.log(`[0xC0 STORE] Source: (${this.readDstX}, ${this.readDstY}), Size: ${this.readWidth}x${this.readHeight}`);

        // Flush setup words without setting transferWordsRemaining
        this.gp0Buffer = [];
        this.gp0WordsRemaining = 0;
      }
      return;
    }

    // 4. Standard command execution for other primitives (polygons, lines, etc.)
    this.checkAndExecutePrimitive();
  }

  public checkAndExecutePrimitive(): void {
    if (this.gp0Buffer.length === 0) return;
    const cmd = (this.gp0Buffer[0] >>> 24) & 0xFF;

    // Check for polyline termination (0x48-0x4F, 0x58-0x5F)
    if ((cmd >= 0x48 && cmd <= 0x4f) || (cmd >= 0x58 && cmd <= 0x5f)) {
      const lastWord = this.gp0Buffer[this.gp0Buffer.length - 1];
      if (this.gp0Buffer.length >= 3 && ((lastWord & 0xFFFFFFFF) === 0x55555555 || ((lastWord >>> 16) === 0x5555 && (lastWord & 0xFFFF) === 0x5555))) {
        this.executeGp0Packet(this.gp0Buffer);
        this.gp0Buffer = [];
        this.gp0WordsRemaining = 0;
      }
      return;
    }

    const totalWords = getGp0PacketLength(this.gp0Buffer[0]);
    if (this.gp0Buffer.length >= totalWords) {
      this.executeGp0Packet(this.gp0Buffer);
      this.gp0Buffer = [];
      this.gp0WordsRemaining = 0;
    }
  }

  public sendGp0Command(word: number): void {
    this.sendGp0(word);
  }

  // Write GP0 (0x1F801810) single word
  public writeGp0(val: number): void {
    this.sendGp0(val);
  }

  public gp1(command: number): void {
    this.writeGp1(command);
  }

  // Write GP1 (0x1F801814)
  public writeGp1(val: number): void {
    val = val >>> 0;
    const cmd = (val >>> 24) & 0xff;
    
    console.log(`[GPU GP1] Received Command: GP1(0x${cmd.toString(16).padStart(2, '0').toUpperCase()}) with parameter 0x${(val & 0xffffff).toString(16).toUpperCase()}`);

    switch (cmd) {
      case 0x00: // Reset GPU
        this.reset();
        console.log(`[GPU GP1 MODE] Reset GPU. Res: ${this.displayWidth}x${this.displayHeight}, Blanked: ${this.displayDisabled ? 'YES' : 'NO'}`);
        break;

      case 0x01: // Reset command buffer / acknowledge
        this.currentGp0Cmd = 0;
        this.gp0Buffer = [];
        this.gp0WordsRemaining = 0;
        break;

      case 0x02: // Acknowledge GPU interrupt
        this.gpuStat &= ~(1 << 24);
        break;

      case 0x03: // Display enable (0 = enable, 1 = blank)
        this.gp1DisplayToggled = true;
        this.displayDisabled = (val & 1) !== 0;
        this.displayEnabled = !this.displayDisabled;
        if (this.displayDisabled) {
          this.gpuStat |= (1 << 23);
        } else {
          this.gpuStat &= ~(1 << 23);
        }
        console.log(`[GPU GP1 MODE] Res: ${this.displayWidth}x${this.displayHeight}, Blanked: ${this.displayDisabled ? 'YES' : 'NO'}`);
        break;

      case 0x04: // Set DMA Direction / Data Request
        {
          const dmaDir = val & 3;
          this.gpuStat = ((this.gpuStat & ~(3 << 29)) | (dmaDir << 29)) >>> 0;
        }
        break;

      case 0x05: // Start of Display area on VRAM
        this.displayVramX = val & 0x3FF; // 10 bits (0..1023)
        this.displayVramY = (val >>> 10) & 0x1FF; // 9 bits (0..511)
        this.nextDisplayX = this.displayVramX;
        this.nextDisplayY = this.displayVramY;
        this.activeDisplayX = this.displayVramX;
        this.activeDisplayY = this.displayVramY;
        this.gp1DisplayAreaSet = true;
        console.log(`[GPU GP1 MODE] Display Area: (${this.displayVramX},${this.displayVramY}), Res: ${this.displayWidth}x${this.displayHeight}, Blanked: ${this.displayDisabled ? 'YES' : 'NO'}`);
        break;

      case 0x06: // Set Horizontal Display Range
        this.displayHorizRange = val & 0x00ffffff;
        break;

      case 0x07: // Set Vertical Display Range
        this.displayVertRange = val & 0x00ffffff;
        break;

      case 0x08: // Display mode
        {
          const hres1 = val & 0x03;
          const hres2 = (val >>> 6) & 0x01;
          if (hres2 === 1) {
            this.displayWidth = 368;
          } else {
            switch (hres1) {
              case 0: this.displayWidth = 256; break;
              case 1: this.displayWidth = 320; break;
              case 2: this.displayWidth = 512; break;
              case 3: this.displayWidth = 640; break;
            }
          }
          if (this.displayWidth === 640) {
            this.hasReachedGuiMode = true;
          }

          const isPal = (val & 0x08) !== 0;
          const is24bpp = (val & 0x10) !== 0;
          this.is24BitColor = is24bpp;
          const vres = ((val >>> 2) & 0x01) !== 0;
          const isInterlaced = (val & 0x20) !== 0;
          this.isInterlaced = isInterlaced || vres;
          this.displayHeight = isInterlaced ? 480 : 240;

          if (this.displayWidth === 320 || (this.displayHeight === 240 && !this.isInterlaced)) {
            this.hasSeenLowResLogo = true;
          }

          const reverse = (val & 0x80) !== 0;

          this.gpuStat = (this.gpuStat & ~0x007f4000) >>> 0;
          this.gpuStat |= (hres1 << 17);
          if (vres) this.gpuStat |= (1 << 19);
          if (isPal) this.gpuStat |= (1 << 20);
          if (is24bpp) this.gpuStat |= (1 << 21);
          if (isInterlaced) this.gpuStat |= (1 << 22);
          if (hres2 === 1) this.gpuStat |= (1 << 16);
          if (reverse) this.gpuStat |= (1 << 14);

          console.log(`[GPU GP1 MODE] Res: ${this.displayWidth}x${this.displayHeight}, Blanked: ${this.displayDisabled ? 'YES' : 'NO'}`);
        }
        break;

      case 0x10: // Get GPU Info
      case 0x11:
      case 0x12:
      case 0x13:
      case 0x14:
      case 0x15:
      case 0x16:
      case 0x17:
      case 0x18:
      case 0x19:
      case 0x1a:
      case 0x1b:
      case 0x1c:
      case 0x1d:
      case 0x1e:
      case 0x1f:
        {
          const infoCmd = val & 0x0f;
          switch (infoCmd) {
            case 2: // Read Texture Window
              this.gpuReadValue = this.textureWindow;
              break;
            case 3: // Read Draw Area Top Left
              this.gpuReadValue = (this.drawAreaX1 & 0x3ff) | ((this.drawAreaY1 & 0x1ff) << 10);
              break;
            case 4: // Read Draw Area Bottom Right
              this.gpuReadValue = (this.drawAreaX2 & 0x3ff) | ((this.drawAreaY2 & 0x1ff) << 10);
              break;
            case 5: // Read Draw Offset
              this.gpuReadValue = (this.drawOffsetX & 0x7ff) | ((this.drawOffsetY & 0x7ff) << 11);
              break;
            case 7: // Read GPU Type
              this.gpuReadValue = 2;
              break;
            case 8: // Unknown / constant
              this.gpuReadValue = 0;
              break;
            default:
              this.gpuReadValue = 0;
              break;
          }
        }
        break;

      default:
        logWarnRateLimited(`[GPU] Unhandled GP1 opcode: 0x${cmd.toString(16).padStart(2, '0')}`);
        break;
    }
  }

  public unpackVertex(word: number, offsetX: number = 0, offsetY: number = 0): { x: number; y: number } {
    const rawX = word & 0xffff;
    const rawY = (word >>> 16) & 0xffff;
    const x = decodeCoord(rawX) + offsetX;
    const y = decodeCoord(rawY) + offsetY;
    return { x, y };
  }

  private executeGp0Environment(cmd: number, val: number): void {
    if (this.isRecordingDmaDiagnostic) {
      this.dmaOpcodeCounts.set(cmd, (this.dmaOpcodeCounts.get(cmd) || 0) + 1);
      this.dmaTotalCommands++;
    }

    switch (cmd) {
      case 0xe1: // Draw Mode setting
        this.drawMode = val & 0x00ffffff;
        this.gpuStat = (this.gpuStat & ~0x000007ff) | (val & 0x000007ff);
        break;
      case 0xe2: // Texture window setting
        this.textureWindow = val & 0x00ffffff;
        break;
      case 0xe3: // Set Drawing Area top left (X1, Y1)
        this.drawAreaX1 = val & 0x3ff;
        this.drawAreaY1 = (val >>> 10) & 0x3ff;
        break;
      case 0xe4: // Set Drawing Area bottom right (X2, Y2)
        this.drawAreaX2 = val & 0x3ff;
        this.drawAreaY2 = (val >>> 10) & 0x3ff;
        break;
      case 0xe5: // Set Drawing Offset (X, Y)
        this.drawOffsetX = (val << 21) >> 21;
        this.drawOffsetY = ((val >>> 11) << 21) >> 21;
        break;
      case 0xe6: // Mask setting
        this.maskBit = val & 3;
        break;
    }
  }

  private writeCpuToVramWord(word: number): void {
    const p1 = word & 0xffff;
    const p2 = (word >>> 16) & 0xffff;

    const writePixel = (pixel: number) => {
      if (this.transferCurY < this.transferHeight) {
        const vx = (this.transferDstX + this.transferCurX) & 1023;
        const vy = (this.transferDstY + this.transferCurY) & 511;
        this.vram[vy * 1024 + vx] = pixel;
        this.transferCurX++;
        if (this.transferCurX >= this.transferWidth) {
          this.transferCurX = 0;
          this.transferCurY++;
        }
      }
    };

    writePixel(p1);
    writePixel(p2);
  }

  /**
   * Dispatches and rasterizes completed GP0 command packets
   */
  private executeGp0Packet(words: number[]): void {
    if (!words || words.length === 0) return;
    this.framePackets++;
    const opcode = (words[0] >>> 24) & 0xff;
    const cmd = opcode;

    // Log the completed GP0 command packet
    console.log(`[GPU GP0] Processed Packet: GP0(0x${opcode.toString(16).padStart(2, '0').toUpperCase()}) with ${words.length} words.`);

    // ZONE TRAP: Log drawing commands crossing Y in [100, 220]
    // if (((opcode >= 0x20 && opcode <= 0x3f) || (opcode >= 0x40 && opcode <= 0x7f)) && words.length >= 2) {
    //   const testY = (((words[1] >>> 16) << 21) >> 21) + this.drawingOffsetY;
    //   const testX = ((words[1] << 21) >> 21) + this.drawingOffsetX;
    //   if (testY >= 100 && testY <= 220) {
    //     if (this.zoneTrapLogCount < 100) {
    //       this.zoneTrapLogCount++;
    //       console.log(`[ZONE TRAP] Opcode: 0x${opcode.toString(16)}, Words: ${words.length}, Pos: (${testX}, ${testY}), Color: 0x${(words[0] & 0xffffff).toString(16)}`);
    //     }
    //   }
    // }

    if (this.isRecordingDmaDiagnostic && !(cmd >= 0xe1 && cmd <= 0xe6)) {
      this.dmaOpcodeCounts.set(cmd, (this.dmaOpcodeCounts.get(cmd) || 0) + 1);
      this.dmaTotalCommands++;
    }

    // Disabled per-packet logging for high frame-rate performance
    // if (!this.isLoggingPaused && this.onLog) {
    //   this.onLog('gpu', `[GPU EXECUTED] Opcode: 0x${(words[0] >>> 24).toString(16)} | Words: ${words.length}`);
    // }

    if (opcode >= 0x20 && opcode <= 0x7f) {
      this.totalDrawPacketsProcessed++;
      this.checkGuiBootBenchmark();
    } else if (opcode === 0x02 || (opcode >= 0x80 && opcode <= 0xdf)) {
      this.totalDrawPacketsProcessed++;
    }

    if (cmd >= 0x00 && cmd <= 0x1f) {
      if (cmd === 0x02) {
        if (words.length >= 3) {
          const color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;

          const w1 = words[1];
          const w2 = words[2];

          const x = w1 & 0x3f0; // Hardware forces 16-pixel horizontal quantization
          const y = (w1 >>> 16) & 0x1ff; // VRAM scanlines 0..511

          const rawW2 = w2;
          const rawWidth = rawW2 & 0xffff;
          const rawHeight = (rawW2 >>> 16) & 0xffff;
          // console.log(`[FILL 0x02 RAW] rawW2: 0x${rawW2.toString(16)} -> rawWidth: ${rawWidth}, rawHeight: ${rawHeight}`);

          // Guard against desynchronized raw pixel data being interpreted as fill command
          if (rawWidth > 1024 || rawHeight > 512) {
            console.warn(`[FILL 0x02 DESYNC IGNORED] rawW2: 0x${rawW2.toString(16)} (rawWidth: ${rawWidth}, rawHeight: ${rawHeight}) exceeds VRAM bounds. Ignoring spurious fill command.`);
            return;
          }

          let width = ((w2 & 0xffff) + 0x0f) & ~0x0f; // Rounded up to 16-pixel units
          let height = (w2 >>> 16) & 0x1ff;

          // Strict safety clamp to 1024x512 VRAM dimensions:
          if (x + width > 1024) width = Math.max(0, 1024 - x);
          if (y + height > 512) height = Math.max(0, 512 - y);

          // if (this.fillTrapLogCount < 50) {
          //   this.fillTrapLogCount++;
          //   console.log(`[FILL TRAP 0x02] Pos: (${x}, ${y}), Size: ${width}x${height}, Color: 0x${(words[0] & 0xffffff).toString(16)}`);
          // }

          if (width > 0 && height > 0) {
            this.fillRectangle(x, y, width, height, r, g, b);
            this.framesRendered++;
          }
        }
        return;
      }
      if (cmd === 0x1f) {
        this.gpuStat |= (1 << 24);
        return;
      }
      // Single-word benign NOPs (0x00, 0x01, 0x0C, 0x10, 0x11, 0x12, etc.)
      return;
    }

    switch (cmd) {

      case 0x20: // Flat Monochrome Triangle (3 vertices)
      case 0x21:
      case 0x22:
      case 0x23:
        if (words.length >= 4) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;

          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const v1 = this.unpackVertex(words[2], this.drawOffsetX, this.drawOffsetY);
          const v2 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);

          this.drawFlatTriangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x24: // Flat Textured Triangle (c0, v0, uv0+clut, v1, uv1+texpage, v2, uv2)
      case 0x25:
      case 0x26:
      case 0x27:
        if (words.length >= 7) {
          const color = words[0];
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let r = color & 0xff;
          let g = (color >>> 8) & 0xff;
          let b = (color >>> 16) & 0xff;
          if (isRaw || (r === 0 && g === 0 && b === 0)) {
            r = 0x80;
            g = 0x80;
            b = 0x80;
          }

          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff;
          const v0_uv = (words[2] >>> 8) & 0xff;
          const clut = (words[2] >>> 16) & 0xffff;

          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const u1 = words[4] & 0xff;
          const v1_uv = (words[4] >>> 8) & 0xff;
          const texpage = (words[4] >>> 16) & 0xffff;

          const v2 = this.unpackVertex(words[5], this.drawOffsetX, this.drawOffsetY);
          const u2 = words[6] & 0xff;
          const v2_uv = (words[6] >>> 8) & 0xff;

          this.drawMode = (this.drawMode & ~0xffff) | (texpage & 0xffff);

          const c = { r, g, b };
          this.drawTexturedTriangle(
            v0, { u: u0, v: v0_uv }, c,
            v1, { u: u1, v: v1_uv }, c,
            v2, { u: u2, v: v2_uv }, c,
            clut, texpage, isRaw, isSemiTransparent
          );
          this.framesRendered++;
        }
        break;

      case 0x28: // Flat Monochrome Quad (4 vertices -> 2 triangles)
      case 0x29:
      case 0x2a:
      case 0x2b:
        if (words.length >= 5) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const color = words[0];
          let r = color & 0xff;
          let g = (color >>> 8) & 0xff;
          let b = (color >>> 16) & 0xff;

          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const v1 = this.unpackVertex(words[2], this.drawOffsetX, this.drawOffsetY);
          const v2 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const v3 = this.unpackVertex(words[4], this.drawOffsetX, this.drawOffsetY);

          // Triangle 1: V0, V1, V2
          this.drawFlatTriangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, r, g, b, isSemiTransparent);
          // Triangle 2: V1, V3, V2
          this.drawFlatTriangle(v1.x, v1.y, v3.x, v3.y, v2.x, v2.y, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x2c: // Flat Textured Quad (c0, v0, uv0+clut, v1, uv1+texpage, v2, uv2, v3, uv3)
      case 0x2d:
      case 0x2e:
      case 0x2f:
        if (words.length >= 9) {
          this.checkGuiBootBenchmark();
          const w0 = words[0];
          const w1 = words[1];
          const w2 = words[2];
          const w3 = words[3];
          const w4 = words[4];
          const w5 = words[5];
          const w6 = words[6];
          const w7 = words[7];
          const w8 = words[8];

          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;

          // Base Color / Multiplier
          let r = w0 & 0xff;
          let g = (w0 >>> 8) & 0xff;
          let b = (w0 >>> 16) & 0xff;
          if (isRaw || (r === 0 && g === 0 && b === 0)) {
            r = 0x80;
            g = 0x80;
            b = 0x80;
          }

          // Attributes: CLUT is in Word 2 (upper 16), Texpage is in Word 4 (upper 16)
          const clut = (w2 >>> 16) & 0xffff;
          const texpage = (w4 >>> 16) & 0xffff;
          this.currentTexpage = texpage; // Latch texpage in GPU state
          this.drawMode = (this.drawMode & ~0xffff) | (texpage & 0xffff);
          this.gpuStat = (this.gpuStat & ~0x7ff) | (texpage & 0x7ff);

          // 11-bit signed sign extension via unpackVertex
          const v0 = this.unpackVertex(w1, this.drawOffsetX, this.drawOffsetY);
          const uv0 = { u: w2 & 0xff, v: (w2 >>> 8) & 0xff };

          const v1 = this.unpackVertex(w3, this.drawOffsetX, this.drawOffsetY);
          const uv1 = { u: w4 & 0xff, v: (w4 >>> 8) & 0xff };

          const v2 = this.unpackVertex(w5, this.drawOffsetX, this.drawOffsetY);
          const uv2 = { u: w6 & 0xff, v: (w6 >>> 8) & 0xff };

          const v3 = this.unpackVertex(w7, this.drawOffsetX, this.drawOffsetY);
          const uv3 = { u: w8 & 0xff, v: (w8 >>> 8) & 0xff };

          const c = { r, g, b };

          // if (v0.y > 90 && this.buttonQuadLogCount < 15) {
          //   this.buttonQuadLogCount++;
          //   const blendMode = (texpage >>> 5) & 0x03;
          //   console.log(`[BUTTON QUAD TRAP] Cmd: 0x${cmd.toString(16)}, isSemiTransparent: ${isSemiTransparent}, isRaw: ${isRaw}, BlendMode: ${blendMode}`);
          // }

          // Authentically decompose Z-order Quad (0=TL, 1=TR, 2=BL, 3=BR) into two CCW triangles:
          // Triangle 1: (v0, uv0), (v1, uv1), (v2, uv2)
          this.drawTexturedTriangle(
            v0, uv0, c,
            v1, uv1, c,
            v2, uv2, c,
            clut, texpage, isRaw, isSemiTransparent
          );
          // Triangle 2: (v1, uv1), (v3, uv3), (v2, uv2)
          this.drawTexturedTriangle(
            v1, uv1, c,
            v3, uv3, c,
            v2, uv2, c,
            clut, texpage, isRaw, isSemiTransparent
          );
          this.framesRendered++;
        }
        break;

      case 0x30: // Gouraud Shaded Triangle (c0, v0, c1, v1, c2, v2)
      case 0x31:
      case 0x32:
      case 0x33:
        if (words.length >= 6) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const w0 = words[0];
          const w1 = words[1];
          const w2 = words[2];
          const w3 = words[3];
          const w4 = words[4];
          const w5 = words[5];

          const c0 = { r: w0 & 0xff, g: (w0 >>> 8) & 0xff, b: (w0 >>> 16) & 0xff };
          const v0 = this.unpackVertex(w1, this.drawOffsetX, this.drawOffsetY);

          const c1 = { r: w2 & 0xff, g: (w2 >>> 8) & 0xff, b: (w2 >>> 16) & 0xff };
          const v1 = this.unpackVertex(w3, this.drawOffsetX, this.drawOffsetY);

          const c2 = { r: w4 & 0xff, g: (w4 >>> 8) & 0xff, b: (w4 >>> 16) & 0xff };
          const v2 = this.unpackVertex(w5, this.drawOffsetX, this.drawOffsetY);

          // if (!this.hasLogged0x30Clip) {
          //   this.hasLogged0x30Clip = true;
          //   console.log(`[CLIP CHECK] Scissor: [${this.drawingAreaLeft}, ${this.drawingAreaTop}] to [${this.drawingAreaRight}, ${this.drawingAreaBottom}]`);
          // }

          this.drawGouraudTriangle(
            v0.x, v0.y, c0.r, c0.g, c0.b,
            v1.x, v1.y, c1.r, c1.g, c1.b,
            v2.x, v2.y, c2.r, c2.g, c2.b,
            isSemiTransparent
          );
          this.framesRendered++;
        }
        break;

      case 0x34: // Shaded Textured Triangle (c0, v0, uv0+clut, c1, v1, uv1+texpage, c2, v2, uv2)
      case 0x35:
      case 0x36:
      case 0x37:
        if (words.length >= 9) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let r0 = words[0] & 0xff, g0 = (words[0] >>> 8) & 0xff, b0 = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff;
          const v0_uv = (words[2] >>> 8) & 0xff;
          const clut = (words[2] >>> 16) & 0xffff;

          let r1 = words[3] & 0xff, g1 = (words[3] >>> 8) & 0xff, b1 = (words[3] >>> 16) & 0xff;
          const v1 = this.unpackVertex(words[4], this.drawOffsetX, this.drawOffsetY);
          const u1 = words[5] & 0xff;
          const v1_uv = (words[5] >>> 8) & 0xff;
          const texpage = (words[5] >>> 16) & 0xffff;

          let r2 = words[6] & 0xff, g2 = (words[6] >>> 8) & 0xff, b2 = (words[6] >>> 16) & 0xff;
          const v2 = this.unpackVertex(words[7], this.drawOffsetX, this.drawOffsetY);
          const u2 = words[8] & 0xff;
          const v2_uv = (words[8] >>> 8) & 0xff;

          if (isRaw) {
            r0 = g0 = b0 = 0x80;
            r1 = g1 = b1 = 0x80;
            r2 = g2 = b2 = 0x80;
          } else {
            if (r0 === 0 && g0 === 0 && b0 === 0) { r0 = g0 = b0 = 0x80; }
            if (r1 === 0 && g1 === 0 && b1 === 0) { r1 = g1 = b1 = 0x80; }
            if (r2 === 0 && g2 === 0 && b2 === 0) { r2 = g2 = b2 = 0x80; }
          }

          this.drawMode = (this.drawMode & ~0xffff) | (texpage & 0xffff);

          this.drawTexturedTriangle(
            v0, { u: u0, v: v0_uv }, { r: r0, g: g0, b: b0 },
            v1, { u: u1, v: v1_uv }, { r: r1, g: g1, b: b1 },
            v2, { u: u2, v: v2_uv }, { r: r2, g: g2, b: b2 },
            clut, texpage, isRaw, isSemiTransparent
          );
          this.framesRendered++;
        }
        break;

      case 0x38: // Gouraud Shaded Quad (c0, v0, c1, v1, c2, v2, c3, v3)
      case 0x39:
      case 0x3a:
      case 0x3b:
        if (words.length >= 8) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const w0 = words[0];
          const w1 = words[1];
          const w2 = words[2];
          const w3 = words[3];
          const w4 = words[4];
          const w5 = words[5];
          const w6 = words[6];
          const w7 = words[7];

          const c0 = { r: w0 & 0xff, g: (w0 >>> 8) & 0xff, b: (w0 >>> 16) & 0xff };
          const v0 = this.unpackVertex(w1, this.drawOffsetX, this.drawOffsetY);

          const c1 = { r: w2 & 0xff, g: (w2 >>> 8) & 0xff, b: (w2 >>> 16) & 0xff };
          const v1 = this.unpackVertex(w3, this.drawOffsetX, this.drawOffsetY);

          const c2 = { r: w4 & 0xff, g: (w4 >>> 8) & 0xff, b: (w4 >>> 16) & 0xff };
          const v2 = this.unpackVertex(w5, this.drawOffsetX, this.drawOffsetY);

          const c3 = { r: w6 & 0xff, g: (w6 >>> 8) & 0xff, b: (w6 >>> 16) & 0xff };
          const v3 = this.unpackVertex(w7, this.drawOffsetX, this.drawOffsetY);

          // PS1 quad decomposition: Tri 1 = (v0, v1, v2), Tri 2 = (v1, v2, v3)
          this.drawGouraudTriangle(
            v0.x, v0.y, c0.r, c0.g, c0.b,
            v1.x, v1.y, c1.r, c1.g, c1.b,
            v2.x, v2.y, c2.r, c2.g, c2.b,
            isSemiTransparent
          );
          this.drawGouraudTriangle(
            v1.x, v1.y, c1.r, c1.g, c1.b,
            v2.x, v2.y, c2.r, c2.g, c2.b,
            v3.x, v3.y, c3.r, c3.g, c3.b,
            isSemiTransparent
          );
          this.framesRendered++;
        }
        break;

      case 0x3c: // Shaded Textured Quad (c0, v0, uv0+clut, c1, v1, uv1+texpage, c2, v2, uv2, c3, v3, uv3)
      case 0x3d:
      case 0x3e:
      case 0x3f:
        if (words.length >= 12) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let r0 = words[0] & 0xff, g0 = (words[0] >>> 8) & 0xff, b0 = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff;
          const v0_uv = (words[2] >>> 8) & 0xff;
          const clut = (words[2] >>> 16) & 0xffff;

          let r1 = words[3] & 0xff, g1 = (words[3] >>> 8) & 0xff, b1 = (words[3] >>> 16) & 0xff;
          const v1 = this.unpackVertex(words[4], this.drawOffsetX, this.drawOffsetY);
          const u1 = words[5] & 0xff;
          const v1_uv = (words[5] >>> 8) & 0xff;
          const texpage = (words[5] >>> 16) & 0xffff;

          let r2 = words[6] & 0xff, g2 = (words[6] >>> 8) & 0xff, b2 = (words[6] >>> 16) & 0xff;
          const v2 = this.unpackVertex(words[7], this.drawOffsetX, this.drawOffsetY);
          const u2 = words[8] & 0xff;
          const v2_uv = (words[8] >>> 8) & 0xff;

          let r3 = words[9] & 0xff, g3 = (words[9] >>> 8) & 0xff, b3 = (words[9] >>> 16) & 0xff;
          const v3 = this.unpackVertex(words[10], this.drawOffsetX, this.drawOffsetY);
          const u3 = words[11] & 0xff;
          const v3_uv = (words[11] >>> 8) & 0xff;

          if (isRaw) {
            r0 = g0 = b0 = 0x80;
            r1 = g1 = b1 = 0x80;
            r2 = g2 = b2 = 0x80;
            r3 = g3 = b3 = 0x80;
          } else {
            if (r0 === 0 && g0 === 0 && b0 === 0) { r0 = g0 = b0 = 0x80; }
            if (r1 === 0 && g1 === 0 && b1 === 0) { r1 = g1 = b1 = 0x80; }
            if (r2 === 0 && g2 === 0 && b2 === 0) { r2 = g2 = b2 = 0x80; }
            if (r3 === 0 && g3 === 0 && b3 === 0) { r3 = g3 = b3 = 0x80; }
          }

          this.drawMode = (this.drawMode & ~0xffff) | (texpage & 0xffff);

          this.drawTexturedQuad(
            v0, { u: u0, v: v0_uv }, { r: r0, g: g0, b: b0 },
            v1, { u: u1, v: v1_uv }, { r: r1, g: g1, b: b1 },
            v2, { u: u2, v: v2_uv }, { r: r2, g: g2, b: b2 },
            v3, { u: u3, v: v3_uv }, { r: r3, g: g3, b: b3 },
            clut, texpage, isRaw, isSemiTransparent
          );
          this.framesRendered++;
        }
        break;

      case 0x40: // Flat Monochrome Line
      case 0x41:
      case 0x42:
      case 0x43:
        if (words.length >= 3) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const v1 = this.unpackVertex(words[2], this.drawOffsetX, this.drawOffsetY);
          this.drawLine(v0.x, v0.y, v1.x, v1.y, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x48: // Flat Monochrome Polyline
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f:
        if (words.length >= 3) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;
          let prevV = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          for (let i = 2; i < words.length; i++) {
            const w = words[i];
            if ((w & 0xffffffff) === 0x55555555 || ((w >>> 16) === 0x5555 && (w & 0xffff) === 0x5555)) {
              break;
            }
            const nextV = this.unpackVertex(w, this.drawOffsetX, this.drawOffsetY);
            this.drawLine(prevV.x, prevV.y, nextV.x, nextV.y, r, g, b, isSemiTransparent);
            prevV = nextV;
          }
          this.framesRendered++;
        }
        break;

      case 0x50: // Gouraud Shaded Line
      case 0x51:
      case 0x52:
      case 0x53:
        if (words.length >= 4) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const c0 = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const c1 = { r: words[2] & 0xff, g: (words[2] >>> 8) & 0xff, b: (words[2] >>> 16) & 0xff };
          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          this.drawLine(v0.x, v0.y, v1.x, v1.y, (c0.r + c1.r) >> 1, (c0.g + c1.g) >> 1, (c0.b + c1.b) >> 1, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x58: // Gouraud Shaded Polyline
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
        if (words.length >= 4) {
          const isSemiTransparent = (cmd & 2) !== 0;
          let prevC = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          let prevV = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          for (let i = 2; i + 1 < words.length; i += 2) {
            const cw = words[i];
            if ((cw & 0xffffffff) === 0x55555555 || ((cw >>> 16) === 0x5555 && (cw & 0xffff) === 0x5555)) {
              break;
            }
            const nextC = { r: cw & 0xff, g: (cw >>> 8) & 0xff, b: (cw >>> 16) & 0xff };
            const nextV = this.unpackVertex(words[i + 1], this.drawOffsetX, this.drawOffsetY);
            this.drawLine(prevV.x, prevV.y, nextV.x, nextV.y, (prevC.r + nextC.r) >> 1, (prevC.g + nextC.g) >> 1, (prevC.b + nextC.b) >> 1, isSemiTransparent);
            prevC = nextC;
            prevV = nextV;
          }
          this.framesRendered++;
        }
        break;

      case 0x60: // Variable monochrome rect
      case 0x61:
      case 0x62:
      case 0x63:
        if (words.length >= 3) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const w = words[2] & 0xffff;
          const h = (words[2] >>> 16) & 0xffff;
          this.drawRect(v0.x, v0.y, w, h, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x64: // Variable textured rect (Sprites / Font Glyphs)
      case 0x65:
      case 0x66:
      case 0x67:
        if (words.length >= 4) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;
          if (isRaw || (r === 0 && g === 0 && b === 0)) {
            color = 0x808080;
          }
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff;
          const v0_uv = (words[2] >>> 8) & 0xff;
          const clut = (words[2] >>> 16) & 0xffff;
          const w = words[3] & 0xffff;
          const h = (words[3] >>> 16) & 0xffff;

          // if (this.rect0x65LogCount < 10) {
          //   this.rect0x65LogCount++;
          //   console.log(`[0x65 RECT TRAP]`);
          // }

          this.drawTexturedRect(v0.x, v0.y, w, h, u0, v0_uv, clut, color, this.currentTexpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x70: // 8x8 monochrome rect
      case 0x71:
      case 0x72:
      case 0x73:
      case 0x78: // 16x16 monochrome rect
      case 0x79:
      case 0x7a:
      case 0x7b:
        if (words.length >= 2) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const size = (cmd & 0x08) !== 0 ? 16 : 8;
          this.drawRect(v0.x, v0.y, size, size, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x74: // 8x8 textured rect
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x7c: // 16x16 textured rect
      case 0x7d:
      case 0x7e:
      case 0x7f:
        if (words.length >= 3) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let color = words[0];
          const r = color & 0xff;
          const g = (color >>> 8) & 0xff;
          const b = (color >>> 16) & 0xff;
          if (isRaw || (r === 0 && g === 0 && b === 0)) {
            color = 0x808080;
          }
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff;
          const v0_uv = (words[2] >>> 8) & 0xff;
          const clut = (words[2] >>> 16) & 0xffff;
          const size = (cmd & 0x08) !== 0 ? 16 : 8;

          this.drawTexturedRect(v0.x, v0.y, size, size, u0, v0_uv, clut, color, this.currentTexpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x80: // Copy VRAM to VRAM
      case 0x81:
      case 0x82:
      case 0x83:
      case 0x84:
      case 0x85:
      case 0x86:
      case 0x87:
      case 0x88:
      case 0x89:
      case 0x8a:
      case 0x8b:
      case 0x8c:
      case 0x8d:
      case 0x8e:
      case 0x8f:
        if (words.length >= 4) {
          const src = words[1];
          const dst = words[2];
          const size = words[3];

          const sx = src & 0x3ff;
          const sy = (src >>> 16) & 0x1ff;
          const dx = dst & 0x3ff;
          const dy = (dst >>> 16) & 0x1ff;
          const w = size & 0xffff;
          const h = (size >>> 16) & 0xffff;

          for (let cy = 0; cy < h; cy++) {
            const srcRow = ((sy + cy) & 511) * 1024;
            const dstRow = ((dy + cy) & 511) * 1024;
            for (let cx = 0; cx < w; cx++) {
              this.vram[dstRow + ((dx + cx) & 1023)] = this.vram[srcRow + ((sx + cx) & 1023)];
            }
          }
          this.framesRendered++;
        }
        break;

      case 0xa0: // Copy CPU to VRAM (Image Load / Font Upload)
      case 0xa1: case 0xa2: case 0xa3: case 0xa4: case 0xa5: case 0xa6: case 0xa7:
      case 0xa8: case 0xa9: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
      case 0xc0: // Image Transfer / Load Image to VRAM
      case 0xc1: case 0xc2: case 0xc3: case 0xc4: case 0xc5: case 0xc6: case 0xc7:
      case 0xc8: case 0xc9: case 0xca: case 0xcb: case 0xcc: case 0xcd: case 0xce: case 0xcf: {
        if (words.length >= 3) {
          const dest = words[1];
          const size = words[2];
          const width = size & 0xffff;
          const height = (size >>> 16) & 0xffff;
          this.transferDstX = dest & 0x3ff;
          this.transferDstY = (dest >>> 16) & 0x1ff;
          this.transferWidth = width;
          this.transferHeight = height;
          this.transferCurX = 0;
          this.transferCurY = 0;
          const totalPixels = width * height;
          this.transferWordsRemaining = ((totalPixels + 1) >>> 1);
          this.isImageTransfer = this.transferWordsRemaining > 0;

          // console.log(`[0xA0 UPLOAD] Dest: (${this.transferDstX}, ${this.transferDstY}), Size: ${this.transferWidth}x${this.transferHeight}`);

          if (!this.hasLoggedOpcodeA0) {
            this.hasLoggedOpcodeA0 = true;
          }

          for (let i = 3; i < words.length && this.transferWordsRemaining > 0; i++) {
            this.writeCpuToVramWord(words[i]);
            this.transferWordsRemaining--;
          }
          if (this.transferWordsRemaining === 0) {
            this.isImageTransfer = false;
            this.framesRendered++;
          }
        }
        break;
      }

      case 0xe1: // Draw Mode setting
      case 0xe2: // Texture window setting
      case 0xe3: // Set Drawing Area top left
      case 0xe4: // Set Drawing Area bottom right
      case 0xe5: // Set Drawing Offset
      case 0xe6: // Mask setting
        this.executeGp0Environment(cmd, words[0]);
        break;

      default:
        logWarnRateLimited(`[GPU] Unhandled GP0 opcode: 0x${cmd.toString(16).padStart(2, '0')}`);
        break;
    }
  }

  /**
   * Sample 16-bit texel from VRAM with 4-bit, 8-bit CLUT or 15-bit Direct mode.
   * On PS1: 0x0000 is transparent (discarded), 0x8000 is opaque black.
   */
  private sampleTexel(
    u: number,
    v: number,
    clut: number,
    texPageWord: number
  ): { r: number; g: number; b: number; transparent: boolean; stp: boolean; raw16: number; isClut: boolean; index: number } {
    const texBaseX = (texPageWord & 0x0f) * 64;
    const texBaseY = ((texPageWord >>> 4) & 0x01) * 256;
    const colorDepth = (texPageWord >>> 7) & 0x03;

    // CLUT coordinates in VRAM (16-bit halfwords): 0..1008 in steps of 16, lines 0..511
    const clutX = (clut & 0x3f) << 4;
    const clutY = (clut >>> 6) & 0x1ff;

    let curU = Math.floor(u) & 0xff;
    let curV = Math.floor(v) & 0xff;

    // Apply hardware Texture Window mask & offset (GP0 E2h)
    if (this.texWindowMaskX !== 0 || this.texWindowMaskY !== 0) {
      curU = (curU & ~(this.texWindowMaskX * 8)) | ((this.texWindowOffsetX & this.texWindowMaskX) * 8);
      curV = (curV & ~(this.texWindowMaskY * 8)) | ((this.texWindowOffsetY & this.texWindowMaskY) * 8);
      curU &= 0xff;
      curV &= 0xff;
    }

    let raw16 = 0;
    let isClut = false;
    let clutIndex = 0;
    const texY = (texBaseY + curV) & 511;

    if (colorDepth === 0) {
      // 4-bit CLUT mode: four 4-bit pixels per 16-bit VRAM word
      isClut = true;
      const wordX = (texBaseX + (curU >>> 2)) & 1023;
      const texWord = this.vram[texY * 1024 + wordX];
      const shift = (curU & 3) << 2; // (curU & 3) * 4
      clutIndex = (texWord >>> shift) & 0x0f;

      const clutAddr = ((clutY & 511) * 1024) + ((clutX + clutIndex) & 1023);
      raw16 = this.vram[clutAddr];
    } else if (colorDepth === 1) {
      // 8-bit CLUT mode: two 8-bit pixels per 16-bit VRAM word
      isClut = true;
      const wordX = (texBaseX + (curU >>> 1)) & 1023;
      const texWord = this.vram[texY * 1024 + wordX];
      const shift = (curU & 1) << 3; // (curU & 1) * 8
      clutIndex = (texWord >>> shift) & 0xff;

      const clutAddr = ((clutY & 511) * 1024) + ((clutX + clutIndex) & 1023);
      raw16 = this.vram[clutAddr];
    } else {
      // 15-bit Direct mode: one 16-bit pixel per VRAM word
      const wordX = (texBaseX + curU) & 1023;
      raw16 = this.vram[texY * 1024 + wordX];
    }

    // PS1 Texture Transparency Rule:
    // A 16-bit texel of 0x0000 is FULLY TRANSPARENT (discarded)
    if (raw16 === 0x0000) {
      return { r: 0, g: 0, b: 0, transparent: true, stp: false, raw16: 0, isClut, index: clutIndex };
    }

    const r5 = raw16 & 0x1f;
    const g5 = (raw16 >>> 5) & 0x1f;
    const b5 = (raw16 >>> 10) & 0x1f;
    const stp = (raw16 & 0x8000) !== 0;

    const r8 = (r5 << 3) | (r5 >> 2);
    const g8 = (g5 << 3) | (g5 >> 2);
    const b8 = (b5 << 3) | (b5 >> 2);

    return { r: r8, g: g8, b: b8, transparent: false, stp, raw16, isClut, index: clutIndex };
  }

  /**
   * PS1 Semi-Transparency Blending Modes
   * Mode 0: 0.5 x B + 0.5 x F (Average)
   * Mode 1: 1.0 x B + 1.0 x F (Additive)
   * Mode 2: 1.0 x B - 1.0 x F (Subtractive)
   * Mode 3: 1.0 x B + 0.25 x F (Quarter-Add)
   */
  private blendColor(
    bgR: number, bgG: number, bgB: number,
    fgR: number, fgG: number, fgB: number,
    mode: number
  ): { r: number; g: number; b: number } {
    switch (mode) {
      case 0: // 0.5 * B + 0.5 * F
        return {
          r: (bgR >> 1) + (fgR >> 1),
          g: (bgG >> 1) + (fgG >> 1),
          b: (bgB >> 1) + (fgB >> 1),
        };
      case 1: // 1.0 * B + 1.0 * F
        return {
          r: Math.min(255, bgR + fgR),
          g: Math.min(255, bgG + fgG),
          b: Math.min(255, bgB + fgB),
        };
      case 2: // 1.0 * B - 1.0 * F
        return {
          r: Math.max(0, bgR - fgR),
          g: Math.max(0, bgG - fgG),
          b: Math.max(0, bgB - fgB),
        };
      case 3: // 1.0 * B + 0.25 * F
        return {
          r: Math.min(255, bgR + (fgR >> 2)),
          g: Math.min(255, bgG + (fgG >> 2)),
          b: Math.min(255, bgB + (fgB >> 2)),
        };
      default:
        return { r: fgR, g: fgG, b: fgB };
    }
  }

  /**
   * Helper to render a Gouraud triangle with vertex colors and screen offsets applied
   */
  private renderGouraudTriangle(
    v0: { x: number; y: number; color: number },
    v1: { x: number; y: number; color: number },
    v2: { x: number; y: number; color: number },
    isSemiTransparent: boolean = false
  ): void {
    const r0 = v0.color & 0xff;
    const g0 = (v0.color >>> 8) & 0xff;
    const b0 = (v0.color >>> 16) & 0xff;

    const r1 = v1.color & 0xff;
    const g1 = (v1.color >>> 8) & 0xff;
    const b1 = (v1.color >>> 16) & 0xff;

    const r2 = v2.color & 0xff;
    const g2 = (v2.color >>> 8) & 0xff;
    const b2 = (v2.color >>> 16) & 0xff;

    const x0 = v0.x + this.drawOffsetX;
    const y0 = v0.y + this.drawOffsetY;
    const x1 = v1.x + this.drawOffsetX;
    const y1 = v1.y + this.drawOffsetY;
    const x2 = v2.x + this.drawOffsetX;
    const y2 = v2.y + this.drawOffsetY;

    this.drawGouraudTriangle(
      x0, y0, r0, g0, b0,
      x1, y1, r1, g1, b1,
      x2, y2, r2, g2, b2,
      isSemiTransparent
    );
  }

  /**
   * Fast Gouraud Triangle Rasterizer with 4x4 Bayer Hardware Dithering and Semi-Transparency Blending
   */
  private drawGouraudTriangle(
    x0: number, y0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, r2: number, g2: number, b2: number,
    isSemiTransparent: boolean = false
  ): void {
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (this.drawMode >>> 5) & 0x03;

    // Record into vertex buffer for batch tracking
    if (this.vertexCount + 18 <= this.vertexBuffer.length) {
      const vb = this.vertexBuffer;
      let vi = this.vertexCount;
      vb[vi++] = x0; vb[vi++] = y0; vb[vi++] = r0; vb[vi++] = g0; vb[vi++] = b0; vb[vi++] = 1.0;
      vb[vi++] = x1; vb[vi++] = y1; vb[vi++] = r1; vb[vi++] = g1; vb[vi++] = b1; vb[vi++] = 1.0;
      vb[vi++] = x2; vb[vi++] = y2; vb[vi++] = r2; vb[vi++] = g2; vb[vi++] = b2; vb[vi++] = 1.0;
      this.vertexCount = vi;
    }

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const minX = Math.max(clipMinX, Math.min(x0, x1, x2));
    const maxX = Math.min(clipMaxX, Math.max(x0, x1, x2));
    const minY = Math.max(clipMinY, Math.min(y0, y1, y2));
    const maxY = Math.min(clipMaxY, Math.max(y0, y1, y2));

    if (minX > maxX || minY > maxY) {
      if (this.isRecordingDmaDiagnostic) {
        this.dmaClipRejections++;
      }
      return;
    }

    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area === 0) return;
    const invArea = 1 / area;

    let pixelsDrawn = 0;
    for (let y = minY; y <= maxY; y++) {
      const rowOffset = (y & 511) * 1024;
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((x1 - x) * (y2 - y) - (y1 - y) * (x2 - x)) * invArea;
        const w1 = ((x2 - x) * (y0 - y) - (y2 - y) * (x0 - x)) * invArea;
        const w2 = 1 - w0 - w1;

        if (w0 >= -0.001 && w1 >= -0.001 && w2 >= -0.001) {
          let r8 = Math.min(255, Math.max(0, Math.round(r0 * w0 + r1 * w1 + r2 * w2)));
          let g8 = Math.min(255, Math.max(0, Math.round(g0 * w0 + g1 * w1 + g2 * w2)));
          let b8 = Math.min(255, Math.max(0, Math.round(b0 * w0 + b1 * w1 + b2 * w2)));

          if (isSemiTransparent) {
            const bg16 = this.vram[rowOffset + (x & 1023)];
            const bgR5 = bg16 & 0x1f;
            const bgG5 = (bg16 >> 5) & 0x1f;
            const bgB5 = (bg16 >> 10) & 0x1f;
            const bgR = (bgR5 << 3) | (bgR5 >> 2);
            const bgG = (bgG5 << 3) | (bgG5 >> 2);
            const bgB = (bgB5 << 3) | (bgB5 >> 2);

            const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
            r8 = blended.r;
            g8 = blended.g;
            b8 = blended.b;
          }

          const r5 = applyDither(r8, x, y, dither);
          const g5 = applyDither(g8, x, y, dither);
          const b5 = applyDither(b8, x, y, dither);
          const bgr555 = (b5 << 10) | (g5 << 5) | r5;
          this.vram[rowOffset + (x & 1023)] = bgr555;
          pixelsDrawn++;
        }
      }
    }
  }

  /**
   * Fast Flat Triangle Rasterizer with 4x4 Bayer Hardware Dithering and Semi-Transparency Blending
   */
  private drawFlatTriangle(
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    r: number, g: number, b: number,
    isSemiTransparent: boolean = false
  ): void {
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (this.drawMode >>> 5) & 0x03;

    // Record into vertex buffer for batch tracking
    if (this.vertexCount + 18 <= this.vertexBuffer.length) {
      const vb = this.vertexBuffer;
      let vi = this.vertexCount;
      vb[vi++] = x0; vb[vi++] = y0; vb[vi++] = r; vb[vi++] = g; vb[vi++] = b; vb[vi++] = 1.0;
      vb[vi++] = x1; vb[vi++] = y1; vb[vi++] = r; vb[vi++] = g; vb[vi++] = b; vb[vi++] = 1.0;
      vb[vi++] = x2; vb[vi++] = y2; vb[vi++] = r; vb[vi++] = g; vb[vi++] = b; vb[vi++] = 1.0;
      this.vertexCount = vi;
    }

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const minX = Math.max(clipMinX, Math.min(x0, x1, x2));
    const maxX = Math.min(clipMaxX, Math.max(x0, x1, x2));
    const minY = Math.max(clipMinY, Math.min(y0, y1, y2));
    const maxY = Math.min(clipMaxY, Math.max(y0, y1, y2));

    if (minX > maxX || minY > maxY) {
      if (this.isRecordingDmaDiagnostic) {
        this.dmaClipRejections++;
      }
      return;
    }

    let area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
    if (area === 0) return;
    const invArea = 1 / area;

    for (let y = minY; y <= maxY; y++) {
      const rowOffset = (y & 511) * 1024;
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((x1 - x) * (y2 - y) - (y1 - y) * (x2 - x)) * invArea;
        const w1 = ((x2 - x) * (y0 - y) - (y2 - y) * (x0 - x)) * invArea;
        const w2 = 1 - w0 - w1;

        if (w0 >= -0.001 && w1 >= -0.001 && w2 >= -0.001) {
          let r8 = r;
          let g8 = g;
          let b8 = b;

          if (isSemiTransparent) {
            const bg16 = this.vram[rowOffset + (x & 1023)];
            const bgR5 = bg16 & 0x1f;
            const bgG5 = (bg16 >> 5) & 0x1f;
            const bgB5 = (bg16 >> 10) & 0x1f;
            const bgR = (bgR5 << 3) | (bgR5 >> 2);
            const bgG = (bgG5 << 3) | (bgG5 >> 2);
            const bgB = (bgB5 << 3) | (bgB5 >> 2);

            const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
            r8 = blended.r;
            g8 = blended.g;
            b8 = blended.b;
          }

          const r5 = applyDither(r8, x, y, dither);
          const g5 = applyDither(g8, x, y, dither);
          const b5 = applyDither(b8, x, y, dither);
          const bgr555 = (b5 << 10) | (g5 << 5) | r5;
          this.vram[rowOffset + (x & 1023)] = bgr555;
        }
      }
    }
  }

  /**
   * Fast Rectangle Fill (Unclipped Framebuffer Fill GP0 02h)
   */
  private fillRectangle(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
    const r5 = (r >> 3) & 0x1f;
    const g5 = (g >> 3) & 0x1f;
    const b5 = (b >> 3) & 0x1f;
    const color16 = (b5 << 10) | (g5 << 5) | r5;

    const startX = x & 0x3f0;
    const startY = y & 0x1ff;
    let width = w;
    let height = h;

    if (startX + width > 1024) width = Math.max(0, 1024 - startX);
    if (startY + height > 512) height = Math.max(0, 512 - startY);

    if (width <= 0 || height <= 0) return;

    for (let dy = 0; dy < height; dy++) {
      const row = (startY + dy) * 1024;
      for (let dx = 0; dx < width; dx++) {
        this.vram[row + startX + dx] = color16;
      }
    }
  }

  /**
   * Clipped Rectangle Fill (GP0 60h / 70h / 78h)
   */
  private drawRect(
    x: number, y: number, w: number, h: number,
    r: number, g: number, b: number,
    isSemiTransparent: boolean = false
  ): void {
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (this.drawMode >>> 5) & 0x03;

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const startX = Math.max(clipMinX, x);
    const endX = Math.min(clipMaxX, x + w - 1);
    const startY = Math.max(clipMinY, y);
    const endY = Math.min(clipMaxY, y + h - 1);

    if (startX > endX || startY > endY) {
      if (this.isRecordingDmaDiagnostic) {
        this.dmaClipRejections++;
      }
      return;
    }

    for (let cy = startY; cy <= endY; cy++) {
      const row = (cy & 511) * 1024;
      for (let cx = startX; cx <= endX; cx++) {
        let r8 = r;
        let g8 = g;
        let b8 = b;

        if (isSemiTransparent) {
          const bg16 = this.vram[row + (cx & 1023)];
          const bgR5 = bg16 & 0x1f;
          const bgG5 = (bg16 >> 5) & 0x1f;
          const bgB5 = (bg16 >> 10) & 0x1f;
          const bgR = (bgR5 << 3) | (bgR5 >> 2);
          const bgG = (bgG5 << 3) | (bgG5 >> 2);
          const bgB = (bgB5 << 3) | (bgB5 >> 2);

          const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
          r8 = blended.r;
          g8 = blended.g;
          b8 = blended.b;
        }

        const r5 = applyDither(r8, cx, cy, dither);
        const g5 = applyDither(g8, cx, cy, dither);
        const b5 = applyDither(b8, cx, cy, dither);
        this.vram[row + (cx & 1023)] = (b5 << 10) | (g5 << 5) | r5;
      }
    }
  }

  /**
   * Textured Rectangle / Sprite Rasterizer (GP0 64h / 65h / 74h / 7ch)
   * Samples texture page from VRAM and applies CLUT or direct color.
   */
  private drawTexturedRect(
    x0: number,
    y0: number,
    w: number,
    h: number,
    u0: number,
    v0: number,
    clut: number,
    color: number = 0x808080,
    overrideTexPage?: number,
    isRaw: boolean = false,
    isSemiTransparent: boolean = false
  ): void {
    const texPageWord = (overrideTexPage !== undefined) ? overrideTexPage : (this.drawMode & 0xffff);
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (texPageWord >>> 5) & 0x03;

    const tintR = color & 0xff;
    const tintG = (color >>> 8) & 0xff;
    const tintB = (color >>> 16) & 0xff;

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    if (x0 > clipMaxX || x0 + w - 1 < clipMinX || y0 > clipMaxY || y0 + h - 1 < clipMinY) {
      if (this.isRecordingDmaDiagnostic) {
        this.dmaClipRejections++;
      }
      return;
    }

    for (let dy = 0; dy < h; dy++) {
      const destY = y0 + dy;
      if (destY < clipMinY || destY > clipMaxY) continue;
      const destRow = (destY & 511) * 1024;
      const v = (v0 + dy) & 0xff;

      for (let dx = 0; dx < w; dx++) {
        const destX = x0 + dx;
        if (destX < clipMinX || destX > clipMaxX) continue;
        const u = (u0 + dx) & 0xff;

        const texel = this.sampleTexel(u, v, clut, texPageWord);
        // PS1 Texture Transparency Rule:
        // A texel of 0x0000 is FULLY TRANSPARENT (discarded)
        if (texel.transparent || texel.raw16 === 0x0000) {
          continue; // DO NOT write pixel, DO NOT blend, skip to next fragment!
        }

        let rFinal: number;
        let gFinal: number;
        let bFinal: number;

        if (isRaw) {
          rFinal = texel.r;
          gFinal = texel.g;
          bFinal = texel.b;
        } else {
          let vR = tintR;
          let vG = tintG;
          let vB = tintB;
          if (vR === 0 && vG === 0 && vB === 0) {
            vR = 0x80;
            vG = 0x80;
            vB = 0x80;
          }
          // PS1 Hardware Texture Color Modulation: C_final = (C_tex * C_vert) >> 7
          rFinal = Math.min(255, (texel.r * vR) >> 7);
          gFinal = Math.min(255, (texel.g * vG) >> 7);
          bFinal = Math.min(255, (texel.b * vB) >> 7);
        }

        // Semi-transparency blending when enabled on primitive and texel stp is set
        if (isSemiTransparent && texel.stp) {
          const bg16 = this.vram[destRow + (destX & 1023)];
          const bgR5 = bg16 & 0x1f;
          const bgG5 = (bg16 >> 5) & 0x1f;
          const bgB5 = (bg16 >> 10) & 0x1f;
          const bgR = (bgR5 << 3) | (bgR5 >> 2);
          const bgG = (bgG5 << 3) | (bgG5 >> 2);
          const bgB = (bgB5 << 3) | (bgB5 >> 2);

          const blended = this.blendColor(bgR, bgG, bgB, rFinal, gFinal, bFinal, blendMode);
          rFinal = blended.r;
          gFinal = blended.g;
          bFinal = blended.b;
        }

        const r5 = applyDither(rFinal, destX, destY, dither);
        const g5 = applyDither(gFinal, destX, destY, dither);
        const b5 = applyDither(bFinal, destX, destY, dither);

        let bgr555 = (b5 << 10) | (g5 << 5) | r5;
        if (bgr555 === 0 && (texel.stp || texel.raw16 === 0x8000)) {
          bgr555 = 0x8000;
        }

        this.vram[destRow + (destX & 1023)] = bgr555;
      }
    }
  }

  /**
   * Textured Quad Rasterizer (GP0 2Ch / 2Dh / 2Eh / 2Fh / 3Ch / 3Dh / 3Eh / 3Fh)
   * Splits quad into Triangle 1: (0, 1, 2) and Triangle 2: (1, 2, 3)
   */
  private drawTexturedQuad(
    v0: { x: number; y: number }, uv0: { u: number; v: number }, c0: { r: number; g: number; b: number },
    v1: { x: number; y: number }, uv1: { u: number; v: number }, c1: { r: number; g: number; b: number },
    v2: { x: number; y: number }, uv2: { u: number; v: number }, c2: { r: number; g: number; b: number },
    v3: { x: number; y: number }, uv3: { u: number; v: number }, c3: { r: number; g: number; b: number },
    clut: number,
    texpage: number,
    isRaw: boolean = false,
    isSemiTransparent: boolean = false
  ): void {
    // Triangle 1: V0, V1, V2
    this.drawTexturedTriangle(
      v0, uv0, c0,
      v1, uv1, c1,
      v2, uv2, c2,
      clut, texpage, isRaw, isSemiTransparent
    );
    // Triangle 2: V1, V3, V2
    this.drawTexturedTriangle(
      v1, uv1, c1,
      v3, uv3, c3,
      v2, uv2, c2,
      clut, texpage, isRaw, isSemiTransparent
    );
  }

  /**
   * Textured Triangle Rasterizer with UV interpolation, color modulation, semi-transparency blending, and dithering
   */
  private drawTexturedTriangle(
    v0: { x: number; y: number }, uv0: { u: number; v: number }, c0: { r: number; g: number; b: number },
    v1: { x: number; y: number }, uv1: { u: number; v: number }, c1: { r: number; g: number; b: number },
    v2: { x: number; y: number }, uv2: { u: number; v: number }, c2: { r: number; g: number; b: number },
    clut: number,
    texpage: number,
    isRaw: boolean = false,
    isSemiTransparent: boolean = false
  ): void {
    const texPageWord = texpage & 0xffff;
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (texPageWord >>> 5) & 0x03;

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    // if (!this.diagnosticLoggedOnce && isRaw) {
    //   this.diagnosticLoggedOnce = true;
    //   console.log(`[VRAM DIAGNOSTIC]`);
    // }

    const minX = Math.max(clipMinX, Math.min(v0.x, v1.x, v2.x));
    const maxX = Math.min(clipMaxX, Math.max(v0.x, v1.x, v2.x));
    const minY = Math.max(clipMinY, Math.min(v0.y, v1.y, v2.y));
    const maxY = Math.min(clipMaxY, Math.max(v0.y, v1.y, v2.y));

    if (minX > maxX || minY > maxY) {
      if (this.isRecordingDmaDiagnostic) {
        this.dmaClipRejections++;
      }
      return;
    }

    let area = (v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x);
    if (area === 0) return;
    const invArea = 1 / area;

    for (let y = minY; y <= maxY; y++) {
      const rowOffset = (y & 511) * 1024;
      for (let x = minX; x <= maxX; x++) {
        const w0 = ((v1.x - x) * (v2.y - y) - (v1.y - y) * (v2.x - x)) * invArea;
        const w1 = ((v2.x - x) * (v0.y - y) - (v2.y - y) * (v0.x - x)) * invArea;
        const w2 = 1 - w0 - w1;

        if (w0 >= -0.001 && w1 >= -0.001 && w2 >= -0.001) {
          const u = uv0.u * w0 + uv1.u * w1 + uv2.u * w2;
          const v = uv0.v * w0 + uv1.v * w1 + uv2.v * w2;

          const texel = this.sampleTexel(u, v, clut, texPageWord);
          // PS1 Texture Transparency Rule:
          // A texel of 0x0000 is FULLY TRANSPARENT (discarded)
          if (texel.transparent || texel.raw16 === 0x0000) {
            continue; // DO NOT write pixel, DO NOT blend, skip to next fragment!
          }

          let rFinal: number;
          let gFinal: number;
          let bFinal: number;

          if (isRaw) {
            rFinal = texel.r;
            gFinal = texel.g;
            bFinal = texel.b;
          } else {
            let rVert = Math.min(255, Math.max(0, Math.round(c0.r * w0 + c1.r * w1 + c2.r * w2)));
            let gVert = Math.min(255, Math.max(0, Math.round(c0.g * w0 + c1.g * w1 + c2.g * w2)));
            let bVert = Math.min(255, Math.max(0, Math.round(c0.b * w0 + c1.b * w1 + c2.b * w2)));

            if (rVert === 0 && gVert === 0 && bVert === 0) {
              rVert = 0x80;
              gVert = 0x80;
              bVert = 0x80;
            }

            // Color modulation: C_final = (C_tex * C_vert) >> 7
            rFinal = Math.min(255, (texel.r * rVert) >> 7);
            gFinal = Math.min(255, (texel.g * gVert) >> 7);
            bFinal = Math.min(255, (texel.b * bVert) >> 7);
          }

          // Semi-transparency blending when enabled on primitive and texel stp is set
          if (isSemiTransparent && texel.stp) {
            const bg16 = this.vram[rowOffset + (x & 1023)];
            const bgR5 = bg16 & 0x1f;
            const bgG5 = (bg16 >> 5) & 0x1f;
            const bgB5 = (bg16 >> 10) & 0x1f;
            const bgR = (bgR5 << 3) | (bgR5 >> 2);
            const bgG = (bgG5 << 3) | (bgG5 >> 2);
            const bgB = (bgB5 << 3) | (bgB5 >> 2);

            const blended = this.blendColor(bgR, bgG, bgB, rFinal, gFinal, bFinal, blendMode);
            rFinal = blended.r;
            gFinal = blended.g;
            bFinal = blended.b;
          }

          const r5 = applyDither(rFinal, x, y, dither);
          const g5 = applyDither(gFinal, x, y, dither);
          const b5 = applyDither(bFinal, x, y, dither);

          let bgr555 = (b5 << 10) | (g5 << 5) | r5;
          if (bgr555 === 0 && (texel.stp || texel.raw16 === 0x8000)) {
            bgr555 = 0x8000;
          }

          this.vram[rowOffset + (x & 1023)] = bgr555;
        }
      }
    }
  }

  public clearVram(): void {
    this.vram.fill(0);
    this.framesRendered++;
  }

  public setPixel(x: number, y: number, r: number, g: number, b: number): void {
    if (x < 0 || x >= 1024 || y < 0 || y >= 512) return;
    const r5 = (r >> 3) & 0x1f;
    const g5 = (g >> 3) & 0x1f;
    const b5 = (b >> 3) & 0x1f;
    const bgr555 = (b5 << 10) | (g5 << 5) | r5;
    this.vram[y * 1024 + x] = bgr555;
  }

  /**
   * Authentic PlayStation 1 Canvas Frame Blit Loop
   * Extracts the active (W × H) window starting at (displayStartX, displayStartY)
   * from 1024×512 16-bit BGR555 VRAM and writes to HTML5 Canvas via putImageData.
   * Honors display blank flag (GP1 0x03).
   */
  /**
   * Decoupled blitFrame: Draws the already completed offscreen frame buffer
   * directly to the active HTML5 Canvas context.
   */
  public blitFrame(ctx?: CanvasRenderingContext2D): void {
    const t0 = performance.now();

    // Log telemetry every 60 frames
    this.blitFrameCount++;
    if (this.blitFrameCount % 60 === 0) {
      console.log(`[GPU RENDER] VRAM Display Area: (${this.displayX}, ${this.displayY}) | Size: ${this.width}x${this.height} | Blanked: ${this.isBlanked} | GP0 packets this frame: ${this.framePackets}`);
    }

    let targetCtx = ctx || this.targetCanvasCtx;
    if (!targetCtx && typeof document !== 'undefined') {
      const el = document.getElementById('ps1-gpu-canvas') as HTMLCanvasElement | null;
      if (el) {
        const foundCtx = el.getContext('2d', { alpha: false });
        if (foundCtx) {
          targetCtx = foundCtx;
          this.targetCanvasCtx = targetCtx;
        }
      }
    }
    if (!targetCtx) return;
    this.targetCanvasCtx = targetCtx;

    // Decoupled blit: check frameReady flag
    if (this.frameReady && this.completedFrame) {
      const dispW = this.completedFrame.width;
      const dispH = this.completedFrame.height;

      // Handle dynamic canvas resize
      if (targetCtx.canvas.width !== dispW || targetCtx.canvas.height !== dispH) {
        targetCtx.canvas.width = dispW;
        targetCtx.canvas.height = dispH;
      }

      try {
        targetCtx.putImageData(this.completedFrame, 0, 0);
      } catch (err) {
        console.error('[BLIT ERROR] putImageData failed:', err);
      }
      this.frameReady = false;
    }

    this.totalBlitMs += performance.now() - t0;
  }

  /**
   * Extracts the full active display area from VRAM into the off-screen completed frame buffer
   * during VBLANK, fully synchronized with CPU frame completion boundaries.
   */
  public extractFrame(): void {
    const dispW = Math.max(1, this.displayWidth || 320);
    const dispH = Math.max(1, this.displayHeight || 240);

    // Initialize or resize completedFrame off-screen buffer
    if (!this.completedFrame || this.completedFrame.width !== dispW || this.completedFrame.height !== dispH) {
      if (typeof ImageData !== 'undefined') {
        this.completedFrame = new ImageData(dispW, dispH);
      } else {
        this.completedFrame = {
          width: dispW,
          height: dispH,
          data: new Uint8ClampedArray(dispW * dispH * 4)
        } as ImageData;
      }
    }

    const data = this.completedFrame.data;

    // Check Display Enable GP1(0x03):
    // Do NOT clear the canvas to black unless this.displayDisabled === true
    if (this.displayDisabled) {
      for (let i = 0; i < dispW * dispH; i++) {
        const dest = i * 4;
        data[dest + 0] = 0;
        data[dest + 1] = 0;
        data[dest + 2] = 0;
        data[dest + 3] = 255;
      }
      this.framePackets = 0;
      return;
    }

    const startX = this.displayVramX & 1023;
    const startY = this.displayVramY & 511;
    const width = dispW;
    const height = dispH; // 480 in interlaced GUI mode, 240 in progressive
    const vram = this.vram;

    let nonZeroCount = 0;

    for (let y = 0; y < height; y++) {
      // Modulo 512 safely wraps VRAM scanlines if height spans the full buffer
      const vramY = (startY + y) & 511;
      const lineOffset = vramY * 1024;
      const destOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const vramX = (startX + x) & 1023;
        const pixel = vram[lineOffset + vramX];

        // Convert 16-bit BGR555 to RGBA32 and write to ImageData buffer
        const r = (pixel & 0x1f) << 3;
        const g = ((pixel >> 5) & 0x1f) << 3;
        const b = ((pixel >> 10) & 0x1f) << 3;

        if (r !== 0 || g !== 0 || b !== 0) {
          nonZeroCount++;
        }

        const idx = destOffset + (x * 4);
        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }

    // Visual Canvas Dump / Framebuffer Diagnostic:
    const resChanged = dispW !== this.lastLogDispW || dispH !== this.lastLogDispH;
    const areaChanged = startX !== this.lastLogStartX || startY !== this.lastLogStartY;
    const contentTransition = (this.lastLogNonZeroCount <= 0 && nonZeroCount > 0) || (this.lastLogNonZeroCount > 0 && nonZeroCount === 0);
    const countChanged = Math.abs(nonZeroCount - this.lastLogNonZeroCount) > 500;
    const now = performance.now();

    if (resChanged || areaChanged || contentTransition || (countChanged && (now - this.lastLogTime > 2000))) {
      this.lastLogDispW = dispW;
      this.lastLogDispH = dispH;
      this.lastLogStartX = startX;
      this.lastLogStartY = startY;
      this.lastLogNonZeroCount = nonZeroCount;
      this.lastLogTime = now;
      if (contentTransition || areaChanged || resChanged) {
        this.blitCheckLoggedCount = 0;
      }
      const screenLogMsg = `[SCREEN PRESENTATION] Resolution: ${dispW}x${dispH}, DisplayArea: (${startX},${startY}), Non-zero pixels drawn: ${nonZeroCount}`;
      console.log(screenLogMsg);
      if (this.onScreenChange) {
        this.onScreenChange(screenLogMsg);
      }
    }
    this.framePackets = 0;
  }

  /**
   * Returns total count of non-zero pixels in entire 1024x512 VRAM (1MB)
   */
  public getTotalVramNonZeroCount(): number {
    let count = 0;
    const vram = this.vram;
    for (let i = 0; i < vram.length; i++) {
      if ((vram[i] & 0x7fff) !== 0) {
        count++;
      }
    }
    return count;
  }

  /**
   * Returns count of non-zero pixels in current active display viewport
   */
  public getDisplayNonZeroCount(): number {
    let count = 0;
    const vram = this.vram;
    const dispW = this.displayWidth;
    const dispH = this.displayHeight;
    const startX = this.displayVramX;
    const startY = this.displayVramY;

    for (let y = 0; y < dispH; y++) {
      const vramY = (startY + y) & 511;
      const vramRow = vramY * 1024;
      for (let x = 0; x < dispW; x++) {
        const vramX = (startX + x) & 1023;
        if ((vram[vramRow + vramX] & 0x7fff) !== 0) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Render real VRAM display to the HTML5 canvas
   */
  public renderToCanvas(
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number,
    showScanlines: boolean,
    isRunning: boolean = false,
    errorMessage: string | null = null
  ): void {
    this.targetCanvasCtx = ctx;
    const dispW = this.displayWidth;
    const dispH = this.displayHeight;

    if (isRunning || this.framesRendered > 0) {
      this.blitFrame(ctx);
    } else {
      if (ctx.canvas.width !== dispW || ctx.canvas.height !== dispH) {
        ctx.canvas.width = dispW;
        ctx.canvas.height = dispH;
      }
      // Standby CRT display
      ctx.fillStyle = '#090b10';
      ctx.fillRect(0, 0, dispW, dispH);

      // Fine calibration grid
      ctx.strokeStyle = '#181d28';
      ctx.lineWidth = 1;
      const gridStep = dispW / 16;
      for (let x = 0; x <= dispW; x += gridStep) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, dispH);
        ctx.stroke();
      }
      for (let y = 0; y <= dispH; y += gridStep) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(dispW, y);
        ctx.stroke();
      }

      // Information readout
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#a1a1aa';
      ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText('PS1 EMULATION CORE • ACTIVE MONITOR', dispW / 2, dispH / 2 - 10);

      ctx.fillStyle = '#52525b';
      ctx.font = '9px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText('Native 320×240 15bpp BGR555 • Click RUN [F1]', dispW / 2, dispH / 2 + 10);
      ctx.restore();
    }

    // Active error banner overlay on screen
    if (errorMessage) {
      ctx.save();
      ctx.fillStyle = 'rgba(220, 38, 38, 0.9)';
      ctx.fillRect(8, 8, dispW - 16, 36);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 1;
      ctx.strokeRect(8, 8, dispW - 16, 36);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('CRITICAL EMULATION HALT', 14, 22);

      ctx.fillStyle = '#fecaca';
      ctx.font = '9px ui-monospace, monospace';
      const truncated = errorMessage.length > 50 ? errorMessage.substring(0, 47) + '...' : errorMessage;
      ctx.fillText(truncated, 14, 34);
      ctx.restore();
    }
  }
}
