// Zero-startup-overhead extractor for all ZX Spectrum archive formats and file type classification.
// Fast pure-JS paths: .ZIP (fflate + archive-wasm fallback), .GZ/.GZIP, .BZ2/.BZIP2, .ARJ.
// Lazy WASM path (loaded only on demand): .RAR, .7Z, .TAR, .TGZ, .TBZ2, .TXZ, .TLZ, .TZST, .LZH/.LHA, .CAB, .ISO, .CPIO, etc.

import { unzipSync, gunzipSync } from 'fflate';
import {
  isHobetaExtension,
  parseHobetaFile,
  buildTrdFromHobetaFiles,
  ParsedHobetaFile,
} from './diskFormats';

export const TAPE_EXTENSIONS = ['tap', 'blk', 'tzx', 'cdt', 'pzx', 'csw', 'wav', 'voc'] as const;
export const SNAPSHOT_EXTENSIONS = [
  'sna', 'z80', 'slt', 'szx', 'sp', 'sit', 'snx', 'zx', 'ach', 'prg', 'sem', 'frz', 'zx82',
] as const;
export const DISK_EXTENSIONS = [
  'trd', 'scl', 'fdi', 'td0', 'udi', 'dsk', 'mgt', 'img', 'opd', 'opu', 'd40', 'd80', 'mdr',
  'hob', 'hobeta', '$b', '$c', '$d', '$#', '!b', '!c',
] as const;
export const CART_SCREEN_EXTENSIONS = ['rom', 'if2', 'dck', 'scr', 'bin', 'raw'] as const;
export const ARCHIVE_EXTENSIONS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'gzip', 'tgz', 'bz2', 'bzip2', 'tbz', 'tbz2',
  'xz', 'txz', 'lzma', 'tlz', 'zst', 'tzst', 'lzh', 'lha', 'arj', 'cab', 'iso', 'cpio', 'ar', 'pax',
] as const;

export const GAME_ACCEPT_ATTR = [
  ...TAPE_EXTENSIONS,
  ...SNAPSHOT_EXTENSIONS,
  ...DISK_EXTENSIONS,
  ...CART_SCREEN_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
]
  .map((ext) => `.${ext}`)
  .join(',');

export const DISK_ACCEPT_ATTR = [
  ...DISK_EXTENSIONS,
  ...ARCHIVE_EXTENSIONS,
]
  .map((ext) => `.${ext}`)
  .join(',');

export function getFileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isTapeExtension(ext: string): boolean {
  return (TAPE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isSnapshotExtension(ext: string): boolean {
  return (SNAPSHOT_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isCartOrScreenExtension(ext: string): boolean {
  return (CART_SCREEN_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

export function isDiskOrMediaExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return (DISK_EXTENSIONS as readonly string[]).includes(lower) || isHobetaExtension(lower);
}

export function isMountableDriveExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  if (lower === 'mdr') return false;
  return isDiskOrMediaExtension(lower);
}

export function isPlayableGameExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return (
    isTapeExtension(lower) ||
    isSnapshotExtension(lower) ||
    isDiskOrMediaExtension(lower) ||
    isCartOrScreenExtension(lower)
  );
}

export function isArchiveFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tar.bz2') ||
    lower.endsWith('.tar.xz') ||
    lower.endsWith('.tar.lzma') ||
    lower.endsWith('.tar.zst')
  ) {
    return true;
  }
  const ext = getFileExtension(lower);
  return (ARCHIVE_EXTENSIONS as readonly string[]).includes(ext);
}

export function getFormatBadge(filename: string): string {
  const ext = getFileExtension(filename);
  if (isHobetaExtension(ext)) return ext.toUpperCase();
  return ext ? `.${ext.toUpperCase()}` : 'BIN';
}

export interface ExtractedEntry {
  name: string;
  path: string;
  ext: string;
  bytes: Uint8Array;
}

export type ArchiveExtractionResult =
  | { kind: 'single'; file: ExtractedEntry }
  | { kind: 'multiple'; archiveName: string; files: ExtractedEntry[] };

function isIgnoredArchivePath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const parts = norm.split('/');
  for (const part of parts) {
    if (!part) continue;
    if (part === '__MACOSX') return true;
    if (part.startsWith('._')) return true;
  }
  const base = (parts[parts.length - 1] || '').toLowerCase();
  if (!base || base === '.ds_store' || base === 'thumbs.db' || base === 'desktop.ini') {
    return true;
  }
  // Ignore common readme/metadata text files when selecting playable Spectrum media
  if (
    base.endsWith('.txt') ||
    base.endsWith('.nfo') ||
    base.endsWith('.diz') ||
    base.endsWith('.doc') ||
    base.endsWith('.md') ||
    base.endsWith('.url') ||
    base.endsWith('.html') ||
    base.endsWith('.htm')
  ) {
    return true;
  }
  return false;
}

/**
 * Returns true only for entries inside a ZIP archive that can yield playable
 * ZX Spectrum media, Hobeta files, or nested archives.
 * Used both as a filter in fflate.unzipSync and for HTTP Range selective fetching.
 */
export function shouldUnzipEntry(path: string): boolean {
  if (!path || path.endsWith('/')) return false;
  if (isIgnoredArchivePath(path)) return false;
  const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = cleanPath.split('/').pop() || cleanPath;
  if (!baseName) return false;
  if (isArchiveFile(baseName)) return true;
  const ext = getFileExtension(baseName);
  return isPlayableGameExtension(ext);
}

function stripCompressionExt(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || filename;
  const lower = base.toLowerCase();
  for (const suffix of ['.gz', '.gzip', '.bz2', '.bzip2']) {
    if (lower.endsWith(suffix) && base.length > suffix.length) {
      return base.slice(0, base.length - suffix.length);
    }
  }
  return base;
}

function looksLikeTar(bytes: Uint8Array): boolean {
  if (bytes.length < 512) return false;
  // POSIX ustar magic at offset 257: "ustar\0" or "ustar "
  return (
    bytes[257] === 0x75 &&
    bytes[258] === 0x73 &&
    bytes[259] === 0x74 &&
    bytes[260] === 0x61 &&
    bytes[261] === 0x72
  );
}

// ============================================================================
// Pure-TS BZIP2 Decoder (supports raw .bz2 / .tap.bz2 / .trd.bz2 / .tar.bz2)
// ============================================================================
export function decompressBzip2(src: Uint8Array): Uint8Array {
  if (
    src.length < 10 ||
    src[0] !== 0x42 || // 'B'
    src[1] !== 0x5a || // 'Z'
    src[2] !== 0x68 || // 'h'
    src[3] < 0x31 ||
    src[3] > 0x39
  ) {
    throw new Error('Некорректный заголовок BZip2');
  }

  let bitBytePos = 4;
  let bitBuf = 0;
  let bitCount = 0;

  const readBits = (n: number): number => {
    while (bitCount < n) {
      if (bitBytePos >= src.length) {
        throw new Error('Неожиданный конец потока BZip2');
      }
      bitBuf = (bitBuf << 8) | src[bitBytePos++];
      bitCount += 8;
    }
    bitCount -= n;
    return (bitBuf >>> bitCount) & ((1 << n) - 1);
  };

  const chunks: Uint8Array[] = [];
  let totalOut = 0;

  while (true) {
    const m0 = readBits(8);
    const m1 = readBits(8);
    const m2 = readBits(8);
    const m3 = readBits(8);
    const m4 = readBits(8);
    const m5 = readBits(8);

    // End of stream magic: 0x17 0x72 0x45 0x38 0x50 0x90
    if (m0 === 0x17 && m1 === 0x72 && m2 === 0x45 && m3 === 0x38 && m4 === 0x50 && m5 === 0x90) {
      readBits(32); // stream CRC
      break;
    }

    // Block magic: 0x31 0x41 0x59 0x26 0x53 0x59
    if (m0 !== 0x31 || m1 !== 0x41 || m2 !== 0x59 || m3 !== 0x26 || m4 !== 0x53 || m5 !== 0x59) {
      throw new Error('Повреждённый блок BZip2');
    }

    readBits(32); // block CRC
    const randomized = readBits(1);
    if (randomized !== 0) {
      throw new Error('Устаревший randomized BZip2 не поддерживается');
    }
    const origPtr = readBits(24);

    // Symbol bitmap
    const usedMap = readBits(16);
    const symToByte = new Uint8Array(256);
    let symCount = 0;
    for (let i = 0; i < 16; i++) {
      if ((usedMap & (0x8000 >> i)) !== 0) {
        const subMap = readBits(16);
        for (let j = 0; j < 16; j++) {
          if ((subMap & (0x8000 >> j)) !== 0) {
            symToByte[symCount++] = (i << 4) | j;
          }
        }
      }
    }

    const alphaSize = symCount + 2; // + RUNA(0), RUNB(1), EOB(symCount+1)
    const numGroups = readBits(3);
    const numSelectors = readBits(15);

    const selectorsMtf = new Uint8Array(numSelectors);
    for (let i = 0; i < numSelectors; i++) {
      let idx = 0;
      while (readBits(1) !== 0) idx++;
      selectorsMtf[i] = idx;
    }

    // Undo MTF on selectors
    const selectors = new Uint8Array(numSelectors);
    const selList = new Uint8Array(numGroups);
    for (let i = 0; i < numGroups; i++) selList[i] = i;
    for (let i = 0; i < numSelectors; i++) {
      const pos = selectorsMtf[i];
      const val = selList[pos];
      for (let k = pos; k > 0; k--) selList[k] = selList[k - 1];
      selList[0] = val;
      selectors[i] = val;
    }

    // Read Huffman code lengths for each group
    const MAX_CODE_LEN = 20;
    const minLen = new Int32Array(numGroups);
    const limit = Array.from({ length: numGroups }, () => new Int32Array(MAX_CODE_LEN + 2));
    const base = Array.from({ length: numGroups }, () => new Int32Array(MAX_CODE_LEN + 2));
    const perm = Array.from({ length: numGroups }, () => new Int32Array(258));

    for (let t = 0; t < numGroups; t++) {
      const len = new Uint8Array(alphaSize);
      let curr = readBits(5);
      for (let i = 0; i < alphaSize; i++) {
        while (readBits(1) !== 0) {
          curr += readBits(1) ? -1 : 1;
        }
        len[i] = curr;
      }

      let minL = 23;
      let maxL = 0;
      for (let i = 0; i < alphaSize; i++) {
        if (len[i] < minL) minL = len[i];
        if (len[i] > maxL) maxL = len[i];
      }
      minLen[t] = minL;

      let pp = 0;
      for (let l = minL; l <= maxL; l++) {
        for (let s = 0; s < alphaSize; s++) {
          if (len[s] === l) perm[t][pp++] = s;
        }
      }

      const bArr = base[t];
      const lArr = limit[t];
      for (let i = 0; i < alphaSize; i++) bArr[len[i] + 1]++;
      for (let l = 1; l <= MAX_CODE_LEN + 1; l++) bArr[l] += bArr[l - 1];
      let vec = 0;
      for (let l = minL; l <= maxL; l++) {
        vec += bArr[l + 1] - bArr[l];
        lArr[l] = vec - 1;
        vec <<= 1;
      }
      for (let l = minL + 1; l <= maxL; l++) {
        bArr[l] = ((lArr[l - 1] + 1) << 1) - bArr[l];
      }
    }

    // Decode MTF + RLE2 data
    const mtfOrder = new Uint8Array(256);
    for (let i = 0; i < symCount; i++) mtfOrder[i] = symToByte[i];

    const tt = new Uint8Array(100000 * (src[3] - 0x30));
    const counts = new Int32Array(256);
    let blockLen = 0;

    let selIdx = -1;
    let groupPos = 0;
    let curGroup = 0;

    const readSym = (): number => {
      if (groupPos === 0) {
        selIdx++;
        if (selIdx >= numSelectors) throw new Error('Неверный индекс селектора BZip2');
        curGroup = selectors[selIdx];
        groupPos = 50;
      }
      groupPos--;
      let zn = minLen[curGroup];
      let zvec = readBits(zn);
      const lArr = limit[curGroup];
      while (zvec > lArr[zn]) {
        zn++;
        if (zn > MAX_CODE_LEN) throw new Error('Неверный код Хаффмана BZip2');
        zvec = (zvec << 1) | readBits(1);
      }
      return perm[curGroup][zvec - base[curGroup][zn]];
    };

    const eob = symCount + 1;
    let nextSym = readSym();
    while (nextSym !== eob) {
      if (nextSym === 0 || nextSym === 1) {
        let es = -1;
        let N = 1;
        while (nextSym === 0 || nextSym === 1) {
          es += (nextSym === 0 ? 1 : 2) * N;
          N <<= 1;
          nextSym = readSym();
        }
        es++;
        const ch = mtfOrder[0];
        counts[ch] += es;
        for (let k = 0; k < es; k++) {
          tt[blockLen++] = ch;
        }
      } else {
        const mtfIdx = nextSym - 1;
        const ch = mtfOrder[mtfIdx];
        for (let k = mtfIdx; k > 0; k--) mtfOrder[k] = mtfOrder[k - 1];
        mtfOrder[0] = ch;
        counts[ch]++;
        tt[blockLen++] = ch;
        nextSym = readSym();
      }
    }

    // Inverse Burrows-Wheeler Transform
    const cumm = new Int32Array(256);
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      cumm[i] = sum;
      sum += counts[i];
    }

    const lf = new Int32Array(blockLen);
    for (let i = 0; i < blockLen; i++) {
      const ch = tt[i];
      lf[cumm[ch]++] = i;
    }

    // Inverse RLE1
    const outBlock = new Uint8Array(blockLen * 2 + 16);
    let outPos = 0;
    let tPos = origPtr;
    let prevByte = -1;
    let runLen = 0;

    for (let i = 0; i < blockLen; i++) {
      tPos = lf[tPos];
      const b = tt[tPos];
      if (runLen === 4) {
        for (let r = 0; r < b; r++) {
          outBlock[outPos++] = prevByte;
        }
        runLen = 0;
        prevByte = -1;
      } else {
        outBlock[outPos++] = b;
        if (b === prevByte) {
          runLen++;
        } else {
          prevByte = b;
          runLen = 1;
        }
      }
    }

    const trimmed = outBlock.subarray(0, outPos);
    chunks.push(new Uint8Array(trimmed));
    totalOut += trimmed.length;
  }

  const out = new Uint8Array(totalOut);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

// ============================================================================
// Pure-TS ARJ Archive Unpacker (methods 0=Stored, 1..3=LZHUF, 4=Fastest)
// ============================================================================
function decodeArjMethod1to3(src: Uint8Array, origSize: number): Uint8Array {
  const THRESHOLD = 3;
  const DDICSIZ = 26624;
  const NC = 510;
  const NP = 17;
  const NT = 19;
  const CBIT = 9;
  const PBIT = 5;
  const TBIT = 5;
  const CTABLESIZE = 4096;
  const PTABLESIZE = 256;

  let bytePos = 0;
  let bitBuf = 0;
  let subBitBuf = 0;
  let bitCount = 0;

  const fillBuf = (n: number): void => {
    bitBuf = (bitBuf << n) & 0xffff;
    let rem = n;
    while (rem > bitCount) {
      rem -= bitCount;
      bitBuf = (bitBuf | (subBitBuf << rem)) & 0xffff;
      subBitBuf = bytePos < src.length ? src[bytePos++] : 0;
      bitCount = 8;
    }
    bitCount -= rem;
    bitBuf = (bitBuf | (subBitBuf >>> bitCount)) & 0xffff;
  };

  const getBits = (n: number): number => {
    if (n === 0) return 0;
    const x = bitBuf >>> (16 - n);
    fillBuf(n);
    return x;
  };

  fillBuf(16);

  const left = new Int32Array(2 * NC);
  const right = new Int32Array(2 * NC);
  const cLen = new Uint8Array(NC);
  const ptLen = new Uint8Array(NT);
  const cTable = new Uint16Array(CTABLESIZE);
  const ptTable = new Uint16Array(PTABLESIZE);

  const makeTable = (
    nChar: number,
    bitLen: Uint8Array,
    tableBits: number,
    table: Uint16Array
  ): void => {
    const count = new Int32Array(17);
    const weight = new Int32Array(17);
    const start = new Int32Array(18);

    for (let i = 0; i < nChar; i++) count[bitLen[i]]++;
    start[1] = 0;
    for (let i = 1; i <= 16; i++) {
      start[i + 1] = (start[i] + (count[i] << (16 - i))) & 0xffff;
    }
    const jutBits = 16 - tableBits;
    for (let i = 1; i <= tableBits; i++) {
      start[i] >>>= jutBits;
      weight[i] = 1 << (tableBits - i);
    }
    for (let i = tableBits + 1; i <= 16; i++) {
      weight[i] = 1 << (16 - i);
    }

    const iStart = start[tableBits + 1] >>> jutBits;
    if (iStart !== 0) {
      const k = 1 << tableBits;
      for (let i = iStart; i < k; i++) table[i] = 0;
    }

    let avail = nChar;
    const mask = 1 << (15 - tableBits);
    for (let ch = 0; ch < nChar; ch++) {
      const len = bitLen[ch];
      if (len === 0) continue;
      const nextCode = start[len] + weight[len];
      if (len <= tableBits) {
        const lim = Math.min(table.length, nextCode);
        for (let i = start[len]; i < lim; i++) table[i] = ch;
      } else {
        let k = start[len];
        let pIdx = k >>> jutBits;
        let isLeft = false;
        let parent = -1;
        let i = len - tableBits;
        let node = table[pIdx];
        while (i > 0) {
          if (node === 0 || parent === -1) {
            if (parent === -1 && node === 0) {
              node = avail++;
              table[pIdx] = node;
            }
          }
          parent = node;
          if ((k & mask) !== 0) {
            isLeft = false;
            node = right[parent];
            if (node === 0 && i > 1) {
              node = avail++;
              right[parent] = node;
            }
          } else {
            isLeft = true;
            node = left[parent];
            if (node === 0 && i > 1) {
              node = avail++;
              left[parent] = node;
            }
          }
          k = (k << 1) & 0xffff;
          i--;
        }
        if (parent >= 0) {
          if (isLeft) left[parent] = ch;
          else right[parent] = ch;
        }
      }
      start[len] = nextCode;
    }
  };

  const readPtLen = (nn: number, nbit: number, iSpecial: number): void => {
    const n = getBits(nbit);
    if (n === 0) {
      const c = getBits(nbit);
      ptLen.fill(0, 0, nn);
      ptTable.fill(c);
      return;
    }
    let i = 0;
    while (i < n) {
      let c = bitBuf >>> 13;
      if (c === 7) {
        let mask = 1 << 12;
        while ((mask & bitBuf) !== 0) {
          mask >>>= 1;
          c++;
        }
      }
      fillBuf(c < 7 ? 3 : c - 3);
      ptLen[i++] = c;
      if (i === iSpecial) {
        let zeroCount = getBits(2);
        while (--zeroCount >= 0 && i < nn) ptLen[i++] = 0;
      }
    }
    while (i < nn) ptLen[i++] = 0;
    left.fill(0, 0, 2 * nn);
    right.fill(0, 0, 2 * nn);
    makeTable(nn, ptLen, 8, ptTable);
  };

  const readCLen = (): void => {
    const n = getBits(CBIT);
    if (n === 0) {
      const c = getBits(CBIT);
      cLen.fill(0, 0, NC);
      cTable.fill(c);
      return;
    }
    let i = 0;
    while (i < n) {
      let c = ptTable[bitBuf >>> 8];
      if (c >= NT) {
        let mask = 1 << 7;
        do {
          c = (bitBuf & mask) !== 0 ? right[c] : left[c];
          mask >>>= 1;
        } while (c >= NT && mask > 0);
      }
      fillBuf(ptLen[c]);
      if (c <= 2) {
        if (c === 0) c = 1;
        else if (c === 1) c = getBits(4) + 3;
        else c = getBits(CBIT) + 20;
        while (--c >= 0 && i < NC) cLen[i++] = 0;
      } else {
        cLen[i++] = c - 2;
      }
    }
    while (i < NC) cLen[i++] = 0;
    left.fill(0);
    right.fill(0);
    makeTable(NC, cLen, 12, cTable);
  };

  const decodeC = (): number => {
    let j = cTable[bitBuf >>> 4];
    if (j >= NC) {
      let mask = 1 << 3;
      do {
        j = (bitBuf & mask) !== 0 ? right[j] : left[j];
        mask >>>= 1;
      } while (j >= NC && mask > 0);
    }
    fillBuf(cLen[j]);
    return j;
  };

  const decodeP = (): number => {
    let j = ptTable[bitBuf >>> 8];
    if (j >= NP) {
      let mask = 1 << 7;
      do {
        j = (bitBuf & mask) !== 0 ? right[j] : left[j];
        mask >>>= 1;
      } while (j >= NP && mask > 0);
    }
    fillBuf(ptLen[j]);
    if (j !== 0) {
      j = (1 << (j - 1)) + getBits(j - 1);
    }
    return j;
  };

  const out = new Uint8Array(origSize);
  let outPos = 0;
  let blockSize = 0;

  while (outPos < origSize) {
    if (blockSize === 0) {
      blockSize = getBits(16);
      if (blockSize === 0) break;
      readPtLen(NT, TBIT, 3);
      readCLen();
      readPtLen(NP, PBIT, -1);
    }
    blockSize--;
    const c = decodeC();
    if (c <= 255) {
      out[outPos++] = c;
    } else {
      const len = c - 256 + THRESHOLD;
      const dist = decodeP() + 1;
      for (let k = 0; k < len && outPos < origSize; k++) {
        out[outPos] = outPos >= dist ? out[outPos - dist] : 0;
        outPos++;
      }
    }
  }
  return out;
}

function decodeArjMethod4(src: Uint8Array, origSize: number): Uint8Array {
  let bytePos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const getBits = (n: number): number => {
    while (bitCount < n) {
      bitBuf = (bitBuf << 8) | (bytePos < src.length ? src[bytePos++] : 0);
      bitCount += 8;
    }
    bitCount -= n;
    return (bitBuf >>> bitCount) & ((1 << n) - 1);
  };

  const decodeLen = (): number => {
    let ext = 0;
    while (ext < 7 && getBits(1) === 1) ext++;
    const base = ((1 << ext) - 1) << 1;
    const val = ext > 0 ? getBits(ext) : 0;
    return base + val - (ext > 0 ? 1 : 0);
  };

  const decodePtr = (): number => {
    let ext = 0;
    while (ext < 4 && getBits(1) === 1) ext++;
    const base = ((1 << ext) - 1) << 9;
    return base + getBits(9 + ext);
  };

  const out = new Uint8Array(origSize);
  let outPos = 0;
  while (outPos < origSize) {
    const lenCode = decodeLen();
    if (lenCode === 0) {
      out[outPos++] = getBits(8);
    } else {
      const len = lenCode + 2;
      const dist = decodePtr() + 1;
      for (let k = 0; k < len && outPos < origSize; k++) {
        out[outPos] = outPos >= dist ? out[outPos - dist] : 0;
        outPos++;
      }
    }
  }
  return out;
}

function extractArj(bytes: Uint8Array): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  let pos = 0;
  let seenMain = false;

  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0x60 || bytes[pos + 1] !== 0xea) {
      throw new Error('Некорректный заголовок архива .ARJ');
    }
    const basicSize = bytes[pos + 2] | (bytes[pos + 3] << 8);
    pos += 4;
    if (basicSize === 0) break; // End of ARJ archive
    if (pos + basicSize + 4 > bytes.length) break;

    const firstHdrSize = bytes[pos];
    const method = bytes[pos + 5];
    const fileType = bytes[pos + 6];
    const compSize =
      (bytes[pos + 12] |
        (bytes[pos + 13] << 8) |
        (bytes[pos + 14] << 16) |
        (bytes[pos + 15] << 24)) >>>
      0;
    const origSize =
      (bytes[pos + 16] |
        (bytes[pos + 17] << 8) |
        (bytes[pos + 18] << 16) |
        (bytes[pos + 19] << 24)) >>>
      0;

    // Extract filename (null-terminated starting at pos + firstHdrSize)
    let namePos = pos + firstHdrSize;
    let nameEnd = namePos;
    while (nameEnd < pos + basicSize && bytes[nameEnd] !== 0) nameEnd++;
    let filePath = '';
    for (let i = namePos; i < nameEnd; i++) {
      filePath += String.fromCharCode(bytes[i]);
    }

    pos += basicSize + 4; // skip basic header + 4-byte CRC

    // Skip extended headers
    while (pos + 2 <= bytes.length) {
      const extSize = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2;
      if (extSize === 0) break;
      pos += extSize + 4;
    }

    if (!seenMain) {
      seenMain = true;
      continue; // Main header has no compressed payload
    }

    const payloadEnd = Math.min(bytes.length, pos + compSize);
    const compBytes = bytes.subarray(pos, payloadEnd);
    pos = payloadEnd;

    // fileType 0 = binary, 1 = 7-bit text, 3 = dir, 4 = volume label
    if (fileType === 3 || fileType === 4 || origSize === 0) continue;

    let decoded: Uint8Array;
    if (method === 0) {
      decoded = new Uint8Array(compBytes.subarray(0, Math.min(compBytes.length, origSize)));
    } else if (method >= 1 && method <= 3) {
      decoded = decodeArjMethod1to3(compBytes, origSize);
    } else if (method === 4) {
      decoded = decodeArjMethod4(compBytes, origSize);
    } else {
      throw new Error(`Неподдерживаемый метод сжатия .ARJ (${method})`);
    }

    if (filePath) {
      out.push({ path: filePath, bytes: decoded });
    }
  }

  return out;
}

// ============================================================================
// Lazy WASM Unpacker (archive-wasm: .RAR, .7Z, .TAR, .TGZ, .LHA/.LZH, .CAB, .ISO, etc.)
// ============================================================================
async function extractViaArchiveWasm(bytes: Uint8Array): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const mod = await import('archive-wasm');
  const raw = await mod.extractAll(bytes);
  const entries: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const item of raw) {
    if (item.type === 'FILE' && item.path && item.data && item.data.byteLength > 0) {
      entries.push({
        path: item.path,
        bytes: item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data),
      });
    }
  }
  return entries;
}

async function unpackSingleArchiveLayer(
  filename: string,
  bytes: Uint8Array
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
  const lower = filename.toLowerCase();
  const ext = getFileExtension(lower);

  if (ext === 'zip') {
    try {
      const files = unzipSync(bytes, {
        filter: (file) => shouldUnzipEntry(file.name),
      });
      const result: Array<{ path: string; bytes: Uint8Array }> = [];
      for (const [path, data] of Object.entries(files)) {
        if (path.endsWith('/') || data.length === 0) continue;
        result.push({ path, bytes: data });
      }
      return result;
    } catch {
      // Fallback to libarchive.wasm for legacy ZIP methods (Shrink/Implode/Bzip2/LZMA)
      return extractViaArchiveWasm(bytes);
    }
  }

  if (
    lower.endsWith('.tar.gz') ||
    ext === 'tgz' ||
    lower.endsWith('.tar.bz2') ||
    ext === 'tbz' ||
    ext === 'tbz2' ||
    lower.endsWith('.tar.xz') ||
    ext === 'txz' ||
    lower.endsWith('.tar.lzma') ||
    ext === 'tlz' ||
    lower.endsWith('.tar.zst') ||
    ext === 'tzst' ||
    ext === 'tar' ||
    ext === 'rar' ||
    ext === '7z' ||
    ext === 'lzh' ||
    ext === 'lha' ||
    ext === 'cab' ||
    ext === 'iso' ||
    ext === 'cpio' ||
    ext === 'ar' ||
    ext === 'pax' ||
    ext === 'xz' ||
    ext === 'lzma' ||
    ext === 'zst'
  ) {
    return extractViaArchiveWasm(bytes);
  }

  if (ext === 'gz' || ext === 'gzip') {
    const unpacked = gunzipSync(bytes);
    if (looksLikeTar(unpacked)) {
      return extractViaArchiveWasm(unpacked);
    }
    const innerName = stripCompressionExt(filename);
    return [{ path: innerName, bytes: unpacked }];
  }

  if (ext === 'bz2' || ext === 'bzip2') {
    const unpacked = decompressBzip2(bytes);
    if (looksLikeTar(unpacked)) {
      return extractViaArchiveWasm(unpacked);
    }
    const innerName = stripCompressionExt(filename);
    return [{ path: innerName, bytes: unpacked }];
  }

  if (ext === 'arj') {
    return extractArj(bytes);
  }

  return extractViaArchiveWasm(bytes);
}

async function collectRawEntriesRecursive(
  filename: string,
  bytes: Uint8Array,
  depth: number,
  prefix: string,
  out: Array<{ path: string; bytes: Uint8Array }>
): Promise<void> {
  const layer = await unpackSingleArchiveLayer(filename, bytes);
  for (const item of layer) {
    if (isIgnoredArchivePath(item.path)) continue;
    const cleanPath = item.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const fullPath = prefix ? `${prefix}/${cleanPath}` : cleanPath;
    const baseName = cleanPath.split('/').pop() || cleanPath;

    if (depth < 4 && isArchiveFile(baseName)) {
      await collectRawEntriesRecursive(baseName, item.bytes, depth + 1, fullPath, out);
    } else {
      out.push({ path: fullPath, bytes: item.bytes });
    }
  }
}

/**
 * Unpacks an archive and collects playable ZX Spectrum files (or disk images).
 * Groups multi-file Hobeta drops in the same directory into ready-to-boot .TRD disks.
 */
export async function extractPlayableFiles(
  filename: string,
  bytes: Uint8Array,
  mode: 'game' | 'disk' = 'game'
): Promise<ArchiveExtractionResult> {
  if (!isArchiveFile(filename)) {
    const ext = getFileExtension(filename);
    const baseName = filename.split(/[\\/]/).pop() || filename;
    return {
      kind: 'single',
      file: { name: baseName, path: baseName, ext, bytes },
    };
  }

  const rawEntries: Array<{ path: string; bytes: Uint8Array }> = [];
  await collectRawEntriesRecursive(filename, bytes, 0, '', rawEntries);

  const playable: ExtractedEntry[] = [];
  const hobetaByDir = new Map<string, ParsedHobetaFile[]>();

  for (const item of rawEntries) {
    const norm = item.path.replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash) : '';
    const base = slash >= 0 ? norm.slice(slash + 1) : norm;
    const ext = getFileExtension(base);

    if (isHobetaExtension(ext)) {
      try {
        const parsed = parseHobetaFile(item.bytes);
        if (!hobetaByDir.has(dir)) hobetaByDir.set(dir, []);
        hobetaByDir.get(dir)!.push(parsed);
        if (rawEntries.length === 1) {
          playable.push({ name: base, path: norm, ext, bytes: item.bytes });
        }
        continue;
      } catch {
        // Not a valid Hobeta header: skip
      }
    }

    const ok = mode === 'disk' ? isMountableDriveExtension(ext) : isPlayableGameExtension(ext);
    if (ok) {
      playable.push({ name: base, path: norm, ext, bytes: item.bytes });
    }
  }

  // If directories contained Hobeta files, bundle each directory into a single bootable .TRD image
  if (hobetaByDir.size > 0) {
    const archiveBase = (filename.split(/[\\/]/).pop() || 'disk').replace(/\.[^.]+$/, '');
    const hobetaBundles: ExtractedEntry[] = [];
    for (const [dir, list] of hobetaByDir.entries()) {
      if (list.length === 1 && playable.length === 1) continue;
      const trd = buildTrdFromHobetaFiles(list);
      const bundleBase = dir ? dir.split('/').pop() || archiveBase : archiveBase;
      const trdName = `${bundleBase}.trd`;
      hobetaBundles.push({
        name: trdName,
        path: dir ? `${dir}/${trdName}` : trdName,
        ext: 'trd',
        bytes: trd,
      });
    }
    if (hobetaBundles.length > 0) {
      // Put bundled TRD disks first so multi-Hobeta releases are immediately clear
      playable.unshift(...hobetaBundles);
    }
  }

  if (playable.length === 0) {
    throw new Error(
      mode === 'disk'
        ? `В архиве «${filename}» не найдено образов дискет ZX Spectrum`
        : `В архиве «${filename}» не найдено совместимых файлов ZX Spectrum`
    );
  }

  if (playable.length === 1) {
    return { kind: 'single', file: playable[0] };
  }

  // Sort standard snapshots/tapes/disks cleanly before raw/scr/aux files
  const rank = (ext: string): number => {
    if (ext === 'trd' || ext === 'scl' || ext === 'fdi' || ext === 'td0' || ext === 'udi' || ext === 'dsk') return 0;
    if (ext === 'tap' || ext === 'tzx' || ext === 'pzx' || ext === 'sna' || ext === 'z80' || ext === 'szx') return 1;
    if (isTapeExtension(ext) || isSnapshotExtension(ext) || isDiskOrMediaExtension(ext)) return 2;
    return 3;
  };
  playable.sort((a, b) => rank(a.ext) - rank(b.ext) || a.path.localeCompare(b.path));

  return {
    kind: 'multiple',
    archiveName: filename,
    files: playable,
  };
}
