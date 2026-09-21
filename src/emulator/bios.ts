/**
 * PS1 Low-Level Emulator (LLE) BIOS Inspector & Validator
 * Handles authentic Sony PlayStation 1 BIOS dumps (SCPH-1001, SCPH-7001, SCPH-5500, etc.)
 */

import { BiosInfo } from '../types';

export class BiosManager {
  /**
   * Analyzes an uploaded 512 KB BIOS ROM dump
   */
  public static inspectBios(data: Uint8Array, fileName: string): BiosInfo {
    const size = data.length;
    let versionString = 'PS1 System BIOS ROM (512 KB)';
    let isOfficial = false;

    // Search for Sony Computer Entertainment signature or version strings
    const ascii = BiosManager.getAsciiString(data, 0, Math.min(size, 0x80000));

    if (
      ascii.includes('Sony Computer Entertainment') ||
      ascii.includes('SONY COMPUTER') ||
      ascii.includes('SCPH-1001') ||
      ascii.includes('SCPH-7001') ||
      ascii.includes('SCPH-5500') ||
      ascii.includes('SCPH-9002') ||
      ascii.includes('PlayStation')
    ) {
      isOfficial = true;
      const match =
        ascii.match(/System ROM Version [\d.]+[ \w]*/i) ||
        ascii.match(/ROM Version [\d.]+[ \w]*/i) ||
        ascii.match(/SCPH-[\d]+/i);
      versionString = match ? match[0] : 'Sony PS1 Official System BIOS';
    } else if (ascii.includes('OpenBIOS') || ascii.includes('openbios')) {
      versionString = 'OpenBIOS (Open Source PS1 ROM)';
    } else if (ascii.includes('FreePSXBoot')) {
      versionString = 'FreePSXBoot Exploit Payload';
    }

    // Generate CRC/Checksum
    let checksum = 0;
    for (let i = 0; i < Math.min(size, 4096); i += 4) {
      checksum = (checksum + ((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3])) >>> 0;
    }

    return {
      name: fileName,
      size,
      versionString,
      isOfficial,
      checksum: '0x' + checksum.toString(16).padStart(8, '0').toUpperCase(),
      loadedAt: Date.now(),
    };
  }

  private static getAsciiString(buffer: Uint8Array, start: number, length: number): string {
    let result = '';
    const end = Math.min(buffer.length, start + length);
    for (let i = start; i < end; i++) {
      const code = buffer[i];
      if (code >= 32 && code <= 126) {
        result += String.fromCharCode(code);
      } else if (code === 10 || code === 13) {
        result += ' ';
      }
    }
    return result;
  }
}
