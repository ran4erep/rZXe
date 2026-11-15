// Beta Disk Interface (WD1793 FDC) + .TRD, .SCL, .FDI, .TD0, .UDI, .DSK Floppy Disk Image Support

import type { CustomDiskImage, CustomDiskSector } from './diskFormats';
import { encodeSpectrumStringKeys } from './keyboard';

const TRD_SIZE = 655360; // 80 tracks * 2 sides * 16 sectors * 256 bytes

export interface DiskFileEntry {
  name: string;
  ext: string;
  start: number;
  length: number;
  sectors: number;
  track: number;
  sector: number;
}

export type TrdosAutoBootTarget =
  | { kind: 'boot' }
  | { kind: 'named'; name: string; keyChords: ReadonlyArray<readonly string[]> };

/**
 * Inspects a TR-DOS disk catalog (Track 0, Sectors 1..8) to determine what BASIC file
 * auto-boot should launch. Prefers exact "boot" (RUN), then case-insensitive "boot",
 * then a BASIC file matching preferredFilename, and finally the first typable BASIC file.
 */
export function findTrdosAutoBootTarget(
  trdBytes: Uint8Array,
  preferredFilename?: string
): TrdosAutoBootTarget | null {
  if (trdBytes.length < 0x800) return null;

  const preferredBase = preferredFilename
    ? (preferredFilename.split(/[\\/]/).pop() || '')
        .replace(/\.[^.]+$/, '')
        .trim()
        .toLowerCase()
    : '';

  let caseBootMatch: TrdosAutoBootTarget | null = null;
  let preferredMatch: TrdosAutoBootTarget | null = null;
  let firstBasic: TrdosAutoBootTarget | null = null;

  for (let i = 0; i < 128; i++) {
    const off = i * 16;
    const first = trdBytes[off];
    if (first === 0x00) break; // End of TR-DOS catalog
    if (first === 0x01) continue; // Deleted entry
    if (trdBytes[off + 8] !== 0x42) continue; // Only 'B' (BASIC) files

    let rawName = '';
    for (let k = 0; k < 8; k++) {
      rawName += String.fromCharCode(trdBytes[off + k]);
    }
    const trimmed = rawName.replace(/\s+$/, '');
    if (!trimmed) continue;

    if (trimmed === 'boot') {
      return { kind: 'boot' };
    }

    const keyChords = encodeSpectrumStringKeys(trimmed);
    if (!keyChords) continue;

    const candidate: TrdosAutoBootTarget = { kind: 'named', name: trimmed, keyChords };
    const lower = trimmed.toLowerCase();
    if (!caseBootMatch && lower === 'boot') {
      caseBootMatch = candidate;
    } else if (preferredBase && !preferredMatch && lower === preferredBase) {
      preferredMatch = candidate;
    }
    if (!firstBasic) {
      firstBasic = candidate;
    }
  }

  return caseBootMatch ?? preferredMatch ?? firstBasic;
}

/**
 * Converts a .SCL archive into a standard 640KB .TRD floppy image.
 */
export function convertSclToTrd(scl: Uint8Array): Uint8Array {
  if (scl.length < 10) {
    throw new Error('Файл .SCL слишком короткий');
  }
  const sig = String.fromCharCode(...scl.subarray(0, 8));
  if (sig !== 'SINCLAIR') {
    throw new Error('Некорректная сигнатура .SCL (ожидается SINCLAIR)');
  }
  const fileCount = scl[8];
  if (fileCount > 128) {
    throw new Error('Слишком много файлов в .SCL образе');
  }

  const trd = new Uint8Array(TRD_SIZE);
  const headerLen = 9 + fileCount * 14;
  if (scl.length < headerLen) {
    throw new Error('Повреждённый заголовок .SCL');
  }

  let curTrack = 1;
  let curSector = 0;
  let dataOffset = headerLen;

  for (let i = 0; i < fileCount; i++) {
    const srcOff = 9 + i * 14;
    const dstOff = i * 16;
    // Copy 14 bytes (8 name + 1 ext + 2 start + 2 len + 1 sectors)
    trd.set(scl.subarray(srcOff, srcOff + 14), dstOff);
    const sectors = scl[srcOff + 13];
    trd[dstOff + 14] = curSector;
    trd[dstOff + 15] = curTrack;

    // Copy file sector data
    const byteLen = sectors * 256;
    const diskPos = (curTrack * 16 + curSector) * 256;
    if (diskPos + byteLen <= TRD_SIZE && dataOffset + byteLen <= scl.length) {
      trd.set(scl.subarray(dataOffset, dataOffset + byteLen), diskPos);
    }
    dataOffset += byteLen;

    const totalSec = curTrack * 16 + curSector + sectors;
    curTrack = Math.floor(totalSec / 16);
    curSector = totalSec % 16;
  }

  // Track 0 Sector 8: TR-DOS Disk Info block (offset 0x800)
  const info = 0x800;
  trd[info + 0xe1] = curSector; // First free sector
  trd[info + 0xe2] = curTrack;  // First free track
  trd[info + 0xe3] = 0x16;      // Disk type: 80 tracks double-sided (DSDD)
  trd[info + 0xe4] = fileCount; // Total files

  const usedSectors = curTrack * 16 + curSector;
  const freeSectors = Math.max(0, 2560 - usedSectors);
  trd[info + 0xe5] = freeSectors & 0xff;
  trd[info + 0xe6] = (freeSectors >> 8) & 0xff;
  trd[info + 0xe7] = 0x10;      // TR-DOS ID byte (0x10!)

  // Disk label "SPECTRUM"
  const label = 'TR-DOS  ';
  for (let i = 0; i < 8; i++) trd[info + 0xf5 + i] = label.charCodeAt(i);
  for (let i = 0; i < 9; i++) trd[info + 0xea + i] = 0x20;

  return trd;
}

/**
 * Builds a bootable .TRD disk image from a set of TR-DOS files.
 */
export function buildTrdImage(
  files: Array<{ name: string; ext: string; start: number; lengthOverride?: number; payload: Uint8Array }>,
  diskLabel = 'SPECTRUM'
): Uint8Array {
  const trd = new Uint8Array(TRD_SIZE);
  let curTrack = 1;
  let curSector = 0;

  for (let i = 0; i < Math.min(files.length, 128); i++) {
    const f = files[i];
    const dstOff = i * 16;
    const padded = f.name.padEnd(8, ' ').slice(0, 8);
    for (let k = 0; k < 8; k++) trd[dstOff + k] = padded.charCodeAt(k) & 0xff;
    trd[dstOff + 8] = f.ext.charCodeAt(0) & 0xff;
    trd[dstOff + 9] = f.start & 0xff;
    trd[dstOff + 10] = (f.start >> 8) & 0xff;
    const dirLen = f.lengthOverride ?? f.payload.length;
    trd[dstOff + 11] = dirLen & 0xff;
    trd[dstOff + 12] = (dirLen >> 8) & 0xff;

    const sectors = Math.max(1, Math.ceil(f.payload.length / 256));
    trd[dstOff + 13] = sectors & 0xff;
    trd[dstOff + 14] = curSector;
    trd[dstOff + 15] = curTrack;

    const diskPos = (curTrack * 16 + curSector) * 256;
    trd.set(f.payload, diskPos);

    const totalSec = curTrack * 16 + curSector + sectors;
    curTrack = Math.floor(totalSec / 16);
    curSector = totalSec % 16;
  }

  const info = 0x800;
  trd[info + 0xe1] = curSector;
  trd[info + 0xe2] = curTrack;
  trd[info + 0xe3] = 0x16;
  trd[info + 0xe4] = files.length;
  const freeSectors = Math.max(0, 2560 - (curTrack * 16 + curSector));
  trd[info + 0xe5] = freeSectors & 0xff;
  trd[info + 0xe6] = (freeSectors >> 8) & 0xff;
  trd[info + 0xe7] = 0x10;
  for (let i = 0; i < 9; i++) trd[info + 0xea + i] = 0x20;
  const lbl = diskLabel.padEnd(8, ' ').slice(0, 8);
  for (let i = 0; i < 8; i++) trd[info + 0xf5 + i] = lbl.charCodeAt(i);

  return trd;
}

/**
 * Creates a clean, formatted empty 640KB .TRD floppy disk image ready for TR-DOS writes.
 */
export function createBlankTrdImage(diskLabel = 'BLANK'): Uint8Array {
  return buildTrdImage([], diskLabel);
}

export class BetaDisk128 {
  // 4 drives (A..D), null = empty
  public readonly disks: Array<Uint8Array | null> = [null, null, null, null];
  public readonly customDisks: Array<CustomDiskImage | null> = [null, null, null, null];
  private readonly tracks = new Uint8Array(4);

  // WD1793 registers
  private status = 0x00;
  private trackReg = 0;
  private sectorReg = 1;
  private dataReg = 0;
  private systemReg = 0x3c;
  private drive = 0;
  private side = 0;
  private stepDir = 1;

  // Transfer state
  private mode: 'idle' | 'read' | 'write' | 'read_addr' = 'idle';
  private lastCmdType: 'I' | 'II' | 'III' = 'I';
  private multiSector = false;
  private bufOffset = 0;
  private bufEnd = 0;
  private activeCustomSector: CustomDiskSector | null = null;
  private readAddrCursor = 0;
  private readAddrBuf = new Uint8Array(6);
  private drq = false;
  private intrq = false;
  private busy = false;
  private indexPulse = 0;

  // Bitmask of drives (bit 0 = A, bit 1 = B) read/written since last UI poll
  public readActivityMask = 0;
  // Bitmask of drives that received actual sector write data since last persistence flush
  public writeDirtyMask = 0;

  public reset(): void {
    this.status = 0x00;
    this.trackReg = 0;
    this.sectorReg = 1;
    this.dataReg = 0;
    this.mode = 'idle';
    this.lastCmdType = 'I';
    this.drq = false;
    this.intrq = false;
    this.busy = false;
  }

  public insertDisk(driveIdx: number, trdBytes: Uint8Array, customImage?: CustomDiskImage): void {
    if (driveIdx < 0 || driveIdx > 3) return;
    const normalized = new Uint8Array(TRD_SIZE);
    normalized.set(trdBytes.subarray(0, Math.min(trdBytes.length, TRD_SIZE)));
    this.disks[driveIdx] = normalized;
    this.customDisks[driveIdx] = customImage ?? null;
    this.tracks[driveIdx] = 0;
    this.writeDirtyMask &= ~(1 << driveIdx);
  }

  public ejectDisk(driveIdx: number): void {
    if (driveIdx < 0 || driveIdx > 3) return;
    this.disks[driveIdx] = null;
    this.customDisks[driveIdx] = null;
    this.tracks[driveIdx] = 0;
    this.writeDirtyMask &= ~(1 << driveIdx);
    if (this.drive === driveIdx) {
      this.mode = 'idle';
      this.busy = false;
      this.drq = false;
      this.activeCustomSector = null;
    }
  }

  private currentDisk(): Uint8Array | null {
    return this.disks[this.drive];
  }

  private findCustomSector(cyl: number, side: number, sec: number): CustomDiskSector | null {
    const custom = this.customDisks[this.drive];
    if (!custom) return null;
    const trackSectors = custom.tracks[cyl * 2 + side];
    if (!trackSectors || trackSectors.length === 0) return null;
    for (let i = 0; i < trackSectors.length; i++) {
      if (trackSectors[i].r === sec) return trackSectors[i];
    }
    return null;
  }

  private getSectorByteOffset(cyl: number, side: number, sec: number): number {
    // TR-DOS sector numbering: 1..16
    const s = Math.max(0, Math.min(15, sec - 1));
    const linearTrack = cyl * 2 + side;
    return (linearTrack * 16 + s) * 256;
  }

  public readPort(port: number): number {
    const p = port & 0xff;
    switch (p) {
      case 0x1f: {
        // Status register
        this.intrq = false;
        const disk = this.currentDisk();
        if (!disk) {
          return 0x80; // Not ready
        }
        let st = 0x00;
        if (this.mode === 'idle') {
          if (this.lastCmdType === 'I') {
            this.indexPulse = (this.indexPulse + 1) & 0x0f;
            st = 0x20; // Head loaded
            if (this.tracks[this.drive] === 0) st |= 0x04; // TR00
            if (this.indexPulse === 0) st |= 0x02; // Index pulse
          } else {
            // Type II / III finished cleanly with 0 error bits
            st = 0x00;
          }
        } else {
          st = (this.busy ? 0x01 : 0) | (this.drq ? 0x02 : 0);
        }
        this.status = st;
        return st;
      }

      case 0x3f:
        return this.trackReg;

      case 0x5f:
        return this.sectorReg;

      case 0x7f: {
        const disk = this.currentDisk();
        if (this.mode === 'read' && disk && this.drq) {
          this.readActivityMask |= 1 << (this.drive & 0x03);
          const customSec = this.activeCustomSector;
          if (customSec) {
            this.dataReg = this.bufOffset < customSec.data.length ? customSec.data[this.bufOffset] : 0;
          } else {
            this.dataReg = this.bufOffset < disk.length ? disk[this.bufOffset] : 0;
          }
          this.bufOffset++;
          if (this.bufOffset >= this.bufEnd) {
            if (this.multiSector && this.sectorReg < 16) {
              this.sectorReg++;
              this.startSectorRead();
            } else {
              this.mode = 'idle';
              this.activeCustomSector = null;
              this.drq = false;
              this.busy = false;
              this.intrq = true;
            }
          }
        } else if (this.mode === 'read_addr' && this.drq) {
          this.readActivityMask |= 1 << (this.drive & 0x03);
          this.dataReg = this.readAddrBuf[this.bufOffset++];
          if (this.bufOffset >= 6) {
            this.mode = 'idle';
            this.drq = false;
            this.busy = false;
            this.intrq = true;
          }
        }
        return this.dataReg;
      }

      case 0xff: {
        // Beta Disk system read: bit 7 = INTRQ, bit 6 = DRQ
        let res = 0x3f;
        if (this.intrq) res |= 0x80;
        if (this.drq) res |= 0x40;
        return res;
      }

      default:
        return 0xff;
    }
  }

  public writePort(port: number, val: number): void {
    const p = port & 0xff;
    switch (p) {
      case 0x1f:
        this.execCommand(val & 0xff);
        break;
      case 0x3f:
        this.trackReg = val & 0xff;
        break;
      case 0x5f:
        this.sectorReg = val & 0xff;
        break;
      case 0x7f: {
        this.dataReg = val & 0xff;
        const disk = this.currentDisk();
        if (this.mode === 'write' && disk && this.drq) {
          this.readActivityMask |= 1 << (this.drive & 0x03);
          this.writeDirtyMask |= 1 << (this.drive & 0x03);
          const customSec = this.activeCustomSector;
          if (customSec && this.bufOffset < customSec.data.length) {
            customSec.data[this.bufOffset] = this.dataReg;
          }
          if (!customSec && this.bufOffset < disk.length) {
            disk[this.bufOffset] = this.dataReg;
          } else if (customSec && customSec.r >= 1 && customSec.r <= 16) {
            const trdOff = this.getSectorByteOffset(this.tracks[this.drive], this.side, customSec.r) + this.bufOffset;
            if (this.bufOffset < 256 && trdOff < disk.length) {
              disk[trdOff] = this.dataReg;
            }
          }
          this.bufOffset++;
          if (this.bufOffset >= this.bufEnd) {
            if (this.multiSector && this.sectorReg < 16) {
              this.sectorReg++;
              this.startSectorWrite();
            } else {
              this.mode = 'idle';
              this.activeCustomSector = null;
              this.drq = false;
              this.busy = false;
              this.intrq = true;
            }
          }
        }
        break;
      }
      case 0xff: {
        this.systemReg = val & 0xff;
        this.drive = val & 0x03;
        this.side = (~(val >> 4)) & 0x01;
        if ((val & 0x04) === 0) {
          // /RESET active
          this.reset();
        }
        break;
      }
    }
  }

  private startSectorRead(): void {
    const cyl = this.tracks[this.drive];
    const customSec = this.findCustomSector(cyl, this.side, this.sectorReg);
    if (customSec) {
      this.activeCustomSector = customSec;
      this.bufOffset = 0;
      this.bufEnd = customSec.data.length;
    } else {
      this.activeCustomSector = null;
      this.bufOffset = this.getSectorByteOffset(cyl, this.side, this.sectorReg);
      this.bufEnd = this.bufOffset + 256;
    }
    this.mode = 'read';
    this.busy = true;
    this.drq = true;
    this.intrq = false;
    this.readActivityMask |= 1 << (this.drive & 0x03);
  }

  private startSectorWrite(): void {
    const cyl = this.tracks[this.drive];
    const customSec = this.findCustomSector(cyl, this.side, this.sectorReg);
    if (customSec) {
      this.activeCustomSector = customSec;
      this.bufOffset = 0;
      this.bufEnd = customSec.data.length;
    } else {
      this.activeCustomSector = null;
      this.bufOffset = this.getSectorByteOffset(cyl, this.side, this.sectorReg);
      this.bufEnd = this.bufOffset + 256;
    }
    this.mode = 'write';
    this.busy = true;
    this.drq = true;
    this.intrq = false;
    this.readActivityMask |= 1 << (this.drive & 0x03);
  }

  private execCommand(cmd: number): void {
    const disk = this.currentDisk();
    const type = cmd >> 4;

    if (type === 0x0d) {
      // Force Interrupt
      this.mode = 'idle';
      this.busy = false;
      this.drq = false;
      this.intrq = (cmd & 0x08) !== 0;
      return;
    }

    if (!disk) {
      this.mode = 'idle';
      this.busy = false;
      this.drq = false;
      this.intrq = true;
      return;
    }

    if ((cmd & 0x80) === 0) {
      // Type I commands: Restore, Seek, Step
      this.lastCmdType = 'I';
      this.mode = 'idle';
      this.busy = false;
      this.drq = false;
      if (type === 0x00) {
        // Restore
        this.tracks[this.drive] = 0;
        this.trackReg = 0;
      } else if (type === 0x01) {
        // Seek
        const target = Math.min(79, this.dataReg);
        this.tracks[this.drive] = target;
        this.trackReg = target;
      } else {
        // Step / Step In / Step Out
        if (type >= 0x04 && type <= 0x05) this.stepDir = 1;
        else if (type >= 0x06 && type <= 0x07) this.stepDir = -1;
        const next = Math.max(0, Math.min(79, this.tracks[this.drive] + this.stepDir));
        this.tracks[this.drive] = next;
        if (cmd & 0x10) this.trackReg = next;
      }
      this.intrq = true;
      return;
    }

    if (type === 0x08 || type === 0x09) {
      // Read Sector (single / multiple)
      this.lastCmdType = 'II';
      this.multiSector = (cmd & 0x10) !== 0;
      this.startSectorRead();
      return;
    }

    if (type === 0x0a || type === 0x0b) {
      // Write Sector (single / multiple)
      this.lastCmdType = 'II';
      this.multiSector = (cmd & 0x10) !== 0;
      this.startSectorWrite();
      return;
    }

    if (type === 0x0c) {
      // Read Address
      this.lastCmdType = 'III';
      const custom = this.customDisks[this.drive];
      const trackSecs = custom?.tracks[this.tracks[this.drive] * 2 + this.side];
      if (trackSecs && trackSecs.length > 0) {
        const sec = trackSecs[this.readAddrCursor % trackSecs.length];
        this.readAddrCursor = (this.readAddrCursor + 1) % trackSecs.length;
        this.readAddrBuf[0] = sec.c;
        this.readAddrBuf[1] = sec.h;
        this.readAddrBuf[2] = sec.r;
        this.readAddrBuf[3] = sec.n;
      } else {
        this.readAddrBuf[0] = this.tracks[this.drive];
        this.readAddrBuf[1] = this.side;
        this.readAddrBuf[2] = this.sectorReg;
        this.readAddrBuf[3] = 1; // 256 bytes/sector
      }
      this.readAddrBuf[4] = 0;
      this.readAddrBuf[5] = 0;
      this.bufOffset = 0;
      this.mode = 'read_addr';
      this.busy = true;
      this.drq = true;
      this.intrq = false;
      return;
    }

    // Read/Write Track fallback -> finish immediately
    this.lastCmdType = 'III';
    this.mode = 'idle';
    this.busy = false;
    this.drq = false;
    this.intrq = true;
  }
}
