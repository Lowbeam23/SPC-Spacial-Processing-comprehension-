/**
 * PlayStation 1 Macroblock Decoder (MDEC)
 * Hardware video decompressor for full-motion video (FMV) streams.
 * Handles DCT/IDCT, Run-Length Decoding, Quantization Tables,
 * and 16x16 YUV-to-RGB15/24 macroblock decoding.
 */

import type { Memory } from './memory';

export const ZSCAN = [
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
];

const COS_TABLE = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) {
    COS_TABLE[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

export class Mdec {
  public qTableLuma: Uint8Array = new Uint8Array(64);
  public qTableChroma: Uint8Array = new Uint8Array(64);
  public scaleTable: Int16Array = new Int16Array(64);

  public command: number = 0;
  public status: number = 0x80040000; // Reset status (Data Out empty = bit 31)

  public inBuffer: Uint16Array = new Uint16Array(65536);
  public inBufferPtr: number = 0;
  public inBufferLen: number = 0;

  public outBuffer: Uint16Array = new Uint16Array(65536);
  public outBufferPtr: number = 0;
  public outBufferLen: number = 0;

  public outputBit15: boolean = false;
  public isSignedYuv: boolean = false;
  public is24Bit: boolean = false;

  private paramWordsRemaining: number = 0;
  private currentCmdOp: number = 0;

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.qTableLuma.fill(1);
    this.qTableChroma.fill(1);
    this.scaleTable.fill(1);

    this.command = 0;
    this.status = 0x80040000;

    this.inBufferPtr = 0;
    this.inBufferLen = 0;
    this.outBufferPtr = 0;
    this.outBufferLen = 0;

    this.paramWordsRemaining = 0;
    this.currentCmdOp = 0;
  }

  public readStatus(): number {
    let stat = 0;
    if (this.outputBit15) stat |= (1 << 27);
    if (this.isSignedYuv) stat |= (1 << 28);
    const depth = this.is24Bit ? 2 : 3;
    stat |= (depth << 29);

    if (this.outBufferLen === 0 || this.outBufferPtr >= this.outBufferLen) {
      stat |= (1 << 24); // Data Out FIFO Empty
      stat |= (1 << 31); // Data Out FIFO Empty / Ready
    } else {
      stat |= (1 << 26); // Data-Out Request (Ready for DMA/CPU read)
    }

    stat |= (this.paramWordsRemaining & 0xffff);
    return stat >>> 0;
  }

  public readData(): number {
    if (this.outBufferPtr < this.outBufferLen) {
      const w0 = this.outBuffer[this.outBufferPtr++] & 0xffff;
      const w1 = (this.outBufferPtr < this.outBufferLen) ? (this.outBuffer[this.outBufferPtr++] & 0xffff) : 0;
      if (this.outBufferPtr >= this.outBufferLen) {
        this.outBufferPtr = 0;
        this.outBufferLen = 0;
      }
      return ((w1 << 16) | w0) >>> 0;
    }
    return 0;
  }

  public writeCommand(val: number): void {
    const cmd = (val >>> 29) & 0x7;
    this.command = val >>> 0;

    if (cmd === 1) {
      // Command 1: Decode Macroblock(s)
      this.currentCmdOp = 1;
      this.paramWordsRemaining = val & 0xffff;
      this.outputBit15 = (val & (1 << 25)) !== 0;
      this.isSignedYuv = (val & (1 << 26)) !== 0;
      const format = (val >>> 27) & 3;
      this.is24Bit = (format === 2);
    } else if (cmd === 2) {
      // Command 2: Set Quantization Table
      this.currentCmdOp = 2;
      this.paramWordsRemaining = (val & 1) !== 0 ? 32 : 16; // 32 words = 64 bytes (Luma + Chroma)
    } else if (cmd === 3) {
      // Command 3: Set Scale Table
      this.currentCmdOp = 3;
      this.paramWordsRemaining = 16; // 32 16-bit values
    }
  }

  public writeControl(val: number): void {
    if ((val & 0x80000000) !== 0) {
      this.reset();
    }
  }

  public feedInputWords(words: Uint32Array | number[]): void {
    for (let i = 0; i < words.length; i++) {
      const w = words[i] >>> 0;
      if (this.inBufferLen + 2 < this.inBuffer.length) {
        this.inBuffer[this.inBufferLen++] = w & 0xffff;
        this.inBuffer[this.inBufferLen++] = (w >>> 16) & 0xffff;
      }
    }
    if (this.paramWordsRemaining > 0) {
      this.paramWordsRemaining = Math.max(0, this.paramWordsRemaining - words.length);
    }
    this.processInStream();
  }

  public processInStream(): void {
    if (this.currentCmdOp === 2) {
      // Set Quantization Tables (Luma & Chroma)
      let p = this.inBufferPtr;
      let bytesRead = 0;
      while (bytesRead < 64 && p < this.inBufferLen) {
        const word = this.inBuffer[p++];
        this.qTableLuma[bytesRead++] = word & 0xff;
        if (bytesRead < 64) this.qTableLuma[bytesRead++] = (word >>> 8) & 0xff;
      }
      if (bytesRead >= 64 && p < this.inBufferLen) {
        let bytesChroma = 0;
        while (bytesChroma < 64 && p < this.inBufferLen) {
          const word = this.inBuffer[p++];
          this.qTableChroma[bytesChroma++] = word & 0xff;
          if (bytesChroma < 64) this.qTableChroma[bytesChroma++] = (word >>> 8) & 0xff;
        }
      }
      this.inBufferPtr = p;
      if (this.inBufferPtr >= this.inBufferLen) {
        this.inBufferPtr = 0;
        this.inBufferLen = 0;
      }
      this.currentCmdOp = 0;
    } else if (this.currentCmdOp === 3) {
      // Set Scale Table
      let p = this.inBufferPtr;
      let idx = 0;
      while (idx < 32 && p < this.inBufferLen) {
        const word = this.inBuffer[p++];
        this.scaleTable[idx++] = (word << 16) >> 16;
      }
      this.inBufferPtr = p;
      if (this.inBufferPtr >= this.inBufferLen) {
        this.inBufferPtr = 0;
        this.inBufferLen = 0;
      }
      this.currentCmdOp = 0;
    } else if (this.currentCmdOp === 1 || this.paramWordsRemaining > 0) {
      this.decodeMacroblocks();
    }
  }

  private decodeMacroblocks(): void {
    const blockInt = new Int32Array(64);
    const crFloat = new Float32Array(64);
    const cbFloat = new Float32Array(64);
    const yFloats = [
      new Float32Array(64),
      new Float32Array(64),
      new Float32Array(64),
      new Float32Array(64)
    ];

    const srcIdx = { ptr: this.inBufferPtr };

    while (srcIdx.ptr < this.inBufferLen) {
      // Decode 6 blocks per 16x16 macroblock (Cr, Cb, Y0, Y1, Y2, Y3)
      if (!this.decodeBlock(this.inBuffer, srcIdx, blockInt, this.qTableChroma)) break;
      this.idct8x8(blockInt, crFloat);

      if (!this.decodeBlock(this.inBuffer, srcIdx, blockInt, this.qTableChroma)) break;
      this.idct8x8(blockInt, cbFloat);

      let failed = false;
      for (let yIdx = 0; yIdx < 4; yIdx++) {
        if (!this.decodeBlock(this.inBuffer, srcIdx, blockInt, this.qTableLuma)) {
          failed = true;
          break;
        }
        this.idct8x8(blockInt, yFloats[yIdx]);
      }
      if (failed) break;

      // Convert 16x16 YUV to RGB macroblock (15-bit or 24-bit)
      if (this.is24Bit) {
        this.yuvToRgb24(crFloat, cbFloat, yFloats);
      } else {
        this.yuvToRgb15(crFloat, cbFloat, yFloats);
      }
    }

    this.inBufferPtr = srcIdx.ptr;
    if (this.inBufferPtr >= this.inBufferLen) {
      this.inBufferPtr = 0;
      this.inBufferLen = 0;
    }
  }

  private decodeBlock(
    src: Uint16Array,
    srcIdx: { ptr: number },
    block: Int32Array,
    qTable: Uint8Array
  ): boolean {
    block.fill(0);
    if (srcIdx.ptr >= src.length) return false;

    let word = src[srcIdx.ptr++];
    while (word === 0xfe00 && srcIdx.ptr < src.length) {
      word = src[srcIdx.ptr++];
    }

    let dc = (word << 16) >> 16;
    block[0] = dc * qTable[0];

    let k = 0;
    while (srcIdx.ptr < src.length) {
      word = src[srcIdx.ptr++];
      if (word === 0xfe00) break;

      const run = (word >>> 10) & 0x3f;
      let level = (word << 22) >> 22;

      k += run + 1;
      if (k >= 64) break;

      const z = ZSCAN[k];
      block[z] = level * qTable[k];
    }
    return true;
  }

  private idct8x8(block: Int32Array, output: Float32Array): void {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) {
          const cv = v === 0 ? 1 / Math.SQRT2 : 1;
          for (let u = 0; u < 8; u++) {
            const cu = u === 0 ? 1 / Math.SQRT2 : 1;
            const coeff = block[v * 8 + u];
            if (coeff !== 0) {
              sum += cu * cv * coeff * COS_TABLE[u * 8 + x] * COS_TABLE[v * 8 + y];
            }
          }
        }
        output[y * 8 + x] = sum * 0.25;
      }
    }
  }

  private yuvToRgb15(
    cr: Float32Array,
    cb: Float32Array,
    yBlocks: Float32Array[]
  ): void {
    const stpBit = this.outputBit15 ? 0x8000 : 0;

    for (let my = 0; my < 16; my++) {
      const blockYIdx = (my >= 8 ? 2 : 0);
      const localY = my & 7;

      for (let mx = 0; mx < 16; mx++) {
        const blockIdx = blockYIdx + (mx >= 8 ? 1 : 0);
        const localX = mx & 7;

        const yVal = yBlocks[blockIdx][localY * 8 + localX];
        const crVal = cr[(my >> 1) * 8 + (mx >> 1)];
        const cbVal = cb[(my >> 1) * 8 + (mx >> 1)];

        let r = yVal + 1.402 * crVal;
        let g = yVal - 0.344136 * cbVal - 0.714136 * crVal;
        let b = yVal + 1.772 * cbVal;

        r = Math.min(255, Math.max(0, Math.round(r)));
        g = Math.min(255, Math.max(0, Math.round(g)));
        b = Math.min(255, Math.max(0, Math.round(b)));

        const r5 = r >> 3;
        const g5 = g >> 3;
        const b5 = b >> 3;
        const pixel16 = r5 | (g5 << 5) | (b5 << 10) | stpBit;

        if (this.outBufferLen < this.outBuffer.length) {
          this.outBuffer[this.outBufferLen++] = pixel16;
        }
      }
    }
  }

  private yuvToRgb24(
    cr: Float32Array,
    cb: Float32Array,
    yBlocks: Float32Array[]
  ): void {
    const bytes = new Uint8Array(256 * 3);
    let byteIdx = 0;

    for (let my = 0; my < 16; my++) {
      const blockYIdx = (my >= 8 ? 2 : 0);
      const localY = my & 7;

      for (let mx = 0; mx < 16; mx++) {
        const blockIdx = blockYIdx + (mx >= 8 ? 1 : 0);
        const localX = mx & 7;

        const yVal = yBlocks[blockIdx][localY * 8 + localX];
        const crVal = cr[(my >> 1) * 8 + (mx >> 1)];
        const cbVal = cb[(my >> 1) * 8 + (mx >> 1)];

        let r = yVal + 1.402 * crVal;
        let g = yVal - 0.344136 * cbVal - 0.714136 * crVal;
        let b = yVal + 1.772 * cbVal;

        bytes[byteIdx++] = Math.min(255, Math.max(0, Math.round(r)));
        bytes[byteIdx++] = Math.min(255, Math.max(0, Math.round(g)));
        bytes[byteIdx++] = Math.min(255, Math.max(0, Math.round(b)));
      }
    }

    for (let i = 0; i < bytes.length; i += 2) {
      const b0 = bytes[i];
      const b1 = (i + 1 < bytes.length) ? bytes[i + 1] : 0;
      if (this.outBufferLen < this.outBuffer.length) {
        this.outBuffer[this.outBufferLen++] = (b0 | (b1 << 8)) & 0xffff;
      }
    }
  }

  /**
   * DMA Channel 0 Transfer (RAM to MDEC)
   */
  public dmaTransferMode0201(madr: number, bcr: number, memory: Memory): void {
    const blockSize = bcr & 0xffff;
    const numBlocks = (bcr >>> 16) & 0xffff;
    const totalWords = (blockSize === 0 ? 0x10000 : blockSize) * (numBlocks === 0 ? 1 : numBlocks);

    let addr = madr & 0x001ffffc;
    const inputWords: number[] = [];

    for (let i = 0; i < totalWords && addr <= memory.ram.length - 4; i++) {
      const word = memory.safeReadRam32(addr);
      inputWords.push(word);
      addr = (addr + 4) & 0x001ffffc;
    }

    this.feedInputWords(inputWords);
  }

  /**
   * DMA Channel 1 Transfer (MDEC to RAM)
   */
  public dmaTransferMode0200(madr: number, bcr: number, memory: Memory): void {
    const blockSize = bcr & 0xffff;
    const numBlocks = (bcr >>> 16) & 0xffff;
    const totalWords = (blockSize === 0 ? 0x10000 : blockSize) * (numBlocks === 0 ? 1 : numBlocks);

    let addr = madr & 0x001ffffc;

    for (let i = 0; i < totalWords && addr <= memory.ram.length - 4; i++) {
      const word32 = this.readData();
      memory.safeWriteRam32(addr, word32);
      addr = (addr + 4) & 0x001ffffc;
    }
  }
}
