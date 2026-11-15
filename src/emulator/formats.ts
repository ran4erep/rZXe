// Parsers and builders for authentic ZX Spectrum file formats:
// .SNA, .Z80, .SZX, .SP, .SLT, .SIT, .SNX, .ZX, .ACH, .PRG, .SEM, .FRZ, .ZX82, .SCR, .DCK, .TAP

import { unzlibSync } from 'fflate';
import { Z80 } from './z80';
import type { MachineId } from './machines';

export interface TapeBlock {
  flag: number;
  data: Uint8Array;
  raw: Uint8Array;
}

export interface SnapshotTarget {
  cpu: Z80;
  ramPages: Uint8Array[]; // up to 16 x 16KB pages
  apply128kState: (port7FFD: number, trdosActive: boolean) => void;
  applyAyState?: (selectedReg: number, regs: Uint8Array) => void;
  applyScorpion1FFD?: (port1FFD: number) => void;
}

export function parseTap(bytes: Uint8Array): TapeBlock[] {
  const blocks: TapeBlock[] = [];
  let offset = 0;
  while (offset + 2 <= bytes.length) {
    const len = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2;
    if (len === 0 || offset + len > bytes.length) break;
    const raw = bytes.subarray(offset, offset + len);
    const flag = raw[0];
    const data = len >= 2 ? raw.subarray(1, len - 1) : new Uint8Array(0);
    blocks.push({ flag, data, raw: new Uint8Array(raw) });
    offset += len;
  }
  return blocks;
}

export function buildTapBlock(flag: number, payload: Uint8Array): Uint8Array {
  const blockLen = payload.length + 2;
  const out = new Uint8Array(2 + blockLen);
  out[0] = blockLen & 0xff;
  out[1] = (blockLen >> 8) & 0xff;
  out[2] = flag & 0xff;
  let xor = flag & 0xff;
  for (let i = 0; i < payload.length; i++) {
    const b = payload[i];
    out[3 + i] = b;
    xor ^= b;
  }
  out[3 + payload.length] = xor & 0xff;
  return out;
}

export function buildTapHeader(
  type: number,
  name: string,
  dataLength: number,
  param1: number,
  param2: number
): Uint8Array {
  const hdr = new Uint8Array(17);
  hdr[0] = type & 0xff;
  const padded = name.padEnd(10, ' ').slice(0, 10);
  for (let i = 0; i < 10; i++) {
    hdr[1 + i] = padded.charCodeAt(i) & 0xff;
  }
  hdr[11] = dataLength & 0xff;
  hdr[12] = (dataLength >> 8) & 0xff;
  hdr[13] = param1 & 0xff;
  hdr[14] = (param1 >> 8) & 0xff;
  hdr[15] = param2 & 0xff;
  hdr[16] = (param2 >> 8) & 0xff;
  return buildTapBlock(0x00, hdr);
}

export function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function loadSnaSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 49179) {
    throw new Error('Некорректный размер файла .SNA (ожидается минимум 49179 байт)');
  }

  const cpu = target.cpu;
  cpu.i = bytes[0];
  cpu.l_ = bytes[1];
  cpu.h_ = bytes[2];
  cpu.e_ = bytes[3];
  cpu.d_ = bytes[4];
  cpu.c_ = bytes[5];
  cpu.b_ = bytes[6];
  cpu.f_ = bytes[7];
  cpu.a_ = bytes[8];

  cpu.l = bytes[9];
  cpu.h = bytes[10];
  cpu.e = bytes[11];
  cpu.d = bytes[12];
  cpu.c = bytes[13];
  cpu.b = bytes[14];
  cpu.iyl = bytes[15];
  cpu.iyh = bytes[16];
  cpu.ixl = bytes[17];
  cpu.ixh = bytes[18];

  const iff2 = (bytes[19] & 0x04) !== 0 ? 1 : 0;
  cpu.iff1 = iff2;
  cpu.iff2 = iff2;

  cpu.r = bytes[20] & 0x7f;
  cpu.r7 = bytes[20] & 0x80;
  cpu.f = bytes[21];
  cpu.a = bytes[22];

  const sp = bytes[23] | (bytes[24] << 8);
  cpu.im = bytes[25] & 0x03;
  const border = bytes[26] & 0x07;

  const is128k = bytes.length >= 131103;
  if (is128k) {
    const pc = bytes[49179] | (bytes[49180] << 8);
    const port7FFD = bytes[49181];
    const trdosPaged = bytes[49182] !== 0;
    const activePage = port7FFD & 0x07;

    target.ramPages[5].set(bytes.subarray(27, 27 + 16384));
    target.ramPages[2].set(bytes.subarray(27 + 16384, 27 + 32768));
    target.ramPages[activePage].set(bytes.subarray(27 + 32768, 27 + 49152));

    let off = 49183;
    for (let p = 0; p < 8; p++) {
      if (p === 5 || p === 2 || p === activePage) continue;
      if (off + 16384 <= bytes.length) {
        target.ramPages[p].set(bytes.subarray(off, off + 16384));
        off += 16384;
      }
    }

    target.apply128kState(port7FFD, trdosPaged);
    cpu.pc = pc;
    cpu.sp = sp;
  } else {
    // 48K SNA
    target.ramPages[5].set(bytes.subarray(27, 27 + 16384));
    target.ramPages[2].set(bytes.subarray(27 + 16384, 27 + 32768));
    target.ramPages[0].set(bytes.subarray(27 + 32768, 27 + 49152));
    // Lock to 48K ROM bank if running on 128K machine
    target.apply128kState(0x30, false);

    // Pop PC from stack (RETN semantics)
    const pcl = cpu.rb(sp);
    const pch = cpu.rb((sp + 1) & 0xffff);
    cpu.pc = pcl | (pch << 8);
    cpu.sp = (sp + 2) & 0xffff;
  }

  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k };
}

export interface SnapshotSource {
  cpu: Z80;
  ramPages: Uint8Array[];
  is128k: boolean;
  port7FFD: number;
  trdosActive: boolean;
  borderColor: number;
}

function write48kSnaByte(out: Uint8Array, addr: number, val: number): void {
  if (addr >= 0x4000 && addr < 0x8000) {
    out[27 + (addr - 0x4000)] = val & 0xff;
  } else if (addr >= 0x8000 && addr < 0xc000) {
    out[27 + 16384 + (addr - 0x8000)] = val & 0xff;
  } else if (addr >= 0xc000) {
    out[27 + 32768 + (addr - 0xc000)] = val & 0xff;
  }
}

export function buildSnaSnapshot(source: SnapshotSource): Uint8Array {
  const { cpu, ramPages, is128k, port7FFD, trdosActive, borderColor } = source;
  const out = new Uint8Array(is128k ? 131103 : 49179);

  out[0] = cpu.i & 0xff;
  out[1] = cpu.l_ & 0xff;
  out[2] = cpu.h_ & 0xff;
  out[3] = cpu.e_ & 0xff;
  out[4] = cpu.d_ & 0xff;
  out[5] = cpu.c_ & 0xff;
  out[6] = cpu.b_ & 0xff;
  out[7] = cpu.f_ & 0xff;
  out[8] = cpu.a_ & 0xff;

  out[9] = cpu.l & 0xff;
  out[10] = cpu.h & 0xff;
  out[11] = cpu.e & 0xff;
  out[12] = cpu.d & 0xff;
  out[13] = cpu.c & 0xff;
  out[14] = cpu.b & 0xff;
  out[15] = cpu.iyl & 0xff;
  out[16] = cpu.iyh & 0xff;
  out[17] = cpu.ixl & 0xff;
  out[18] = cpu.ixh & 0xff;

  out[19] = cpu.iff2 ? 0x04 : 0x00;
  out[20] = (cpu.r & 0x7f) | (cpu.r7 & 0x80);
  out[21] = cpu.f & 0xff;
  out[22] = cpu.a & 0xff;
  out[25] = cpu.im & 0x03;
  out[26] = borderColor & 0x07;

  if (is128k) {
    const activePage = port7FFD & 0x07;
    out[23] = cpu.sp & 0xff;
    out[24] = (cpu.sp >> 8) & 0xff;

    out.set(ramPages[5], 27);
    out.set(ramPages[2], 27 + 16384);
    out.set(ramPages[activePage], 27 + 32768);

    out[49179] = cpu.pc & 0xff;
    out[49180] = (cpu.pc >> 8) & 0xff;
    out[49181] = port7FFD & 0xff;
    out[49182] = trdosActive ? 1 : 0;

    let off = 49183;
    for (let p = 0; p < 8; p++) {
      if (p === 5 || p === 2 || p === activePage) continue;
      out.set(ramPages[p], off);
      off += 16384;
    }
  } else {
    out.set(ramPages[5], 27);
    out.set(ramPages[2], 27 + 16384);
    out.set(ramPages[0], 27 + 32768);

    // 48K .SNA pops PC from stack via RETN semantics; write PC into snapshot buffer copy only
    const spAfterPush = (cpu.sp - 2) & 0xffff;
    write48kSnaByte(out, spAfterPush, cpu.pc & 0xff);
    write48kSnaByte(out, (spAfterPush + 1) & 0xffff, (cpu.pc >> 8) & 0xff);
    out[23] = spAfterPush & 0xff;
    out[24] = (spAfterPush >> 8) & 0xff;
  }

  return out;
}

function decompressZ80Block(src: Uint8Array, expectedLen: number): Uint8Array {
  const out = new Uint8Array(expectedLen);
  let i = 0;
  let o = 0;
  while (i < src.length && o < expectedLen) {
    if (
      src[i] === 0xed &&
      i + 1 < src.length &&
      src[i + 1] === 0xed &&
      i + 3 < src.length
    ) {
      const count = src[i + 2];
      const val = src[i + 3];
      for (let k = 0; k < count && o < expectedLen; k++) {
        out[o++] = val;
      }
      i += 4;
    } else {
      out[o++] = src[i++];
    }
  }
  return out;
}

export function loadZ80Snapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 30) {
    throw new Error('Файл .Z80 повреждён');
  }

  const cpu = target.cpu;
  cpu.a = bytes[0];
  cpu.f = bytes[1];
  cpu.c = bytes[2];
  cpu.b = bytes[3];
  cpu.l = bytes[4];
  cpu.h = bytes[5];
  let pc = bytes[6] | (bytes[7] << 8);
  cpu.sp = bytes[8] | (bytes[9] << 8);
  cpu.i = bytes[10];
  cpu.r = bytes[11] & 0x7f;

  let flags12 = bytes[12];
  if (flags12 === 255) flags12 = 1;
  cpu.r7 = (flags12 & 0x01) << 7;
  const border = (flags12 >> 1) & 0x07;
  const compressedV1 = (flags12 & 0x20) !== 0;

  cpu.e = bytes[13];
  cpu.d = bytes[14];
  cpu.c_ = bytes[15];
  cpu.b_ = bytes[16];
  cpu.e_ = bytes[17];
  cpu.d_ = bytes[18];
  cpu.l_ = bytes[19];
  cpu.h_ = bytes[20];
  cpu.a_ = bytes[21];
  cpu.f_ = bytes[22];
  cpu.iyl = bytes[23];
  cpu.iyh = bytes[24];
  cpu.ixl = bytes[25];
  cpu.ixh = bytes[26];
  cpu.iff1 = bytes[27] ? 1 : 0;
  cpu.iff2 = bytes[28] ? 1 : 0;
  cpu.im = bytes[29] & 0x03;

  let is128k = false;

  if (pc !== 0) {
    cpu.pc = pc;
    let ram: Uint8Array;
    if (compressedV1) {
      let end = bytes.length;
      if (
        end >= 34 &&
        bytes[end - 4] === 0x00 &&
        bytes[end - 3] === 0xed &&
        bytes[end - 2] === 0xed &&
        bytes[end - 1] === 0x00
      ) {
        end -= 4;
      }
      ram = decompressZ80Block(bytes.subarray(30, end), 49152);
    } else {
      if (bytes.length < 30 + 49152) {
        throw new Error('Недостаточно данных в v1 .Z80 файле');
      }
      ram = bytes.subarray(30, 30 + 49152);
    }
    target.ramPages[5].set(ram.subarray(0, 16384));
    target.ramPages[2].set(ram.subarray(16384, 32768));
    target.ramPages[0].set(ram.subarray(32768, 49152));
    target.apply128kState(0x30, false);
  } else {
    if (bytes.length < 34) {
      throw new Error('Повреждён заголовок v2/v3 .Z80');
    }
    const extLen = bytes[30] | (bytes[31] << 8);
    pc = bytes[32] | (bytes[33] << 8);
    cpu.pc = pc;
    const hwMode = bytes[34];
    is128k = (extLen === 23 && hwMode >= 3) || (extLen >= 54 && hwMode >= 4);
    const port7FFD = is128k && bytes.length > 35 ? bytes[35] : 0x30;

    let offset = 32 + extLen;
    while (offset + 3 <= bytes.length) {
      // Stop cleanly if .SLT level marker (00 ED ED 00 'S' 'L' 'T') is reached
      if (
        offset + 4 <= bytes.length &&
        bytes[offset] === 0x00 &&
        bytes[offset + 1] === 0xed &&
        bytes[offset + 2] === 0xed &&
        bytes[offset + 3] === 0x00
      ) {
        break;
      }
      const len = bytes[offset] | (bytes[offset + 1] << 8);
      const page = bytes[offset + 2];
      offset += 3;

      let pageData: Uint8Array;
      if (len === 0xffff) {
        const take = Math.min(16384, bytes.length - offset);
        pageData = new Uint8Array(16384);
        pageData.set(bytes.subarray(offset, offset + take));
        offset += 16384;
      } else {
        if (offset + len > bytes.length) break;
        pageData = decompressZ80Block(bytes.subarray(offset, offset + len), 16384);
        offset += len;
      }

      if (is128k) {
        // 128K Z80: pages 3..10 -> RAM banks 0..7 (or up to 15 on Scorpion)
        if (page >= 3 && page <= 18) {
          target.ramPages[page - 3].set(pageData);
        }
      } else {
        // 48K Z80: 8 -> 0x4000 (bank 5), 4 -> 0x8000 (bank 2), 5 -> 0xC000 (bank 0)
        if (page === 8) target.ramPages[5].set(pageData);
        else if (page === 4) target.ramPages[2].set(pageData);
        else if (page === 5) target.ramPages[0].set(pageData);
      }
    }

    target.apply128kState(is128k ? port7FFD : 0x30, false);

    // Restore AY-3-8910 registers (v2/v3 bytes 38..54) if 128K
    if (is128k && bytes.length >= 55 && target.applyAyState) {
      target.applyAyState(bytes[38] & 0x0f, bytes.subarray(39, 55));
    }
    // Restore Scorpion 256 port 0x1FFD (v3 byte 86) if present
    if (extLen >= 55 && bytes.length > 86 && hwMode === 9 && target.applyScorpion1FFD) {
      target.applyScorpion1FFD(bytes[86]);
    }
  }

  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k };
}

function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readU32LE(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function asciiAt(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && o + i < b.length; i++) {
    s += String.fromCharCode(b[o + i]);
  }
  return s;
}

function writeFlat48kRam(target: SnapshotTarget, ram48k: Uint8Array): void {
  target.ramPages[5].set(ram48k.subarray(0, 16384));
  target.ramPages[2].set(ram48k.subarray(16384, 32768));
  target.ramPages[0].set(ram48k.subarray(32768, 49152));
  target.apply128kState(0x30, false);
}

export interface SzxResult {
  border: number;
  is128k: boolean;
  recommendedMachine: MachineId;
}

export function detectSzxMachine(bytes: Uint8Array): MachineId {
  if (bytes.length < 8 || asciiAt(bytes, 0, 4) !== 'ZXST') return '48k';
  const id = bytes[6];
  switch (id) {
    case 0: // 16K
    case 1: // 48K
    case 15: // 48K NTSC
      return '48k';
    case 2: // 128K
    case 16: // 128Ke
      return '128k';
    case 3: // +2
      return 'plus2';
    case 7: // Pentagon 128
    case 13: // Pentagon 512
    case 14: // Pentagon 1024
      return 'pentagon128';
    case 10: // Scorpion
      return 'scorpion256';
    default:
      return '128k';
  }
}

export function loadSzxSnapshot(bytes: Uint8Array, target: SnapshotTarget): SzxResult {
  if (bytes.length < 8 || asciiAt(bytes, 0, 4) !== 'ZXST') {
    throw new Error('Некорректный заголовок .SZX (ожидается ZXST)');
  }
  const recommendedMachine = detectSzxMachine(bytes);
  const is128k = recommendedMachine !== '48k';
  const cpu = target.cpu;

  let border = 7;
  let port7FFD = is128k ? 0x00 : 0x30;
  let port1FFD = 0x00;
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const id = asciiAt(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    offset += 8;
    const end = Math.min(bytes.length, offset + size);

    if (id === 'Z80R' && offset + 30 <= end) {
      cpu.f = bytes[offset];
      cpu.a = bytes[offset + 1];
      cpu.c = bytes[offset + 2];
      cpu.b = bytes[offset + 3];
      cpu.e = bytes[offset + 4];
      cpu.d = bytes[offset + 5];
      cpu.l = bytes[offset + 6];
      cpu.h = bytes[offset + 7];
      cpu.f_ = bytes[offset + 8];
      cpu.a_ = bytes[offset + 9];
      cpu.c_ = bytes[offset + 10];
      cpu.b_ = bytes[offset + 11];
      cpu.e_ = bytes[offset + 12];
      cpu.d_ = bytes[offset + 13];
      cpu.l_ = bytes[offset + 14];
      cpu.h_ = bytes[offset + 15];
      cpu.ixl = bytes[offset + 16];
      cpu.ixh = bytes[offset + 17];
      cpu.iyl = bytes[offset + 18];
      cpu.iyh = bytes[offset + 19];
      cpu.sp = readU16LE(bytes, offset + 20);
      cpu.pc = readU16LE(bytes, offset + 22);
      cpu.i = bytes[offset + 24];
      cpu.r = bytes[offset + 25] & 0x7f;
      cpu.r7 = bytes[offset + 25] & 0x80;
      cpu.iff1 = bytes[offset + 26] ? 1 : 0;
      cpu.iff2 = bytes[offset + 27] ? 1 : 0;
      cpu.im = bytes[offset + 28] & 0x03;
      if (offset + 34 < end) {
        cpu.halted = (bytes[offset + 34] & 0x02) !== 0;
      } else {
        cpu.halted = false;
      }
    } else if (id === 'SPCR' && offset + 4 <= end) {
      border = bytes[offset] & 0x07;
      port7FFD = bytes[offset + 1];
      port1FFD = bytes[offset + 2];
    } else if (id === 'RAMP' && offset + 3 <= end) {
      const flags = readU16LE(bytes, offset);
      const page = bytes[offset + 2];
      const payload = bytes.subarray(offset + 3, end);
      const pageData = (flags & 0x01) !== 0 ? unzlibSync(payload) : payload;
      if (page < target.ramPages.length) {
        target.ramPages[page].set(pageData.subarray(0, Math.min(16384, pageData.length)));
      }
    } else if (id === 'AY\0\0' && offset + 18 <= end && target.applyAyState) {
      target.applyAyState(bytes[offset + 1] & 0x0f, bytes.subarray(offset + 2, offset + 18));
    }

    offset = end;
  }

  target.apply128kState(is128k ? port7FFD : 0x30, false);
  if (recommendedMachine === 'scorpion256' && target.applyScorpion1FFD) {
    target.applyScorpion1FFD(port1FFD);
  }
  cpu.vramDirty = true;
  return { border, is128k, recommendedMachine };
}

export function loadSpSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  const cpu = target.cpu;
  const hasMagic = bytes.length >= 49190 && bytes[0] === 0x53 && bytes[1] === 0x50; // "SP"

  if (hasMagic) {
    const len = readU16LE(bytes, 2);
    const start = readU16LE(bytes, 4);
    const hdr = 6;
    cpu.c = bytes[hdr + 0];
    cpu.b = bytes[hdr + 1];
    cpu.e = bytes[hdr + 2];
    cpu.d = bytes[hdr + 3];
    cpu.l = bytes[hdr + 4];
    cpu.h = bytes[hdr + 5];
    cpu.f = bytes[hdr + 6];
    cpu.a = bytes[hdr + 7];
    cpu.ixl = bytes[hdr + 8];
    cpu.ixh = bytes[hdr + 9];
    cpu.iyl = bytes[hdr + 10];
    cpu.iyh = bytes[hdr + 11];
    cpu.c_ = bytes[hdr + 12];
    cpu.b_ = bytes[hdr + 13];
    cpu.e_ = bytes[hdr + 14];
    cpu.d_ = bytes[hdr + 15];
    cpu.l_ = bytes[hdr + 16];
    cpu.h_ = bytes[hdr + 17];
    cpu.f_ = bytes[hdr + 18];
    cpu.a_ = bytes[hdr + 19];
    cpu.r = bytes[hdr + 20] & 0x7f;
    cpu.r7 = bytes[hdr + 20] & 0x80;
    cpu.i = bytes[hdr + 21];
    cpu.sp = readU16LE(bytes, hdr + 22);
    cpu.pc = readU16LE(bytes, hdr + 24);
    const border = bytes[hdr + 28] & 0x07;
    const status = bytes[hdr + 30];
    cpu.iff1 = (status & 0x01) !== 0 ? 1 : 0;
    cpu.iff2 = (status & 0x04) !== 0 ? 1 : 0;
    cpu.im = (status & 0x02) !== 0 ? 2 : (status & 0x08) !== 0 ? 0 : 1;

    target.apply128kState(0x30, false);
    const ramOffset = 38;
    const ramLen = Math.min(len, bytes.length - ramOffset);
    for (let i = 0; i < ramLen; i++) {
      cpu.wb((start + i) & 0xffff, bytes[ramOffset + i]);
    }
    cpu.halted = false;
    cpu.vramDirty = true;
    return { border, is128k: false };
  }

  // Headerless old .SP format (49152 RAM + 32-byte register trailer = 49184 bytes)
  if (bytes.length < 49184) {
    throw new Error('Некорректный размер файла .SP');
  }
  writeFlat48kRam(target, bytes.subarray(0, 49152));
  const t = 49152;
  cpu.c = bytes[t + 0];
  cpu.b = bytes[t + 1];
  cpu.e = bytes[t + 2];
  cpu.d = bytes[t + 3];
  cpu.l = bytes[t + 4];
  cpu.h = bytes[t + 5];
  cpu.f = bytes[t + 6];
  cpu.a = bytes[t + 7];
  cpu.ixl = bytes[t + 8];
  cpu.ixh = bytes[t + 9];
  cpu.iyl = bytes[t + 10];
  cpu.iyh = bytes[t + 11];
  cpu.c_ = bytes[t + 12];
  cpu.b_ = bytes[t + 13];
  cpu.e_ = bytes[t + 14];
  cpu.d_ = bytes[t + 15];
  cpu.l_ = bytes[t + 16];
  cpu.h_ = bytes[t + 17];
  cpu.f_ = bytes[t + 18];
  cpu.a_ = bytes[t + 19];
  cpu.r = bytes[t + 20] & 0x7f;
  cpu.r7 = bytes[t + 20] & 0x80;
  cpu.i = bytes[t + 21];
  cpu.sp = readU16LE(bytes, t + 22);
  cpu.pc = readU16LE(bytes, t + 24);
  const border = bytes[t + 28] & 0x07;
  const status = bytes[t + 30];
  cpu.iff1 = (status & 0x01) !== 0 ? 1 : 0;
  cpu.iff2 = (status & 0x04) !== 0 ? 1 : 0;
  cpu.im = (status & 0x02) !== 0 ? 2 : 1;
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: false };
}

export function loadSitSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 49180) {
    throw new Error('Некорректный размер файла .SIT (ожидается 49180 байт)');
  }
  const cpu = target.cpu;
  cpu.c = bytes[0];
  cpu.b = bytes[1];
  cpu.e = bytes[2];
  cpu.d = bytes[3];
  cpu.l = bytes[4];
  cpu.h = bytes[5];
  cpu.f = bytes[6];
  cpu.a = bytes[7];
  cpu.ixl = bytes[8];
  cpu.ixh = bytes[9];
  cpu.iyl = bytes[10];
  cpu.iyh = bytes[11];
  cpu.sp = readU16LE(bytes, 12);
  cpu.pc = readU16LE(bytes, 14);
  cpu.r = bytes[16] & 0x7f;
  cpu.r7 = bytes[16] & 0x80;
  cpu.i = bytes[17];
  cpu.c_ = bytes[18];
  cpu.b_ = bytes[19];
  cpu.e_ = bytes[20];
  cpu.d_ = bytes[21];
  cpu.l_ = bytes[22];
  cpu.h_ = bytes[23];
  cpu.f_ = bytes[24];
  cpu.a_ = bytes[25];
  const flags = bytes[26];
  cpu.im = flags & 0x03;
  cpu.iff1 = (flags & 0x04) !== 0 ? 1 : 0;
  cpu.iff2 = cpu.iff1;
  const border = bytes[27] & 0x07;

  writeFlat48kRam(target, bytes.subarray(28, 28 + 49152));
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: false };
}

export function loadSnxSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length >= 49179 && asciiAt(bytes, 0, 4) !== 'XSNA') {
    return loadSnaSnapshot(bytes, target);
  }
  if (bytes.length < 35 || asciiAt(bytes, 0, 4) !== 'XSNA') {
    throw new Error('Некорректный формат файла .SNX');
  }
  // XSNA header (4) + 27-byte SNA header + 48KB RLE/raw data (0xED 0xED count val or raw)
  const sna = new Uint8Array(49179);
  sna.set(bytes.subarray(8, 35), 0);
  const ram = decompressZ80Block(bytes.subarray(35), 49152);
  sna.set(ram, 27);
  return loadSnaSnapshot(sna, target);
}

export function loadZxSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 49284) {
    throw new Error('Некорректный размер файла .ZX');
  }
  // KGB .ZX format: 132-byte header (or 49152 RAM + 132-byte footer)
  // Standard KGB layout: 49152 bytes RAM starting at offset 0 (when total 49284/49486), followed by registers
  const cpu = target.cpu;
  writeFlat48kRam(target, bytes.subarray(0, 49152));
  const f = 49152;
  cpu.iff1 = bytes[f + 7] ? 1 : 0;
  cpu.iff2 = cpu.iff1;
  cpu.im = bytes[f + 9] & 0x03;
  const border = bytes[f + 11] & 0x07;
  // Z80 registers in big-endian or little-endian depending on KGB rev; support standard LE block at f+12
  if (f + 44 <= bytes.length) {
    cpu.b = bytes[f + 12];
    cpu.c = bytes[f + 13];
    cpu.d = bytes[f + 14];
    cpu.e = bytes[f + 15];
    cpu.h = bytes[f + 16];
    cpu.l = bytes[f + 17];
    cpu.a = bytes[f + 18];
    cpu.f = bytes[f + 19];
    cpu.b_ = bytes[f + 20];
    cpu.c_ = bytes[f + 21];
    cpu.d_ = bytes[f + 22];
    cpu.e_ = bytes[f + 23];
    cpu.h_ = bytes[f + 24];
    cpu.l_ = bytes[f + 25];
    cpu.a_ = bytes[f + 26];
    cpu.f_ = bytes[f + 27];
    cpu.ixh = bytes[f + 28];
    cpu.ixl = bytes[f + 29];
    cpu.iyh = bytes[f + 30];
    cpu.iyl = bytes[f + 31];
    cpu.sp = (bytes[f + 32] << 8) | bytes[f + 33];
    cpu.pc = (bytes[f + 34] << 8) | bytes[f + 35];
    cpu.i = bytes[f + 36];
    cpu.r = bytes[f + 37] & 0x7f;
    cpu.r7 = bytes[f + 37] & 0x80;
  }
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: false };
}

export function loadAchSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 65792) {
    throw new Error('Некорректный размер файла .ACH (ожидается 65792 байта)');
  }
  const cpu = target.cpu;
  // 256-byte header, then 16384 ROM, then 49152 RAM
  cpu.a = bytes[0];
  cpu.f = bytes[4];
  cpu.b = bytes[8];
  cpu.c = bytes[12];
  cpu.d = bytes[16];
  cpu.e = bytes[20];
  cpu.h = bytes[24];
  cpu.l = bytes[28];
  cpu.pc = readU16LE(bytes, 32);
  cpu.sp = readU16LE(bytes, 36);
  cpu.r = bytes[40] & 0x7f;
  cpu.r7 = bytes[40] & 0x80;
  cpu.i = bytes[92];
  cpu.iff1 = bytes[96] ? 1 : 0;
  cpu.iff2 = cpu.iff1;
  cpu.im = bytes[104] & 0x03;
  cpu.ixl = bytes[128];
  cpu.ixh = bytes[129];
  cpu.iyl = bytes[132];
  cpu.iyh = bytes[133];
  cpu.a_ = bytes[136];
  cpu.f_ = bytes[140];
  cpu.b_ = bytes[144];
  cpu.c_ = bytes[148];
  cpu.d_ = bytes[152];
  cpu.e_ = bytes[156];
  cpu.h_ = bytes[160];
  cpu.l_ = bytes[164];
  const border = bytes[145] & 0x07;

  writeFlat48kRam(target, bytes.subarray(256 + 16384, 256 + 16384 + 49152));
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: false };
}

export function loadPrgSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 49408) {
    throw new Error('Некорректный размер файла .PRG (ожидается 49408 байт)');
  }
  const cpu = target.cpu;
  // 256-byte SpecEm .PRG header + 49152 bytes RAM
  cpu.i = bytes[0xdc];
  cpu.l_ = bytes[0xdd];
  cpu.h_ = bytes[0xde];
  cpu.e_ = bytes[0xdf];
  cpu.d_ = bytes[0xe0];
  cpu.c_ = bytes[0xe1];
  cpu.b_ = bytes[0xe2];
  cpu.f_ = bytes[0xe3];
  cpu.a_ = bytes[0xe4];
  cpu.l = bytes[0xe5];
  cpu.h = bytes[0xe6];
  cpu.e = bytes[0xe7];
  cpu.d = bytes[0xe8];
  cpu.c = bytes[0xe9];
  cpu.b = bytes[0xea];
  cpu.iyl = bytes[0xeb];
  cpu.iyh = bytes[0xec];
  cpu.ixl = bytes[0xed];
  cpu.ixh = bytes[0xee];
  cpu.iff1 = (bytes[0xef] & 0x04) !== 0 ? 1 : 0;
  cpu.iff2 = cpu.iff1;
  cpu.r = bytes[0xf0] & 0x7f;
  cpu.r7 = bytes[0xf0] & 0x80;
  cpu.f = bytes[0xf1];
  cpu.a = bytes[0xf2];
  cpu.sp = readU16LE(bytes, 0xf3);
  cpu.im = bytes[0xf5] & 0x03;
  const border = bytes[0xf6] & 0x07;

  writeFlat48kRam(target, bytes.subarray(256, 256 + 49152));
  // .PRG pops PC from SP (like .SNA)
  const pcl = cpu.rb(cpu.sp);
  const pch = cpu.rb((cpu.sp + 1) & 0xffff);
  cpu.pc = pcl | (pch << 8);
  cpu.sp = (cpu.sp + 2) & 0xffff;
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: false };
}

export function loadSemSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 49181) {
    throw new Error('Некорректный размер файла .SEM');
  }
  const hasSpecSig = asciiAt(bytes, 0, 4) === 'SPEC';
  const hdrOffset = hasSpecSig ? 4 : 0;
  if (bytes.length < hdrOffset + 49152 + 29) {
    throw new Error('Файл .SEM повреждён');
  }
  // SpecEmu layout: 4-byte "SPEC" + 49152 RAM + 29-byte Z80 trailer (or 31-byte)
  const cpu = target.cpu;
  writeFlat48kRam(target, bytes.subarray(hdrOffset, hdrOffset + 49152));
  const t = hdrOffset + 49152;
  cpu.c = bytes[t + 0];
  cpu.b = bytes[t + 1];
  cpu.e = bytes[t + 2];
  cpu.d = bytes[t + 3];
  cpu.l = bytes[t + 4];
  cpu.h = bytes[t + 5];
  cpu.f = bytes[t + 6];
  cpu.a = bytes[t + 7];
  cpu.ixl = bytes[t + 8];
  cpu.ixh = bytes[t + 9];
  cpu.iyl = bytes[t + 10];
  cpu.iyh = bytes[t + 11];
  cpu.c_ = bytes[t + 12];
  cpu.b_ = bytes[t + 13];
  cpu.e_ = bytes[t + 14];
  cpu.d_ = bytes[t + 15];
  cpu.l_ = bytes[t + 16];
  cpu.h_ = bytes[t + 17];
  cpu.f_ = bytes[t + 18];
  cpu.a_ = bytes[t + 19];
  cpu.sp = readU16LE(bytes, t + 20);
  cpu.pc = readU16LE(bytes, t + 22);
  cpu.i = bytes[t + 24];
  cpu.r = bytes[t + 25] & 0x7f;
  cpu.r7 = bytes[t + 25] & 0x80;
  cpu.iff1 = bytes[t + 26] ? 1 : 0;
  cpu.iff2 = cpu.iff1;
  cpu.im = bytes[t + 27] & 0x03;
  const border = bytes[t + 28] & 0x07;
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: false };
}

export function loadFrzSnapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 131114) {
    throw new Error('Некорректный размер файла .FRZ (ожидается 131114 байт)');
  }
  // CBSpeccy .FRZ 128K snapshot: 42-byte register header + 8 x 16KB RAM pages (0..7)
  const cpu = target.cpu;
  const port7FFD = bytes[0];
  cpu.c = bytes[2];
  cpu.b = bytes[3];
  cpu.e = bytes[4];
  cpu.d = bytes[5];
  cpu.l = bytes[6];
  cpu.h = bytes[7];
  cpu.f = bytes[8];
  cpu.a = bytes[9];
  cpu.c_ = bytes[10];
  cpu.b_ = bytes[11];
  cpu.e_ = bytes[12];
  cpu.d_ = bytes[13];
  cpu.l_ = bytes[14];
  cpu.h_ = bytes[15];
  cpu.f_ = bytes[16];
  cpu.a_ = bytes[17];
  cpu.ixl = bytes[18];
  cpu.ixh = bytes[19];
  cpu.iyl = bytes[20];
  cpu.iyh = bytes[21];
  cpu.sp = readU16LE(bytes, 22);
  cpu.pc = readU16LE(bytes, 24);
  cpu.i = bytes[26];
  cpu.r = bytes[27] & 0x7f;
  cpu.r7 = bytes[27] & 0x80;
  cpu.iff1 = bytes[28] ? 1 : 0;
  cpu.iff2 = bytes[29] ? 1 : 0;
  cpu.im = bytes[30] & 0x03;
  const border = bytes[31] & 0x07;

  let off = 42;
  for (let p = 0; p < 8 && off + 16384 <= bytes.length; p++) {
    target.ramPages[p].set(bytes.subarray(off, off + 16384));
    off += 16384;
  }
  target.apply128kState(port7FFD, false);
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k: true };
}

export function loadZx82Snapshot(bytes: Uint8Array, target: SnapshotTarget): { border: number; is128k: boolean } {
  if (bytes.length < 30 || asciiAt(bytes, 0, 4) !== 'ZX82') {
    throw new Error('Некорректный заголовок .ZX82');
  }
  const typeByte = bytes[4]; // bit 0 = compressed, bit 1 = 128K
  const compressed = (typeByte & 0x01) !== 0;
  const is128k = (typeByte & 0x02) !== 0;
  const border = bytes[5] & 0x07;

  const cpu = target.cpu;
  cpu.i = bytes[6];
  cpu.l_ = bytes[7];
  cpu.h_ = bytes[8];
  cpu.e_ = bytes[9];
  cpu.d_ = bytes[10];
  cpu.c_ = bytes[11];
  cpu.b_ = bytes[12];
  cpu.f_ = bytes[13];
  cpu.a_ = bytes[14];
  cpu.l = bytes[15];
  cpu.h = bytes[16];
  cpu.e = bytes[17];
  cpu.d = bytes[18];
  cpu.c = bytes[19];
  cpu.b = bytes[20];
  cpu.iyl = bytes[21];
  cpu.iyh = bytes[22];
  cpu.ixl = bytes[23];
  cpu.ixh = bytes[24];
  cpu.iff1 = (bytes[25] & 0x04) !== 0 ? 1 : 0;
  cpu.iff2 = cpu.iff1;
  cpu.r = bytes[26] & 0x7f;
  cpu.r7 = bytes[26] & 0x80;
  cpu.f = bytes[27];
  cpu.a = bytes[28];
  cpu.sp = readU16LE(bytes, 29);
  cpu.im = bytes[31] & 0x03;

  const expectedRam = is128k ? 131072 : 49152;
  const rawBody = compressed
    ? decompressZ80Block(bytes.subarray(32), expectedRam)
    : bytes.subarray(32, 32 + expectedRam);

  if (is128k) {
    for (let p = 0; p < 8; p++) {
      target.ramPages[p].set(rawBody.subarray(p * 16384, (p + 1) * 16384));
    }
    target.apply128kState(0x00, false);
  } else {
    writeFlat48kRam(target, rawBody);
  }

  const pcl = cpu.rb(cpu.sp);
  const pch = cpu.rb((cpu.sp + 1) & 0xffff);
  cpu.pc = pcl | (pch << 8);
  cpu.sp = (cpu.sp + 2) & 0xffff;
  cpu.halted = false;
  cpu.vramDirty = true;
  return { border, is128k };
}

export function loadScrScreen(bytes: Uint8Array, target: SnapshotTarget): number {
  if (bytes.length < 6144) {
    throw new Error('Файл .SCR слишком короткий (ожидается 6912 или 6144 байт)');
  }
  const scr = target.ramPages[5];
  scr.fill(0, 0, 6912);
  scr.set(bytes.subarray(0, Math.min(6912, bytes.length)), 0);
  if (bytes.length < 6912) {
    // Monochrome 6144-byte bitmap: default white ink on black paper
    scr.fill(0x07, 6144, 6912);
  }
  // Put CPU into a clean DI; HALT loop in RAM so ROM doesn't overwrite the loaded SCREEN$
  target.ramPages[2].set([0xf3, 0x76, 0x18, 0xfd], 0); // DI; HALT; JR $-3
  target.apply128kState(0x30, false);
  target.cpu.pc = 0x8000;
  target.cpu.iff1 = 0;
  target.cpu.iff2 = 0;
  target.cpu.halted = true;
  target.cpu.vramDirty = true;
  // Determine matching border color from bottom-left attribute paper if available
  const paper = (scr[6144] >> 3) & 0x07;
  return paper;
}

export function parseDckCartridge(bytes: Uint8Array): Uint8Array {
  // Timex .DCK format: 1-byte bank ID + 8-byte chunk bitmask + N * 8KB chunks
  if (bytes.length >= 16384 && (bytes.length === 16384 || bytes.length === 32768)) {
    return new Uint8Array(bytes);
  }
  if (bytes.length < 9 + 8192) {
    throw new Error('Некорректный размер картриджа .DCK');
  }
  const rom = new Uint8Array(16384);
  let pos = 9;
  const bitmask = bytes.subarray(1, 9);
  for (let chunk = 0; chunk < 2 && pos + 8192 <= bytes.length; chunk++) {
    if (bitmask[chunk] !== 0) {
      rom.set(bytes.subarray(pos, pos + 8192), chunk * 8192);
      pos += 8192;
    }
  }
  return rom;
}

