/**
 * PlayStation 1 Direct Memory Access (DMA) Controller
 * Handles DMA Channels 0-6:
 * Channel 0: MDEC In (RAM to MDEC)
 * Channel 1: MDEC Out (MDEC to RAM)
 * Channel 2: GPU (RAM to/from GPU)
 * Channel 3: CD-ROM (CD-ROM to RAM)
 * Channel 4: SPU (RAM to/from SPU)
 * Channel 5: PIO (RAM to/from PIO)
 * Channel 6: OTC (Ordering Table Clear)
 */

import type { Memory } from './memory';
import type { CdRom } from './cdrom';
import { Gpu, getGp0PacketLength } from './gpu';
import type { Spu } from './spu';

export interface DmaChannelState {
  madr: number; // Base address
  bcr: number;  // Block control
  chcr: number; // Channel control
}

export class DmaController {
  // DPCR (0x1F8010F0) - Default: 0x07654321
  public dpcr: number = 0x07654321;

  // DMA Channel 0 (MDEC In - RAM to MDEC)
  public dma0Madr: number = 0;
  public dma0Bcr: number = 0;
  public dma0Chcr: number = 0;

  // DMA Channel 1 (MDEC Out - MDEC to RAM)
  public dma1Madr: number = 0;
  public dma1Bcr: number = 0;
  public dma1Chcr: number = 0;

  // DMA Channel 2 (GPU)
  public dma2Madr: number = 0;
  public dma2Bcr: number = 0;
  public dma2Chcr: number = 0;
  public dma2TransferCount: number = 0;
  public totalGpuWordsTransferred: number = 0;

  // DMA Channel 3 (CD-ROM)
  public dma3Madr: number = 0;
  public dma3Bcr: number = 0;
  public dma3Chcr: number = 0;
  public dma3TransferCount: number = 0;
  public totalWordsTransferred: number = 0;

  // DMA Channel 4 (SPU)
  public dma4Madr: number = 0;
  public dma4Bcr: number = 0;
  public dma4Chcr: number = 0;
  public dma4TransferCount: number = 0;
  public totalSpuWordsTransferred: number = 0;

  public onDmaTransfer?: (channel: number, message: string) => void;
  public memory?: Memory;
  public gpu?: Gpu;

  public triggerDmaIrq(channel: number): void {
    if (this.memory && typeof this.memory.triggerDmaIrq === 'function') {
      this.memory.triggerDmaIrq(channel);
    }
  }

  constructor() {
    this.reset();
  }

  public reset(): void {
    this.dpcr = 0x07654321;
    this.dma0Madr = 0;
    this.dma0Bcr = 0;
    this.dma0Chcr = 0;

    this.dma1Madr = 0;
    this.dma1Bcr = 0;
    this.dma1Chcr = 0;

    this.dma2Madr = 0;
    this.dma2Bcr = 0;
    this.dma2Chcr = 0;
    this.dma2TransferCount = 0;
    this.totalGpuWordsTransferred = 0;

    this.dma3Madr = 0;
    this.dma3Bcr = 0;
    this.dma3Chcr = 0;
    this.dma3TransferCount = 0;
    this.totalWordsTransferred = 0;

    this.dma4Madr = 0;
    this.dma4Bcr = 0;
    this.dma4Chcr = 0;
    this.dma4TransferCount = 0;
    this.totalSpuWordsTransferred = 0;
  }

  // =========================================================================
  // DMA CHANNEL 0 (MDEC IN) & CHANNEL 1 (MDEC OUT) HANDLERS
  // =========================================================================

  public writeMadr0(val: number): void {
    this.dma0Madr = val & 0x00ffffff;
  }

  public writeBcr0(val: number): void {
    this.dma0Bcr = val >>> 0;
  }

  public writeChcr0(val: number, memory: Memory): void {
    this.dma0Chcr = val >>> 0;
    if ((this.dpcr & 0x00000008) === 0) return; // Channel 0 enable in DPCR
    const isTrigger = (this.dma0Chcr & 0x01000000) !== 0;
    const isBusy = (this.dma0Chcr & 0x10000000) !== 0;
    if (isTrigger || isBusy || (this.dma0Chcr & 0x01000201) === 0x01000201) {
      if (memory.mdec) {
        memory.mdec.dmaTransferMode0201(this.dma0Madr, this.dma0Bcr, memory);
      }
      this.dma0Chcr &= ~(1 << 24);
      this.dma0Chcr &= ~(1 << 28);
      memory.triggerDmaIrq(0);
    }
  }

  public writeMadr1(val: number): void {
    this.dma1Madr = val & 0x00ffffff;
  }

  public writeBcr1(val: number): void {
    this.dma1Bcr = val >>> 0;
  }

  public writeChcr1(val: number, memory: Memory): void {
    this.dma1Chcr = val >>> 0;
    if ((this.dpcr & 0x00000080) === 0) return; // Channel 1 enable in DPCR
    const isTrigger = (this.dma1Chcr & 0x01000000) !== 0;
    const isBusy = (this.dma1Chcr & 0x10000000) !== 0;
    if (isTrigger || isBusy || (this.dma1Chcr & 0x01000200) === 0x01000200) {
      if (memory.mdec) {
        memory.mdec.dmaTransferMode0200(this.dma1Madr, this.dma1Bcr, memory);
      }
      this.dma1Chcr &= ~(1 << 24);
      this.dma1Chcr &= ~(1 << 28);
      memory.triggerDmaIrq(1);
    }
  }

  // =========================================================================
  // DMA CHANNEL 2 (GPU) HANDLERS
  // =========================================================================

  /**
   * Log and set DMA Channel 2 Base Address (MADR2 / 0x1F8010A0)
   */
  public writeMadr2(val: number): void {
    this.dma2Madr = val & 0x00ffffff;
  }

  /**
   * Log and set DMA Channel 2 Block Control (BCR2 / 0x1F8010A4)
   */
  public writeBcr2(val: number): void {
    this.dma2Bcr = val >>> 0;
  }

  /**
   * Log and set DMA Channel 2 Channel Control (CHCR2 / 0x1F8010A8)
   * Triggers DMA 2 transfer if active (bit 24, bit 28, or sync mode)
   */
  public writeChcr2(val: number, memory?: any, gpu?: any): void {
    if (memory) this.memory = memory;
    if (gpu) this.gpu = gpu;
    this.dma2Chcr = val >>> 0;

    // Check if Channel 2 is enabled in DPCR (bit 11)
    if ((this.dpcr & 0x00000800) === 0) {
      this.dma2Chcr &= 0xFEFFFFFF;
      return;
    }

    const trigger = (val >>> 24) & 1;
    const isBusy = (val >>> 28) & 1;
    const syncMode = (val >>> 9) & 3;
    const direction = val & 1; // 0 = GPU->RAM, 1 = RAM->GPU

    if (syncMode === 2 && direction === 1) {
      // Linked List (OT) mode
      this.dmaTransferMode0401(this.dma2Madr, this.memory || memory, this.gpu || gpu);
    } else if (syncMode === 1) {
      if (direction === 0) {
        // GPU to RAM (VRAM Readback)
        this.dmaTransferMode0200(this.dma2Madr, this.dma2Bcr, this.memory || memory, this.gpu || gpu);
      } else if (direction === 1) {
        // RAM to GPU (Slice upload)
        this.dmaTransferMode0201(this.dma2Madr, this.dma2Bcr, this.memory || memory, this.gpu || gpu);
      }
    } else if (syncMode === 0 && (trigger || isBusy)) {
      this.executeDma2(this.memory || memory, this.gpu || gpu);
    }
  }

  /**
   * Hardware linked-list dispatch for CHCR2 Mode 0401 / Linked List
   */
  public dmaTransferMode0401(madr: number, memory: Memory, gpu?: Gpu): number {
    const targetGpu = gpu || memory.gpu;
    let addr = madr & 0x001ffffc;
    let totalWords = 0;
    const seen = new Set<number>();

    while (true) {
      if (addr === 0 || seen.has(addr)) break;
      seen.add(addr);

      const header = memory.safeReadRam32(addr);
      const nitem = (header >>> 24) & 0xff;
      const nextPointer = header & 0x00ffffff;

      addr = (addr + 4) & 0x001ffffc;
      totalWords++;

      for (let i = 0; i < nitem; i++) {
        const cmd = memory.safeReadRam32(addr);
        if (targetGpu) {
          targetGpu.sendGp0(cmd);
        } else if (memory.gpuWriteHandler) {
          memory.gpuWriteHandler(cmd);
        }
        addr = (addr + 4) & 0x001ffffc;
        totalWords++;
      }

      if (targetGpu) {
        targetGpu.endDmaPacket();
      }

      // Hardware terminator condition: bit 23 set, 0x00FFFFFF, or 0
      if ((nextPointer & 0x800000) !== 0 || nextPointer === 0x00ffffff || nextPointer === 0) {
        break;
      }

      addr = nextPointer & 0x001ffffc;
    }

    this.dma2Madr = 0x00ffffff;
    this.dma2Chcr &= ~(1 << 24); // Clear trigger (bit 24)
    this.dma2Chcr &= ~(1 << 28); // Clear busy (bit 28)

    this.dma2TransferCount++;
    this.totalGpuWordsTransferred += totalWords;

    if (targetGpu) {
      targetGpu.gpuStat |= (1 << 28);
    }

    // Trigger DMA IRQ
    memory.triggerDmaIrq(2);

    return totalWords;
  }

  /**
   * VRAM-to-RAM DMA Channel 2 Transfer (Direction 0: GPU to RAM, sync mode 1 / block transfer)
   */
  public dmaTransferMode0200(madr: number, bcr: number, memory: any, gpu: any): number {
    const mem = memory || this.memory;
    const targetGpu = gpu || this.gpu || mem?.gpu;

    if (!(madr & 0x007FFFFF)) return 0x10;

    // Total 32-bit words requested = (block count * block size)
    const count = (bcr >>> 16) & 0xFFFF;
    const size = bcr & 0xFFFF;
    let blockWords = count * size;
    if (blockWords === 0) blockWords = (count === 0 ? 1 : count) * (size === 0 ? 0x10000 : size);
    let transferHalfwords = blockWords << 1;
    let destAddr = madr & 0x001FFFFC;

    // Transfer 16-bit halfwords from gpu.imgReadBuffer into RAM, packed 2 per 32-bit word
    while (transferHalfwords > 0) {
      const p0 = (targetGpu && targetGpu.imgReadIndex < targetGpu.imgReadTotal) ? targetGpu.imgReadBuffer[targetGpu.imgReadIndex++] : 0;
      const p1 = (targetGpu && targetGpu.imgReadIndex < targetGpu.imgReadTotal) ? targetGpu.imgReadBuffer[targetGpu.imgReadIndex++] : 0;

      // Pack: p0 = low 16 bits (Word N), p1 = high 16 bits (Word N+1)
      const packedWord = ((p1 << 16) | (p0 & 0xFFFF)) >>> 0;
      if (mem) {
        if (typeof mem.writeRam32 === 'function') {
          mem.writeRam32(destAddr, packedWord);
        } else if (typeof mem.safeWriteRam32 === 'function') {
          mem.safeWriteRam32(destAddr, packedWord);
        }
      }

      destAddr = (destAddr + 4) & 0x001FFFFC;
      transferHalfwords -= 2;
    }

    // Update hardware registers and post-conditions
    this.dma2Madr = destAddr;
    this.dma2Bcr = 0;
    this.dma2Chcr &= 0xFEFFFFFF; // Clear trigger bit 24
    this.dma2Chcr &= 0xEFFFFFFF; // Clear busy bit 28

    // Clear GPUSTAT Bit 27 if read is complete
    if (targetGpu && targetGpu.imgReadIndex >= targetGpu.imgReadTotal) {
      targetGpu.gpuStat &= ~(1 << 27);
    }

    // Fire PS1 DMA Channel 2 IRQ
    this.triggerDmaIrq(2);

    return blockWords;
  }

  public dma2TransferMode0200(madr: number, bcr: number, memory: any, gpu: any): number {
    return this.dmaTransferMode0200(madr, bcr, memory, gpu);
  }

  /**
   * RAM-to-GPU DMA Channel 2 Transfer (Direction 1: RAM to GPU, sync mode 1 / block transfer)
   */
  public dmaTransferMode0201(madr: number, bcr: number, memory: any, gpu: any): number {
    const mem = memory || this.memory;
    const targetGpu = gpu || this.gpu || mem?.gpu;
    const blockSize = bcr & 0xffff;
    const numBlocks = (bcr >>> 16) & 0xffff;
    const bs = blockSize === 0 ? 0x10000 : blockSize;
    const nb = numBlocks === 0 ? 1 : numBlocks;
    const totalWords = bs * nb;
    let addr = (madr & 0x001ffffc) >>> 0;
    const step = (this.dma2Chcr & 2) !== 0 ? -1 : 1;

    for (let i = 0; i < totalWords && addr <= (mem?.ram?.length || 0x200000) - 4 && addr >= 0; i++) {
      const word = mem ? mem.safeReadRam32(addr) : 0;
      if (targetGpu) {
        targetGpu.sendGp0(word);
      } else if (mem && mem.gpuWriteHandler) {
        mem.gpuWriteHandler(word);
      }
      addr = (addr + (step * 4)) & 0x001ffffc;
    }

    this.dma2Madr = addr;
    this.dma2Bcr = 0;
    this.dma2Chcr &= 0xFEFFFFFF; // Clear trigger bit 24
    this.dma2Chcr &= 0xEFFFFFFF; // Clear busy bit 28
    this.dma2TransferCount++;
    this.totalGpuWordsTransferred += totalWords;

    if (targetGpu) {
      targetGpu.gpuStat |= (1 << 28);
    }
    this.triggerDmaIrq(2);

    return totalWords;
  }

  /**
   * Executes GPU DMA Channel 2 transfer (Linked-List OT mode & Block/Slice mode)
   */
  public executeDma2(memory: Memory, gpu?: Gpu): boolean {
    if ((this.dpcr & 0x00000800) === 0) {
      return false;
    }

    const toGpu = (this.dma2Chcr & 1) !== 0; // bit 0: 1 = RAM to GPU, 0 = GPU to RAM
    const step = (this.dma2Chcr & 2) !== 0 ? -1 : 1; // bit 1: step direction
    const syncMode = (this.dma2Chcr >>> 9) & 3;
    const targetGpu = gpu || memory.gpu;

    if (!toGpu) {
      this.dma2TransferMode0200(this.dma2Madr, this.dma2Bcr, memory, gpu);
      return true;
    }

    if ((syncMode === 2 && toGpu) || (this.dma2Chcr & 0x01000401) === 0x01000401) {
      this.dmaTransferMode0401(this.dma2Madr, memory, gpu);
      return true;
    }

    // Block/Slice Mode (SyncMode 1) or Manual Mode (SyncMode 0)
    const blockSize = this.dma2Bcr & 0xffff;
      const numBlocks = (this.dma2Bcr >>> 16) & 0xffff;
      let totalWords = 0;

      if (syncMode === 1) {
        const bs = blockSize === 0 ? 0x10000 : blockSize;
        const nb = numBlocks === 0 ? 1 : numBlocks;
        totalWords = bs * nb;
      } else {
        totalWords = blockSize === 0 ? 0x10000 : blockSize;
      }

      let addr = (this.dma2Madr & 0x001ffffc) >>> 0;
      const startAddr = addr;

      if (toGpu) {
        for (let i = 0; i < totalWords && addr <= memory.ram.length - 4 && addr >= 0; i++) {
          const word = memory.safeReadRam32(addr);
          if (targetGpu) {
            targetGpu.sendGp0(word);
          } else if (memory.gpuWriteHandler) {
            memory.gpuWriteHandler(word);
          }
          addr = (addr + (step * 4)) & 0x001ffffc;
        }
        this.dma2Madr = addr;
      } else {
        // GPU to RAM (VRAM image read transfer)
        for (let i = 0; i < totalWords && addr <= memory.ram.length - 4 && addr >= 0; i++) {
          const word = memory.gpuReadHandler ? memory.gpuReadHandler() : (targetGpu ? targetGpu.readGpu() : 0);
          memory.safeWriteRam32(addr, word);
          addr = (addr + (step * 4)) & 0x001ffffc;
        }
        this.dma2Madr = addr;
      }

      this.dma2Bcr = 0; // Clear BCR upon completion
      this.dma2TransferCount++;
      this.totalGpuWordsTransferred += totalWords;

      const msg = `[DMA2 SLICE BLIT #${this.dma2TransferCount}] Mode ${syncMode}, Transferred ${totalWords} words [0x${startAddr.toString(16).padStart(8, '0').toUpperCase()}..0x${addr.toString(16).padStart(8, '0').toUpperCase()}]. Dir: ${toGpu ? 'RAM->GPU' : 'GPU->RAM'}`;
      console.log(msg);
      if (memory.onLog) {
        memory.onLog('gpu', msg);
      }

    // Finish DMA: Clear trigger (bit 24) and busy (bit 28)
    this.dma2Chcr &= ~(1 << 24);
    this.dma2Chcr &= ~(1 << 28);

    // Ensure GPUSTAT bit 28 is ready (1)
    if (targetGpu) {
      targetGpu.gpuStat |= (1 << 28);
    }

    // Trigger DMA Channel 2 interrupt (bit 26 in DICR / asserts I_STAT bit 3)
    memory.triggerDmaIrq(2);

    return true;
  }

  // =========================================================================
  // DMA CHANNEL 3 (CD-ROM) HANDLERS
  // =========================================================================

  /**
   * Log and set DMA Channel 3 Base Address (MADR3 / 0x1F8010B0)
   */
  public writeMadr3(val: number): void {
    this.dma3Madr = val & 0x00ffffff;
    // Throttled / silenced register write log
    // const physAddr = (this.dma3Madr & 0x001ffffc) >>> 0;
    // console.log(`[DMA3 MADR Write] 0x1F8010B0 = 0x${(val >>> 0).toString(16).padStart(8, '0').toUpperCase()} (Target RAM: 0x${physAddr.toString(16).padStart(8, '0').toUpperCase()})`);
  }

  /**
   * Log and set DMA Channel 3 Block Control (BCR3 / 0x1F8010B4)
   */
  public writeBcr3(val: number): void {
    this.dma3Bcr = val >>> 0;
    // Throttled / silenced register write log
    // const blockSize = this.dma3Bcr & 0xffff;
    // const numBlocks = (this.dma3Bcr >>> 16) & 0xffff;
    // const effectiveWords = blockSize * (numBlocks || 1);
    // console.log(`[DMA3 BCR Write] 0x1F8010B4 = 0x${this.dma3Bcr.toString(16).padStart(8, '0').toUpperCase()} (BlockSize: ${blockSize} words, NumBlocks: ${numBlocks || 1}, Total: ${effectiveWords} words / ${effectiveWords * 4} bytes)`);
  }

  /**
   * Log and set DMA Channel 3 Channel Control (CHCR3 / 0x1F8010B8)
   * Triggers DMA 3 transfer if active (bit 24 or bit 28)
   */
  public writeChcr3(val: number, memory: Memory, cdrom?: CdRom): void {
    this.dma3Chcr = val >>> 0;
    const isTrigger = (this.dma3Chcr & 0x01000000) !== 0; // bit 24
    const isBusy = (this.dma3Chcr & 0x10000000) !== 0;    // bit 28

    if (isTrigger || isBusy) {
      this.executeDma3(memory, cdrom);
    }
  }

  /**
   * Executes CD-ROM DMA Channel 3 transfer
   */
  public executeDma3(memory: Memory, cdrom?: CdRom): boolean {
    if (!cdrom) return false;

    // CD-ROM DMA Channel 3 in PS1 hardware is dedicated to transferring sector data from CD-ROM to RAM
    const isTrigger = (this.dma3Chcr & 0x01000000) !== 0;
    const isBusy = (this.dma3Chcr & 0x10000000) !== 0;
    if (!isTrigger && !isBusy) {
      return false;
    }

    const sync = (this.dma3Chcr >>> 9) & 3;
    const blockSize = (this.dma3Bcr & 0xffff);
    const numBlocks = (this.dma3Bcr >>> 16) & 0xffff;
    let totalWords = 0;

    if (sync === 1) {
      // In Request/Slice mode:
      // If D3_BCR is 0x00010200, blockSize=0x200 (512 words), numBlocks=1 -> 512 words (2048 bytes)
      // If D3_BCR is 0x0200, blockSize=0x200 (512 words), numBlocks=0 -> 1 block of 512 words
      const bs = blockSize === 0 ? 512 : blockSize;
      const nb = numBlocks === 0 ? 1 : numBlocks;
      totalWords = bs * nb;
    } else {
      totalWords = blockSize === 0 ? 512 : blockSize;
    }

    if (totalWords <= 0) {
      totalWords = 512; // Standard 2048-byte CD-ROM sector (512 words)
    }

    // Step direction: bit 1 (0 = increment by 4, 1 = decrement by 4)
    const step = (this.dma3Chcr & (1 << 1)) !== 0 ? -4 : 4;
    let madr = (this.dma3Madr & 0x001ffffc) >>> 0;
    const startMadr = madr;

    for (let i = 0; i < totalWords && madr <= memory.ram.length - 4; i++) {
      const word = cdrom.readDataWord();
      memory.safeWriteRam32(madr, word);
      madr = (madr + step) & 0x001ffffc;
    }

    this.dma3Madr = madr;
    this.dma3Bcr = 0; // Clear BCR upon completion

    // Keep JIT cache coherent across full transferred block
    if (memory.recompiler) {
      memory.recompiler.invalidateAddress(startMadr, totalWords * 4);
    }

    // Clear trigger (bit 24) and busy (bit 28) flags immediately upon completion
    this.dma3Chcr &= ~(1 << 24);
    this.dma3Chcr &= ~(1 << 28);

    this.dma3TransferCount++;
    this.totalWordsTransferred += totalWords;

    // Trigger DMA Channel 3 interrupt (bit 27 in DICR / asserts I_STAT bit 3)
    memory.triggerDmaIrq(3);

    const firstWord = memory.safeReadRam32(startMadr);
    const logMsg = `[DMA3 COMPLETE #${this.dma3TransferCount}] Transferred ${totalWords} words (${totalWords * 4} bytes) to RAM [0x${startMadr.toString(16).padStart(8, '0').toUpperCase()}..0x${madr.toString(16).padStart(8, '0').toUpperCase()}], Word0: 0x${firstWord.toString(16).padStart(8, '0').toUpperCase()}. D3_BCR=0, D3_CHCR=0x${this.dma3Chcr.toString(16).padStart(8, '0').toUpperCase()}, Asserted DMA IRQ Ch3.`;
    console.log(logMsg);
    if (this.onDmaTransfer) {
      this.onDmaTransfer(3, logMsg);
    }

    return true;
  }

  // =========================================================================
  // DMA CHANNEL 4 (SPU) HANDLERS
  // =========================================================================

  public writeMadr4(val: number): void {
    this.dma4Madr = val & 0x00ffffff;
  }

  public writeBcr4(val: number): void {
    this.dma4Bcr = val >>> 0;
  }

  public writeChcr4(val: number, memory: Memory, spu?: Spu): void {
    this.dma4Chcr = val >>> 0;
    const isTrigger = (this.dma4Chcr & 0x01000000) !== 0; // bit 24
    const isBusy = (this.dma4Chcr & 0x10000000) !== 0;    // bit 28
    const syncMode = (this.dma4Chcr >>> 9) & 3;          // bits 9-10

    if (isTrigger || isBusy || syncMode === 0 || syncMode === 1) {
      this.executeDma4(memory, spu);
    }
  }

  public executeDma4(memory: Memory, spu?: Spu): boolean {
    if (!spu) return false;

    const toSpu = (this.dma4Chcr & 1) !== 0; // bit 0: 1 = RAM to SPU, 0 = SPU to RAM
    const stepDec = (this.dma4Chcr & 2) !== 0; // bit 1: 0 = +4, 1 = -4
    const sync = (this.dma4Chcr >>> 9) & 3;

    const blockSize = this.dma4Bcr & 0xffff;
    const numBlocks = (this.dma4Bcr >>> 16) & 0xffff;
    let totalWords = 0;

    if (sync === 1) {
      const bs = blockSize === 0 ? 0x10000 : blockSize;
      const nb = numBlocks === 0 ? 1 : numBlocks;
      totalWords = bs * nb;
    } else {
      totalWords = blockSize === 0 ? 0x10000 : blockSize;
    }

    if (totalWords <= 0) {
      totalWords = 1;
    }

    let madr = (this.dma4Madr & 0x001ffffc) >>> 0;
    const step = stepDec ? -4 : 4;

    for (let i = 0; i < totalWords && madr <= memory.ram.length - 4; i++) {
      if (toSpu) {
        const word = memory.safeReadRam32(madr);
        spu.dmaWrite(word);
      } else {
        const word = spu.dmaRead();
        memory.safeWriteRam32(madr, word);
      }
      madr = (madr + step) & 0x001ffffc;
    }

    this.dma4Madr = madr;
    this.dma4Bcr = 0;
    this.dma4Chcr &= ~(1 << 24);
    this.dma4Chcr &= ~(1 << 28);

    this.dma4TransferCount++;
    this.totalSpuWordsTransferred += totalWords;

    // Assert DMA Channel 4 IRQ (channel 4 bit in DICR)
    memory.triggerDmaIrq(4);

    const logMsg = `[DMA4 COMPLETE #${this.dma4TransferCount}] Transferred ${totalWords} words between RAM [0x${this.dma4Madr.toString(16).padStart(8, '0').toUpperCase()}] and SPU (${toSpu ? 'RAM->SPU' : 'SPU->RAM'}). Asserted DMA IRQ Ch4.`;
    if (this.onDmaTransfer) {
      this.onDmaTransfer(4, logMsg);
    }

    return true;
  }
}
