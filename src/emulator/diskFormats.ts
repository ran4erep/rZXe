// Parsers and converters for all ZX Spectrum disk, TR-DOS, +D, Opus, Didaktik & Microdrive formats:
// .TRD, .SCL, .FDI, .TD0, .UDI, .DSK, .MGT, .IMG, .OPD, .OPU, .D40, .D80, .MDR, Hobeta (.$B/.$C/.hob/.hobeta)

import { buildTrdImage, convertSclToTrd } from './betaDisk';
import { TapeExportFile, buildTapFromFiles } from './tapeFormats';

export interface CustomDiskSector {
  c: number;
  h: number;
  r: number;
  n: number; // size code: 0=128, 1=256, 2=512, 3=1024
  flags: number;
  data: Uint8Array;
}

export interface CustomDiskImage {
  cylinders: number;
  heads: number;
  writeProtected: boolean;
  // tracks[cyl * 2 + side] -> array of sectors
  tracks: CustomDiskSector[][];
}

export type DiskParseResult =
  | {
      kind: 'disk';
      formatLabel: string;
      trdBytes: Uint8Array;
      customImage?: CustomDiskImage;
    }
  | {
      kind: 'tap';
      formatLabel: string;
      tapBytes: Uint8Array;
    }
  | {
      kind: 'sna';
      formatLabel: string;
      snaBytes: Uint8Array;
    };

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

export function isHobetaExtension(ext: string): boolean {
  return /^(\$[a-z0-9#]|![a-z0-9#]|hob|hobeta)$/i.test(ext);
}

export interface ParsedHobetaFile {
  name: string;
  ext: string;
  start: number;
  length: number;
  sectors: number;
  payload: Uint8Array;
}

export function parseHobetaFile(bytes: Uint8Array): ParsedHobetaFile {
  if (bytes.length < 17) {
    throw new Error('Файл Hobeta слишком короткий');
  }
  let name = '';
  for (let i = 0; i < 8; i++) {
    const ch = bytes[i];
    name += ch >= 0x20 && ch < 0x7f ? String.fromCharCode(ch) : ' ';
  }
  const ext = String.fromCharCode(bytes[8] || 0x43);
  const start = readU16LE(bytes, 9);
  const length = readU16LE(bytes, 11);
  const sectors = Math.max(1, bytes[14] || Math.ceil(length / 256));
  const payload = new Uint8Array(sectors * 256);
  const avail = Math.min(bytes.length - 17, payload.length);
  if (avail > 0) {
    payload.set(bytes.subarray(17, 17 + avail));
  }
  return { name, ext, start, length, sectors, payload };
}

function encodeBasicNumber(n: number): number[] {
  const s = String(n);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  out.push(0x0e, 0x00, 0x00, n & 0xff, (n >> 8) & 0xff, 0x00);
  return out;
}

function buildTrdosBootBasic(target: ParsedHobetaFile): Uint8Array {
  const trimmedName = target.name.trimEnd() || target.name;
  const nameBytes: number[] = [];
  for (let i = 0; i < trimmedName.length; i++) nameBytes.push(trimmedName.charCodeAt(i));

  let body: number[];
  if (target.ext === 'B') {
    // 10 RANDOMIZE USR 15619: REM : RUN "name"
    body = [
      0xf9, 0xc0, ...encodeBasicNumber(15619), 0x3a,
      0xea, 0x3a, 0xf7, 0x22, ...nameBytes, 0x22, 0x0d,
    ];
  } else {
    // 10 CLEAR 24575: RANDOMIZE USR 15619: REM : LOAD "name" CODE : RANDOMIZE USR start
    const clearAddr = Math.max(24575, Math.min(target.start > 0 ? target.start - 1 : 24575, 32767));
    const runAddr = target.start >= 0x5d00 ? target.start : 0x8000;
    body = [
      0xfd, ...encodeBasicNumber(clearAddr), 0x3a,
      0xf9, 0xc0, ...encodeBasicNumber(15619), 0x3a,
      0xea, 0x3a, 0xef, 0x22, ...nameBytes, 0x22, 0xaf, 0x3a,
      0xf9, 0xc0, ...encodeBasicNumber(runAddr), 0x0d,
    ];
  }

  const program = new Uint8Array(4 + body.length + 4);
  program[0] = 0x00;
  program[1] = 10;
  program[2] = body.length & 0xff;
  program[3] = (body.length >> 8) & 0xff;
  program.set(body, 4);
  // TR-DOS BASIC autostart trailer: 0x80, 0xAA, lineLo, lineHi
  const tr = 4 + body.length;
  program[tr] = 0x80;
  program[tr + 1] = 0xaa;
  program[tr + 2] = 10;
  program[tr + 3] = 0x00;
  return program;
}

export function buildTrdFromHobetaFiles(files: ParsedHobetaFile[]): Uint8Array {
  if (files.length === 0) {
    throw new Error('Нет файлов Hobeta для сборки диска');
  }
  const hasBoot = files.some(
    (f) => f.ext === 'B' && f.name.trimEnd().toLowerCase() === 'boot'
  );
  const trdFiles: Array<{
    name: string;
    ext: string;
    start: number;
    lengthOverride?: number;
    payload: Uint8Array;
  }> = [];

  if (!hasBoot) {
    const primary = files.find((f) => f.ext === 'B') ?? files.find((f) => f.ext === 'C') ?? files[0];
    const bootPayload = buildTrdosBootBasic(primary);
    trdFiles.push({
      name: 'boot',
      ext: 'B',
      start: bootPayload.length - 4,
      lengthOverride: bootPayload.length - 4,
      payload: bootPayload,
    });
  }

  for (const f of files) {
    trdFiles.push({
      name: f.name,
      ext: f.ext,
      start: f.start,
      lengthOverride: f.length,
      payload: f.payload,
    });
  }

  return buildTrdImage(trdFiles, 'HOBETA  ');
}

function buildTrdFromCustomTracks(tracks: CustomDiskSector[][]): Uint8Array {
  const trd = new Uint8Array(655360);
  const maxTracks = Math.min(tracks.length, 160);
  for (let t = 0; t < maxTracks; t++) {
    const secList = tracks[t];
    if (!secList) continue;
    for (const s of secList) {
      if (s.r >= 1 && s.r <= 16 && s.data.length > 0) {
        const off = (t * 16 + (s.r - 1)) * 256;
        if (off + 256 <= trd.length) {
          trd.set(s.data.subarray(0, Math.min(256, s.data.length)), off);
        }
      }
    }
  }
  return trd;
}

export function parseFdi(bytes: Uint8Array): DiskParseResult {
  if (bytes.length < 14 || asciiAt(bytes, 0, 3) !== 'FDI') {
    throw new Error('Некорректный заголовок .FDI');
  }
  const writeProtected = bytes[3] !== 0;
  const cylinders = Math.min(86, readU16LE(bytes, 4) || 80);
  const heads = Math.min(2, readU16LE(bytes, 6) || 2);
  const dataOffset = readU16LE(bytes, 10);
  const extraLen = readU16LE(bytes, 12);

  let pos = 14 + extraLen;
  const tracks: CustomDiskSector[][] = [];

  for (let c = 0; c < cylinders; c++) {
    for (let h = 0; h < heads; h++) {
      if (pos + 7 > bytes.length) break;
      const trackOffset = readU32LE(bytes, pos);
      const secCount = bytes[pos + 6];
      pos += 7;

      const secList: CustomDiskSector[] = [];
      for (let s = 0; s < secCount; s++) {
        if (pos + 7 > bytes.length) break;
        const sc = bytes[pos];
        const sh = bytes[pos + 1];
        const sr = bytes[pos + 2];
        const sn = bytes[pos + 3];
        const flags = bytes[pos + 4];
        const secDataOff = readU16LE(bytes, pos + 5);
        pos += 7;

        const secLen = 128 << Math.min(3, sn & 0x03);
        const absOff = dataOffset + trackOffset + secDataOff;
        const data = new Uint8Array(secLen);
        if (absOff < bytes.length) {
          data.set(bytes.subarray(absOff, Math.min(bytes.length, absOff + secLen)));
        }
        secList.push({ c: sc, h: sh, r: sr, n: sn, flags, data });
      }
      tracks[c * 2 + h] = secList;
    }
  }

  return {
    kind: 'disk',
    formatLabel: 'FDI',
    trdBytes: buildTrdFromCustomTracks(tracks),
    customImage: { cylinders, heads, writeProtected, tracks },
  };
}

// --- Teledisk (.TD0) LZHUF Decompressor (used by compressed 'td' images) ---
function decompressTd0Lzhuf(src: Uint8Array): Uint8Array {
  const N = 4096;
  const F = 60;
  const THRESHOLD = 2;
  const N_CHAR = 256 - THRESHOLD + F; // 314
  const T_SIZE = N_CHAR * 2 - 1;       // 627
  const R_IDX = T_SIZE - 1;            // 626
  const MAX_FREQ = 0x8000;

  const dCode = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02,
    0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03, 0x03,
    0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05,
    0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07, 0x07,
    0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09, 0x09,
    0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0a, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b,
    0x0c, 0x0c, 0x0c, 0x0c, 0x0d, 0x0d, 0x0d, 0x0d, 0x0e, 0x0e, 0x0e, 0x0e, 0x0f, 0x0f, 0x0f, 0x0f,
    0x10, 0x10, 0x10, 0x10, 0x11, 0x11, 0x11, 0x11, 0x12, 0x12, 0x12, 0x12, 0x13, 0x13, 0x13, 0x13,
    0x14, 0x14, 0x14, 0x14, 0x15, 0x15, 0x15, 0x15, 0x16, 0x16, 0x16, 0x16, 0x17, 0x17, 0x17, 0x17,
    0x18, 0x18, 0x19, 0x19, 0x1a, 0x1a, 0x1b, 0x1b, 0x1c, 0x1c, 0x1d, 0x1d, 0x1e, 0x1e, 0x1f, 0x1f,
    0x20, 0x20, 0x21, 0x21, 0x22, 0x22, 0x23, 0x23, 0x24, 0x24, 0x25, 0x25, 0x26, 0x26, 0x27, 0x27,
    0x28, 0x28, 0x29, 0x29, 0x2a, 0x2a, 0x2b, 0x2b, 0x2c, 0x2c, 0x2d, 0x2d, 0x2e, 0x2e, 0x2f, 0x2f,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
  ]);
  const dLen = new Uint8Array([
    3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
    4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
    5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
    7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  ]);

  const freq = new Uint16Array(T_SIZE + 1);
  const prnt = new Int16Array(T_SIZE + N_CHAR);
  const son = new Int16Array(T_SIZE);
  const ring = new Uint8Array(N + F);
  ring.fill(0x20, 0, N - F);

  for (let i = 0; i < N_CHAR; i++) {
    freq[i] = 1;
    son[i] = i + T_SIZE;
    prnt[i + T_SIZE] = i;
  }
  let i = 0;
  let j = N_CHAR;
  while (j <= R_IDX) {
    freq[j] = freq[i] + freq[i + 1];
    son[j] = i;
    prnt[i] = prnt[i + 1] = j;
    i += 2;
    j++;
  }
  freq[T_SIZE] = 0xffff;
  prnt[R_IDX] = 0;

  let getbuf = 0;
  let getlen = 0;
  let srcPos = 0;

  const getBit = (): number => {
    while (getlen <= 8) {
      const b = srcPos < src.length ? src[srcPos++] : 0;
      getbuf |= b << (8 - getlen);
      getlen += 8;
    }
    const bit = (getbuf >>> 15) & 1;
    getbuf = (getbuf << 1) & 0xffff;
    getlen--;
    return bit;
  };

  const getByte = (): number => {
    while (getlen <= 8) {
      const b = srcPos < src.length ? src[srcPos++] : 0;
      getbuf |= b << (8 - getlen);
      getlen += 8;
    }
    const val = (getbuf >>> 8) & 0xff;
    getbuf = (getbuf << 8) & 0xffff;
    getlen -= 8;
    return val;
  };

  const reconst = () => {
    let k = 0;
    for (let x = 0; x < T_SIZE; x++) {
      if (son[x] >= T_SIZE) {
        freq[k] = (freq[x] + 1) >> 1;
        son[k] = son[x];
        k++;
      }
    }
    for (let x = 0, y = N_CHAR; y < T_SIZE; x += 2, y++) {
      const f = freq[x] + freq[x + 1];
      freq[y] = f;
      let z = y - 1;
      while (f < freq[z]) z--;
      z++;
      const l = y - z;
      freq.copyWithin(z + 1, z, z + l);
      freq[z] = f;
      son.copyWithin(z + 1, z, z + l);
      son[z] = x;
    }
    for (let x = 0; x < T_SIZE; x++) {
      const s = son[x];
      if (s >= T_SIZE) {
        prnt[s] = x;
      } else {
        prnt[s] = prnt[s + 1] = x;
      }
    }
  };

  const update = (c: number) => {
    if (freq[R_IDX] === MAX_FREQ) reconst();
    let cur = prnt[c + T_SIZE];
    do {
      freq[cur]++;
      const k = freq[cur];
      let l = cur + 1;
      if (k > freq[l]) {
        while (k > freq[++l]);
        l--;
        freq[cur] = freq[l];
        freq[l] = k;
        const u = son[cur];
        prnt[u] = l;
        if (u < T_SIZE) prnt[u + 1] = l;
        const v = son[l];
        son[l] = u;
        prnt[v] = cur;
        if (v < T_SIZE) prnt[v + 1] = cur;
        son[cur] = v;
        cur = l;
      }
      cur = prnt[cur];
    } while (cur !== 0);
  };

  const decodeChar = (): number => {
    let c = son[R_IDX];
    while (c < T_SIZE) {
      c = son[c + getBit()];
    }
    c -= T_SIZE;
    update(c);
    return c;
  };

  const decodePos = (): number => {
    const b = getByte();
    let c = dCode[b] << 6;
    let jBits = dLen[b] - 2;
    let val = b;
    while (jBits--) {
      val = (val << 1) | getBit();
    }
    return c | (val & 0x3f);
  };

  const out: number[] = [];
  let r = N - F;
  while (srcPos < src.length || getlen > 0) {
    const c = decodeChar();
    if (c < 256) {
      out.push(c);
      ring[r++] = c;
      r &= N - 1;
    } else {
      const pos = (r - decodePos() - 1) & (N - 1);
      const len = c - 255 + THRESHOLD;
      for (let k = 0; k < len; k++) {
        const ch = ring[(pos + k) & (N - 1)];
        out.push(ch);
        ring[r++] = ch;
        r &= N - 1;
      }
    }
    if (out.length > 2 * 1024 * 1024) break;
  }
  return new Uint8Array(out);
}

export function parseTd0(bytes: Uint8Array): DiskParseResult {
  if (bytes.length < 12) {
    throw new Error('Файл .TD0 слишком короткий');
  }
  const sig = asciiAt(bytes, 0, 2);
  if (sig !== 'TD' && sig !== 'td') {
    throw new Error('Некорректная сигнатура .TD0 (ожидается TD или td)');
  }
  const hasComment = (bytes[7] & 0x80) !== 0;
  let body = bytes.subarray(12);
  if (sig === 'td') {
    body = decompressTd0Lzhuf(body);
  }

  let pos = 0;
  if (hasComment && pos + 10 <= body.length) {
    const commentLen = readU16LE(body, pos + 2);
    pos += 10 + commentLen;
  }

  const tracks: CustomDiskSector[][] = [];
  let maxCyl = 0;
  let maxHead = 1;

  while (pos + 4 <= body.length) {
    const secCount = body[pos++];
    if (secCount === 0xff) break;
    const cyl = body[pos++];
    const head = body[pos++] & 0x01;
    pos++; // track CRC

    maxCyl = Math.max(maxCyl, cyl + 1);
    maxHead = Math.max(maxHead, head + 1);

    const secList: CustomDiskSector[] = [];
    for (let s = 0; s < secCount && pos + 6 <= body.length; s++) {
      const sc = body[pos++];
      const sh = body[pos++];
      const sr = body[pos++];
      const sn = body[pos++];
      const flags = body[pos++];
      const crc = body[pos++];
      void crc;

      const secSize = 128 << Math.min(3, sn & 0x03);
      const secData = new Uint8Array(secSize);

      if ((flags & 0x30) === 0 && pos + 3 <= body.length) {
        const blockLen = readU16LE(body, pos);
        const enc = body[pos + 2];
        pos += 3;
        const dataEnd = Math.min(body.length, pos + blockLen - 1);

        if (enc === 0) {
          secData.set(body.subarray(pos, Math.min(dataEnd, pos + secSize)));
        } else if (enc === 1 && pos + 4 <= dataEnd) {
          const count = readU16LE(body, pos);
          const pat0 = body[pos + 2];
          const pat1 = body[pos + 3];
          for (let k = 0; k < count && k * 2 + 1 < secSize; k++) {
            secData[k * 2] = pat0;
            secData[k * 2 + 1] = pat1;
          }
        } else if (enc === 2) {
          let p = pos;
          let outIdx = 0;
          while (p + 2 <= dataEnd && outIdx < secSize) {
            const type = body[p++];
            const len = body[p++];
            if (type === 0) {
              const copy = Math.min(len, dataEnd - p, secSize - outIdx);
              secData.set(body.subarray(p, p + copy), outIdx);
              p += len;
              outIdx += copy;
            } else {
              const patLen = type * 2;
              const pat = body.subarray(p, Math.min(dataEnd, p + patLen));
              p += patLen;
              for (let r = 0; r < len && outIdx < secSize; r++) {
                for (let k = 0; k < pat.length && outIdx < secSize; k++) {
                  secData[outIdx++] = pat[k];
                }
              }
            }
          }
        }
        pos = dataEnd;
      }

      secList.push({ c: sc, h: sh, r: sr, n: sn, flags, data: secData });
    }
    tracks[cyl * 2 + head] = secList;
  }

  return {
    kind: 'disk',
    formatLabel: 'TD0',
    trdBytes: buildTrdFromCustomTracks(tracks),
    customImage: {
      cylinders: Math.max(40, maxCyl),
      heads: maxHead,
      writeProtected: false,
      tracks,
    },
  };
}

export function parseUdi(bytes: Uint8Array): DiskParseResult {
  if (bytes.length < 16 || asciiAt(bytes, 0, 4) !== 'UDI!') {
    throw new Error('Некорректный заголовок .UDI (ожидается UDI!)');
  }
  const cylinders = Math.min(86, bytes[9] + 1);
  const heads = Math.min(2, bytes[10] + 1);
  const extHdrLen = readU16LE(bytes, 12);
  let pos = 16 + extHdrLen;

  const tracks: CustomDiskSector[][] = [];
  for (let c = 0; c < cylinders; c++) {
    for (let h = 0; h < heads; h++) {
      if (pos + 3 > bytes.length) break;
      const trackLen = readU16LE(bytes, pos + 1);
      pos += 3;
      const clkLen = Math.ceil(trackLen / 8);
      const trackData = bytes.subarray(pos, Math.min(bytes.length, pos + trackLen));
      pos += trackLen + clkLen;

      // Scan MFM track for A1 A1 A1 FE IDAM followed by A1 A1 A1 FB/F8 DAM
      const secList: CustomDiskSector[] = [];
      for (let i = 0; i + 10 < trackData.length; i++) {
        if (
          trackData[i] === 0xa1 &&
          trackData[i + 1] === 0xa1 &&
          trackData[i + 2] === 0xa1 &&
          trackData[i + 3] === 0xfe
        ) {
          const sc = trackData[i + 4];
          const sh = trackData[i + 5];
          const sr = trackData[i + 6];
          const sn = trackData[i + 7] & 0x03;
          const secSize = 128 << sn;

          let damIdx = -1;
          for (let j = i + 10; j + 4 < Math.min(trackData.length, i + 80); j++) {
            if (
              trackData[j] === 0xa1 &&
              trackData[j + 1] === 0xa1 &&
              trackData[j + 2] === 0xa1 &&
              (trackData[j + 3] === 0xfb || trackData[j + 3] === 0xf8)
            ) {
              damIdx = j + 4;
              break;
            }
          }
          if (damIdx >= 0) {
            const data = new Uint8Array(secSize);
            data.set(trackData.subarray(damIdx, Math.min(trackData.length, damIdx + secSize)));
            secList.push({ c: sc, h: sh, r: sr, n: sn, flags: 0, data });
            i = damIdx + secSize;
          }
        }
      }
      tracks[c * 2 + h] = secList;
    }
  }

  return {
    kind: 'disk',
    formatLabel: 'UDI',
    trdBytes: buildTrdFromCustomTracks(tracks),
    customImage: { cylinders, heads, writeProtected: false, tracks },
  };
}

function extractPlus3DosTapFromTracks(tracks: CustomDiskSector[][], numSides: number): Uint8Array | null {
  // +3DOS uses CP/M directory starting at track 1 (512-byte sectors 1..9 or C1..C9)
  const sectorMap = new Map<string, Uint8Array>();
  for (let t = 0; t < tracks.length; t++) {
    const list = tracks[t];
    if (!list) continue;
    const logicalTrack = numSides === 1 ? (t >> 1) : t;
    for (const s of list) {
      sectorMap.set(`${logicalTrack}:${s.r & 0x0f}`, s.data);
    }
  }

  // Standard +3DOS: 180KB SS (40 tracks * 9 sectors * 512 bytes), system track 0, dir at track 1..2
  const getBlock = (blk: number): Uint8Array => {
    const out = new Uint8Array(1024);
    for (let sub = 0; sub < 2; sub++) {
      const linSec = blk * 2 + sub + 9; // skip track 0 (9 sectors)
      const track = Math.floor(linSec / 9);
      const sec = (linSec % 9) + 1;
      const data = sectorMap.get(`${track}:${sec}`);
      if (data) out.set(data.subarray(0, 512), sub * 512);
    }
    return out;
  };

  const dirBuf = new Uint8Array(2048);
  const b0 = getBlock(0);
  const b1 = getBlock(1);
  dirBuf.set(b0, 0);
  dirBuf.set(b1, 1024);

  const fileChunks = new Map<string, { ext: string; chunks: Array<{ extent: number; blocks: number[] }> }>();
  for (let i = 0; i < 64; i++) {
    const off = i * 32;
    const user = dirBuf[off];
    if (user > 15) continue;
    const name = asciiAt(dirBuf, off + 1, 8).trimEnd();
    const ext = String.fromCharCode(
      dirBuf[off + 9] & 0x7f,
      dirBuf[off + 10] & 0x7f,
      dirBuf[off + 11] & 0x7f
    ).trimEnd();
    if (!name) continue;
    const extent = dirBuf[off + 12];
    const blocks: number[] = [];
    for (let k = 0; k < 16; k++) {
      const blk = dirBuf[off + 16 + k];
      if (blk !== 0) blocks.push(blk);
    }
    const key = `${name}.${ext}`;
    if (!fileChunks.has(key)) fileChunks.set(key, { ext, chunks: [] });
    fileChunks.get(key)!.chunks.push({ extent, blocks });
  }

  const tapFiles: TapeExportFile[] = [];
  for (const [key, info] of fileChunks.entries()) {
    info.chunks.sort((a, b) => a.extent - b.extent);
    const rawParts: Uint8Array[] = [];
    for (const ch of info.chunks) {
      for (const blk of ch.blocks) rawParts.push(getBlock(blk));
    }
    let total = 0;
    for (const p of rawParts) total += p.length;
    const full = new Uint8Array(total);
    let pos = 0;
    for (const p of rawParts) {
      full.set(p, pos);
      pos += p.length;
    }

    if (full.length >= 128 && asciiAt(full, 0, 8) === 'PLUS3DOS') {
      const fileType = full[15]; // 0=BASIC, 1=NumArr, 2=CharArr, 3=CODE
      const dataLen = readU16LE(full, 16);
      const param1 = readU16LE(full, 18);
      const param2 = readU16LE(full, 20);
      const payload = full.subarray(128, Math.min(full.length, 128 + dataLen));
      if (fileType <= 3 && payload.length > 0) {
        tapFiles.push({
          name: key.split('.')[0].slice(0, 10),
          type: fileType as 0 | 1 | 2 | 3,
          param1,
          param2,
          payload: new Uint8Array(payload),
        });
      }
    }
  }

  if (tapFiles.length === 0) return null;
  tapFiles.sort((a, b) => a.type - b.type);
  return buildTapFromFiles(tapFiles);
}

export function parseDsk(bytes: Uint8Array): DiskParseResult {
  if (bytes.length < 256) {
    throw new Error('Файл .DSK слишком короткий');
  }
  const sig = asciiAt(bytes, 0, 8);
  const isExtended = sig === 'EXTENDED';
  const isStandard = sig === 'MV - CPC';
  if (!isExtended && !isStandard) {
    throw new Error('Некорректный заголовок .DSK');
  }

  const numTracks = bytes[0x30];
  const numSides = Math.max(1, Math.min(2, bytes[0x31]));
  const stdTrackSize = readU16LE(bytes, 0x32);
  const tracks: CustomDiskSector[][] = [];

  let offset = 0x100;
  for (let i = 0; i < numTracks * numSides; i++) {
    const trackSize = isExtended ? bytes[0x34 + i] * 256 : stdTrackSize;
    if (trackSize === 0 || offset + 0x18 > bytes.length) {
      offset += trackSize;
      continue;
    }
    const trackNum = bytes[offset + 0x10];
    const sideNum = bytes[offset + 0x11] & 0x01;
    const secSizeCode = bytes[offset + 0x14];
    const secCount = bytes[offset + 0x15];

    const secList: CustomDiskSector[] = [];
    let dataPos = offset + 0x100;
    for (let s = 0; s < secCount && offset + 0x18 + (s + 1) * 8 <= bytes.length; s++) {
      const infoOff = offset + 0x18 + s * 8;
      const sc = bytes[infoOff];
      const sh = bytes[infoOff + 1];
      const sr = bytes[infoOff + 2];
      const sn = bytes[infoOff + 3];
      const actualLen = isExtended
        ? readU16LE(bytes, infoOff + 6) || (128 << Math.min(3, sn & 0x03))
        : 128 << Math.min(3, secSizeCode & 0x03);
      const data = new Uint8Array(actualLen);
      if (dataPos < bytes.length) {
        data.set(bytes.subarray(dataPos, Math.min(bytes.length, dataPos + actualLen)));
      }
      dataPos += actualLen;
      secList.push({ c: sc, h: sh, r: sr, n: sn, flags: 0, data });
    }
    tracks[trackNum * 2 + sideNum] = secList;
    offset += trackSize;
  }

  const trd = buildTrdFromCustomTracks(tracks);
  if (trd[0x8e7] === 0x10) {
    return {
      kind: 'disk',
      formatLabel: 'DSK',
      trdBytes: trd,
      customImage: { cylinders: numTracks, heads: numSides, writeProtected: false, tracks },
    };
  }

  // Try +3DOS extraction into runnable TAP
  const plus3Tap = extractPlus3DosTapFromTracks(tracks, numSides);
  if (plus3Tap) {
    return { kind: 'tap', formatLabel: 'DSK (+3DOS)', tapBytes: plus3Tap };
  }

  return {
    kind: 'disk',
    formatLabel: 'DSK',
    trdBytes: trd,
    customImage: { cylinders: numTracks, heads: numSides, writeProtected: false, tracks },
  };
}

export function parseMgtOrImg(bytes: Uint8Array, extLabel: string): DiskParseResult {
  // Check if raw TR-DOS image (.IMG is often used as raw .TRD dump)
  if (bytes.length === 655360 || bytes.length === 327680 || bytes.length === 163840 || bytes[0x8e7] === 0x10) {
    const trd = new Uint8Array(655360);
    trd.set(bytes.subarray(0, Math.min(bytes.length, 655360)));
    return { kind: 'disk', formatLabel: extLabel, trdBytes: trd };
  }

  // DISCiPLE / +D 819200-byte (80 tracks * 2 sides * 10 sectors * 512 bytes)
  if (bytes.length < 819200) {
    throw new Error(`Неподдерживаемый размер образа .${extLabel} (${bytes.length} байт)`);
  }

  const readSector = (track: number, sector1Based: number): Uint8Array => {
    const side = track >= 80 ? 1 : 0;
    const cyl = track >= 80 ? track - 80 : track;
    const off = ((cyl * 2 + side) * 10 + (sector1Based - 1)) * 512;
    return bytes.subarray(off, off + 512);
  };

  const tapFiles: TapeExportFile[] = [];
  for (let tr = 0; tr < 4; tr++) {
    for (let sec = 1; sec <= 10; sec++) {
      const secBytes = readSector(tr, sec);
      for (let e = 0; e < 2; e++) {
        const entry = secBytes.subarray(e * 256, e * 256 + 256);
        const ftype = entry[0];
        if (ftype === 0) continue;
        const name = asciiAt(entry, 1, 10).trimEnd();
        const sectors = (entry[11] << 8) | entry[12];
        let curTrack = entry[13];
        let curSec = entry[14];

        const chunks: Uint8Array[] = [];
        for (let s = 0; s < sectors && curTrack < 160; s++) {
          const data = readSector(curTrack, curSec);
          chunks.push(data.subarray(0, 510));
          curTrack = data[510];
          curSec = data[511];
          if (curTrack === 0 && curSec === 0) break;
        }
        const total = chunks.reduce((acc, c) => acc + c.length, 0);
        const full = new Uint8Array(total);
        let p = 0;
        for (const c of chunks) {
          full.set(c, p);
          p += c.length;
        }

        if (ftype === 5 && full.length >= 49152 + 22) {
          // +D 48K Snapshot -> convert to 48K SNA
          const sna = new Uint8Array(49179);
          // +D snap header (9-byte tape header + 22-byte regs, or 22-byte regs)
          const regOff = full.length >= 49152 + 31 ? 9 : 0;
          sna[0] = full[regOff + 1]; // I
          sna[1] = full[regOff + 2]; // L'
          sna[2] = full[regOff + 3]; // H'
          sna[3] = full[regOff + 4]; // E'
          sna[4] = full[regOff + 5]; // D'
          sna[5] = full[regOff + 6]; // C'
          sna[6] = full[regOff + 7]; // B'
          sna[7] = full[regOff + 8]; // F'
          sna[8] = full[regOff + 9]; // A'
          sna[9] = full[regOff + 10]; // L
          sna[10] = full[regOff + 11]; // H
          sna[11] = full[regOff + 12]; // E
          sna[12] = full[regOff + 13]; // D
          sna[13] = full[regOff + 14]; // C
          sna[14] = full[regOff + 15]; // B
          sna[15] = full[regOff + 16]; // IYL
          sna[16] = full[regOff + 17]; // IYH
          sna[17] = full[regOff + 18]; // IXL
          sna[18] = full[regOff + 19]; // IXH
          sna[19] = 0x04;
          sna[20] = full[regOff]; // R
          sna[21] = full[regOff + 20]; // F
          sna[22] = full[regOff + 21]; // A
          sna[23] = full[regOff + 22]; // SPlo
          sna[24] = full[regOff + 23]; // SPhi
          sna[25] = 1;
          sna[26] = 7;
          const ramOff = regOff + 24;
          if (ramOff + 49152 <= full.length) {
            sna.set(full.subarray(ramOff, ramOff + 49152), 27);
            return { kind: 'sna', formatLabel: `${extLabel} (+D Snap)`, snaBytes: sna };
          }
        }

        if (ftype >= 1 && ftype <= 4 && full.length > 9) {
          const len = readU16LE(full, 1);
          const param1 = readU16LE(full, 3);
          const param2 = readU16LE(full, 7);
          const payload = full.subarray(9, Math.min(full.length, 9 + len));
          if (payload.length > 0) {
            tapFiles.push({
              name: name || 'file',
              type: (ftype - 1) as 0 | 1 | 2 | 3,
              param1,
              param2,
              payload: new Uint8Array(payload),
            });
          }
        }
      }
    }
  }

  if (tapFiles.length === 0) {
    throw new Error(`На диске .${extLabel} не найдено запускаемых файлов`);
  }
  return { kind: 'tap', formatLabel: extLabel, tapBytes: buildTapFromFiles(tapFiles) };
}

export function parseOpus(bytes: Uint8Array, extLabel: string): DiskParseResult {
  if (bytes.length < 184320) {
    throw new Error(`Файл .${extLabel} слишком короткий (ожидается 184320 байт)`);
  }
  const tapFiles: TapeExportFile[] = [];
  // Opus Discovery catalog starts at sector 1.. (after boot sector 0), 16-byte entries
  for (let off = 256; off < 18 * 256; off += 16) {
    const first = bytes[off];
    if (first === 0 || first === 0xff) continue;
    const name = asciiAt(bytes, off, 10).trimEnd();
    const startBlk = bytes[off + 10];
    const lenBlks = bytes[off + 11];
    const dataOff = startBlk * 256;
    const dataLen = lenBlks * 256;
    if (dataOff + 7 >= bytes.length || dataLen <= 7) continue;
    const type = bytes[dataOff] & 0x03;
    const payloadLen = readU16LE(bytes, dataOff + 1);
    const param1 = readU16LE(bytes, dataOff + 3);
    const param2 = readU16LE(bytes, dataOff + 5);
    const payload = bytes.subarray(dataOff + 7, Math.min(bytes.length, dataOff + 7 + payloadLen));
    if (payload.length > 0) {
      tapFiles.push({
        name: name || 'opus',
        type: type as 0 | 1 | 2 | 3,
        param1,
        param2,
        payload: new Uint8Array(payload),
      });
    }
  }
  if (tapFiles.length === 0) {
    throw new Error(`В образе .${extLabel} не найдено программ`);
  }
  return { kind: 'tap', formatLabel: extLabel, tapBytes: buildTapFromFiles(tapFiles) };
}

export function parseDidaktik(bytes: Uint8Array, extLabel: string): DiskParseResult {
  // Didaktik MDOS (.D40 = 360KB/40T or .D80 = 720KB/80T, 512-byte sectors)
  if (bytes.length < 163840) {
    throw new Error(`Файл .${extLabel} слишком короткий`);
  }
  // If TR-DOS signature present, treat as TR-DOS
  if (bytes[0x8e7] === 0x10) {
    const trd = new Uint8Array(655360);
    trd.set(bytes.subarray(0, Math.min(bytes.length, 655360)));
    return { kind: 'disk', formatLabel: extLabel, trdBytes: trd };
  }

  // MDOS directory starts at offset 0x0200 (after boot sector), 16-byte entries
  const tapFiles: TapeExportFile[] = [];
  for (let off = 0x0200; off < 0x1200 && off + 16 <= bytes.length; off += 16) {
    const status = bytes[off];
    if (status === 0 || status === 0xe5) continue;
    const typeChar = String.fromCharCode(bytes[off + 1] & 0x7f);
    const name = asciiAt(bytes, off + 2, 8).trimEnd();
    const startSec = readU16LE(bytes, off + 10);
    const sizeBytes = readU16LE(bytes, off + 12);
    const param = readU16LE(bytes, off + 14);
    const dataOff = startSec * 512;
    if (dataOff >= bytes.length || sizeBytes === 0) continue;
    const payload = bytes.subarray(dataOff, Math.min(bytes.length, dataOff + sizeBytes));
    const tapeType: 0 | 1 | 2 | 3 =
      typeChar === 'P' ? 0 : typeChar === 'N' ? 1 : typeChar === 'C' ? 2 : 3;
    tapFiles.push({
      name: name || 'mdos',
      type: tapeType,
      param1: param,
      param2: tapeType === 0 ? sizeBytes : 0x8000,
      payload: new Uint8Array(payload),
    });
  }
  if (tapFiles.length === 0) {
    throw new Error(`В образе .${extLabel} не найдено программ MDOS`);
  }
  return { kind: 'tap', formatLabel: extLabel, tapBytes: buildTapFromFiles(tapFiles) };
}

export function parseMdr(bytes: Uint8Array): DiskParseResult {
  // ZX Microdrive cartridge: up to 254 sectors x 543 bytes (+ optional 1-byte write-protect trailer)
  const SECTOR_SIZE = 543;
  const numSectors = Math.floor(bytes.length / SECTOR_SIZE);
  if (numSectors < 2) {
    throw new Error('Файл .MDR слишком короткий');
  }

  const fileMap = new Map<
    string,
    { recs: Array<{ recNum: number; len: number; data: Uint8Array }> }
  >();

  for (let s = 0; s < numSectors; s++) {
    const base = s * SECTOR_SIZE;
    const hdFlag = bytes[base];
    if ((hdFlag & 0x01) === 0) continue; // invalid header
    const recFlag = bytes[base + 15];
    if ((recFlag & 0x04) === 0) continue; // empty sector (free)
    const recNum = bytes[base + 16];
    const recLen = bytes[base + 17] | (bytes[base + 18] << 8);
    const name = asciiAt(bytes, base + 19, 10).trimEnd();
    if (!name) continue;
    const data = bytes.subarray(base + 30, base + 30 + Math.min(512, recLen));
    if (!fileMap.has(name)) fileMap.set(name, { recs: [] });
    fileMap.get(name)!.recs.push({ recNum, len: recLen, data: new Uint8Array(data) });
  }

  const tapFiles: TapeExportFile[] = [];
  const entries = Array.from(fileMap.entries());
  // Prioritize 'run' or 'boot' BASIC files first
  entries.sort(([a], [b]) => {
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    const ap = al === 'run' || al === 'boot' ? 0 : 1;
    const bp = bl === 'run' || bl === 'boot' ? 0 : 1;
    return ap - bp;
  });

  for (const [name, info] of entries) {
    info.recs.sort((a, b) => a.recNum - b.recNum);
    const total = info.recs.reduce((acc, r) => acc + r.data.length, 0);
    if (total < 9) continue;
    const full = new Uint8Array(total);
    let pos = 0;
    for (const r of info.recs) {
      full.set(r.data, pos);
      pos += r.data.length;
    }
    // Microdrive files start with 9-byte IF1 header: [type, lenLo, lenHi, startLo, startHi, varLo, varHi, lineLo, lineHi]
    const type = full[0] & 0x03;
    const len = readU16LE(full, 1);
    const start = readU16LE(full, 3);
    const vars = readU16LE(full, 5);
    const autoline = readU16LE(full, 7);
    const payload = full.subarray(9, Math.min(full.length, 9 + len));
    if (payload.length > 0) {
      tapFiles.push({
        name,
        type: type as 0 | 1 | 2 | 3,
        param1: type === 0 ? autoline : start,
        param2: type === 0 ? vars : 0x8000,
        payload: new Uint8Array(payload),
      });
    }
  }

  if (tapFiles.length === 0) {
    throw new Error('На картридже .MDR не найдено файлов');
  }
  return { kind: 'tap', formatLabel: 'MDR', tapBytes: buildTapFromFiles(tapFiles) };
}

export function parseDiskOrMediaImage(ext: string, bytes: Uint8Array): DiskParseResult {
  const lower = ext.toLowerCase();
  if (lower === 'trd') {
    const trd = new Uint8Array(655360);
    trd.set(bytes.subarray(0, Math.min(bytes.length, 655360)));
    return { kind: 'disk', formatLabel: 'TRD', trdBytes: trd };
  }
  if (lower === 'scl') {
    return { kind: 'disk', formatLabel: 'SCL', trdBytes: convertSclToTrd(bytes) };
  }
  if (lower === 'fdi') {
    return parseFdi(bytes);
  }
  if (lower === 'td0') {
    return parseTd0(bytes);
  }
  if (lower === 'udi') {
    return parseUdi(bytes);
  }
  if (lower === 'dsk') {
    return parseDsk(bytes);
  }
  if (lower === 'mgt' || lower === 'img') {
    return parseMgtOrImg(bytes, lower.toUpperCase());
  }
  if (lower === 'opd' || lower === 'opu') {
    return parseOpus(bytes, lower.toUpperCase());
  }
  if (lower === 'd40' || lower === 'd80') {
    return parseDidaktik(bytes, lower.toUpperCase());
  }
  if (lower === 'mdr') {
    return parseMdr(bytes);
  }
  if (isHobetaExtension(lower)) {
    const parsed = parseHobetaFile(bytes);
    return {
      kind: 'disk',
      formatLabel: 'HOBETA',
      trdBytes: buildTrdFromHobetaFiles([parsed]),
    };
  }
  throw new Error(`Неподдерживаемый дисковый формат: .${ext}`);
}
