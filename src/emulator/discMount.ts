/**
 * PS1 Disc Image, CUE Sheet & ZIP Archive Mounting Pipeline
 * Supports in-memory ZIP decompression via JSZip, CUE sheet track parsing,
 * SYSTEM.CNF discovery, and virtual disc payload extraction for CD-ROM streaming.
 */

import JSZip from 'jszip';
import { VirtualDisc, VirtualDiscTrack, ParsedExecutable } from '../types';

/**
 * Parses CUE sheet text into individual tracks and referenced binary filenames.
 */
export function parseCueSheet(cueText: string): {
  tracks: VirtualDiscTrack[];
  binaryFiles: string[];
} {
  const lines = cueText.split(/\r?\n/);
  const tracks: VirtualDiscTrack[] = [];
  const binaryFiles: string[] = [];

  let currentFile = '';
  let currentTrackNumber = 1;
  let currentType = 'MODE2/2352';
  let currentSectorSize = 2352;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('REM')) continue;

    // FILE "name.bin" BINARY
    const fileMatch = line.match(/^FILE\s+["']?([^"']+)["']?\s+(\w+)/i);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!binaryFiles.includes(currentFile)) {
        binaryFiles.push(currentFile);
      }
      continue;
    }

    // TRACK 01 MODE2/2352 or MODE1/2048 or AUDIO
    const trackMatch = line.match(/^TRACK\s+(\d+)\s+([\w\/]+)/i);
    if (trackMatch) {
      currentTrackNumber = parseInt(trackMatch[1], 10);
      currentType = trackMatch[2].toUpperCase();
      if (currentType.includes('2352') || currentType === 'AUDIO') {
        currentSectorSize = 2352;
      } else if (currentType.includes('2048')) {
        currentSectorSize = 2048;
      } else if (currentType.includes('2336')) {
        currentSectorSize = 2336;
      } else {
        currentSectorSize = 2352;
      }
      continue;
    }

    // INDEX 01 00:00:00
    const indexMatch = line.match(/^INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)/i);
    if (indexMatch && indexMatch[1] === '01') {
      const min = parseInt(indexMatch[2], 10);
      const sec = parseInt(indexMatch[3], 10);
      const frame = parseInt(indexMatch[4], 10);
      const lba = (min * 60 + sec) * 75 + frame;
      tracks.push({
        trackNumber: currentTrackNumber,
        offset: lba * currentSectorSize,
        sectorSize: currentSectorSize,
        type: currentType,
      });
    }
  }

  if (tracks.length === 0) {
    tracks.push({
      trackNumber: 1,
      offset: 0,
      sectorSize: currentSectorSize,
      type: currentType,
    });
  }

  return { tracks, binaryFiles };
}

/**
 * Inspects a byte buffer to check if it represents a ZIP archive.
 */
function isZipBuffer(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  return data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07);
}

/**
 * Reads ASCII text from byte array.
 */
function readAscii(data: Uint8Array, start: number, length: number): string {
  let str = '';
  const end = Math.min(data.length, start + length);
  for (let i = start; i < end; i++) {
    const c = data[i];
    str += (c >= 32 && c <= 126) ? String.fromCharCode(c) : ' ';
  }
  return str;
}

/**
 * Searches for SYSTEM.CNF content in disc image or filesystem sector tables.
 */
export function scanSystemCnf(data: Uint8Array, sectorSize: number = 2352): {
  systemCnf?: string;
  primaryExecutable?: string;
  volumeLabel?: string;
} {
  let systemCnf: string | undefined;
  let primaryExecutable: string | undefined;
  let volumeLabel: string | undefined;

  // 1. Scan Primary Volume Descriptor (Sector 16)
  const pvdSector = 16;
  const pvdBase = pvdSector * sectorSize;
  if (pvdBase + 100 < data.length) {
    const mode = (pvdBase + 15 < data.length) ? data[pvdBase + 15] : 2;
    const headerOffset = (sectorSize === 2352) ? ((mode === 1) ? 16 : 24) : 0;
    const pvdData = pvdBase + headerOffset;
    if (pvdData + 40 < data.length) {
      const magic = readAscii(data, pvdData + 1, 5).trim();
      if (magic === 'CD001') {
        volumeLabel = readAscii(data, pvdData + 40, 32).trim();
      }
    }
  }

  // 2. Scan for "BOOT = cdrom:" or "BOOT=cdrom:" in first 100 sectors
  const scanLimit = Math.min(data.length, sectorSize * 150);
  for (let i = 0; i < scanLimit - 16; i++) {
    // Match 'B', 'O', 'O', 'T' (case-insensitive)
    if (
      (data[i] === 0x42 || data[i] === 0x62) &&
      (data[i + 1] === 0x4f || data[i + 1] === 0x6f) &&
      (data[i + 2] === 0x4f || data[i + 2] === 0x6f) &&
      (data[i + 3] === 0x54 || data[i + 3] === 0x74)
    ) {
      const line = readAscii(data, i, 128);
      const bootMatch = line.match(/BOOT\s*=\s*cdrom:\\?([^;\r\n\s]+)(?:;(\d+))?/i);
      if (bootMatch && bootMatch[1]) {
        primaryExecutable = bootMatch[1].trim().replace(/^\\+/, '');
        systemCnf = line.trim();
        break;
      }
    }
  }

  return { systemCnf, primaryExecutable, volumeLabel };
}

/**
 * Client-side pipeline to mount uncompressed ZIP archives, CUE/BIN pairs, or ISO files
 * into a structured VirtualDisc object.
 */
export async function mountArchiveOrDisc(
  fileOrBuffer: File | ArrayBuffer | Uint8Array,
  fileName: string = 'disc.bin'
): Promise<VirtualDisc> {
  let rawBytes: Uint8Array;
  let baseName = fileName;

  if (fileOrBuffer instanceof File) {
    baseName = fileOrBuffer.name;
    const arrayBuffer = await fileOrBuffer.arrayBuffer();
    rawBytes = new Uint8Array(arrayBuffer);
  } else if (fileOrBuffer instanceof ArrayBuffer) {
    rawBytes = new Uint8Array(fileOrBuffer);
  } else {
    rawBytes = fileOrBuffer;
  }

  // Check if buffer is a ZIP archive
  if (isZipBuffer(rawBytes) || baseName.toLowerCase().endsWith('.zip')) {
    const zip = await JSZip.loadAsync(rawBytes);
    const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir);

    // Look for .cue file in the zip
    const cueFileName = files.find((f) => f.toLowerCase().endsWith('.cue'));
    let cueSheet: string | undefined;
    let discPayload: Uint8Array | null = null;
    let discPayloadName = baseName;
    let tracks: VirtualDiscTrack[] | undefined;

    if (cueFileName) {
      const cueFile = zip.files[cueFileName];
      cueSheet = await cueFile.async('text');
      const parsedCue = parseCueSheet(cueSheet);
      tracks = parsedCue.tracks;

      // Find referenced binary file
      let targetBinaryName = parsedCue.binaryFiles[0];
      if (!targetBinaryName) {
        // Fallback: search for any .bin / .iso / .img in zip
        targetBinaryName = files.find((f) => {
          const l = f.toLowerCase();
          return l.endsWith('.bin') || l.endsWith('.iso') || l.endsWith('.img') || l.endsWith('.exe');
        }) || '';
      }

      // Case-insensitive / path-normalized match in zip
      const matchedFileInZip = files.find(
        (f) => f === targetBinaryName || f.endsWith('/' + targetBinaryName) || f.toLowerCase() === targetBinaryName.toLowerCase()
      );

      if (matchedFileInZip) {
        discPayload = await zip.files[matchedFileInZip].async('uint8array');
        discPayloadName = matchedFileInZip.split('/').pop() || matchedFileInZip;
      }
    }

    // If no cue or binary match found, find largest binary file in zip
    if (!discPayload) {
      const candidateFiles = files.filter((f) => {
        const l = f.toLowerCase();
        return l.endsWith('.bin') || l.endsWith('.iso') || l.endsWith('.img') || l.endsWith('.exe') || l.endsWith('.rom');
      });

      if (candidateFiles.length > 0) {
        // Pick the first or largest candidate
        const chosenFile = candidateFiles[0];
        discPayload = await zip.files[chosenFile].async('uint8array');
        discPayloadName = chosenFile.split('/').pop() || chosenFile;
      } else if (files.length > 0) {
        // Pick first non-empty file
        discPayload = await zip.files[files[0]].async('uint8array');
        discPayloadName = files[0].split('/').pop() || files[0];
      }
    }

    if (!discPayload) {
      throw new Error(`The ZIP archive "${baseName}" does not contain any valid PS1 disc image (.bin, .iso, .cue, .img, .exe).`);
    }

    // Determine sector size
    const sectorSize = discPayload.length % 2352 === 0 ? 2352 : 2048;
    const totalSectors = Math.floor(discPayload.length / sectorSize);
    const { systemCnf, primaryExecutable, volumeLabel } = scanSystemCnf(discPayload, sectorSize);

    return {
      name: `${baseName} [${discPayloadName}]`,
      buffer: discPayload.buffer.slice(discPayload.byteOffset, discPayload.byteOffset + discPayload.byteLength),
      data: discPayload,
      sectorSize,
      totalSectors,
      cueSheet,
      tracks,
      systemCnf,
      primaryExecutable: primaryExecutable || 'PSX.EXE',
      volumeLabel: volumeLabel || 'PlayStation Disc',
    };
  }

  // Raw disc image or companion file (.bin, .iso, .img, .exe)
  const sectorSize = rawBytes.length % 2352 === 0 ? 2352 : 2048;
  const totalSectors = Math.floor(rawBytes.length / sectorSize);
  const { systemCnf, primaryExecutable, volumeLabel } = scanSystemCnf(rawBytes, sectorSize);

  return {
    name: baseName,
    buffer: rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength),
    data: rawBytes,
    sectorSize,
    totalSectors,
    systemCnf,
    primaryExecutable: primaryExecutable || (baseName.toLowerCase().endsWith('.exe') ? baseName : 'PSX.EXE'),
    volumeLabel: volumeLabel || (baseName.toLowerCase().endsWith('.exe') ? 'PS-X Direct EXE' : 'PlayStation Disc'),
  };
}

/**
 * Extracts and parses PS-X executable machine code and execution vectors from a VirtualDisc.
 */
export function extractExecutableFromDisc(discData: VirtualDisc): ParsedExecutable {
  const data = discData.data;

  // 1. Direct standalone PS-X EXE
  if (
    data.length >= 2048 &&
    data[0] === 0x50 && data[1] === 0x53 && data[2] === 0x2d && data[3] === 0x58 &&
    data[4] === 0x20 && data[5] === 0x45 && data[6] === 0x58 && data[7] === 0x45
  ) {
    const view = new DataView(data.buffer, data.byteOffset, 2048);
    const entryPc = view.getUint32(0x10, true) || 0x80010000;
    const initialGp = view.getUint32(0x14, true) || 0x00000000;
    const loadAddr = view.getUint32(0x18, true) || 0x80010000;
    const loadSize = view.getUint32(0x1c, true) || (data.length - 2048);
    const initialSpBase = view.getUint32(0x30, true) || 0x801f0000;
    const initialSpOffset = view.getUint32(0x34, true) || 0x0000fff0;
    const bssAddr = view.getUint32(0x38, true) || 0;
    const bssSize = view.getUint32(0x3c, true) || 0;

    const payload = data.subarray(2048, 2048 + loadSize);
    return {
      entryPc: entryPc >>> 0,
      loadAddr: loadAddr >>> 0,
      loadSize,
      data: payload,
      initialSp: ((initialSpBase + initialSpOffset) || 0x801ffff0) >>> 0,
      initialGp: initialGp >>> 0,
      bssAddr: bssAddr >>> 0,
      bssSize: bssSize >>> 0,
    };
  }

  // 2. Scan sectors for PS-X EXE header
  const sectorSize = discData.sectorSize || (data.length % 2352 === 0 ? 2352 : 2048);
  const totalSectors = Math.min(Math.floor(data.length / sectorSize), 50000);
  let headerOffset = -1;

  for (let s = 0; s < totalSectors; s++) {
    const candidates = sectorSize === 2352
      ? [s * 2352 + 24, s * 2352 + 16, s * 2352]
      : [s * 2048];

    for (const cand of candidates) {
      if (cand + 2048 <= data.length) {
        if (
          data[cand] === 0x50 && data[cand + 1] === 0x53 && data[cand + 2] === 0x2d && data[cand + 3] === 0x58 &&
          data[cand + 4] === 0x20 && data[cand + 5] === 0x45 && data[cand + 6] === 0x58 && data[cand + 7] === 0x45
        ) {
          headerOffset = cand;
          break;
        }
      }
    }
    if (headerOffset !== -1) break;
  }

  if (headerOffset !== -1 && headerOffset + 0x40 <= data.length) {
    const view = new DataView(data.buffer, data.byteOffset + headerOffset, Math.min(2048, data.length - headerOffset));
    const entryPc = view.getUint32(0x10, true) || 0x80010000;
    const initialGp = view.getUint32(0x14, true) || 0x00000000;
    const loadAddr = view.getUint32(0x18, true) || 0x80010000;
    const loadSize = view.getUint32(0x1c, true) || 0;
    const initialSpBase = view.getUint32(0x30, true) || 0x801f0000;
    const initialSpOffset = view.getUint32(0x34, true) || 0x0000fff0;
    const bssAddr = view.getUint32(0x38, true) || 0;
    const bssSize = view.getUint32(0x3c, true) || 0;

    const payload = new Uint8Array(loadSize > 0 ? loadSize : 2048);

    if (sectorSize === 2352) {
      const subOffset = (headerOffset % 2352 === 24 || headerOffset % 2352 === 16)
        ? (headerOffset % 2352)
        : 24;
      const headerLba = Math.floor(headerOffset / 2352);
      let bytesRead = 0;
      let curLba = headerLba + 1;
      while (bytesRead < payload.length && (curLba * 2352 + subOffset) < data.length) {
        const srcStart = curLba * 2352 + subOffset;
        const chunkLen = Math.min(2048, payload.length - bytesRead, data.length - srcStart);
        payload.set(data.subarray(srcStart, srcStart + chunkLen), bytesRead);
        bytesRead += chunkLen;
        curLba++;
      }
    } else {
      const srcStart = headerOffset + 2048;
      const chunkLen = Math.min(payload.length, data.length - srcStart);
      if (chunkLen > 0) {
        payload.set(data.subarray(srcStart, srcStart + chunkLen), 0);
      }
    }

    return {
      entryPc: entryPc >>> 0,
      loadAddr: loadAddr >>> 0,
      loadSize: payload.length,
      data: payload,
      initialSp: ((initialSpBase + initialSpOffset) || 0x801ffff0) >>> 0,
      initialGp: initialGp >>> 0,
      bssAddr: bssAddr >>> 0,
      bssSize: bssSize >>> 0,
    };
  }

  // 3. Fallback: Minimal empty executable stub at 0x80010000
  return {
    entryPc: 0x80010000,
    loadAddr: 0x80010000,
    loadSize: 0,
    data: new Uint8Array(0),
    initialSp: 0x801ffff0,
    initialGp: 0x00000000,
  };
}
