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
  // Controller connection status (default connected to report healthy ready state)
  public isControllerConnected: boolean = true;

  // Digital Controller State Machine
  // 0: IDLE
  // 1: READY_FOR_CMD (got 0x01, expecting 0x42)
  // 2: SEND_Z (got 0x42, will send 0x5A)
  // 3: SEND_BTN_LOW (will send 0xFF)
  // 4: SEND_BTN_HIGH (will send 0xFF)
  public padState: number = 0;
  public buttonsLow: number = 0xff; // Digital buttons 1 (0xFF = released)
  public buttonsHigh: number = 0xff; // Digital buttons 2 (0xFF = released)

  // Callback to trigger IRQ7 on acknowledge
  public onTriggerIrq?: () => void;

  public reset(): void {
    this.rxFifo = [];
    this.ack = false;
    this.ctrl = 0;
    this.mode = 0;
    this.baud = 0;
    this.padState = 0;
    this.buttonsLow = 0xff;
    this.buttonsHigh = 0xff;
  }

  /**
   * Set digital buttons (active low: 0 = pressed, 1 = released)
   */
  public setButtonState(buttonMask: number): void {
    this.buttonsLow = buttonMask & 0xff;
    this.buttonsHigh = (buttonMask >>> 8) & 0xff;
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
   */
  public readData(): number {
    if (this.rxFifo.length > 0) {
      const byte = this.rxFifo.shift()! & 0xff;
      // In hardware reading the byte or completing transfer deasserts ACK line
      this.ack = false;
      return byte;
    }
    this.ack = false;
    return 0xff;
  }

  /**
   * 0x1F801040 - JOY_DATA (W)
   * Standard PS1 Digital Controller serial handshake:
   * 1. 0x01 (Start) -> returns 0xFF, asserts /ACK
   * 2. 0x42 (Poll)  -> returns 0x41 (Digital Pad ID), asserts /ACK
   * 3. 0x00         -> returns 0x5A ('Z'), asserts /ACK
   * 4. 0x00         -> returns Buttons Low byte, asserts /ACK
   * 5. 0x00         -> returns Buttons High byte, no ACK (end of packet)
   */
  public writeData(val: number): void {
    val &= 0xff;

    // Check if slot 2 is selected (JOY_CTRL bit 13): only slot 1 has a controller in basic config
    const isSlot2 = (this.ctrl & (1 << 13)) !== 0;
    if (!this.isControllerConnected || isSlot2) {
      this.rxFifo.push(0xff);
      this.ack = false;
      this.padState = 0;
      return;
    }

    switch (this.padState) {
      case 0: // IDLE
        if (val === 0x01) {
          this.rxFifo.push(0xff); // Hi-Z response
          this.ack = true;
          this.padState = 1;
          this.triggerAckIrq();
        } else {
          this.rxFifo.push(0xff);
          this.ack = false;
        }
        break;

      case 1: // Expecting Poll command 0x42
        if (val === 0x42) {
          this.rxFifo.push(0x41); // Standard Digital Controller ID (0x41)
          this.ack = true;
          this.padState = 2;
          this.triggerAckIrq();
        } else {
          this.rxFifo.push(0xff);
          this.ack = false;
          this.padState = 0;
        }
        break;

      case 2: // Expecting 0x00, return 0x5A ('Z')
        this.rxFifo.push(0x5a);
        this.ack = true;
        this.padState = 3;
        this.triggerAckIrq();
        break;

      case 3: // Expecting 0x00, return buttons low
        this.rxFifo.push(this.buttonsLow);
        this.ack = true;
        this.padState = 4;
        this.triggerAckIrq();
        break;

      case 4: // Expecting 0x00, return buttons high
        this.rxFifo.push(this.buttonsHigh);
        this.ack = false; // Last byte in packet: no ACK
        this.padState = 0; // Handshake complete
        break;

      default:
        this.rxFifo.push(0xff);
        this.ack = false;
        this.padState = 0;
        break;
    }
  }

  private triggerAckIrq(): void {
    // If IRQ is enabled in JOY_CTRL (bit 12: IRQ Enable on /ACK)
    // Always notify memory layer so IRQ7 can be asserted if enabled
    if (this.onTriggerIrq) {
      this.onTriggerIrq();
    }
  }

  /**
   * 0x1F80104A - JOY_CTRL (W)
   */
  public writeCtrl(val: number, onAckReset?: () => void): void {
    this.ctrl = val & 0xffff;
    // Bit 4: Reset IRQ / Acknowledge line
    if (val & 0x10) {
      this.ack = false;
      if (onAckReset) {
        onAckReset();
      }
    }
    // Bit 6: Reset SIO controller
    if (val & 0x40) {
      this.reset();
    }
    // If /JOYn output is deselected (bit 1 is 0), reset state machine
    if ((val & 0x02) === 0) {
      this.padState = 0;
    }
  }
}
