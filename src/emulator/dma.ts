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
import type { Gpu } from './gpu';

export interface DmaChannelState {
  madr: number; // Base address
  bcr: number;  // Block control
  chcr: number; // Channel control
}

export class DmaController {
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

  public onDmaTransfer?: (channel: number, message: string) => void;

  constructor() {
    this.reset();
  }

  public reset(): void {
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
  }

  // =========================================================================
  // DMA CHANNEL 2 (GPU) HANDLERS
  // =========================================================================

  /**
   * Log and set DMA Channel 2 Base Address (MADR2 / 0x1F8010A0)
   */
  public writeMadr2(val: number): void {
    this.dma2Madr = val & 0x00ffffff;
    // Throttled / silenced high-frequency per-packet log
    // const physAddr = (this.dma2Madr & 0x001ffffc) >>> 0;
    // console.log(`[DMA2 MADR Write] 0x1F8010A0 = 0x${(val >>> 0).toString(16).padStart(8, '0').toUpperCase()} (Target RAM: 0x${physAddr.toString(16).padStart(8, '0').toUpperCase()})`);
  }

  /**
   * Log and set DMA Channel 2 Block Control (BCR2 / 0x1F8010A4)
   */
  public writeBcr2(val: number): void {
    this.dma2Bcr = val >>> 0;
    // Throttled / silenced high-frequency per-packet log
    // const blockSize = this.dma2Bcr & 0xffff;
    // const numBlocks = (this.dma2Bcr >>> 16) & 0xffff;
    // const effectiveWords = blockSize * (numBlocks || 1);
    // console.log(`[DMA2 BCR Write] 0x1F8010A4 = 0x${this.dma2Bcr.toString(16).padStart(8, '0').toUpperCase()} (BlockSize: ${blockSize} words, NumBlocks: ${numBlocks || 1}, Total: ${effectiveWords} words)`);
  }

  /**
   * Log and set DMA Channel 2 Channel Control (CHCR2 / 0x1F8010A8)
   * Triggers DMA 2 transfer if active (bit 24, bit 28, or sync mode)
   */
  public writeChcr2(val: number, memory: Memory, gpu?: Gpu): void {
    this.dma2Chcr = val >>> 0;
    const isTrigger = (this.dma2Chcr & 0x01000000) !== 0; // bit 24
    const isBusy = (this.dma2Chcr & 0x10000000) !== 0;    // bit 28
    const syncMode = (this.dma2Chcr >>> 9) & 3;          // bits 9-10 (0=Manual, 1=Block/Slice, 2=Linked List)
    // const toGpu = (this.dma2Chcr & 1) !== 0;          // bit 0: 1 = RAM to GPU, 0 = GPU to RAM

    // Throttled / silenced high-frequency per-packet log
    // console.log(`[DMA2 CHCR Write] 0x1F8010A8 = 0x${this.dma2Chcr.toString(16).padStart(8, '0').toUpperCase()} (Trigger: ${isTrigger}, Busy: ${isBusy}, SyncMode: ${syncMode}, Dir: ${toGpu ? 'RAM->GPU' : 'GPU->RAM'})`);

    if (isTrigger || isBusy || syncMode === 1 || syncMode === 2) {
      this.executeDma2(memory, gpu);
    }
  }

  /**
   * Executes GPU DMA Channel 2 transfer (Linked-List OT mode & Block/Slice mode)
   */
  public executeDma2(memory: Memory, gpu?: Gpu): boolean {
    const toGpu = (this.dma2Chcr & 1) !== 0; // bit 0: 1 = RAM to GPU, 0 = GPU to RAM
    const step = (this.dma2Chcr & 2) !== 0 ? -1 : 1; // bit 1: step direction
    const syncMode = (this.dma2Chcr >>> 9) & 3;
    const targetGpu = gpu || memory.gpu;

    if (syncMode === 2 && toGpu) {
      // Linked List Mode (SyncMode 2) - Traverses Ordering Table (OT) packets
      const ramMask = 0x001ffffc;
      let currentAddr = (this.dma2Madr & 0x00ffffff) & ramMask;
      let nodeCount = 0;
      let totalWordsSent = 0;

      while (true) {
        nodeCount++;
        const header = memory.safeReadRam32(currentAddr);
        const count = (header >>> 24) & 0xff;
        const nextAddr = header & 0x00ffffff;

        totalWordsSent += count;
        for (let i = 0; i < count; i++) {
          const packetWord = memory.safeReadRam32((currentAddr + 4 + (i * 4)) & ramMask);
          if (targetGpu) {
            targetGpu.sendGp0(packetWord);
          } else if (memory.gpuWriteHandler) {
            memory.gpuWriteHandler(packetWord);
          }
        }

        if (targetGpu) {
          targetGpu.endDmaPacket();
        }

        // Hardware termination conditions for linked list:
        // 0x00FFFFFF (end marker), MSB set, or null address
        if (nextAddr === 0x00ffffff || (nextAddr & 0x800000) !== 0 || nextAddr === 0) {
          this.dma2Madr = nextAddr;
          break;
        }

        currentAddr = nextAddr & ramMask;
        this.dma2Madr = currentAddr;

        if (nodeCount > 10000) {
          console.warn('[DMA2] Linked list runaway prevented after 10,000 nodes');
          break;
        }
      }

      this.dma2TransferCount++;
      this.totalGpuWordsTransferred += totalWordsSent;
      // Throttled / silenced per-packet log
      // console.log(`[DMA2 OT COMPLETE #${this.dma2TransferCount}] Linked-List OT processed: ${nodeCount} nodes, ${totalWordsSent} words sent to GP0.`);
    } else {
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
      // Throttled / silenced per-packet log
      // console.log(`[DMA2 BLOCK COMPLETE #${this.dma2TransferCount}] Transferred ${totalWords} words [0x${startAddr.toString(16).padStart(8, '0').toUpperCase()}..0x${addr.toString(16).padStart(8, '0').toUpperCase()}]. Dir: ${toGpu ? 'RAM->GPU' : 'GPU->RAM'}`);
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
    const syncMode = (this.dma3Chcr >>> 9) & 3;          // bits 9-10
    // const toRam = (this.dma3Chcr & 1) === 0;          // bit 0: 0 = To RAM, 1 = From RAM

    // Throttled / silenced register write log
    // console.log(`[DMA3 CHCR Write] 0x1F8010B8 = 0x${this.dma3Chcr.toString(16).padStart(8, '0').toUpperCase()} (Trigger: ${isTrigger}, Busy: ${isBusy}, SyncMode: ${syncMode}, Dir: ${toRam ? 'CD-ROM->RAM' : 'RAM->CD-ROM'})`);

    if (isTrigger || isBusy || syncMode === 0 || syncMode === 1) {
      this.executeDma3(memory, cdrom);
    }
  }

  /**
   * Executes CD-ROM DMA Channel 3 transfer
   */
  public executeDma3(memory: Memory, cdrom?: CdRom): boolean {
    if (!cdrom) return false;

    const toRam = (this.dma3Chcr & 1) === 0; // bit 0: 0 = CD-ROM to RAM
    if (!toRam) {
      console.warn(`[DMA3] Unsupported direction: RAM to CD-ROM (CHCR: 0x${this.dma3Chcr.toString(16)})`);
      return false;
    }

    const sync = (this.dma3Chcr >>> 9) & 3;
    const blockSize = (this.dma3Bcr & 0xffff);
    const numBlocks = (this.dma3Bcr >>> 16) & 0xffff;
    let totalWords = 0;

    if (sync === 1) {
      const bs = blockSize === 0 ? 0x10000 : blockSize;
      const nb = numBlocks === 0 ? 1 : numBlocks;
      totalWords = bs * nb;
    } else {
      totalWords = blockSize === 0 ? 512 : blockSize;
    }

    if (totalWords <= 0) {
      totalWords = 512; // Standard 2048-byte CD-ROM sector (512 words)
    }

    // Ensure data FIFO is populated from sector buffer if empty
    if (cdrom.dataFifoIndex >= cdrom.dataFifo.length && cdrom.sectorBufferLength > 0) {
      cdrom.dataFifo = Array.from(cdrom.sectorBuffer.subarray(0, cdrom.sectorBufferLength));
      cdrom.dataFifoIndex = 0;
    }

    if (cdrom.dataFifoIndex >= cdrom.dataFifo.length) {
      // No sector buffered yet, defer execution and keep DMA pending
      return false;
    }

    let madr = (this.dma3Madr & 0x001ffffc) >>> 0;
    const startMadr = madr;

    for (let i = 0; i < totalWords && madr <= memory.ram.length - 4; i++) {
      const word = cdrom.readDataWord();
      memory.safeWriteRam32(madr, word);
      madr = (madr + 4) & 0x001ffffc;
    }

    this.dma3Madr = madr;
    this.dma3Bcr = 0; // Clear BCR upon completion

    // Clear trigger (bit 24) and busy (bit 28) flags
    this.dma3Chcr &= ~(1 << 24);
    this.dma3Chcr &= ~(1 << 28);

    this.dma3TransferCount++;
    this.totalWordsTransferred += totalWords;

    // Trigger DMA Channel 3 interrupt (bit 27 in DICR / asserts I_STAT bit 3)
    memory.triggerDmaIrq(3);

    const logMsg = `[DMA3 COMPLETE #${this.dma3TransferCount}] Transferred ${totalWords} words (${totalWords * 4} bytes) to RAM [0x${startMadr.toString(16).padStart(8, '0').toUpperCase()}..0x${madr.toString(16).padStart(8, '0').toUpperCase()}]. D3_BCR=0, D3_CHCR=0x${this.dma3Chcr.toString(16).padStart(8, '0').toUpperCase()}, Asserted DMA IRQ Ch3.`;
    console.log(logMsg);
    if (this.onDmaTransfer) {
      this.onDmaTransfer(3, logMsg);
    }

    return true;
  }
}
