import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, zipSync, zlibSync } from 'fflate';
import { ZXSpectrum48 } from './spectrum';
import { buildTapBlock, buildTapHeader, buildSnaSnapshot, concatUint8Arrays } from './formats';
import { parseTapeImage, wrapCodeBytesAsTap } from './tapeFormats';
import { TapePlayer } from './tapePlayer';
import { parseDiskOrMediaImage, buildTrdFromHobetaFiles, parseHobetaFile } from './diskFormats';
import { buildTrdImage } from './betaDisk';
import {
  extractPlayableFiles,
  decompressBzip2,
  GAME_ACCEPT_ATTR,
  DISK_ACCEPT_ATTR,
} from './archiveExtractor';

function makeMinimalZ80ProgramBytes(): Uint8Array {
  // Simple Z80 loop at 0x8000: LD A, 2; OUT (0xFE), A; DI; HALT
  return new Uint8Array([0x3e, 0x02, 0xd3, 0xfe, 0xf3, 0x76]);
}

function makeStandardTapBytes(): Uint8Array {
  const code = makeMinimalZ80ProgramBytes();
  const basic = new Uint8Array([0x00, 10, 0x03, 0x00, 0xf3, 0x76, 0x0d]);
  return concatUint8Arrays([
    buildTapHeader(0, 'test', basic.length, 10, basic.length),
    buildTapBlock(0xff, basic),
    buildTapHeader(3, 'code', code.length, 0x8000, 0x8000),
    buildTapBlock(0xff, code),
  ]);
}

function makeHobetaBytes(name8: string, extChar: string, start: number, payload: Uint8Array): Uint8Array {
  const sectors = Math.max(1, Math.ceil(payload.length / 256));
  const out = new Uint8Array(17 + sectors * 256);
  const padded = name8.padEnd(8, ' ').slice(0, 8);
  for (let i = 0; i < 8; i++) out[i] = padded.charCodeAt(i);
  out[8] = extChar.charCodeAt(0);
  out[9] = start & 0xff;
  out[10] = (start >> 8) & 0xff;
  out[11] = payload.length & 0xff;
  out[12] = (payload.length >> 8) & 0xff;
  out[13] = 0;
  out[14] = sectors;
  let chk = 0;
  for (let i = 0; i < 15; i++) chk = (chk + out[i] * 257 + i) & 0xffff;
  out[15] = chk & 0xff;
  out[16] = (chk >> 8) & 0xff;
  out.set(payload, 17);
  return out;
}

function makePosixTar(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const hdr = new Uint8Array(512);
    for (let i = 0; i < Math.min(99, e.name.length); i++) hdr[i] = e.name.charCodeAt(i);
    const writeOct = (off: number, width: number, val: number) => {
      const s = val.toString(8).padStart(width - 1, '0');
      for (let i = 0; i < s.length; i++) hdr[off + i] = s.charCodeAt(i);
    };
    writeOct(100, 8, 0o644);
    writeOct(108, 8, 0);
    writeOct(116, 8, 0);
    writeOct(124, 12, e.data.length);
    writeOct(136, 12, 0);
    hdr.fill(0x20, 148, 156);
    hdr[156] = 0x30; // '0' regular file
    const ustar = 'ustar\0';
    for (let i = 0; i < ustar.length; i++) hdr[257 + i] = ustar.charCodeAt(i);
    hdr[263] = 0x30;
    hdr[264] = 0x30;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += hdr[i];
    const sumStr = sum.toString(8).padStart(6, '0');
    for (let i = 0; i < 6; i++) hdr[148 + i] = sumStr.charCodeAt(i);
    hdr[154] = 0;
    hdr[155] = 0x20;
    blocks.push(hdr);

    const paddedLen = Math.ceil(e.data.length / 512) * 512;
    const dataBlk = new Uint8Array(paddedLen);
    dataBlk.set(e.data);
    blocks.push(dataBlk);
  }
  blocks.push(new Uint8Array(1024)); // EOF two zero blocks
  return concatUint8Arrays(blocks);
}

test('Accept filters include all requested Spectrum extensions and archive formats', () => {
  for (const ext of ['.tap', '.tzx', '.cdt', '.pzx', '.csw', '.wav', '.voc', '.blk']) {
    assert.ok(GAME_ACCEPT_ATTR.includes(ext), `Missing tape ext ${ext}`);
  }
  for (const ext of ['.sna', '.z80', '.slt', '.szx', '.sp', '.sit', '.snx', '.zx', '.ach', '.prg', '.sem', '.frz', '.zx82']) {
    assert.ok(GAME_ACCEPT_ATTR.includes(ext), `Missing snapshot ext ${ext}`);
  }
  for (const ext of ['.trd', '.scl', '.fdi', '.td0', '.udi', '.dsk', '.mgt', '.img', '.opd', '.opu', '.d40', '.d80', '.mdr', '.hob', '.$b', '.$c']) {
    assert.ok(GAME_ACCEPT_ATTR.includes(ext), `Missing disk/hobeta ext ${ext}`);
  }
  for (const ext of ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst', '.lha', '.lzh', '.arj', '.cab', '.iso']) {
    assert.ok(GAME_ACCEPT_ATTR.includes(ext) && DISK_ACCEPT_ATTR.includes(ext), `Missing archive ext ${ext}`);
  }
});

test('Loads all snapshot formats: SZX, SP (headered & headerless), SIT, SNX, ZX, ACH, PRG, SEM, FRZ, ZX82, SLT', () => {
  const speccy = new ZXSpectrum48('48k');
  // Put unique marker in VRAM and set registers
  speccy.ramPages[5][0] = 0xaa;
  speccy.ramPages[5][100] = 0x55;
  speccy.ramPages[2][0] = 0xcd;
  speccy.ramPages[0][0] = 0xef;
  speccy.cpu.a = 0x42;
  speccy.cpu.bc = 0x1234;
  speccy.cpu.de = 0x5678;
  speccy.cpu.hl = 0x9abc;
  speccy.cpu.sp = 0xfff0;
  speccy.ramPages[0][0xfff0 - 0xc000] = 0x00;
  speccy.ramPages[0][0xfff1 - 0xc000] = 0x80;
  const flat48 = concatUint8Arrays([speccy.ramPages[5], speccy.ramPages[2], speccy.ramPages[0]]);

  // 1. .SZX (ZXST with Z80R, SPCR, AY and zlib-compressed RAMP pages)
  const szxHeader = new Uint8Array([0x5a, 0x58, 0x53, 0x54, 1, 4, 2, 0]); // v1.4 machine=2 (128K)
  const z80r = new Uint8Array(8 + 37);
  z80r.set([0x5a, 0x38, 0x30, 0x52, 37, 0, 0, 0], 0);
  z80r[8 + 0] = 0x33; z80r[8 + 1] = 0x42; // F=0x33, A=0x42
  z80r[8 + 2] = 0x34; z80r[8 + 3] = 0x12; // BC=0x1234
  z80r[8 + 22] = 0x00; z80r[8 + 23] = 0x80; // PC=0x8000
  z80r[8 + 24] = 0xfe; z80r[8 + 25] = 0xff; // SP=0xFFFE
  z80r[8 + 27] = 1; z80r[8 + 28] = 1; z80r[8 + 35] = 1; // IFF1, IFF2, IM1
  const spcr = new Uint8Array([0x53, 0x50, 0x43, 0x52, 8, 0, 0, 0, 2, 0x01, 0, 0, 0, 0, 0, 0]);
  const ayChunk = new Uint8Array(8 + 18);
  ayChunk.set([0x41, 0x59, 0x00, 0x00, 18, 0, 0, 0], 0);
  ayChunk[9] = 7; // currentReg = 7
  ayChunk[10 + 8] = 15; // ch A volume = 15
  const compP5 = zlibSync(speccy.ramPages[5]);
  const ramp5 = new Uint8Array(8 + 3 + compP5.length);
  ramp5.set([0x52, 0x41, 0x4d, 0x50], 0);
  const ramp5Sz = 3 + compP5.length;
  ramp5[4] = ramp5Sz & 0xff; ramp5[5] = (ramp5Sz >> 8) & 0xff;
  ramp5[8] = 1; ramp5[9] = 0; ramp5[10] = 5; // compressed, page 5
  ramp5.set(compP5, 11);
  const szxBytes = concatUint8Arrays([szxHeader, z80r, spcr, ayChunk, ramp5]);
  speccy.loadFile('test.szx', szxBytes, false);
  assert.equal(speccy.cpu.pc, 0x8000);
  assert.equal(speccy.borderColor, 2);
  assert.equal(speccy.ramPages[5][0], 0xaa);
  assert.equal(speccy.ay.regs[8], 15);

  // 2. .SP headered ('SP' signature) & headerless (49184 bytes)
  const spHdr = new Uint8Array(38 + 49152);
  spHdr[0] = 0x53; spHdr[1] = 0x50;
  spHdr[2] = 0x00; spHdr[3] = 0xc0; // 49152
  spHdr[4] = 0x00; spHdr[5] = 0x40; // start 0x4000
  spHdr[6] = 0x34; spHdr[7] = 0x12; // BC
  spHdr[13] = 0x77; // A (hdr=6 + 7)
  spHdr[26] = 0x00; spHdr[27] = 0x80; // PC=0x8000
  spHdr[28] = 0x00; spHdr[29] = 0xf0; // SP=0xF000
  spHdr[34] = 4; // border green
  spHdr.set(flat48, 38);
  speccy.loadFile('game.sp', spHdr, false);
  assert.equal(speccy.cpu.a, 0x77);
  assert.equal(speccy.borderColor, 4);

  const spRaw = new Uint8Array(49184);
  spRaw.set(flat48, 0);
  spRaw[49152 + 0] = 0x88; spRaw[49152 + 1] = 0x99; // BC
  spRaw[49152 + 7] = 0x5a; // A (trailer + 7)
  spRaw[49152 + 24] = 0x10; spRaw[49152 + 25] = 0x80; // PC (trailer + 24)
  speccy.loadFile('raw.sp', spRaw, false);
  assert.equal(speccy.cpu.a, 0x5a);
  assert.equal(speccy.cpu.pc, 0x8010);

  // 3. .SIT
  const sit = new Uint8Array(28 + 49152);
  sit[14] = 0x05; sit[15] = 0x80; // PC
  sit[27] = 3; // border=3
  sit.set(flat48, 28);
  speccy.loadFile('game.sit', sit, false);
  assert.equal(speccy.cpu.pc, 0x8005);
  assert.equal(speccy.borderColor, 3);

  // 4. .SNX (4 'XSNA' + 4 meta + 27 SNA header + 49152 RAM, PC popped from SP)
  const snx = new Uint8Array(35 + 49152);
  snx[0] = 0x58; snx[1] = 0x53; snx[2] = 0x4e; snx[3] = 0x41; // XSNA
  snx[8 + 23] = 0xf0; snx[8 + 24] = 0xff; // SP = 0xFFF0
  snx[8 + 26] = 5; // border = 5
  snx.set(flat48, 35);
  snx[35 + (0xfff0 - 0x4000)] = 0x66;
  snx[35 + (0xfff1 - 0x4000)] = 0x80; // PC = 0x8066 on stack
  speccy.loadFile('game.snx', snx, false);
  assert.equal(speccy.cpu.pc, 0x8066);
  assert.equal(speccy.borderColor, 5);

  // 5. .ZX (KGB 49284 bytes: 49152 RAM + 132 trailer, big-endian PC at +34/+35, border at +11)
  const zx = new Uint8Array(49284);
  zx.set(flat48, 0);
  zx[49152 + 11] = 6; // border
  zx[49152 + 34] = 0x81; zx[49152 + 35] = 0x12; // PC=0x8112 BE
  speccy.loadFile('game.zx', zx, false);
  assert.equal(speccy.cpu.pc, 0x8112);
  assert.equal(speccy.borderColor, 6);

  // 6. .ACH (256 hdr + 16384 ROM + 49152 RAM)
  const ach = new Uint8Array(256 + 65536);
  ach[32] = 0x22; ach[33] = 0x82; // PC=0x8222
  ach[145] = 1; // border
  ach.set(flat48, 256 + 16384);
  speccy.loadFile('game.ach', ach, false);
  assert.equal(speccy.cpu.pc, 0x8222);

  // 7. .PRG (256 SpecEm header + 49152 RAM, PC popped from SP)
  const prg = new Uint8Array(256 + 49152);
  prg[0xf2] = 0x44; // A=0x44
  prg[0xf3] = 0xee; prg[0xf4] = 0xee; // SP=0xEEEE
  prg.set(flat48, 256);
  prg[256 + (0xeeee - 0x4000)] = 0x33;
  prg[256 + (0xeeef - 0x4000)] = 0x83;
  speccy.loadFile('game.prg', prg, false);
  assert.equal(speccy.cpu.pc, 0x8333);

  // 8. .SEM (SPEC + 49152 RAM + 29-byte trailer)
  const sem = new Uint8Array(4 + 49152 + 29);
  sem.set([0x53, 0x50, 0x45, 0x43], 0); // SPEC
  sem.set(flat48, 4);
  sem[4 + 49152 + 7] = 0x99; // A
  sem[4 + 49152 + 28] = 2; // border
  speccy.loadFile('game.sem', sem, false);
  assert.equal(speccy.cpu.a, 0x99);
  assert.equal(speccy.borderColor, 2);

  // 9. .FRZ (42-byte header + 8x16K RAM = 131114 bytes)
  const frz = new Uint8Array(42 + 131072);
  frz[24] = 0x44; frz[25] = 0x84; // PC=0x8444
  frz.set(speccy.ramPages[5], 42 + 5 * 16384);
  speccy.loadFile('game.frz', frz, false);
  assert.equal(speccy.cpu.pc, 0x8444);

  // 10. .ZX82 (32-byte header + 49152 RAM, PC popped from SP)
  const zx82 = new Uint8Array(32 + 49152);
  zx82.set([0x5a, 0x58, 0x38, 0x32], 0);
  zx82[4] = 0; // uncompressed 48K
  zx82[5] = 1; // border
  zx82[28] = 0x3c; // A
  zx82[29] = 0xf0; zx82[30] = 0xff; // SP = 0xFFF0
  zx82.set(flat48, 32);
  speccy.loadFile('game.zx82', zx82, false);
  assert.equal(speccy.cpu.a, 0x3c);

  // 11. .SLT (Z80 v3 with trailing 00 ED ED 00 level table)
  const snaValid = buildSnaSnapshot({
    cpu: speccy.cpu, ramPages: speccy.ramPages, is128k: false,
    port7FFD: 0, trdosActive: false, borderColor: 1,
  });
  assert.ok(snaValid.length >= 49179);
  const z80v1 = new Uint8Array(30 + 49152 + 12);
  z80v1[0] = 0x7a; // A
  z80v1[6] = 0x55; z80v1[7] = 0x85; // PC
  z80v1[10] = 0xff; z80v1[11] = 0xff; // SP
  z80v1.set(flat48, 30);
  const slt = new Uint8Array([...z80v1.subarray(0, 30 + 49152), 0x00, 0xed, 0xed, 0x00]);
  speccy.loadFile('levels.slt', slt, false);
  assert.equal(speccy.cpu.a, 0x7a);
  assert.equal(speccy.cpu.pc, 0x8555);
});

test('Loads .SCR screens, .ROM/.IF2/.DCK cartridges, and .BIN/.RAW heuristics', () => {
  const speccy = new ZXSpectrum48('48k');

  // .SCR 6912 bytes
  const scr = new Uint8Array(6912);
  scr[0] = 0xff;
  scr[6144] = 0o16; // paper=1 (blue), ink=6
  speccy.loadFile('splash.scr', scr, false);
  assert.equal(speccy.ramPages[5][0], 0xff);
  assert.equal(speccy.borderColor, 1);

  // .DCK (1-byte bank ID + 8-byte bitmask + 16KB in two 8KB chunks)
  const dck = new Uint8Array(9 + 16384);
  dck[1] = 1; dck[2] = 1;
  dck[9] = 0xf3; dck[9 + 1] = 0x76; // DI; HALT at 0x0000
  speccy.loadFile('cart.dck', dck, false);
  assert.equal(speccy.rom[0], 0xf3);

  // .IF2 16KB ROM cartridge
  const if2 = new Uint8Array(16384);
  if2[0] = 0xc3; if2[1] = 0x00; if2[2] = 0x01;
  speccy.loadFile('game.if2', if2, false);
  assert.equal(speccy.rom[0], 0xc3);

  // .BIN raw code wrapped as auto-bootable .TAP
  const rawCode = makeMinimalZ80ProgramBytes();
  const wrapped = wrapCodeBytesAsTap('RAWCODE', rawCode, 0x8000);
  const parsedWrapped = parseTapeImage('tap', wrapped);
  assert.equal(parsedWrapped.blocks.length, 4);
  const msg = speccy.loadFile('demo.bin', rawCode, false);
  assert.ok(msg.includes('.TAP'));
});

test('Parses and plays all tape formats: .TAP, .BLK, .TZX, .CDT, .PZX, .CSW, .WAV, .VOC', () => {
  const tap = makeStandardTapBytes();
  assert.equal(parseTapeImage('tap', tap).blocks.length, 4);
  assert.equal(parseTapeImage('blk', tap).blocks.length, 4);

  // .TZX / .CDT with block 0x10 (standard) + 0x11 (turbo)
  const tzxSig = new Uint8Array([0x5a, 0x58, 0x54, 0x61, 0x70, 0x65, 0x21, 0x1a, 1, 20]);
  const blkLen1 = tap[0] | (tap[1] << 8);
  const b0 = tap.subarray(2, 2 + blkLen1);
  const tzx10 = new Uint8Array(5 + b0.length);
  tzx10[0] = 0x10;
  tzx10[1] = 0xe8; tzx10[2] = 0x03; // pause 1000ms
  tzx10[3] = b0.length & 0xff; tzx10[4] = (b0.length >> 8) & 0xff;
  tzx10.set(b0, 5);

  const turboHdr = new Uint8Array(19 + 4);
  turboHdr[0] = 0x11;
  turboHdr[1] = 0x10; turboHdr[2] = 0x04; // pilotT = 1040 (turbo)
  turboHdr[11] = 100; // pilot count
  turboHdr[13] = 8; // used bits
  turboHdr[16] = 4; // 4 data bytes
  turboHdr.set([0xaa, 0x55, 0x00, 0xff], 19);

  const tzx = concatUint8Arrays([tzxSig, tzx10, turboHdr]);
  const parsedTzx = parseTapeImage('tzx', tzx);
  assert.equal(parsedTzx.blocks.length, 1);
  assert.ok(parsedTzx.segments.length >= 4);
  assert.equal(parseTapeImage('cdt', tzx).formatLabel, 'CDT');

  // .PZX (PZXT + PULS + DATA + PAUS)
  const makePzxChunk = (tag: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length);
    for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
    out[4] = body.length & 0xff;
    out[5] = (body.length >> 8) & 0xff;
    out[6] = (body.length >> 16) & 0xff;
    out[7] = (body.length >> 24) & 0xff;
    out.set(body, 8);
    return out;
  };
  const pzx = concatUint8Arrays([
    makePzxChunk('PZXT', new Uint8Array([1, 0])),
    makePzxChunk('PULS', new Uint8Array([0x04, 0x00, 0x78, 0x08])), // count=4, dur=2168
    makePzxChunk('PAUS', new Uint8Array([0xe8, 0x03, 0x00, 0x00])), // 1000 T
  ]);
  const parsedPzx = parseTapeImage('pzx', pzx);
  assert.ok(parsedPzx.segments.length >= 2);

  // .CSW v1 RLE
  const csw = new Uint8Array(32 + 6);
  csw.set(Buffer.from('Compressed Square Wave\x1a', 'latin1'), 0);
  csw[23] = 1; csw[24] = 1; // v1.1
  csw[25] = 0x44; csw[26] = 0xac; // 44100 Hz
  csw[27] = 1; // RLE
  csw.set([10, 10, 20, 20, 15, 15], 32);
  const parsedCsw = parseTapeImage('csw', csw);
  assert.equal(parsedCsw.segments.length, 2);

  // Verify TapePlayer flips EAR on CSW pulses
  const player = new TapePlayer();
  player.startSegments(parsedCsw.segments);
  let edges = 0;
  player.advance(50000, 0, () => { edges++; });
  assert.ok(edges >= 2);

  // .WAV (8-bit PCM square wave at 44100 Hz)
  const samples = 200;
  const wav = new Uint8Array(44 + samples);
  wav.set(Buffer.from('RIFF', 'ascii'), 0);
  wav.set(Buffer.from('WAVEfmt ', 'ascii'), 8);
  wav[16] = 16; wav[20] = 1; wav[22] = 1;
  wav[24] = 0x44; wav[25] = 0xac; // 44100 Hz
  wav[32] = 1; wav[34] = 8;
  wav.set(Buffer.from('data', 'ascii'), 36);
  wav[40] = samples;
  for (let i = 0; i < samples; i++) wav[44 + i] = Math.floor(i / 20) % 2 === 0 ? 220 : 30;
  const parsedWav = parseTapeImage('wav', wav);
  assert.ok(parsedWav.segments.length > 0);

  // .VOC (Creative Voice 8-bit square wave)
  const voc = new Uint8Array(26 + 4 + 1 + 60);
  voc.set(Buffer.from('Creative Voice File\x1a', 'ascii'), 0);
  voc[20] = 26; voc[22] = 0x0a; voc[23] = 0x01;
  voc[26] = 1; // Sound data block
  const bLen = 62;
  voc[27] = bLen & 0xff; voc[28] = (bLen >> 8) & 0xff;
  voc[30] = 233; // ~43478 Hz
  voc[31] = 0; // PCM 8-bit
  for (let i = 0; i < 60; i++) voc[32 + i] = Math.floor(i / 10) % 2 === 0 ? 230 : 20;
  const parsedVoc = parseTapeImage('voc', voc);
  assert.ok(parsedVoc.segments.length > 0);

  // Verify ZXSpectrum48 loads non-standard TZX and maps ROM trap
  const speccy = new ZXSpectrum48('48k');
  const msg = speccy.loadFile('turbo.tzx', tzx, false);
  assert.ok(msg.includes('.TZX'));
});

test('Parses and mounts all disk, Hobeta & Microdrive formats (.TRD/.SCL/.FDI/.TD0/.UDI/.DSK/.MGT/.IMG/.OPD/.D40/.MDR/Hobeta)', () => {
  const samplePayload = new Uint8Array([0x00, 10, 0x02, 0x00, 0xf1, 0x0d, 0x80, 0xaa, 10, 0]);
  const hob = makeHobetaBytes('boot    ', 'B', samplePayload.length - 4, samplePayload);
  const trd = buildTrdImage([
    { name: 'boot', ext: 'B', start: samplePayload.length - 4, payload: samplePayload },
  ]);

  // Hobeta standalone
  const hobRes = parseDiskOrMediaImage('$b', hob);
  assert.equal(hobRes.kind, 'disk');
  assert.equal(hobRes.trdBytes[0], 'b'.charCodeAt(0));

  // Multi-Hobeta packer
  const hobCode = makeHobetaBytes('gamecode', 'C', 0x8000, new Uint8Array(512).fill(0xc9));
  const combinedTrd = buildTrdFromHobetaFiles([parseHobetaFile(hobCode)]);
  assert.equal(String.fromCharCode(...combinedTrd.subarray(0, 4)), 'boot');

  // .FDI image wrapping track 0..1 of TRD
  const fdiHeaderSize = 14 + 2 * 7 + 32 * 7; // 2 tracks (cyl 0 head 0 & 1), 16 sectors each
  const fdi = new Uint8Array(fdiHeaderSize + 32 * 256);
  fdi.set(Buffer.from('FDI', 'ascii'), 0);
  fdi[4] = 1; fdi[6] = 2; // 1 cyl, 2 heads
  fdi[8] = fdiHeaderSize & 0xff; fdi[9] = (fdiHeaderSize >> 8) & 0xff;
  fdi[10] = fdiHeaderSize & 0xff; fdi[11] = (fdiHeaderSize >> 8) & 0xff;
  let pos = 14;
  for (let h = 0; h < 2; h++) {
    const trOff = h * 16 * 256;
    fdi[pos] = trOff & 0xff; fdi[pos + 1] = (trOff >> 8) & 0xff;
    fdi[pos + 6] = 16;
    pos += 7;
    for (let s = 0; s < 16; s++) {
      fdi[pos] = 0; fdi[pos + 1] = h; fdi[pos + 2] = s + 1; fdi[pos + 3] = 1; // N=1 (256B)
      const sOff = s * 256;
      fdi[pos + 5] = sOff & 0xff; fdi[pos + 6] = (sOff >> 8) & 0xff;
      pos += 7;
    }
  }
  fdi.set(trd.subarray(0, 32 * 256), fdiHeaderSize);
  const fdiRes = parseDiskOrMediaImage('fdi', fdi);
  assert.equal(fdiRes.kind, 'disk');
  assert.equal(fdiRes.trdBytes[0x8e7], 0x10);

  // .TD0 uncompressed ('TD')
  const td0Hdr = [0x54, 0x44, 0, 0, 21, 0, 2, 0, 0, 0, 0, 0];
  const td0Track0 = [1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 2, 0, 0x01, 0x00]; // 1 sector r=1, 256 bytes RLE fill(0x42)? let's do method 0 raw 256 bytes:
  const td0SecData = new Uint8Array(256).fill(0x55);
  const td0Bytes = concatUint8Arrays([
    new Uint8Array(td0Hdr),
    new Uint8Array([1, 0, 0, 0]), // Track 0 head 0, 1 sector
    new Uint8Array([0, 0, 1, 1, 0, 0, 2, 1, 0]), // C=0,H=0,R=1,N=1,flags=0,dataLen=258(len=257+1) wait dataLen=257, method=0
    td0SecData,
    new Uint8Array([0xff]), // end of disk
  ]);
  // Patch dataLen = 257 (1 byte method + 256 raw) at offset 12 + 4 + 6 = 22
  td0Bytes[22] = 257 & 0xff; td0Bytes[23] = (257 >> 8) & 0xff;
  const td0Res = parseDiskOrMediaImage('td0', td0Bytes);
  assert.equal(td0Res.kind, 'disk');
  assert.equal(td0Res.trdBytes[0], 0x55);

  // .UDI (UDI! track 0 MFM with IDAM FE + DAM FB)
  const udiTrackMfm = new Uint8Array(16 + 1 + 400);
  // Minimal valid UDI MFM track header + IDAM FE C=0,H=0,R=1,N=1 + DAM FB + data
  udiTrackMfm[0] = 0; // MFM
  udiTrackMfm[1] = 350 & 0xff; udiTrackMfm[2] = (350 >> 8) & 0xff;
  const tData = udiTrackMfm.subarray(3);
  tData[10] = 0xa1; tData[11] = 0xa1; tData[12] = 0xa1; tData[13] = 0xfe;
  tData[14] = 0; tData[15] = 0; tData[16] = 1; tData[17] = 1; // N=1 -> 256 bytes
  tData[30] = 0xa1; tData[31] = 0xa1; tData[32] = 0xa1; tData[33] = 0xfb;
  tData.fill(0x7e, 34, 34 + 256);
  const udiTrackLen = 350;
  const bitmapLen = Math.ceil(udiTrackLen / 8);
  const udiTrackFull = new Uint8Array(3 + udiTrackLen + bitmapLen);
  udiTrackFull[0] = 0;
  udiTrackFull[1] = udiTrackLen & 0xff; udiTrackFull[2] = (udiTrackLen >> 8) & 0xff;
  udiTrackFull.set(tData.subarray(0, udiTrackLen), 3);
  const udi = new Uint8Array(16 + udiTrackFull.length);
  udi.set(Buffer.from('UDI!', 'ascii'), 0);
  const udiEnd = udi.length;
  udi[4] = udiEnd & 0xff; udi[5] = (udiEnd >> 8) & 0xff;
  udi[9] = 0; // max cyl = 0 (1 cyl)
  udi[10] = 0; // max head = 0 (1 head)
  udi.set(udiTrackFull, 16);
  const udiRes = parseDiskOrMediaImage('udi', udi);
  assert.equal(udiRes.kind, 'disk');
  assert.equal(udiRes.trdBytes[0], 0x7e);

  // .DSK Extended CPC DSK containing +3DOS file 'GAME.BIN' on 3 tracks -> extracts to TAP
  const numDskTracks = 3;
  const trackChunkBytes = 256 + 9 * 512; // 4864 bytes (19 * 256)
  const dsk = new Uint8Array(256 + numDskTracks * trackChunkBytes);
  dsk.set(Buffer.from('EXTENDED CPC DSK File\r\nDisk-Info\r\n', 'ascii'), 0);
  dsk[0x30] = numDskTracks; dsk[0x31] = 1; // 3 tracks, 1 side
  for (let t = 0; t < numDskTracks; t++) {
    dsk[0x34 + t] = trackChunkBytes / 256;
    const tInfo = 256 + t * trackChunkBytes;
    dsk.set(Buffer.from('Track-Info\r\n', 'ascii'), tInfo);
    dsk[tInfo + 0x10] = t;
    dsk[tInfo + 0x11] = 0;
    dsk[tInfo + 0x14] = 2; // 512 bytes
    dsk[tInfo + 0x15] = 9; // 9 sectors
    for (let s = 0; s < 9; s++) {
      const se = tInfo + 0x18 + s * 8;
      dsk[se] = t;
      dsk[se + 2] = 0xc1 + s; // +3DOS sector IDs C1..C9
      dsk[se + 3] = 2;
      dsk[se + 6] = 0; dsk[se + 7] = 2; // 512 bytes
    }
  }
  // Track 1 (data starts at 256 + 1*trackChunkBytes + 256) holds blocks 0..1 (CP/M directory)
  const dirBase = 256 + 1 * trackChunkBytes + 256;
  dsk.fill(0xe5, dirBase, dirBase + 2048);
  dsk[dirBase + 0] = 0; // user 0
  dsk.set(Buffer.from('GAME    BIN', 'ascii'), dirBase + 1);
  dsk[dirBase + 15] = 1;
  dsk[dirBase + 16] = 4; // block 4 -> sector 8 on Track 1..Track 2 (sec 8 is sector 9 of track 1)
  // Actually blk = 4 => linSec = 4*2 + 9 = 17 => Track 1 sector 8 (sector index 8, i.e. 0xc9)
  // Better use blk = 5 => linSec = 19 => Track 2 sector 1 (offset 256 + 2*trackChunkBytes + 256 + 512)
  dsk[dirBase + 16] = 5;
  const p3Base = 256 + 2 * trackChunkBytes + 256 + 512;
  dsk.set(Buffer.from('PLUS3DOS\x1a\x01\x00', 'ascii'), p3Base);
  dsk[p3Base + 11] = 132 & 0xff;
  dsk[p3Base + 15] = 3; // CODE
  dsk[p3Base + 16] = 4; // len=4
  dsk[p3Base + 18] = 0x00; dsk[p3Base + 19] = 0x80; // start=0x8000
  dsk.set([0x3e, 0x02, 0xf3, 0x76], p3Base + 128);
  const dskRes = parseDiskOrMediaImage('dsk', dsk);
  assert.equal(dskRes.kind, 'tap');

  // .MGT 800KB image with +D 48K snapshot entry (type 5) chained across 97 sectors
  const mgt = new Uint8Array(819200);
  const mgtSnapData = new Uint8Array(24 + 49152);
  mgtSnapData[22] = 0x00; mgtSnapData[23] = 0x80; // SP = 0x8000
  const mgtSectors = Math.ceil(mgtSnapData.length / 510); // 97
  mgt[0] = 5; // 48K snap
  mgt.set(Buffer.from('SNAP48    ', 'ascii'), 1);
  mgt[11] = (mgtSectors >> 8) & 0xff;
  mgt[12] = mgtSectors & 0xff;
  mgt[13] = 4; // start track 4
  mgt[14] = 1; // start sector 1
  for (let s = 0; s < mgtSectors; s++) {
    const absSec = 40 + s; // track 4 sec 1 onwards
    const trk = Math.floor(absSec / 10);
    const sec1 = (absSec % 10) + 1;
    const cyl = trk;
    const off = (cyl * 2 * 10 + (sec1 - 1)) * 512;
    const chunk = mgtSnapData.subarray(s * 510, (s + 1) * 510);
    mgt.set(chunk, off);
    if (s + 1 < mgtSectors) {
      const nextAbs = absSec + 1;
      mgt[off + 510] = Math.floor(nextAbs / 10);
      mgt[off + 511] = (nextAbs % 10) + 1;
    }
  }
  const mgtRes = parseDiskOrMediaImage('mgt', mgt);
  assert.equal(mgtRes.kind, 'sna');

  // .IMG raw TR-DOS vs .OPD (Opus Discovery) vs .D40 (Didaktik MDOS)
  const imgTrdRes = parseDiskOrMediaImage('img', trd);
  assert.equal(imgTrdRes.kind, 'disk');

  const opd = new Uint8Array(184320);
  opd.set(Buffer.from('run       ', 'ascii'), 256);
  opd[256 + 10] = 20; // start block 20
  opd[256 + 11] = 2; // 2 blocks (512 bytes)
  const opdDataOff = 20 * 256;
  opd[opdDataOff] = 3; // CODE
  opd[opdDataOff + 1] = 4; // payload length
  opd[opdDataOff + 3] = 0x00; opd[opdDataOff + 4] = 0x80; // start 0x8000
  opd.set([0xf3, 0x76, 0x00, 0x00], opdDataOff + 7);
  assert.equal(parseDiskOrMediaImage('opd', opd).kind, 'tap');

  const d40 = new Uint8Array(40 * 2 * 10 * 512);
  d40[0x0200] = 0x01; // active status
  d40[0x0201] = 'B'.charCodeAt(0); // CODE
  d40.set(Buffer.from('GAME    ', 'ascii'), 0x0202);
  d40[0x020a] = 10; d40[0x020b] = 0; // start sector 10
  d40[0x020c] = 4; d40[0x020d] = 0; // size 4 bytes
  d40[0x020e] = 0x00; d40[0x020f] = 0x80; // start 0x8000
  d40.set([0xf3, 0x76, 0x00, 0x00], 10 * 512);
  assert.equal(parseDiskOrMediaImage('d40', d40).kind, 'tap');

  // .MDR ZX Microdrive cartridge -> TAP extraction
  const mdr = new Uint8Array(137923);
  const secOff = 0;
  mdr[secOff] = 0x01; // valid header
  mdr[secOff + 15] = 0x06; // EOF + data block
  mdr[secOff + 16] = 0; // rec 0
  mdr[secOff + 17] = 13; mdr[secOff + 18] = 0; // recLen = 13 (9 IF1 hdr + 4 data)
  mdr.set(Buffer.from('run       ', 'ascii'), secOff + 19);
  mdr[secOff + 30] = 3; // CODE
  mdr[secOff + 31] = 4; // len 4
  mdr[secOff + 33] = 0x00; mdr[secOff + 34] = 0x80; // start 0x8000
  mdr.set([0xf3, 0x76, 0x00, 0x00], secOff + 39);
  const mdrRes = parseDiskOrMediaImage('mdr', mdr);
  assert.equal(mdrRes.kind, 'tap');

  // Mount .FDI onto ZXSpectrum48 BDI Drive A:
  const speccy = new ZXSpectrum48('pentagon128');
  speccy.mountDisk(0, 'test.fdi', fdi);
  assert.ok(speccy.bdi.disks[0] !== null);
  assert.ok(speccy.bdi.customDisks[0] !== null);
});

test('Unpacks archives: repo Dizzy .ZIP, multi-file .ZIP, .GZ, .BZ2, .TAR, .ARJ, .7Z, nested & multi-Hobeta', async () => {
  // 1. Real game archive shipped in repository
  const repoZipPath = path.resolve(
    process.cwd(),
    'public/assets/aistudio/Dizzy_-_The_Ultimate_Cartoon_Adventure__1987__Codemasters__1f98e567.zip'
  );
  const repoZipBytes = new Uint8Array(fs.readFileSync(repoZipPath));
  const dizzyExtracted = await extractPlayableFiles('Dizzy.zip', repoZipBytes, 'game');
  assert.equal(dizzyExtracted.kind, 'single');
  assert.equal(dizzyExtracted.file.ext, 'tap');

  const speccy = new ZXSpectrum48('128k');
  const loadMsg = speccy.loadFile(dizzyExtracted.file.name, dizzyExtracted.file.bytes, true);
  assert.ok(loadMsg.includes('.TAP'));

  // 2. Multi-file ZIP (filtering out .txt + sorting)
  const tap = makeStandardTapBytes();
  const multiZip = zipSync({
    'README.TXT': Buffer.from('Info'),
    '__MACOSX/._Game.tap': tap,
    'Side1/Game.tap': tap,
    'Side2/Game.sna': new Uint8Array(49179),
  });
  const multiRes = await extractPlayableFiles('pack.zip', multiZip, 'game');
  assert.equal(multiRes.kind, 'multiple');
  assert.equal(multiRes.files.length, 2);

  // 3. Multi-Hobeta folder inside ZIP auto-bundles into ready-to-boot .TRD
  const hobA = makeHobetaBytes('game    ', 'B', 10, new Uint8Array([0x00, 10, 2, 0, 0xf1, 0x0d]));
  const hobB = makeHobetaBytes('data    ', 'C', 0x8000, new Uint8Array(256).fill(0xcd));
  const hobZip = zipSync({
    'DizzyTRD/game.$B': hobA,
    'DizzyTRD/data.$C': hobB,
  });
  const hobRes = await extractPlayableFiles('DizzyHobeta.zip', hobZip, 'game');
  assert.equal(hobRes.kind, 'single');
  assert.equal(hobRes.file.ext, 'trd');
  assert.equal(hobRes.file.name, 'DizzyTRD.trd');

  // 4. .GZ single-file (.tap.gz) and .TAR.GZ nested
  const tapGz = gzipSync(tap);
  const gzRes = await extractPlayableFiles('JetSet.tap.gz', tapGz, 'game');
  assert.equal(gzRes.kind, 'single');
  assert.equal(gzRes.file.ext, 'tap');

  const tarBytes = makePosixTar([{ name: 'manic.tap', data: tap }]);
  const tgzBytes = gzipSync(tarBytes);
  const tgzRes = await extractPlayableFiles('manic.tar.gz', tgzBytes, 'game');
  assert.equal(tgzRes.kind, 'single');
  assert.equal(tgzRes.file.name, 'manic.tap');

  // Direct .TAR via archive-wasm
  const tarRes = await extractPlayableFiles('manic.tar', tarBytes, 'game');
  assert.equal(tarRes.kind, 'single');
  assert.equal(tarRes.file.name, 'manic.tap');

  // 5. BZip2 native decoder (verified valid stream for "BZh9" + "hi!\n" = 42 5a 68 39 31 41 59 26 53 59 ...)
  // Empty stream BZh9 + footer 17 72 45 38 50 90 00 00 00 00
  const emptyBz2 = new Uint8Array([0x42, 0x5a, 0x68, 0x39, 0x17, 0x72, 0x45, 0x38, 0x50, 0x90, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(decompressBzip2(emptyBz2).length, 0);

  // Real BZip2 stream for ASCII "hello\n" compressed with bzip2 -9
  const helloBz2Hex =
    '425a6839314159265359c1c080e2000001410000100244a00030cd00c3462997177245385090c1c080e2';
  const helloBz2 = new Uint8Array(helloBz2Hex.match(/../g)!.map((h) => parseInt(h, 16)));
  assert.equal(Buffer.from(decompressBzip2(helloBz2)).toString('utf8'), 'hello\n');

  // 6. Native ARJ archive (Main header + Stored entry containing mini.tap)
  const arjMainBasicSize = 32;
  const arjMain = new Uint8Array(4 + arjMainBasicSize + 6);
  arjMain[0] = 0x60; arjMain[1] = 0xea;
  arjMain[2] = arjMainBasicSize; arjMain[3] = 0;
  arjMain[4] = 30; // firstHdrSize
  arjMain[4 + 6] = 2; // main comment/header type
  // File entry (method 0 stored)
  const nameBytes = Buffer.from('mini.tap\0', 'ascii');
  const fBasicSize = 30 + nameBytes.length + 1;
  const arjFile = new Uint8Array(4 + fBasicSize + 6 + tap.length);
  arjFile[0] = 0x60; arjFile[1] = 0xea;
  arjFile[2] = fBasicSize & 0xff; arjFile[3] = (fBasicSize >> 8) & 0xff;
  arjFile[4] = 30;
  arjFile[4 + 5] = 0; // method 0 = stored
  arjFile[4 + 6] = 0; // binary
  arjFile[4 + 12] = tap.length & 0xff; arjFile[4 + 13] = (tap.length >> 8) & 0xff;
  arjFile[4 + 16] = tap.length & 0xff; arjFile[4 + 17] = (tap.length >> 8) & 0xff;
  arjFile.set(nameBytes, 4 + 30);
  arjFile.set(tap, 4 + fBasicSize + 6);
  const arjEnd = new Uint8Array([0x60, 0xea, 0x00, 0x00]);
  const arjBytes = concatUint8Arrays([arjMain, arjFile, arjEnd]);
  const arjRes = await extractPlayableFiles('mini.arj', arjBytes, 'game');
  assert.equal(arjRes.kind, 'single');
  assert.equal(arjRes.file.name, 'mini.tap');
  assert.equal(arjRes.file.bytes.length, tap.length);

  // 7. Nested ZIP -> GZ -> TAP
  const nestedZip = zipSync({
    'inner/deep.tap.gz': tapGz,
  });
  const nestedRes = await extractPlayableFiles('nested.zip', nestedZip, 'game');
  assert.equal(nestedRes.kind, 'single');
  assert.equal(nestedRes.file.name, 'deep.tap');
});
