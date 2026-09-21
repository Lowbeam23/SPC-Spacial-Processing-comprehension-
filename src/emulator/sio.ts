/**
 * PlayStation 1 Serial Input Output 0 (SIO0 / Joypad & Memory Card Interface)
 * Addresses: 0x1F801040 - 0x1F80104E
 */

export class SioController {
  // RX FIFO buffer
  public rxFifo: number[] = [];
  // Acknowledge line (/ACK, active low in hardware, true = acknowledged)
  public ack: boolean = false;
  // Control register (0x1F80104A)
  public ctrl: number = 0;
  // Mode register (0x1F801048)
  public mode: number = 0;
  // Baudrate register (0x1F80104E)
  public baud: number = 0;
  // Controller connection status (default disconnected)
  public isControllerConnected: boolean = false;

  public reset(): void {
    this.rxFifo = [];
    this.ack = false;
    this.ctrl = 0;
    this.mode = 0;
    this.baud = 0;
  }

  /**
   * 0x1F801044 - JOY_STAT (R)
   * Bit 0: TX Ready 1 (1 = ready to send)
   * Bit 1: RX FIFO Not Empty (1 = received byte available)
   * Bit 2: TX Ready 2 (1 = ready to send / finished)
   * Bit 3: RX Parity error (0)
   * Bit 7: /ACK line level (0 = inactive / no ack, 1 = active / acked)
   * Bit 9: Interrupt Request (0 = none, 1 = IRQ7 active)
   * Bits 11-31: Baudrate timer
   */
  public readStat(iStat: number): number {
    let stat = 0x00000005; // Bits 0 and 2 set (TX Ready 1 and 2 always ready)
    if (this.rxFifo.length > 0) {
      stat |= 0x00000002; // Bit 1: RX FIFO Not Empty
    }
    if (this.ack) {
      stat |= 0x00000080; // Bit 7: /ACK line active
    }
    if ((iStat & (1 << 7)) !== 0) {
      stat |= 0x00000200; // Bit 9: IRQ7 active
    }
    return stat >>> 0;
  }

  /**
   * 0x1F801040 - JOY_DATA (R)
   * If no controller is plugged in, return standard disconnected response (0xFF)
   * rather than hanging the communication bus.
   */
  public readData(): number {
    if (this.rxFifo.length > 0) {
      return this.rxFifo.shift()! & 0xff;
    }
    return 0xff;
  }

  /**
   * 0x1F801040 - JOY_DATA (W)
   * When data is transmitted while no peripheral is attached:
   * The RX line floats high (0xFF) and no acknowledge (/ACK) is received.
   * This queues 0xFF into the RX buffer so games polling JOY_STAT bit 1 receive 0xFF.
   */
  public writeData(_val: number): void {
    if (!this.isControllerConnected) {
      this.rxFifo.push(0xff);
      this.ack = false;
    } else {
      this.rxFifo.push(0xff);
      this.ack = false;
    }
  }

  /**
   * 0x1F80104A - JOY_CTRL (W)
   */
  public writeCtrl(val: number, onAckReset?: () => void): void {
    this.ctrl = val & 0xffff;
    // Bit 4: Reset IRQ / Acknowledge
    if (val & 0x10) {
      if (onAckReset) {
        onAckReset();
      }
    }
    // Bit 6: Reset SIO controller
    if (val & 0x40) {
      this.reset();
    }
  }
}
