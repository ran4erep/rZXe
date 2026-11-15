// Parsers for all ZX Spectrum cassette tape formats:
// .TAP, .BLK, .TZX, .CDT, .PZX, .CSW, .WAV, .VOC

import { unzlibSync } from 'fflate';
import { TapeBlock, buildTapBlock, buildTapHeader, concatUint8Arrays, parseTap } from './formats';

const TSTATES_PER_SEC = 3_500_000;
const MS_TO_T = 3_500;

export type TapeSegment =
  | { kind: 'tone'; pulseT: number; count: number }
  | { kind: 'pulses'; pulses: Uint32Array }
  | {
      kind: 'data';
      data: Uint8Array;
      zeroT: number;
      oneT: number;
      pulsesPerBit: 1 | 2;
      usedBitsLastByte: number;
      pauseT: number;
    }
  | { kind: 'pause'; pauseT: number; level?: 0 | 1 }
  | { kind: 'setLevel'; level: 0 | 1 }
  | { kind: 'loopStart'; count: number }
  | { kind: 'loopEnd' }
  | { kind: 'jump'; targetSeg: number }
  | { kind: 'stop48k' }
  | { kind: 'stop' };

export interface ParsedTapeImage {
  blocks: TapeBlock[];
  segments: TapeSegment[];
  blockToSegmentIdx: number[];
  fastLoadable: boolean;
  formatLabel: string;
}

function readU16LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readI16LE(b: Uint8Array, o: number): number {
  const v = b[o] | (b[o + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function readU24LE(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
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

function isStandardRomTiming(
  pilotT: number,
  sync1: number,
  sync2: number,
  zeroT: number,
  oneT: number,
  pilotCount: number,
  usedBits: number
): boolean {
  return (
    usedBits === 8 &&
    pilotCount >= 800 &&
    pilotT >= 1700 &&
    pilotT <= 2600 &&
    sync1 >= 400 &&
    sync1 <= 1000 &&
    sync2 >= 400 &&
    sync2 <= 1050 &&
    zeroT >= 650 &&
    zeroT <= 1100 &&
    oneT >= 1350 &&
    oneT <= 2100
  );
}

function appendStandardBlockSegments(segments: TapeSegment[], blk: TapeBlock, idx: number, pauseMs = 1500): void {
  const pilotCount = blk.flag < 0x80 ? (idx === 0 ? 4500 : 3600) : 3223;
  segments.push({ kind: 'tone', pulseT: 2168, count: pilotCount });
  segments.push({ kind: 'pulses', pulses: new Uint32Array([667, 735]) });
  segments.push({
    kind: 'data',
    data: blk.raw,
    zeroT: 855,
    oneT: 1710,
    pulsesPerBit: 2,
    usedBitsLastByte: 8,
    pauseT: pauseMs * MS_TO_T,
  });
}

export function tapBlocksToTapeImage(blocks: TapeBlock[], formatLabel = 'TAP'): ParsedTapeImage {
  const segments: TapeSegment[] = [];
  const blockToSegmentIdx: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    blockToSegmentIdx.push(segments.length);
    appendStandardBlockSegments(segments, blocks[i], i, i + 1 >= blocks.length ? 20 : 1500);
  }
  return {
    blocks,
    segments,
    blockToSegmentIdx,
    fastLoadable: blocks.length > 0,
    formatLabel,
  };
}

export function parseBlkOrTap(bytes: Uint8Array): ParsedTapeImage {
  const blocks = parseTap(bytes);
  if (blocks.length > 0) {
    return tapBlocksToTapeImage(blocks, 'TAP');
  }
  // Single raw block fallback (some .BLK dumps omit 2-byte length prefix)
  if (bytes.length >= 2) {
    const flag = bytes[0];
    const raw = new Uint8Array(bytes);
    const data = bytes.length >= 2 ? bytes.subarray(1, bytes.length - 1) : new Uint8Array(0);
    return tapBlocksToTapeImage([{ flag, data: new Uint8Array(data), raw }], 'BLK');
  }
  throw new Error('Файл ленты пуст или повреждён');
}

function decodeCswRleToPulses(raw: Uint8Array, sampleRate: number, compressionType: number): Uint32Array {
  const payload = compressionType === 2 ? unzlibSync(raw) : raw;
  const pulses: number[] = [];
  const scale = TSTATES_PER_SEC / Math.max(1000, sampleRate);
  let i = 0;
  while (i < payload.length) {
    let count = payload[i++];
    if (count === 0) {
      if (i + 4 > payload.length) break;
      count = readU32LE(payload, i);
      i += 4;
    }
    const t = Math.max(1, Math.round(count * scale));
    pulses.push(t);
  }
  return new Uint32Array(pulses);
}

export function parseTzx(bytes: Uint8Array, label = 'TZX'): ParsedTapeImage {
  if (bytes.length < 10 || asciiAt(bytes, 0, 7) !== 'ZXTape!' || bytes[7] !== 0x1a) {
    throw new Error(`Некорректный заголовок .${label} (ожидается ZXTape!)`);
  }

  const segments: TapeSegment[] = [];
  const blocks: TapeBlock[] = [];
  const blockToSegmentIdx: number[] = [];
  const blockIdToSegmentIdx: number[] = [];
  const pendingJumps: Array<{ segIdx: number; targetBlockId: number }> = [];

  let offset = 10;
  let blockIdx = 0;
  let fastChainBroken = false;

  while (offset < bytes.length) {
    const id = bytes[offset++];
    const startSegIdx = segments.length;
    blockIdToSegmentIdx[blockIdx] = startSegIdx;

    switch (id) {
      case 0x10: {
        // Standard Speed Data Block
        if (offset + 4 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const pauseMs = readU16LE(bytes, offset);
        const len = readU16LE(bytes, offset + 2);
        offset += 4;
        const payload = bytes.subarray(offset, Math.min(bytes.length, offset + len));
        offset += len;

        const raw = new Uint8Array(payload);
        const flag = raw.length > 0 ? raw[0] : 0;
        const data = raw.length >= 2 ? new Uint8Array(raw.subarray(1, raw.length - 1)) : new Uint8Array(0);
        const pilotCount = flag < 0x80 ? (blockIdx === 0 ? 4500 : 3600) : 3223;

        segments.push({ kind: 'tone', pulseT: 2168, count: pilotCount });
        segments.push({ kind: 'pulses', pulses: new Uint32Array([667, 735]) });
        segments.push({
          kind: 'data',
          data: raw,
          zeroT: 855,
          oneT: 1710,
          pulsesPerBit: 2,
          usedBitsLastByte: 8,
          pauseT: pauseMs * MS_TO_T,
        });

        if (!fastChainBroken && raw.length >= 2) {
          blockToSegmentIdx.push(startSegIdx);
          blocks.push({ flag, data, raw });
        }
        break;
      }

      case 0x11: {
        // Turbo Speed Data Block
        if (offset + 18 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const pilotT = readU16LE(bytes, offset);
        const sync1 = readU16LE(bytes, offset + 2);
        const sync2 = readU16LE(bytes, offset + 4);
        const zeroT = readU16LE(bytes, offset + 6);
        const oneT = readU16LE(bytes, offset + 8);
        const pilotCount = readU16LE(bytes, offset + 10);
        const usedBits = Math.max(1, Math.min(8, bytes[offset + 12] || 8));
        const pauseMs = readU16LE(bytes, offset + 13);
        const len = readU24LE(bytes, offset + 15);
        offset += 18;
        const raw = new Uint8Array(bytes.subarray(offset, Math.min(bytes.length, offset + len)));
        offset += len;

        if (pilotCount > 0 && pilotT > 0) {
          segments.push({ kind: 'tone', pulseT: pilotT, count: pilotCount });
        }
        if (sync1 > 0 || sync2 > 0) {
          const syncArr: number[] = [];
          if (sync1 > 0) syncArr.push(sync1);
          if (sync2 > 0) syncArr.push(sync2);
          segments.push({ kind: 'pulses', pulses: new Uint32Array(syncArr) });
        }
        segments.push({
          kind: 'data',
          data: raw,
          zeroT: Math.max(1, zeroT),
          oneT: Math.max(1, oneT),
          pulsesPerBit: 2,
          usedBitsLastByte: usedBits,
          pauseT: pauseMs * MS_TO_T,
        });

        if (
          !fastChainBroken &&
          raw.length >= 2 &&
          isStandardRomTiming(pilotT, sync1, sync2, zeroT, oneT, pilotCount, usedBits)
        ) {
          blockToSegmentIdx.push(startSegIdx);
          blocks.push({
            flag: raw[0],
            data: new Uint8Array(raw.subarray(1, raw.length - 1)),
            raw,
          });
        } else {
          fastChainBroken = true;
        }
        break;
      }

      case 0x12: {
        // Pure Tone
        if (offset + 4 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const pulseT = readU16LE(bytes, offset);
        const count = readU16LE(bytes, offset + 2);
        offset += 4;
        if (pulseT > 0 && count > 0) {
          segments.push({ kind: 'tone', pulseT, count });
        }
        fastChainBroken = true;
        break;
      }

      case 0x13: {
        // Pulse Sequence
        if (offset >= bytes.length) break;
        const count = bytes[offset++];
        if (offset + count * 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const pulses = new Uint32Array(count);
        for (let i = 0; i < count; i++) {
          pulses[i] = Math.max(1, readU16LE(bytes, offset + i * 2));
        }
        offset += count * 2;
        if (count > 0) {
          segments.push({ kind: 'pulses', pulses });
        }
        fastChainBroken = true;
        break;
      }

      case 0x14: {
        // Pure Data Block
        if (offset + 10 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const zeroT = Math.max(1, readU16LE(bytes, offset));
        const oneT = Math.max(1, readU16LE(bytes, offset + 2));
        const usedBits = Math.max(1, Math.min(8, bytes[offset + 4] || 8));
        const pauseMs = readU16LE(bytes, offset + 5);
        const len = readU24LE(bytes, offset + 7);
        offset += 10;
        const data = new Uint8Array(bytes.subarray(offset, Math.min(bytes.length, offset + len)));
        offset += len;
        segments.push({
          kind: 'data',
          data,
          zeroT,
          oneT,
          pulsesPerBit: 2,
          usedBitsLastByte: usedBits,
          pauseT: pauseMs * MS_TO_T,
        });
        fastChainBroken = true;
        break;
      }

      case 0x15: {
        // Direct Recording
        if (offset + 8 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const tPerSample = Math.max(1, readU16LE(bytes, offset));
        const pauseMs = readU16LE(bytes, offset + 2);
        const usedBits = Math.max(1, Math.min(8, bytes[offset + 4] || 8));
        const len = readU24LE(bytes, offset + 5);
        offset += 8;
        const data = bytes.subarray(offset, Math.min(bytes.length, offset + len));
        offset += len;

        const pulses: number[] = [];
        let curBit = -1;
        let run = 0;
        for (let bi = 0; bi < data.length; bi++) {
          const byteVal = data[bi];
          const bits = bi === data.length - 1 ? usedBits : 8;
          for (let b = 0; b < bits; b++) {
            const bit = (byteVal >> (7 - b)) & 1;
            if (curBit === -1) {
              curBit = bit;
              segments.push({ kind: 'setLevel', level: bit ? 1 : 0 });
              run = 1;
            } else if (bit === curBit) {
              run++;
            } else {
              pulses.push(run * tPerSample);
              curBit = bit;
              run = 1;
            }
          }
        }
        if (run > 0) {
          pulses.push(run * tPerSample);
        }
        if (pulses.length > 0) {
          segments.push({ kind: 'pulses', pulses: new Uint32Array(pulses) });
        }
        if (pauseMs > 0) {
          segments.push({ kind: 'pause', pauseT: pauseMs * MS_TO_T, level: 0 });
        }
        fastChainBroken = true;
        break;
      }

      case 0x18: {
        // CSW Recording
        if (offset + 4 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const blockLen = readU32LE(bytes, offset);
        const pauseMs = readU16LE(bytes, offset + 4);
        const sampleRate = readU24LE(bytes, offset + 6);
        const compType = bytes[offset + 9];
        const payloadStart = offset + 14;
        const payloadEnd = Math.min(bytes.length, offset + 4 + blockLen);
        offset = payloadEnd;
        if (payloadEnd > payloadStart) {
          const pulses = decodeCswRleToPulses(
            bytes.subarray(payloadStart, payloadEnd),
            sampleRate,
            compType
          );
          if (pulses.length > 0) {
            segments.push({ kind: 'pulses', pulses });
          }
        }
        if (pauseMs > 0) {
          segments.push({ kind: 'pause', pauseT: pauseMs * MS_TO_T, level: 0 });
        }
        fastChainBroken = true;
        break;
      }

      case 0x19: {
        // Generalized Data Block
        if (offset + 4 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const blockLen = readU32LE(bytes, offset);
        const endOff = Math.min(bytes.length, offset + 4 + blockLen);
        if (offset + 18 <= endOff) {
          const pauseMs = readU16LE(bytes, offset + 4);
          const totp = readU32LE(bytes, offset + 6);
          const npp = bytes[offset + 10];
          const asp = bytes[offset + 11] || 256;
          const totd = readU32LE(bytes, offset + 12);
          const npd = bytes[offset + 16];
          const asd = bytes[offset + 17] || 256;
          let p = offset + 18;

          const parseSymTable = (asCount: number, maxPulses: number) => {
            const table: Array<{ flags: number; pulses: number[] }> = [];
            for (let s = 0; s < asCount && p < endOff; s++) {
              const flags = bytes[p++];
              const ps: number[] = [];
              for (let k = 0; k < maxPulses && p + 2 <= endOff; k++) {
                const dur = readU16LE(bytes, p);
                p += 2;
                if (dur > 0) ps.push(dur);
              }
              table.push({ flags, pulses: ps });
            }
            return table;
          };

          const pilotSyms = totp > 0 ? parseSymTable(asp, npp) : [];
          for (let i = 0; i < totp && p + 3 <= endOff; i++) {
            const sym = bytes[p++];
            const rep = readU16LE(bytes, p);
            p += 2;
            const entry = pilotSyms[sym];
            if (entry && entry.pulses.length === 1 && rep > 1) {
              segments.push({ kind: 'tone', pulseT: entry.pulses[0], count: rep });
            } else if (entry && entry.pulses.length > 0 && rep > 0) {
              const expanded = new Uint32Array(entry.pulses.length * rep);
              for (let r = 0; r < rep; r++) {
                expanded.set(entry.pulses, r * entry.pulses.length);
              }
              segments.push({ kind: 'pulses', pulses: expanded });
            }
          }

          if (totd > 0) {
            const dataSyms = parseSymTable(asd, npd);
            const bitsPerSym = Math.max(1, Math.ceil(Math.log2(Math.max(2, asd))));
            const pulses: number[] = [];
            let bitPos = 0;
            for (let s = 0; s < totd && p < endOff; s++) {
              let symIdx = 0;
              for (let b = 0; b < bitsPerSym; b++) {
                const byteIdx = p + (bitPos >> 3);
                if (byteIdx >= endOff) break;
                const bit = (bytes[byteIdx] >> (7 - (bitPos & 7))) & 1;
                symIdx = (symIdx << 1) | bit;
                bitPos++;
              }
              const entry = dataSyms[symIdx];
              if (entry) {
                for (let k = 0; k < entry.pulses.length; k++) {
                  pulses.push(entry.pulses[k]);
                }
              }
            }
            if (pulses.length > 0) {
              segments.push({ kind: 'pulses', pulses: new Uint32Array(pulses) });
            }
          }
          if (pauseMs > 0) {
            segments.push({ kind: 'pause', pauseT: pauseMs * MS_TO_T, level: 0 });
          }
        }
        offset = endOff;
        fastChainBroken = true;
        break;
      }

      case 0x20: {
        // Pause (Silence) or Stop the Tape
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const pauseMs = readU16LE(bytes, offset);
        offset += 2;
        if (pauseMs === 0) {
          segments.push({ kind: 'stop' });
        } else {
          segments.push({ kind: 'pause', pauseT: pauseMs * MS_TO_T, level: 0 });
        }
        break;
      }

      case 0x21: {
        // Group Start
        const len = offset < bytes.length ? bytes[offset++] : 0;
        offset += len;
        break;
      }

      case 0x22:
        // Group End
        break;

      case 0x23: {
        // Jump to Block
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const rel = readI16LE(bytes, offset);
        offset += 2;
        const segIdx = segments.length;
        segments.push({ kind: 'jump', targetSeg: segIdx + 1 });
        pendingJumps.push({ segIdx, targetBlockId: blockIdx + rel });
        fastChainBroken = true;
        break;
      }

      case 0x24: {
        // Loop Start
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const count = readU16LE(bytes, offset);
        offset += 2;
        segments.push({ kind: 'loopStart', count });
        fastChainBroken = true;
        break;
      }

      case 0x25:
        segments.push({ kind: 'loopEnd' });
        fastChainBroken = true;
        break;

      case 0x26: {
        // Call Sequence
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const n = readU16LE(bytes, offset);
        offset += 2 + n * 2;
        break;
      }

      case 0x27:
        break;

      case 0x28: {
        // Select Block
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const len = readU16LE(bytes, offset);
        offset += 2 + len;
        break;
      }

      case 0x2a: {
        // Stop tape if in 48K mode
        offset += 4;
        segments.push({ kind: 'stop48k' });
        break;
      }

      case 0x2b: {
        // Set signal level
        if (offset + 5 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const len = readU32LE(bytes, offset);
        const level = (bytes[offset + 4] & 1) as 0 | 1;
        offset += 4 + len;
        segments.push({ kind: 'setLevel', level });
        break;
      }

      case 0x30: {
        const len = offset < bytes.length ? bytes[offset++] : 0;
        offset += len;
        break;
      }

      case 0x31: {
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const len = bytes[offset + 1];
        offset += 2 + len;
        break;
      }

      case 0x32: {
        if (offset + 2 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const len = readU16LE(bytes, offset);
        offset += 2 + len;
        break;
      }

      case 0x33: {
        const n = offset < bytes.length ? bytes[offset++] : 0;
        offset += n * 3;
        break;
      }

      case 0x34:
        offset += 8;
        break;

      case 0x35: {
        if (offset + 20 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const len = readU32LE(bytes, offset + 16);
        offset += 20 + len;
        break;
      }

      case 0x40: {
        if (offset + 4 > bytes.length) {
          offset = bytes.length;
          break;
        }
        const len = readU24LE(bytes, offset + 1);
        offset += 4 + len;
        break;
      }

      case 0x5a:
        // Glue block (9 bytes)
        offset += 9;
        break;

      default: {
        // Unknown block with standard 4-byte length prefix
        if (offset + 4 <= bytes.length) {
          const len = readU32LE(bytes, offset);
          offset += 4 + len;
        } else {
          offset = bytes.length;
        }
        break;
      }
    }

    blockIdx++;
  }

  for (const j of pendingJumps) {
    const seg = segments[j.segIdx];
    if (seg && seg.kind === 'jump') {
      const resolved = blockIdToSegmentIdx[j.targetBlockId];
      seg.targetSeg = resolved !== undefined ? resolved : segments.length;
    }
  }

  if (segments.length === 0) {
    throw new Error(`В файле .${label} не найдено аудио-блоков`);
  }

  return {
    blocks,
    segments,
    blockToSegmentIdx,
    fastLoadable: blocks.length > 0 && !fastChainBroken,
    formatLabel: label,
  };
}

export function parsePzx(bytes: Uint8Array): ParsedTapeImage {
  if (bytes.length < 8 || asciiAt(bytes, 0, 4) !== 'PZXT') {
    throw new Error('Некорректный заголовок .PZX (ожидается PZXT)');
  }

  const segments: TapeSegment[] = [];
  const blocks: TapeBlock[] = [];
  const blockToSegmentIdx: number[] = [];

  let offset = 0;
  let lastPulsesWereStandardPilot = false;
  let fastChainBroken = false;

  while (offset + 8 <= bytes.length) {
    const tag = asciiAt(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    offset += 8;
    const end = Math.min(bytes.length, offset + size);

    if (tag === 'PULS') {
      const startIdx = segments.length;
      let p = offset;
      const pulseList: number[] = [];
      let totalPulses = 0;
      let lastDur = 0;
      while (p + 2 <= end) {
        let val = readU16LE(bytes, p);
        p += 2;
        let count = 1;
        if (val > 0x8000) {
          count = val & 0x7fff;
          if (p + 2 > end) break;
          val = readU16LE(bytes, p);
          p += 2;
        }
        let dur = val;
        if (dur >= 0x8000) {
          if (p + 2 > end) break;
          dur = ((dur & 0x7fff) << 16) | readU16LE(bytes, p);
          p += 2;
        }
        if (dur === 0) {
          if (pulseList.length > 0) {
            segments.push({ kind: 'pulses', pulses: new Uint32Array(pulseList) });
            pulseList.length = 0;
          }
          segments.push({ kind: 'setLevel', level: 0 });
        } else if (count > 8) {
          if (pulseList.length > 0) {
            segments.push({ kind: 'pulses', pulses: new Uint32Array(pulseList) });
            pulseList.length = 0;
          }
          segments.push({ kind: 'tone', pulseT: dur, count });
          totalPulses += count;
          lastDur = dur;
        } else {
          for (let c = 0; c < count; c++) pulseList.push(dur);
          totalPulses += count;
          lastDur = dur;
        }
      }
      if (pulseList.length > 0) {
        segments.push({ kind: 'pulses', pulses: new Uint32Array(pulseList) });
      }
      lastPulsesWereStandardPilot = totalPulses >= 800 && lastDur >= 500 && lastDur <= 1000 && segments.length > startIdx;
    } else if (tag === 'DATA') {
      if (offset + 8 <= end) {
        const startIdx = segments.length;
        const countField = readU32LE(bytes, offset);
        const totalBits = countField & 0x7fffffff;
        const initLevel = ((countField >>> 31) & 1) as 0 | 1;
        const tail = readU16LE(bytes, offset + 4);
        const p0 = bytes[offset + 6];
        const p1 = bytes[offset + 7];
        let p = offset + 8;

        const s0: number[] = [];
        for (let i = 0; i < p0 && p + 2 <= end; i++, p += 2) s0.push(readU16LE(bytes, p));
        const s1: number[] = [];
        for (let i = 0; i < p1 && p + 2 <= end; i++, p += 2) s1.push(readU16LE(bytes, p));

        const dataBytes = new Uint8Array(bytes.subarray(p, end));
        segments.push({ kind: 'setLevel', level: initLevel });

        const stdTwoPulse =
          p0 === 2 && p1 === 2 && s0[0] === s0[1] && s1[0] === s1[1] && totalBits % 8 === 0;
        if (stdTwoPulse) {
          const zeroT = Math.max(1, s0[0]);
          const oneT = Math.max(1, s1[0]);
          segments.push({
            kind: 'data',
            data: dataBytes,
            zeroT,
            oneT,
            pulsesPerBit: 2,
            usedBitsLastByte: 8,
            pauseT: tail,
          });
          if (
            !fastChainBroken &&
            lastPulsesWereStandardPilot &&
            dataBytes.length >= 2 &&
            zeroT >= 650 &&
            zeroT <= 1100 &&
            oneT >= 1350 &&
            oneT <= 2100
          ) {
            blockToSegmentIdx.push(Math.max(0, startIdx - 1));
            blocks.push({
              flag: dataBytes[0],
              data: new Uint8Array(dataBytes.subarray(1, dataBytes.length - 1)),
              raw: dataBytes,
            });
          } else {
            fastChainBroken = true;
          }
        } else {
          const pulses: number[] = [];
          for (let bitIdx = 0; bitIdx < totalBits; bitIdx++) {
            const byteIdx = bitIdx >> 3;
            if (byteIdx >= dataBytes.length) break;
            const bit = (dataBytes[byteIdx] >> (7 - (bitIdx & 7))) & 1;
            const seq = bit ? s1 : s0;
            for (let k = 0; k < seq.length; k++) {
              if (seq[k] > 0) pulses.push(seq[k]);
            }
          }
          if (tail > 0) pulses.push(tail);
          if (pulses.length > 0) {
            segments.push({ kind: 'pulses', pulses: new Uint32Array(pulses) });
          }
          fastChainBroken = true;
        }
        lastPulsesWereStandardPilot = false;
      }
    } else if (tag === 'PAUS') {
      if (offset + 4 <= end) {
        const val = readU32LE(bytes, offset);
        const dur = val & 0x7fffffff;
        const lvl = ((val >>> 31) & 1) as 0 | 1;
        if (dur > 0) {
          segments.push({ kind: 'pause', pauseT: dur, level: lvl });
        } else {
          segments.push({ kind: 'setLevel', level: lvl });
        }
      }
    } else if (tag === 'STOP') {
      const flags = offset + 2 <= end ? readU16LE(bytes, offset) : 0;
      segments.push((flags & 1) !== 0 ? { kind: 'stop48k' } : { kind: 'stop' });
      fastChainBroken = true;
    }

    offset = end;
  }

  if (segments.length === 0) {
    throw new Error('В файле .PZX не найдено аудио-блоков');
  }

  return {
    blocks,
    segments,
    blockToSegmentIdx,
    fastLoadable: blocks.length > 0 && !fastChainBroken,
    formatLabel: 'PZX',
  };
}

export function parseCsw(bytes: Uint8Array): ParsedTapeImage {
  if (bytes.length < 32 || asciiAt(bytes, 0, 22) !== 'Compressed Square Wave' || bytes[22] !== 0x1a) {
    throw new Error('Некорректный заголовок .CSW');
  }
  const major = bytes[23];
  let sampleRate = 44100;
  let compType = 1;
  let flags = 0;
  let dataOffset = 32;

  if (major === 1) {
    sampleRate = readU16LE(bytes, 25);
    compType = bytes[27];
    flags = bytes[28];
    dataOffset = 32;
  } else {
    if (bytes.length < 52) {
      throw new Error('Повреждён заголовок .CSW v2');
    }
    sampleRate = readU32LE(bytes, 25);
    compType = bytes[33];
    flags = bytes[34];
    const hdrExt = bytes[35];
    dataOffset = 52 + hdrExt;
  }

  const pulses = decodeCswRleToPulses(bytes.subarray(dataOffset), sampleRate, compType);
  if (pulses.length === 0) {
    throw new Error('В файле .CSW нет импульсов');
  }

  const segments: TapeSegment[] = [
    { kind: 'setLevel', level: (flags & 1) !== 0 ? 1 : 0 },
    { kind: 'pulses', pulses },
  ];

  return {
    blocks: [],
    segments,
    blockToSegmentIdx: [],
    fastLoadable: false,
    formatLabel: 'CSW',
  };
}

function pcmSamplesToPulses(
  readSample: (index: number) => number,
  sampleCount: number,
  sampleRate: number
): Uint32Array {
  if (sampleCount <= 0 || sampleRate <= 0) return new Uint32Array(0);

  // Measure adaptive baseline & hysteresis threshold
  let minVal = 1;
  let maxVal = -1;
  const stride = Math.max(1, Math.floor(sampleCount / 4096));
  for (let i = 0; i < sampleCount; i += stride) {
    const v = readSample(i);
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const mid = (minVal + maxVal) * 0.5;
  const hyst = Math.max(0.02, (maxVal - minVal) * 0.06);
  const hiThresh = mid + hyst;
  const loThresh = mid - hyst;

  const scale = TSTATES_PER_SEC / sampleRate;
  const pulses: number[] = [];
  let state = readSample(0) >= mid ? 1 : 0;
  let lastEdge = 0;

  for (let i = 1; i < sampleCount; i++) {
    const s = readSample(i);
    if (state === 0 && s >= hiThresh) {
      const dt = Math.max(1, Math.round((i - lastEdge) * scale));
      pulses.push(dt);
      lastEdge = i;
      state = 1;
    } else if (state === 1 && s <= loThresh) {
      const dt = Math.max(1, Math.round((i - lastEdge) * scale));
      pulses.push(dt);
      lastEdge = i;
      state = 0;
    }
  }
  if (sampleCount - lastEdge > 0) {
    pulses.push(Math.max(1, Math.round((sampleCount - lastEdge) * scale)));
  }
  return new Uint32Array(pulses);
}

export function parseWav(bytes: Uint8Array): ParsedTapeImage {
  if (bytes.length < 44 || asciiAt(bytes, 0, 4) !== 'RIFF' || asciiAt(bytes, 8, 4) !== 'WAVE') {
    throw new Error('Некорректный заголовок .WAV');
  }

  let offset = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bitsPerSample = 8;
  let audioFormat = 1;
  let dataStart = -1;
  let dataLen = 0;

  while (offset + 8 <= bytes.length) {
    const id = asciiAt(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    offset += 8;
    if (id === 'fmt ') {
      if (offset + 16 <= bytes.length) {
        audioFormat = readU16LE(bytes, offset);
        channels = Math.max(1, readU16LE(bytes, offset + 2));
        sampleRate = readU32LE(bytes, offset + 4);
        bitsPerSample = readU16LE(bytes, offset + 14);
      }
    } else if (id === 'data') {
      dataStart = offset;
      dataLen = Math.min(size, bytes.length - offset);
      break;
    }
    offset += size + (size & 1);
  }

  if (dataStart < 0 || dataLen <= 0) {
    throw new Error('В файле .WAV не найден аудиопоток data');
  }
  if (audioFormat !== 1 && audioFormat !== 3) {
    throw new Error(`Неподдерживаемый кодек .WAV (format=${audioFormat}, требуется PCM)`);
  }

  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frameSize = bytesPerSample * channels;
  const sampleCount = Math.floor(dataLen / frameSize);
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, dataLen);

  const pulses = pcmSamplesToPulses(
    (idx) => {
      const off = idx * frameSize;
      if (audioFormat === 3 && bitsPerSample === 32) {
        return view.getFloat32(off, true);
      }
      if (bitsPerSample === 8) {
        return (bytes[dataStart + off] - 128) / 128;
      }
      if (bitsPerSample === 16) {
        return view.getInt16(off, true) / 32768;
      }
      if (bitsPerSample === 24) {
        const b0 = bytes[dataStart + off];
        const b1 = bytes[dataStart + off + 1];
        const b2 = bytes[dataStart + off + 2];
        const signed = (b2 & 0x80 ? -0x1000000 : 0) | (b2 << 16) | (b1 << 8) | b0;
        return signed / 8388608;
      }
      return view.getInt32(off, true) / 2147483648;
    },
    sampleCount,
    sampleRate
  );

  if (pulses.length === 0) {
    throw new Error('В файле .WAV не обнаружено аудиосигнала');
  }

  return {
    blocks: [],
    segments: [{ kind: 'pulses', pulses }],
    blockToSegmentIdx: [],
    fastLoadable: false,
    formatLabel: 'WAV',
  };
}

export function parseVoc(bytes: Uint8Array): ParsedTapeImage {
  if (bytes.length < 26 || asciiAt(bytes, 0, 19) !== 'Creative Voice File' || bytes[19] !== 0x1a) {
    throw new Error('Некорректный заголовок .VOC');
  }

  let offset = readU16LE(bytes, 20);
  const segments: TapeSegment[] = [];
  let currentRate = 22050;
  let currentBits = 8;
  let currentChannels = 1;

  while (offset < bytes.length) {
    const type = bytes[offset++];
    if (type === 0) break;
    if (offset + 3 > bytes.length) break;
    const len = readU24LE(bytes, offset);
    offset += 3;
    const end = Math.min(bytes.length, offset + len);

    if (type === 1 && offset + 2 <= end) {
      const srByte = bytes[offset];
      currentRate = Math.round(1_000_000 / Math.max(1, 256 - srByte));
      const dataStart = offset + 2;
      const count = end - dataStart;
      const pulses = pcmSamplesToPulses((i) => (bytes[dataStart + i] - 128) / 128, count, currentRate);
      if (pulses.length > 0) segments.push({ kind: 'pulses', pulses });
    } else if (type === 2 && end > offset) {
      const dataStart = offset;
      const count = Math.floor((end - dataStart) / ((currentBits >> 3) * currentChannels));
      const pulses = pcmSamplesToPulses(
        (i) =>
          currentBits === 16
            ? readI16LE(bytes, dataStart + i * 2 * currentChannels) / 32768
            : (bytes[dataStart + i * currentChannels] - 128) / 128,
        count,
        currentRate
      );
      if (pulses.length > 0) segments.push({ kind: 'pulses', pulses });
    } else if (type === 3 && offset + 3 <= end) {
      const silenceSamples = readU16LE(bytes, offset) + 1;
      const srByte = bytes[offset + 2];
      const sr = Math.round(1_000_000 / Math.max(1, 256 - srByte));
      segments.push({
        kind: 'pause',
        pauseT: Math.round((silenceSamples * TSTATES_PER_SEC) / sr),
        level: 0,
      });
    } else if (type === 8 && offset + 4 <= end) {
      const tc = readU16LE(bytes, offset);
      currentChannels = bytes[offset + 3] ? 2 : 1;
      currentRate = Math.round(256_000_000 / (currentChannels * (65536 - tc)));
      currentBits = 8;
    } else if (type === 9 && offset + 12 <= end) {
      currentRate = readU32LE(bytes, offset);
      currentBits = bytes[offset + 4] || 8;
      currentChannels = Math.max(1, bytes[offset + 5]);
      const dataStart = offset + 12;
      const step = (currentBits >> 3) * currentChannels;
      const count = Math.floor((end - dataStart) / Math.max(1, step));
      const pulses = pcmSamplesToPulses(
        (i) =>
          currentBits === 16
            ? readI16LE(bytes, dataStart + i * step) / 32768
            : (bytes[dataStart + i * step] - 128) / 128,
        count,
        currentRate
      );
      if (pulses.length > 0) segments.push({ kind: 'pulses', pulses });
    }

    offset = end;
  }

  if (segments.length === 0) {
    throw new Error('В файле .VOC не найдено аудиоданных');
  }

  return {
    blocks: [],
    segments,
    blockToSegmentIdx: [],
    fastLoadable: false,
    formatLabel: 'VOC',
  };
}

export function parseTapeImage(ext: string, bytes: Uint8Array): ParsedTapeImage {
  switch (ext) {
    case 'tap':
    case 'blk':
      return parseBlkOrTap(bytes);
    case 'tzx':
      return parseTzx(bytes, 'TZX');
    case 'cdt':
      return parseTzx(bytes, 'CDT');
    case 'pzx':
      return parsePzx(bytes);
    case 'csw':
      return parseCsw(bytes);
    case 'wav':
      return parseWav(bytes);
    case 'voc':
      return parseVoc(bytes);
    default:
      throw new Error(`Неподдерживаемый формат ленты: .${ext}`);
  }
}

export interface TapeExportFile {
  name: string;
  type: 0 | 1 | 2 | 3; // 0=Program, 1=NumArray, 2=CharArray, 3=Code
  param1: number;      // autostart line (BASIC) or start addr (CODE)
  param2: number;      // prog length (BASIC) or 0x8000 (CODE)
  payload: Uint8Array;
}

export function buildTapFromFiles(files: TapeExportFile[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const f of files) {
    chunks.push(buildTapHeader(f.type, f.name, f.payload.length, f.param1, f.param2));
    chunks.push(buildTapBlock(0xff, f.payload));
  }
  return concatUint8Arrays(chunks);
}

/**
 * Wraps raw machine-code bytes into a tiny self-booting BASIC + CODE .TAP image.
 */
export function wrapCodeBytesAsTap(name: string, code: Uint8Array, loadAddr = 0x8000): Uint8Array {
  const clearAddr = Math.max(0x5fff, loadAddr - 1);
  const strNum = (n: number): number[] => {
    const s = String(n);
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    out.push(0x0e, 0x00, 0x00, n & 0xff, (n >> 8) & 0xff, 0x00);
    return out;
  };
  const lineBody: number[] = [
    0xfd, ...strNum(clearAddr), 0x3a, // CLEAR addr :
    0xef, 0x22, 0x22, 0xaf, ...strNum(loadAddr), 0x3a, // LOAD "" CODE addr :
    0xf9, 0xc0, ...strNum(loadAddr), 0x0d, // RANDOMIZE USR addr
  ];
  const basic = new Uint8Array(4 + lineBody.length);
  basic[0] = 0x00;
  basic[1] = 10;
  basic[2] = lineBody.length & 0xff;
  basic[3] = (lineBody.length >> 8) & 0xff;
  basic.set(lineBody, 4);

  return buildTapFromFiles([
    { name: 'boot', type: 0, param1: 10, param2: basic.length, payload: basic },
    { name: name.slice(0, 10) || 'code', type: 3, param1: loadAddr, param2: 0x8000, payload: code },
  ]);
}
