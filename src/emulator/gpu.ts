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
  const c = val & 0x7FF;
  return (c >= 0x400) ? (c - 0x800) : c;
}

export function signExtend11(val: number): number {
  return (val << 21) >> 21;
}

export function getGp0PacketLength(commandWord: number): number {
  const opcode = (commandWord >>> 24) & 0xff;

  if (opcode >= 0xe1 && opcode <= 0xe6) return 1;
  if (opcode === 0x02) return 3;
  if (opcode >= 0x00 && opcode <= 0x1f) return 1;

  switch (opcode & 0xfc) {
    case 0x20: return 4;
    case 0x24: return 7;
    case 0x28: return 5;
    case 0x2c: return 9;
    case 0x30: return 6;
    case 0x34: return 9;
    case 0x38: return 8;
    case 0x3c: return 12;
  }

  if (opcode >= 0x60 && opcode <= 0x7f) {
    const isTextured = (opcode & 0x04) !== 0;
    const sizeType = (opcode >>> 3) & 0x3;
    let rectWords = 2;
    if (isTextured) rectWords += 1;
    if (sizeType === 0) rectWords += 1;
    return rectWords;
  }

  if (opcode >= 0x40 && opcode <= 0x47) return 3;
  if (opcode >= 0x48 && opcode <= 0x4f) return 0xffff;
  if (opcode >= 0x50 && opcode <= 0x57) return 4;
  if (opcode >= 0x58 && opcode <= 0x5f) return 0xffff;

  if (opcode >= 0x80 && opcode <= 0x9f) return 4;
  if (opcode >= 0xa0 && opcode <= 0xdf) return 3;

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
    const stat = this.gpuStat;
    const vres = (stat >>> 19) & 0x01;
    const isPal = (stat >>> 20) & 0x01;
    const isInterlaced = (stat >>> 22) & 0x01;
    if (vres === 1 && isInterlaced === 1) return 480;
    if (isPal === 1) return 256;
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

  public maskSet: boolean = false;
  public maskCheck: boolean = false;

  public vram: Uint16Array = new Uint16Array(1024 * 512);
  public vram32: Uint32Array = new Uint32Array(this.vram.buffer);

  public displayStartX: number = 0;
  public displayStartY: number = 0;
  public isLoggingPaused: boolean = false;
  public debugLogging: boolean = false;

  public displayHorizRange: number = 0x00c40200;
  public displayVertRange: number = 0x00040010;

  public drawAreaX1: number = 0;
  public drawAreaY1: number = 0;
  public drawAreaX2: number = 1023;
  public drawAreaY2: number = 511;

  public get clipX1(): number { return this.drawAreaX1; }
  public get clipY1(): number { return this.drawAreaY1; }
  public get clipX2(): number { return this.drawAreaX2; }
  public get clipY2(): number { return this.drawAreaY2; }

  public get displayVramX(): number { return this.displayStartX; }
  public set displayVramX(val: number) { this.displayStartX = val & 0x3ff; }
  public get displayVramY(): number { return this.displayStartY; }
  public set displayVramY(val: number) { this.displayStartY = val & 0x1ff; }

  public drawOffsetX: number = 0;
  public drawOffsetY: number = 0;

  public drawMode: number = 0;
  public get currentTexpage(): number {
    return this.drawMode & 0xffff;
  }
  public set currentTexpage(val: number) {
    this.drawMode = (this.drawMode & ~0xffff) | (val & 0xffff);
  }

  public textureWindow: number = 0;
  public get texWindowMaskX(): number { return this.textureWindow & 0x1f; }
  public get texWindowMaskY(): number { return (this.textureWindow >>> 5) & 0x1f; }
  public get texWindowOffsetX(): number { return (this.textureWindow >>> 10) & 0x1f; }
  public get texWindowOffsetY(): number { return (this.textureWindow >>> 15) & 0x1f; }

  public gpuStat: number = 0x14002000;
  public get status(): number {
    return this.readStat();
  }
  public set status(val: number) {
    this.gpuStat = val >>> 0;
  }
  public gpuReadValue: number = 0;

  public vblank: boolean = false;
  public framesRendered: number = 0;
  public displayDisabled: boolean = false;
  public displayEnabled: boolean = true;
  public targetCanvasCtx: CanvasRenderingContext2D | null = null;
  public currentScanline: number = 0;
  public currentField: number = 0;
  public isInterlaced: boolean = false;
  public is24BitColor: boolean = false;

  public completedFrame: ImageData | null = null;
  public frameReady: boolean = false;
  public framePackets: number = 0;
  public blitFrameCount: number = 0;

  public vertexBuffer: Float32Array = new Float32Array(65536 * 6);
  public vertexCount: number = 0;

  public gp0Buffer: number[] = [];
  public currentGp0Cmd: number = 0;

  public imgBuffer: Uint16Array = new Uint16Array(1024 * 512);
  public imgIndex: number = 0;

  public imgReadBuffer: Uint16Array = new Uint16Array(1024 * 512);
  public imgReadIndex: number = 0;
  public imgReadTotal: number = 0;

  public transferDstX: number = 0;
  public transferDstY: number = 0;
  public transferWidth: number = 0;
  public transferHeight: number = 0;
  public transferCurX: number = 0;
  public transferCurY: number = 0;
  public transferWordsRemaining: number = 0;

  public readDstX: number = 0;
  public readDstY: number = 0;
  public readWidth: number = 0;
  public readHeight: number = 0;
  public readCurX: number = 0;
  public readCurY: number = 0;
  public readWordsRemaining: number = 0;

  public onFrame?: () => void;
  public onLog?: (type: 'gpu' | 'warn' | 'error', msg: string) => void;
  public onBootBenchmark?: () => void;
  public onScreenChange?: (message: string) => void;
  public onTriggerIrq?: () => void;
  public onAcknowledgeIrq?: () => void;

  public hasBootBenchmarked: boolean = false;
  public totalDrawPacketsProcessed: number = 0;
  public totalGpuDrawMs: number = 0;
  public totalBlitMs: number = 0;

  public gp0WriteCount: number = 0;
  public gp1WriteCount: number = 0;
  public dma2PacketCount: number = 0;
  public vblankIrqCount: number = 0;
  private _lastLoggedGp0Cmd: number = -1;
  private _lastLoggedGp1Cmd: number = -1;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.vram.fill(0);
    this.gpuStat = 0x14002000;
    this.gpuReadValue = 0;
    this.width = 320;
    this.height = 240;
    this.displayStartX = 0;
    this.displayStartY = 0;
    this.drawAreaX1 = 0;
    this.drawAreaY1 = 0;
    this.drawAreaX2 = 1023;
    this.drawAreaY2 = 511;
    this.drawOffsetX = 0;
    this.drawOffsetY = 0;
    this.drawMode = 0;
    this.currentTexpage = 0;
    this.textureWindow = 0;
    this.maskSet = false;
    this.maskCheck = false;
    this.displayDisabled = false;
    this.displayEnabled = true;
    this.vblank = false;
    this.currentScanline = 0;
    this.currentField = 0;
    this.isInterlaced = false;
    this.is24BitColor = false;
    this.framesRendered = 0;
    this.currentGp0Cmd = 0;
    this.gp0Buffer = [];
    this.transferWordsRemaining = 0;
    this.totalDrawPacketsProcessed = 0;
    this.gp0WriteCount = 0;
    this.gp1WriteCount = 0;
    this.dma2PacketCount = 0;
    this.vblankIrqCount = 0;
  }

  public endDmaPacket(): void {
    this.dma2PacketCount++;
    if (this.gp0Buffer.length > 0) {
      const cmd = (this.gp0Buffer[0] >>> 24) & 0xff;
      if ((cmd >= 0x48 && cmd <= 0x4f) || (cmd >= 0x58 && cmd <= 0x5f)) {
        this.executeGp0Packet(this.gp0Buffer);
      } else {
        const totalWords = getGp0PacketLength(this.gp0Buffer[0]);
        if (this.gp0Buffer.length >= totalWords) {
          this.executeGp0Packet(this.gp0Buffer.slice(0, totalWords));
        }
      }
      this.gp0Buffer = [];
      this.currentGp0Cmd = 0;
    }
  }

  public onVBlank(): void {
    this.vblankIrqCount++;
    this.extractFrame();
    this.frameReady = true;
    if (this.onFrame) {
      this.onFrame();
    }
  }

  public getState(): GpuState {
    const statusVal = this.readStat();
    const first16 = Array.from(this.vram.subarray(0, 16)).map(v => '0x' + (v & 0xffff).toString(16).padStart(4, '0')).join(' ');
    return {
      status: statusVal,
      displayMode: `${this.width}x${this.height} ${this.is24BitColor ? '24bpp' : '15bpp'}`,
      width: this.width,
      height: this.height,
      vblank: this.vblank,
      framesRendered: this.framesRendered,
      readyForCommands: (statusVal & (1 << 26)) !== 0,
      readyForDma: (statusVal & (1 << 28)) !== 0,
      gp0WriteCount: this.gp0WriteCount,
      gp1WriteCount: this.gp1WriteCount,
      dma2PacketCount: this.dma2PacketCount,
      vblankIrqCount: this.vblankIrqCount,
      totalVramNonZero: this.getTotalVramNonZeroCount(),
      displayNonZero: this.getDisplayNonZeroCount(),
      displayStartX: this.displayStartX,
      displayStartY: this.displayStartY,
      displayDisabled: this.displayDisabled,
      vramFirst16WordsHex: first16,
    };
  }

  public readGpu(): number {
    if (this.imgReadIndex < this.imgReadTotal) {
      const p0 = this.imgReadBuffer[this.imgReadIndex++];
      const p1 = (this.imgReadIndex < this.imgReadTotal) ? this.imgReadBuffer[this.imgReadIndex++] : 0;
      if (this.imgReadIndex >= this.imgReadTotal) {
        this.gpuStat &= ~(1 << 27);
      }
      return ((p1 << 16) | (p0 & 0xffff)) >>> 0;
    }
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
      if (this.readWordsRemaining <= 0) {
        this.gpuStat &= ~(1 << 27);
      }
      return ((p2 << 16) | p1) >>> 0;
    }
    return this.gpuReadValue;
  }

  public readStat(cpuCycles?: number): number {
    let stat = this.gpuStat;
    stat |= (1 << 26); // Ready to receive DMA block

    if (this.transferWordsRemaining > 0) {
      stat &= ~(1 << 28); // Busy receiving image data
    } else {
      stat |= (1 << 28);  // Ready for command word
    }

    const isOddField = (cpuCycles !== undefined && cpuCycles > 0)
      ? (Math.floor(cpuCycles / 564480) & 1) !== 0
      : this.currentField === 1;

    if (isOddField) {
      stat |= (1 << 31);
    } else {
      stat &= ~(1 << 31);
    }

    this.gpuStat = stat >>> 0;
    return stat >>> 0;
  }

  public processDmaBatch(words: number[]): void {
    if (!words || words.length === 0) return;
    const t0 = performance.now();
    for (let i = 0; i < words.length; i++) {
      this.sendGp0(words[i]);
    }
    this.totalGpuDrawMs += performance.now() - t0;
  }

  public sendGp0(data: number): void {
    const val = data >>> 0;
    this.gp0WriteCount++;

    if (this.transferWordsRemaining > 0) {
      this.writeCpuToVramWord(val);
      this.transferWordsRemaining--;

      if (this.transferWordsRemaining <= 0) {
        this.gpuStat |= (1 << 28); // GPU ready for commands
        this.framesRendered++;
      }
      return;
    }

    if (this.gp0Buffer.length === 0) {
      this.currentGp0Cmd = (val >>> 24) & 0xFF;
      if (this.onLog && this.currentGp0Cmd !== this._lastLoggedGp0Cmd) {
        this._lastLoggedGp0Cmd = this.currentGp0Cmd;
        let cmdDesc = `0x${this.currentGp0Cmd.toString(16).padStart(2, '0').toUpperCase()}`;
        if (this.currentGp0Cmd === 0x01) cmdDesc += ' (Clear Cache)';
        else if (this.currentGp0Cmd === 0x02) cmdDesc += ' (Fill VRAM Rectangle)';
        else if (this.currentGp0Cmd >= 0x20 && this.currentGp0Cmd <= 0x3f) cmdDesc += ' (Render Polygon)';
        else if (this.currentGp0Cmd >= 0x60 && this.currentGp0Cmd <= 0x7f) cmdDesc += ' (Render Rectangle / Sprite)';
        else if (this.currentGp0Cmd >= 0xa0 && this.currentGp0Cmd <= 0xbf) cmdDesc += ' (CPU-to-VRAM Transfer)';
        else if (this.currentGp0Cmd >= 0xe1 && this.currentGp0Cmd <= 0xe6) cmdDesc += ' (Environment / Draw Settings)';
        this.onLog('gpu', `[GPU GP0 WRITE 0x1F801810] Command: ${cmdDesc} (Val: 0x${val.toString(16).toUpperCase()})`);
      }
    }
    this.gp0Buffer.push(val);

    if (this.currentGp0Cmd >= 0xA0 && this.currentGp0Cmd <= 0xBF) {
      if (this.gp0Buffer.length === 3) {
        const rawDst = this.gp0Buffer[1];
        const rawSize = this.gp0Buffer[2];

        const x = rawDst & 0xFFFF;
        const y = (rawDst >>> 16) & 0xFFFF;
        const w = rawSize & 0xFFFF;
        const h = (rawSize >>> 16) & 0xFFFF;

        // Reject invalid zero-size transfers (e.g., rawSize === 0)
        if (w === 0 && h === 0) {
          this.transferWordsRemaining = 0;
          this.gp0Buffer = [];
          this.currentGp0Cmd = 0;
          return;
        }

        this.transferDstX = x & 0x3FF;
        this.transferDstY = y & 0x1FF;
        this.transferWidth = ((w - 1) & 0x3FF) + 1;
        this.transferHeight = ((h - 1) & 0x1FF) + 1;
        this.transferCurX = 0;
        this.transferCurY = 0;
        this.imgIndex = 0;

        const totalPixels = this.transferWidth * this.transferHeight;
        this.transferWordsRemaining = (totalPixels + 1) >>> 1;

        const msg = `[VRAM IMAGE LOAD] Corrected Dst: (${this.transferDstX}, ${this.transferDstY}), Size: ${this.transferWidth}x${this.transferHeight} (${this.transferWordsRemaining} words)`;
        console.log(msg);
        if (this.onLog) {
          this.onLog('gpu', msg);
        }

        this.gp0Buffer = [];
      }
      return;
    }

    if (this.currentGp0Cmd >= 0xC0 && this.currentGp0Cmd <= 0xDF) {
      if (this.gp0Buffer.length === 3) {
        const rawSrc = this.gp0Buffer[1];
        const rawSize = this.gp0Buffer[2];

        const sx = rawSrc & 0xFFFF;
        const sy = (rawSrc >>> 16) & 0xFFFF;
        const w = rawSize & 0xFFFF;
        const h = (rawSize >>> 16) & 0xFFFF;

        this.readDstX = sx & 0x3FF;
        this.readDstY = sy & 0x1FF;
        this.readWidth = ((w - 1) & 0x3FF) + 1;
        this.readHeight = ((h - 1) & 0x1FF) + 1;

        const totalPixels = this.readWidth * this.readHeight;
        this.imgReadTotal = totalPixels;
        this.imgReadIndex = 0;
        this.readWordsRemaining = (totalPixels + 1) >>> 1;

        // Extract halfwords line-by-line from VRAM into the read buffer
        if (!this.imgReadBuffer || this.imgReadBuffer.length < totalPixels) {
          this.imgReadBuffer = new Uint16Array(totalPixels + 2);
        }
        let bufferIdx = 0;
        for (let y = 0; y < this.readHeight; y++) {
          const rowOffset = ((this.readDstY + y) & 511) * 1024;
          for (let x = 0; x < this.readWidth; x++) {
            this.imgReadBuffer[bufferIdx++] = this.vram[rowOffset + ((this.readDstX + x) & 1023)];
          }
        }

        // Set GPUSTAT Bit 27: Ready to send VRAM to CPU
        this.gpuStat |= (1 << 27);
        this.gp0Buffer = [];
      }
      return;
    }

    this.checkAndExecutePrimitive();
  }

  public checkAndExecutePrimitive(): void {
    if (this.gp0Buffer.length === 0) return;
    const cmd = (this.gp0Buffer[0] >>> 24) & 0xFF;

    if ((cmd >= 0x48 && cmd <= 0x4f) || (cmd >= 0x58 && cmd <= 0x5f)) {
      const lastWord = this.gp0Buffer[this.gp0Buffer.length - 1];
      if (
        this.gp0Buffer.length >= 3 &&
        ((lastWord & 0xFFFFFFFF) === 0x55555555 ||
         (lastWord & 0xFFFFFFFF) === 0x50005000 ||
         ((lastWord >>> 16) === 0x5555 && (lastWord & 0xFFFF) === 0x5555) ||
         ((lastWord >>> 16) === 0x5000 && (lastWord & 0xFFFF) === 0x5000))
      ) {
        this.executeGp0Packet(this.gp0Buffer);
        this.gp0Buffer = [];
      }
      return;
    }

    const totalWords = getGp0PacketLength(this.gp0Buffer[0]);
    if (this.gp0Buffer.length >= totalWords) {
      const packet = this.gp0Buffer.slice(0, totalWords);
      this.gp0Buffer = this.gp0Buffer.slice(totalWords);
      this.executeGp0Packet(packet);
      if (this.gp0Buffer.length > 0) {
        this.checkAndExecutePrimitive();
      }
    }
  }

  public writeGp1(val: number): void {
    val = val >>> 0;
    this.gp1WriteCount++;
    const cmd = (val >>> 24) & 0xff;

    if (this.onLog && cmd !== this._lastLoggedGp1Cmd) {
      this._lastLoggedGp1Cmd = cmd;
      let cmdDesc = `0x${cmd.toString(16).padStart(2, '0').toUpperCase()}`;
      if (cmd === 0x00) cmdDesc += ' (Reset GPU)';
      else if (cmd === 0x01) cmdDesc += ' (Reset Command Buffer)';
      else if (cmd === 0x02) cmdDesc += ' (Acknowledge IRQ)';
      else if (cmd === 0x03) cmdDesc += ` (Display ${((val & 1) !== 0) ? 'Disabled' : 'Enabled'})`;
      else if (cmd === 0x04) cmdDesc += ' (DMA Direction / Data Request)';
      else if (cmd === 0x05) cmdDesc += ' (Display Area Start in VRAM)';
      else if (cmd === 0x06) cmdDesc += ' (Horizontal Display Range)';
      else if (cmd === 0x07) cmdDesc += ' (Vertical Display Range)';
      else if (cmd === 0x08) cmdDesc += ' (Display Mode / Resolution)';
      this.onLog('gpu', `[GPU GP1 WRITE 0x1F801814] Control: ${cmdDesc} (Val: 0x${val.toString(16).toUpperCase()})`);
    }

    switch (cmd) {
      case 0x00:
        this.reset();
        break;
      case 0x01:
        this.currentGp0Cmd = 0;
        this.gp0Buffer = [];
        this.transferWordsRemaining = 0;
        break;
      case 0x02:
        this.gpuStat &= ~(1 << 24);
        if (this.onAcknowledgeIrq) {
          this.onAcknowledgeIrq();
        }
        break;
      case 0x03:
        this.displayDisabled = (val & 1) !== 0;
        this.displayEnabled = !this.displayDisabled;
        if (this.displayDisabled) {
          this.gpuStat |= (1 << 23);
        } else {
          this.gpuStat &= ~(1 << 23);
        }
        break;
      case 0x04:
        {
          const dmaDir = val & 3;
          this.gpuStat = ((this.gpuStat & ~(3 << 29)) | (dmaDir << 29)) >>> 0;
        }
        break;
      case 0x05:
        this.displayVramX = val & 0x3FF;
        this.displayVramY = (val >>> 10) & 0x1FF;
        this.displayStartX = this.displayVramX;
        this.displayStartY = this.displayVramY;
        console.log(`[GP1 DISPLAY START] Origin: (${this.displayVramX}, ${this.displayVramY})`);
        if (this.onLog) {
          this.onLog('gpu', `[GP1 DISPLAY START] Origin: (${this.displayVramX}, ${this.displayVramY})`);
        }
        break;
      case 0x06: {
        this.displayHorizRange = val & 0x00ffffff;
        const dispL = val & 0xFFF;
        const dispR = (val >>> 12) & 0xFFF;
        const dispW = Math.max(0, dispR - dispL);

        const hresMode = (this.gpuStat >>> 16) & 7;
        const maxWidths = [256, 368, 320, 368, 512, 368, 640, 368];
        const divisors = [10, 7, 8, 7, 5, 7, 4, 7];

        let calculatedWidth = Math.floor(dispW / (divisors[hresMode] || 8));
        calculatedWidth = Math.min(maxWidths[hresMode] || 320, (calculatedWidth + 2) & ~3);

        if (calculatedWidth > 0) {
          this.displayWidth = calculatedWidth;
          this.width = calculatedWidth;
        }
        break;
      }

      case 0x07: {
        this.displayVertRange = val & 0x00ffffff;
        const dispT = val & 0x3FF;
        let dispB = (val >>> 10) & 0x3FF;
        if (dispB < dispT) dispB += 288;
        const dispH = Math.max(0, dispB - dispT);

        const vresMode = (this.gpuStat >>> 19) & 3;
        const maxHeights = [240, 480, 256, 512];
        const multipliers = [1, 2, 1, 2];

        let calculatedHeight = (multipliers[vresMode] || 1) * dispH;
        calculatedHeight = Math.min(maxHeights[vresMode] || 240, calculatedHeight);

        if (calculatedHeight > 0) {
          this.displayHeight = calculatedHeight;
          this.height = calculatedHeight;
        }
        break;
      }
      case 0x08:
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

          const isPal = (val & 0x08) !== 0;
          const is24bpp = (val & 0x10) !== 0;
          this.is24BitColor = is24bpp;
          const vres = ((val >>> 2) & 0x01) !== 0;
          const isInterlaced = (val & 0x20) !== 0;
          this.isInterlaced = isInterlaced || vres;
          this.displayHeight = isInterlaced ? 480 : 240;

          this.gpuStat = (this.gpuStat & ~0x007f4000) >>> 0;
          this.gpuStat |= (hres1 << 17);
          if (vres) this.gpuStat |= (1 << 19);
          if (isPal) this.gpuStat |= (1 << 20);
          if (is24bpp) this.gpuStat |= (1 << 21);
          if (isInterlaced) this.gpuStat |= (1 << 22);
          if (hres2 === 1) this.gpuStat |= (1 << 16);
          if ((val & 0x80) !== 0) this.gpuStat |= (1 << 14);
        }
        break;
      case 0x10:
        {
          const infoCmd = val & 0x0f;
          switch (infoCmd) {
            case 2: this.gpuReadValue = this.textureWindow; break;
            case 3: this.gpuReadValue = (this.drawAreaX1 & 0x3ff) | ((this.drawAreaY1 & 0x1ff) << 10); break;
            case 4: this.gpuReadValue = (this.drawAreaX2 & 0x3ff) | ((this.drawAreaY2 & 0x1ff) << 10); break;
            case 5: this.gpuReadValue = (this.drawOffsetX & 0x7ff) | ((this.drawOffsetY & 0x7ff) << 11); break;
            case 7: this.gpuReadValue = 2; break;
            default: this.gpuReadValue = 0; break;
          }
        }
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
    switch (cmd) {
      case 0xe1:
        this.drawMode = val & 0x00ffffff;
        this.currentTexpage = val & 0xffff;
        this.gpuStat = (this.gpuStat & ~0x000007ff) | (val & 0x000007ff);
        break;
      case 0xe2:
        this.textureWindow = val & 0x00ffffff;
        break;
      case 0xe3:
        this.drawAreaX1 = Math.min(1023, Math.max(0, val & 0x3ff));
        this.drawAreaY1 = Math.min(511, Math.max(0, (val >>> 10) & 0x1ff));
        break;
      case 0xe4:
        this.drawAreaX2 = Math.min(1023, Math.max(0, val & 0x3ff));
        this.drawAreaY2 = Math.min(511, Math.max(0, (val >>> 10) & 0x1ff));
        break;
      case 0xe5:
        this.drawOffsetX = (val << 21) >> 21;
        this.drawOffsetY = ((val >>> 11) << 21) >> 21;
        break;
      case 0xe6:
        this.maskSet = (val & 1) !== 0;
        this.maskCheck = (val & 2) !== 0;
        this.gpuStat = (this.gpuStat & ~0x1800) | ((val & 3) << 11);
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
        const offset = vy * 1024 + vx;
        if (this.maskCheck && (this.vram[offset] & 0x8000) !== 0) {
          // Pixel masked
        } else {
          this.vram[offset] = this.maskSet ? (pixel | 0x8000) : pixel;
        }
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

  private executeGp0Packet(words: number[]): void {
    if (!words || words.length === 0) return;
    this.framePackets++;
    const opcode = (words[0] >>> 24) & 0xff;
    const cmd = opcode;

    if (opcode >= 0x20 && opcode <= 0x7f) {
      this.totalDrawPacketsProcessed++;
    } else if (opcode === 0x02 || (opcode >= 0x80 && opcode <= 0xdf)) {
      this.totalDrawPacketsProcessed++;
    }

    if (cmd >= 0x00 && cmd <= 0x1f) {
      if (cmd === 0x02 && words.length >= 3) {
        const color = words[0];
        const r = color & 0xff;
        const g = (color >>> 8) & 0xff;
        const b = (color >>> 16) & 0xff;

        const x = words[1] & 0x3f0;
        const y = (words[1] >>> 16) & 0x1ff;

        let width = ((words[2] & 0xffff) + 0x0f) & ~0x0f;
        let height = (words[2] >>> 16) & 0x1ff;

        if (x + width > 1024) width = Math.max(0, 1024 - x);
        if (y + height > 512) height = Math.max(0, 512 - y);

        if (width > 0 && height > 0) {
          this.fillRectangle(x, y, width, height, r, g, b);
          this.framesRendered++;
        }
        return;
      }
      if (cmd === 0x1f) {
        this.gpuStat |= (1 << 24);
        if (this.onTriggerIrq) {
          this.onTriggerIrq();
        }
      }
      return;
    }

    switch (cmd) {
      case 0x20: case 0x21: case 0x22: case 0x23:
        if (words.length >= 4) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const v1 = this.unpackVertex(words[2], this.drawOffsetX, this.drawOffsetY);
          const v2 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          this.drawFlatTriangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x24: case 0x25: case 0x26: case 0x27:
        if (words.length >= 7) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          if (isRaw || (r === 0 && g === 0 && b === 0)) { r = g = b = 0x80; }

          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff, v0_uv = (words[2] >>> 8) & 0xff, clut = (words[2] >>> 16) & 0xffff;
          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const u1 = words[4] & 0xff, v1_uv = (words[4] >>> 8) & 0xff, texpage = (words[4] >>> 16) & 0xffff;
          const v2 = this.unpackVertex(words[5], this.drawOffsetX, this.drawOffsetY);
          const u2 = words[6] & 0xff, v2_uv = (words[6] >>> 8) & 0xff;

          this.currentTexpage = texpage;
          this.gpuStat = (this.gpuStat & ~0x000007ff) | (texpage & 0x000007ff);

          const c = { r, g, b };
          this.drawTexturedTriangle(v0, { u: u0, v: v0_uv }, c, v1, { u: u1, v: v1_uv }, c, v2, { u: u2, v: v2_uv }, c, clut, texpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x28: case 0x29: case 0x2a: case 0x2b:
        if (words.length >= 5) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const v1 = this.unpackVertex(words[2], this.drawOffsetX, this.drawOffsetY);
          const v2 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const v3 = this.unpackVertex(words[4], this.drawOffsetX, this.drawOffsetY);

          this.drawFlatTriangle(v0.x, v0.y, v1.x, v1.y, v2.x, v2.y, r, g, b, isSemiTransparent);
          this.drawFlatTriangle(v1.x, v1.y, v3.x, v3.y, v2.x, v2.y, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x2c: case 0x2d: case 0x2e: case 0x2f:
        if (words.length >= 9) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          if (isRaw || (r === 0 && g === 0 && b === 0)) { r = g = b = 0x80; }

          const clut = (words[2] >>> 16) & 0xffff;
          const texpage = (words[4] >>> 16) & 0xffff;
          this.currentTexpage = texpage;
          this.gpuStat = (this.gpuStat & ~0x000007ff) | (texpage & 0x000007ff);

          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const uv0 = { u: words[2] & 0xff, v: (words[2] >>> 8) & 0xff };
          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const uv1 = { u: words[4] & 0xff, v: (words[4] >>> 8) & 0xff };
          const v2 = this.unpackVertex(words[5], this.drawOffsetX, this.drawOffsetY);
          const uv2 = { u: words[6] & 0xff, v: (words[6] >>> 8) & 0xff };
          const v3 = this.unpackVertex(words[7], this.drawOffsetX, this.drawOffsetY);
          const uv3 = { u: words[8] & 0xff, v: (words[8] >>> 8) & 0xff };

          const c = { r, g, b };
          this.drawTexturedTriangle(v0, uv0, c, v1, uv1, c, v2, uv2, c, clut, texpage, isRaw, isSemiTransparent);
          this.drawTexturedTriangle(v1, uv1, c, v3, uv3, c, v2, uv2, c, clut, texpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x30: case 0x31: case 0x32: case 0x33:
        if (words.length >= 6) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const c0 = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const c1 = { r: words[2] & 0xff, g: (words[2] >>> 8) & 0xff, b: (words[2] >>> 16) & 0xff };
          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const c2 = { r: words[4] & 0xff, g: (words[4] >>> 8) & 0xff, b: (words[4] >>> 16) & 0xff };
          const v2 = this.unpackVertex(words[5], this.drawOffsetX, this.drawOffsetY);

          this.drawGouraudTriangle(v0.x, v0.y, c0.r, c0.g, c0.b, v1.x, v1.y, c1.r, c1.g, c1.b, v2.x, v2.y, c2.r, c2.g, c2.b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x34: case 0x35: case 0x36: case 0x37:
        if (words.length >= 9) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          const c0 = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff, v0_uv = (words[2] >>> 8) & 0xff, clut = (words[2] >>> 16) & 0xffff;
          const c1 = { r: words[3] & 0xff, g: (words[3] >>> 8) & 0xff, b: (words[3] >>> 16) & 0xff };
          const v1 = this.unpackVertex(words[4], this.drawOffsetX, this.drawOffsetY);
          const u1 = words[5] & 0xff, v1_uv = (words[5] >>> 8) & 0xff, texpage = (words[5] >>> 16) & 0xffff;
          const c2 = { r: words[6] & 0xff, g: (words[6] >>> 8) & 0xff, b: (words[6] >>> 16) & 0xff };
          const v2 = this.unpackVertex(words[7], this.drawOffsetX, this.drawOffsetY);
          const u2 = words[8] & 0xff, v2_uv = (words[8] >>> 8) & 0xff;

          this.currentTexpage = texpage;
          this.gpuStat = (this.gpuStat & ~0x000007ff) | (texpage & 0x000007ff);

          this.drawTexturedTriangle(v0, { u: u0, v: v0_uv }, c0, v1, { u: u1, v: v1_uv }, c1, v2, { u: u2, v: v2_uv }, c2, clut, texpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x38: case 0x39: case 0x3a: case 0x3b:
        if (words.length >= 8) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const c0 = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const c1 = { r: words[2] & 0xff, g: (words[2] >>> 8) & 0xff, b: (words[2] >>> 16) & 0xff };
          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          const c2 = { r: words[4] & 0xff, g: (words[4] >>> 8) & 0xff, b: (words[4] >>> 16) & 0xff };
          const v2 = this.unpackVertex(words[5], this.drawOffsetX, this.drawOffsetY);
          const c3 = { r: words[6] & 0xff, g: (words[6] >>> 8) & 0xff, b: (words[6] >>> 16) & 0xff };
          const v3 = this.unpackVertex(words[7], this.drawOffsetX, this.drawOffsetY);

          this.drawGouraudTriangle(v0.x, v0.y, c0.r, c0.g, c0.b, v1.x, v1.y, c1.r, c1.g, c1.b, v2.x, v2.y, c2.r, c2.g, c2.b, isSemiTransparent);
          this.drawGouraudTriangle(v1.x, v1.y, c1.r, c1.g, c1.b, v2.x, v2.y, c2.r, c2.g, c2.b, v3.x, v3.y, c3.r, c3.g, c3.b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x3c: case 0x3d: case 0x3e: case 0x3f:
        if (words.length >= 12) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          const c0 = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const uv0 = { u: words[2] & 0xff, v: (words[2] >>> 8) & 0xff };
          const clut = (words[2] >>> 16) & 0xffff;
          const c1 = { r: words[3] & 0xff, g: (words[3] >>> 8) & 0xff, b: (words[3] >>> 16) & 0xff };
          const v1 = this.unpackVertex(words[4], this.drawOffsetX, this.drawOffsetY);
          const uv1 = { u: words[5] & 0xff, v: (words[5] >>> 8) & 0xff };
          const texpage = (words[5] >>> 16) & 0xffff;
          const c2 = { r: words[6] & 0xff, g: (words[6] >>> 8) & 0xff, b: (words[6] >>> 16) & 0xff };
          const v2 = this.unpackVertex(words[7], this.drawOffsetX, this.drawOffsetY);
          const uv2 = { u: words[8] & 0xff, v: (words[8] >>> 8) & 0xff };
          const c3 = { r: words[9] & 0xff, g: (words[9] >>> 8) & 0xff, b: (words[9] >>> 16) & 0xff };
          const v3 = this.unpackVertex(words[10], this.drawOffsetX, this.drawOffsetY);
          const uv3 = { u: words[11] & 0xff, v: (words[11] >>> 8) & 0xff };

          this.currentTexpage = texpage;
          this.gpuStat = (this.gpuStat & ~0x000007ff) | (texpage & 0x000007ff);

          this.drawTexturedTriangle(v0, uv0, c0, v1, uv1, c1, v2, uv2, c2, clut, texpage, isRaw, isSemiTransparent);
          this.drawTexturedTriangle(v1, uv1, c1, v3, uv3, c3, v2, uv2, c2, clut, texpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x40: case 0x41: case 0x42: case 0x43:
      case 0x44: case 0x45: case 0x46: case 0x47:
        if (words.length >= 3) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const v1 = this.unpackVertex(words[2], this.drawOffsetX, this.drawOffsetY);
          this.drawFlatTriangle(v0.x, v0.y, v1.x, v1.y, v1.x + 1, v1.y + 1, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57:
        if (words.length >= 4) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const c0 = { r: words[0] & 0xff, g: (words[0] >>> 8) & 0xff, b: (words[0] >>> 16) & 0xff };
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const c1 = { r: words[2] & 0xff, g: (words[2] >>> 8) & 0xff, b: (words[2] >>> 16) & 0xff };
          const v1 = this.unpackVertex(words[3], this.drawOffsetX, this.drawOffsetY);
          this.drawGouraudTriangle(v0.x, v0.y, c0.r, c0.g, c0.b, v1.x, v1.y, c1.r, c1.g, c1.b, v1.x + 1, v1.y + 1, c1.r, c1.g, c1.b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x60: case 0x61: case 0x62: case 0x63:
        if (words.length >= 3) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const w = words[2] & 0xffff, h = (words[2] >>> 16) & 0xffff;
          this.drawRect(v0.x, v0.y, w, h, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x64: case 0x65: case 0x66: case 0x67:
        if (words.length >= 4) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let color = words[0];
          if (isRaw || (color & 0xffffff) === 0) color = 0x808080;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff;
          const v0_uv = (words[2] >>> 8) & 0xff;
          const clut = (words[2] >>> 16) & 0xffff;
          const w = words[3] & 0xffff;
          const h = (words[3] >>> 16) & 0xffff;
          const texpage = this.currentTexpage;
          this.drawTexturedRect(v0.x, v0.y, w, h, u0, v0_uv, clut, color, texpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x68: case 0x69: case 0x6a: case 0x6b:
        if (words.length >= 2) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          this.drawRect(v0.x, v0.y, 1, 1, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x6c: case 0x6d: case 0x6e: case 0x6f:
        if (words.length >= 3) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let color = words[0];
          if (isRaw || (color & 0xffffff) === 0) color = 0x808080;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff, v0_uv = (words[2] >>> 8) & 0xff, clut = (words[2] >>> 16) & 0xffff;
          this.drawTexturedRect(v0.x, v0.y, 1, 1, u0, v0_uv, clut, color, this.currentTexpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x70: case 0x71: case 0x72: case 0x73:
        if (words.length >= 2) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          this.drawRect(v0.x, v0.y, 8, 8, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x74: case 0x75: case 0x76: case 0x77:
        if (words.length >= 3) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let color = words[0];
          if (isRaw || (color & 0xffffff) === 0) color = 0x808080;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff, v0_uv = (words[2] >>> 8) & 0xff, clut = (words[2] >>> 16) & 0xffff;
          this.drawTexturedRect(v0.x, v0.y, 8, 8, u0, v0_uv, clut, color, this.currentTexpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x78: case 0x79: case 0x7a: case 0x7b:
        if (words.length >= 2) {
          const isSemiTransparent = (cmd & 2) !== 0;
          const r = words[0] & 0xff, g = (words[0] >>> 8) & 0xff, b = (words[0] >>> 16) & 0xff;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          this.drawRect(v0.x, v0.y, 16, 16, r, g, b, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x7c: case 0x7d: case 0x7e: case 0x7f:
        if (words.length >= 3) {
          const isRaw = (cmd & 1) !== 0;
          const isSemiTransparent = (cmd & 2) !== 0;
          let color = words[0];
          if (isRaw || (color & 0xffffff) === 0) color = 0x808080;
          const v0 = this.unpackVertex(words[1], this.drawOffsetX, this.drawOffsetY);
          const u0 = words[2] & 0xff, v0_uv = (words[2] >>> 8) & 0xff, clut = (words[2] >>> 16) & 0xffff;
          this.drawTexturedRect(v0.x, v0.y, 16, 16, u0, v0_uv, clut, color, this.currentTexpage, isRaw, isSemiTransparent);
          this.framesRendered++;
        }
        break;

      case 0x80: // VRAM to VRAM Copy
        if (words.length >= 4) {
          const sx = words[1] & 0x3ff, sy = (words[1] >>> 16) & 0x1ff;
          const dx = words[2] & 0x3ff, dy = (words[2] >>> 16) & 0x1ff;
          const w = (((words[3] & 0xffff) - 1) & 0x3ff) + 1;
          const h = ((((words[3] >>> 16) & 0xffff) - 1) & 0x1ff) + 1;
          for (let cy = 0; cy < h; cy++) {
            const srcRow = ((sy + cy) & 511) * 1024;
            const dstRow = ((dy + cy) & 511) * 1024;
            for (let cx = 0; cx < w; cx++) {
              const srcPixel = this.vram[srcRow + ((sx + cx) & 1023)];
              const dstOffset = dstRow + ((dx + cx) & 1023);
              if (this.maskCheck && (this.vram[dstOffset] & 0x8000) !== 0) {
                continue;
              }
              this.vram[dstOffset] = this.maskSet ? (srcPixel | 0x8000) : srcPixel;
            }
          }
          this.framesRendered++;
        }
        break;

      case 0xe1: case 0xe2: case 0xe3: case 0xe4: case 0xe5: case 0xe6:
        this.executeGp0Environment(cmd, words[0]);
        break;
    }
  }

  private sampleTexel(u: number, v: number, clut: number, texPageWord: number): { r: number; g: number; b: number; transparent: boolean; stp: boolean; raw16: number } {
    const texBaseX = (texPageWord & 0x0f) * 64;
    const texBaseY = ((texPageWord >>> 4) & 0x01) * 256;
    const colorDepth = (texPageWord >>> 7) & 0x03;

    const clutX = (clut & 0x3f) << 4;
    const clutY = (clut >>> 6) & 0x1ff;

    let curU = Math.floor(u) & 0xff;
    let curV = Math.floor(v) & 0xff;

    if (this.texWindowMaskX !== 0 || this.texWindowMaskY !== 0) {
      curU = (curU & ~(this.texWindowMaskX * 8)) | ((this.texWindowOffsetX & this.texWindowMaskX) * 8);
      curV = (curV & ~(this.texWindowMaskY * 8)) | ((this.texWindowOffsetY & this.texWindowMaskY) * 8);
      curU &= 0xff;
      curV &= 0xff;
    }

    let raw16 = 0;
    const texY = (texBaseY + curV) & 511;

    if (colorDepth === 0) {
      const wordX = (texBaseX + (curU >>> 2)) & 1023;
      const texWord = this.vram[texY * 1024 + wordX];
      const shift = (curU & 3) << 2;
      const clutIndex = (texWord >>> shift) & 0x0f;
      raw16 = this.vram[((clutY & 511) * 1024) + ((clutX + clutIndex) & 1023)];
    } else if (colorDepth === 1) {
      const wordX = (texBaseX + (curU >>> 1)) & 1023;
      const texWord = this.vram[texY * 1024 + wordX];
      const shift = (curU & 1) << 3;
      const clutIndex = (texWord >>> shift) & 0xff;
      raw16 = this.vram[((clutY & 511) * 1024) + ((clutX + clutIndex) & 1023)];
    } else {
      const wordX = (texBaseX + curU) & 1023;
      raw16 = this.vram[texY * 1024 + wordX];
    }

    if (raw16 === 0x0000) {
      return { r: 0, g: 0, b: 0, transparent: true, stp: false, raw16: 0 };
    }

    const r5 = raw16 & 0x1f;
    const g5 = (raw16 >>> 5) & 0x1f;
    const b5 = (raw16 >>> 10) & 0x1f;
    const stp = (raw16 & 0x8000) !== 0;

    return {
      r: (r5 << 3) | (r5 >> 2),
      g: (g5 << 3) | (g5 >> 2),
      b: (b5 << 3) | (b5 >> 2),
      transparent: false,
      stp,
      raw16
    };
  }

  private blendColor(bgR: number, bgG: number, bgB: number, fgR: number, fgG: number, fgB: number, mode: number): { r: number; g: number; b: number } {
    switch (mode) {
      case 0:
        return { r: (bgR >> 1) + (fgR >> 1), g: (bgG >> 1) + (fgG >> 1), b: (bgB >> 1) + (fgB >> 1) };
      case 1:
        return { r: Math.min(255, bgR + fgR), g: Math.min(255, bgG + fgG), b: Math.min(255, bgB + fgB) };
      case 2:
        return { r: Math.max(0, bgR - fgR), g: Math.max(0, bgG - fgG), b: Math.max(0, bgB - fgB) };
      case 3:
        return { r: Math.min(255, bgR + (fgR >> 2)), g: Math.min(255, bgG + (fgG >> 2)), b: Math.min(255, bgB + (fgB >> 2)) };
      default:
        return { r: fgR, g: fgG, b: fgB };
    }
  }

  private drawGouraudTriangle(
    x0: number, y0: number, r0: number, g0: number, b0: number,
    x1: number, y1: number, r1: number, g1: number, b1: number,
    x2: number, y2: number, r2: number, g2: number, b2: number,
    isSemiTransparent: boolean = false
  ): void {
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (this.drawMode >>> 5) & 0x03;

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const minX = Math.max(clipMinX, Math.min(x0, x1, x2));
    const maxX = Math.min(clipMaxX, Math.max(x0, x1, x2));
    const minY = Math.max(clipMinY, Math.min(y0, y1, y2));
    const maxY = Math.min(clipMaxY, Math.max(y0, y1, y2));

    if (minX > maxX || minY > maxY) return;

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
          let r8 = Math.min(255, Math.max(0, Math.round(r0 * w0 + r1 * w1 + r2 * w2)));
          let g8 = Math.min(255, Math.max(0, Math.round(g0 * w0 + g1 * w1 + g2 * w2)));
          let b8 = Math.min(255, Math.max(0, Math.round(b0 * w0 + b1 * w1 + b2 * w2)));

          if (isSemiTransparent) {
            const bg16 = this.vram[rowOffset + (x & 1023)];
            const bgR = ((bg16 & 0x1f) << 3) | ((bg16 & 0x1f) >> 2);
            const bgG = (((bg16 >> 5) & 0x1f) << 3) | (((bg16 >> 5) & 0x1f) >> 2);
            const bgB = (((bg16 >> 10) & 0x1f) << 3) | (((bg16 >> 10) & 0x1f) >> 2);
            const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
            r8 = blended.r; g8 = blended.g; b8 = blended.b;
          }

          const r5 = applyDither(r8, x, y, dither);
          const g5 = applyDither(g8, x, y, dither);
          const b5 = applyDither(b8, x, y, dither);
          const dstIdx = rowOffset + (x & 1023);
          if (this.maskCheck && (this.vram[dstIdx] & 0x8000) !== 0) continue;
          let outPixel = (b5 << 10) | (g5 << 5) | r5;
          if (this.maskSet) outPixel |= 0x8000;
          this.vram[dstIdx] = outPixel;
        }
      }
    }
  }

  private drawFlatTriangle(
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    r: number, g: number, b: number,
    isSemiTransparent: boolean = false
  ): void {
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (this.drawMode >>> 5) & 0x03;

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const minX = Math.max(clipMinX, Math.min(x0, x1, x2));
    const maxX = Math.min(clipMaxX, Math.max(x0, x1, x2));
    const minY = Math.max(clipMinY, Math.min(y0, y1, y2));
    const maxY = Math.min(clipMaxY, Math.max(y0, y1, y2));

    if (minX > maxX || minY > maxY) return;

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
          let r8 = r, g8 = g, b8 = b;
          if (isSemiTransparent) {
            const bg16 = this.vram[rowOffset + (x & 1023)];
            const bgR = ((bg16 & 0x1f) << 3) | ((bg16 & 0x1f) >> 2);
            const bgG = (((bg16 >> 5) & 0x1f) << 3) | (((bg16 >> 5) & 0x1f) >> 2);
            const bgB = (((bg16 >> 10) & 0x1f) << 3) | (((bg16 >> 10) & 0x1f) >> 2);
            const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
            r8 = blended.r; g8 = blended.g; b8 = blended.b;
          }

          const r5 = applyDither(r8, x, y, dither);
          const g5 = applyDither(g8, x, y, dither);
          const b5 = applyDither(b8, x, y, dither);
          const dstIdx = rowOffset + (x & 1023);
          if (this.maskCheck && (this.vram[dstIdx] & 0x8000) !== 0) continue;
          let outPixel = (b5 << 10) | (g5 << 5) | r5;
          if (this.maskSet) outPixel |= 0x8000;
          this.vram[dstIdx] = outPixel;
        }
      }
    }
  }

  private fillRectangle(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
    const r5 = (r >> 3) & 0x1f;
    const g5 = (g >> 3) & 0x1f;
    const b5 = (b >> 3) & 0x1f;
    const color16 = (b5 << 10) | (g5 << 5) | r5;
    // Pack two 16-bit pixels into a 32-bit word for fast block writing
    const color32 = (color16 << 16) | color16;

    const startX = x & 0x3f0;
    const startY = y & 0x1ff;
    let width = w;
    let height = h;

    if (startX + width > 1024) width = Math.max(0, 1024 - startX);
    if (startY + height > 512) height = Math.max(0, 512 - startY);

    if (width <= 0 || height <= 0) return;

    for (let dy = 0; dy < height; dy++) {
      const rowWordOffset = (((startY + dy) & 511) * 1024 + startX) >>> 1;
      const wordCount = width >> 1;
      for (let dw = 0; dw < wordCount; dw++) {
        this.vram32[rowWordOffset + dw] = color32;
      }
      if ((width & 1) !== 0) {
        this.vram[(((startY + dy) & 511) * 1024) + startX + width - 1] = color16;
      }
    }
  }

  private drawRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, isSemiTransparent: boolean = false): void {
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

    if (startX > endX || startY > endY) return;

    for (let cy = startY; cy <= endY; cy++) {
      const row = (cy & 511) * 1024;
      for (let cx = startX; cx <= endX; cx++) {
        let r8 = r, g8 = g, b8 = b;
        if (isSemiTransparent) {
          const bg16 = this.vram[row + (cx & 1023)];
          const bgR = ((bg16 & 0x1f) << 3) | ((bg16 & 0x1f) >> 2);
          const bgG = (((bg16 >> 5) & 0x1f) << 3) | (((bg16 >> 5) & 0x1f) >> 2);
          const bgB = (((bg16 >> 10) & 0x1f) << 3) | (((bg16 >> 10) & 0x1f) >> 2);
          const blended = this.blendColor(bgR, bgG, bgB, r8, g8, b8, blendMode);
          r8 = blended.r; g8 = blended.g; b8 = blended.b;
        }

        const r5 = applyDither(r8, cx, cy, dither);
        const g5 = applyDither(g8, cx, cy, dither);
        const b5 = applyDither(b8, cx, cy, dither);
        const dstIdx = row + (cx & 1023);
        if (this.maskCheck && (this.vram[dstIdx] & 0x8000) !== 0) continue;
        let outPixel = (b5 << 10) | (g5 << 5) | r5;
        if (this.maskSet) outPixel |= 0x8000;
        this.vram[dstIdx] = outPixel;
      }
    }
  }

  private drawTexturedRect(
    x0: number, y0: number, w: number, h: number,
    u0: number, v0: number, clut: number,
    color: number = 0x808080, overrideTexPage?: number,
    isRaw: boolean = false, isSemiTransparent: boolean = false
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

    if (x0 > clipMaxX || x0 + w - 1 < clipMinX || y0 > clipMaxY || y0 + h - 1 < clipMinY) return;

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
        if (texel.transparent || texel.raw16 === 0x0000) continue;

        let rFinal = isRaw ? texel.r : Math.min(255, (texel.r * tintR) >> 7);
        let gFinal = isRaw ? texel.g : Math.min(255, (texel.g * tintG) >> 7);
        let bFinal = isRaw ? texel.b : Math.min(255, (texel.b * tintB) >> 7);

        if (isSemiTransparent && texel.stp) {
          const bg16 = this.vram[destRow + (destX & 1023)];
          const bgR = ((bg16 & 0x1f) << 3) | ((bg16 & 0x1f) >> 2);
          const bgG = (((bg16 >> 5) & 0x1f) << 3) | (((bg16 >> 5) & 0x1f) >> 2);
          const bgB = (((bg16 >> 10) & 0x1f) << 3) | (((bg16 >> 10) & 0x1f) >> 2);
          const blended = this.blendColor(bgR, bgG, bgB, rFinal, gFinal, bFinal, blendMode);
          rFinal = blended.r; gFinal = blended.g; bFinal = blended.b;
        }

        const r5 = applyDither(rFinal, destX, destY, dither);
        const g5 = applyDither(gFinal, destX, destY, dither);
        const b5 = applyDither(bFinal, destX, destY, dither);

        const dstIdx = destRow + (destX & 1023);
        if (this.maskCheck && (this.vram[dstIdx] & 0x8000) !== 0) continue;

        let bgr555 = (b5 << 10) | (g5 << 5) | r5;
        if (this.maskSet || (texel.stp && !isSemiTransparent)) {
          bgr555 |= 0x8000;
        } else if (bgr555 === 0 && (texel.stp || texel.raw16 === 0x8000)) {
          bgr555 = 0x8000;
        }
        this.vram[dstIdx] = bgr555;
      }
    }
  }

  private drawTexturedTriangle(
    v0: { x: number; y: number }, uv0: { u: number; v: number }, c0: { r: number; g: number; b: number },
    v1: { x: number; y: number }, uv1: { u: number; v: number }, c1: { r: number; g: number; b: number },
    v2: { x: number; y: number }, uv2: { u: number; v: number }, c2: { r: number; g: number; b: number },
    clut: number, texpage: number, isRaw: boolean = false, isSemiTransparent: boolean = false
  ): void {
    const texPageWord = texpage & 0xffff;
    const dither = ((this.gpuStat & (1 << 9)) !== 0) || ((this.drawMode & (1 << 9)) !== 0);
    const blendMode = (texPageWord >>> 5) & 0x03;

    const clipMinX = Math.max(0, Math.min(this.drawAreaX1, this.drawAreaX2));
    const clipMaxX = Math.min(1023, Math.max(this.drawAreaX1, this.drawAreaX2));
    const clipMinY = Math.max(0, Math.min(this.drawAreaY1, this.drawAreaY2));
    const clipMaxY = Math.min(511, Math.max(this.drawAreaY1, this.drawAreaY2));

    const minX = Math.max(clipMinX, Math.min(v0.x, v1.x, v2.x));
    const maxX = Math.min(clipMaxX, Math.max(v0.x, v1.x, v2.x));
    const minY = Math.max(clipMinY, Math.min(v0.y, v1.y, v2.y));
    const maxY = Math.min(clipMaxY, Math.max(v0.y, v1.y, v2.y));

    if (minX > maxX || minY > maxY) return;

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
          if (texel.transparent || texel.raw16 === 0x0000) continue;

          let rVert = Math.min(255, Math.max(0, Math.round(c0.r * w0 + c1.r * w1 + c2.r * w2)));
          let gVert = Math.min(255, Math.max(0, Math.round(c0.g * w0 + c1.g * w1 + c2.g * w2)));
          let bVert = Math.min(255, Math.max(0, Math.round(c0.b * w0 + c1.b * w1 + c2.b * w2)));

          let rFinal = isRaw ? texel.r : Math.min(255, (texel.r * rVert) >> 7);
          let gFinal = isRaw ? texel.g : Math.min(255, (texel.g * gVert) >> 7);
          let bFinal = isRaw ? texel.b : Math.min(255, (texel.b * bVert) >> 7);

          if (isSemiTransparent && texel.stp) {
            const bg16 = this.vram[rowOffset + (x & 1023)];
            const bgR = ((bg16 & 0x1f) << 3) | ((bg16 & 0x1f) >> 2);
            const bgG = (((bg16 >> 5) & 0x1f) << 3) | (((bg16 >> 5) & 0x1f) >> 2);
            const bgB = (((bg16 >> 10) & 0x1f) << 3) | (((bg16 >> 10) & 0x1f) >> 2);
            const blended = this.blendColor(bgR, bgG, bgB, rFinal, gFinal, bFinal, blendMode);
            rFinal = blended.r; gFinal = blended.g; bFinal = blended.b;
          }

          const r5 = applyDither(rFinal, x, y, dither);
          const g5 = applyDither(gFinal, x, y, dither);
          const b5 = applyDither(bFinal, x, y, dither);

          const dstIdx = rowOffset + (x & 1023);
          if (this.maskCheck && (this.vram[dstIdx] & 0x8000) !== 0) continue;

          let bgr555 = (b5 << 10) | (g5 << 5) | r5;
          if (this.maskSet || (texel.stp && !isSemiTransparent)) {
            bgr555 |= 0x8000;
          } else if (bgr555 === 0 && (texel.stp || texel.raw16 === 0x8000)) {
            bgr555 = 0x8000;
          }
          this.vram[dstIdx] = bgr555;
        }
      }
    }
  }

  public blitFrame(ctx?: CanvasRenderingContext2D): void {
    const t0 = performance.now();
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

    this.extractFrame();

    if (this.completedFrame) {
      const dispW = this.completedFrame.width;
      const dispH = this.completedFrame.height;

      if (targetCtx.canvas.width !== dispW || targetCtx.canvas.height !== dispH) {
        targetCtx.canvas.width = dispW;
        targetCtx.canvas.height = dispH;
      }

      try {
        targetCtx.putImageData(this.completedFrame, 0, 0);
      } catch (err) {
        console.error('[BLIT ERROR] putImageData failed:', err);
      }
    }

    this.totalBlitMs += performance.now() - t0;
  }

  public getDisplayNonZeroCountAt(startX: number, startY: number): number {
    let count = 0;
    const vram = this.vram;
    const dispW = Math.min(320, this.displayWidth || 320);
    const dispH = Math.min(240, this.displayHeight || 240);

    for (let y = 0; y < dispH; y += 4) {
      const vramY = (startY + y) & 511;
      const vramRow = vramY * 1024;
      for (let x = 0; x < dispW; x += 4) {
        const vramX = (startX + x) & 1023;
        if ((vram[vramRow + vramX] & 0x7fff) !== 0) count++;
      }
    }
    return count;
  }

  public extractFrame(): void {
    const dispW = Math.max(1, this.displayWidth || 320);
    const dispH = Math.max(1, this.displayHeight || 240);

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

    const startX = this.displayStartX & 1023;
    const startY = this.displayStartY & 511;

    if (this.is24BitColor) {
      for (let y = 0; y < dispH; y++) {
        const vramY = (startY + y) & 511;
        const lineOffset = vramY * 1024;
        const destOffset = y * dispW * 4;

        for (let x = 0; x < dispW; x++) {
          const byteIndex = (startX * 2) + (x * 3);
          const wordIndex = byteIndex >> 1;
          const isOdd = (byteIndex & 1) !== 0;

          const w0 = this.vram[lineOffset + (wordIndex & 1023)];
          const w1 = this.vram[lineOffset + ((wordIndex + 1) & 1023)];

          let r = 0, g = 0, b = 0;
          if (!isOdd) {
            r = w0 & 0xff;
            g = (w0 >>> 8) & 0xff;
            b = w1 & 0xff;
          } else {
            r = (w0 >>> 8) & 0xff;
            g = w1 & 0xff;
            b = (w1 >>> 8) & 0xff;
          }

          const idx = destOffset + (x * 4);
          data[idx + 0] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        }
      }
    } else {
      for (let y = 0; y < dispH; y++) {
        const vramY = (startY + y) & 511;
        const lineOffset = vramY * 1024;
        const destOffset = y * dispW * 4;

        for (let x = 0; x < dispW; x++) {
          const vramX = (startX + x) & 1023;
          const pixel = this.vram[lineOffset + vramX];

          const r = (pixel & 0x1F) << 3;
          const g = ((pixel >>> 5) & 0x1F) << 3;
          const b = ((pixel >>> 10) & 0x1F) << 3;

          const idx = destOffset + (x * 4);
          data[idx + 0] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;
        }
      }
    }
  }

  public getTotalVramNonZeroCount(): number {
    let count = 0;
    const vram = this.vram;
    for (let i = 0; i < vram.length; i++) {
      if ((vram[i] & 0x7fff) !== 0) count++;
    }
    return count;
  }

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
        if ((vram[vramRow + vramX] & 0x7fff) !== 0) count++;
      }
    }
    return count;
  }

  public renderToCanvas(
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number,
    showScanlines: boolean,
    isRunning: boolean = false,
    errorMessage: string | null = null
  ): void {
    this.targetCanvasCtx = ctx;
    this.blitFrame(ctx);
  }
}