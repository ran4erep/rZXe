import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAM_ACTIVE_HEIGHT,
  BEAM_BORDER_X,
  BEAM_BORDER_Y,
  BEAM_SCREEN_HEIGHT,
  BEAM_SCREEN_WIDTH,
  PALETTE_ABGR,
  blendFrames5050,
  computeActiveFrameHash,
  renderBeamSpan,
  renderStaticFrame,
  tstatesToBeamPos,
} from './videoBeam';
import { ZXSpectrum48 } from './spectrum';
import { sanitizeEmulatorSettings } from './settingsStorage';

function assembleIntoRam(speccy: ZXSpectrum48, addr: number, bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) {
    speccy.cpu.wb(addr + i, bytes[i]);
  }
}

test('tstatesToBeamPos maps 48K, 128K, and Pentagon active coordinates accurately', () => {
  // 48K: firstActiveT=14336, tstatesPerLine=224
  assert.equal(tstatesToBeamPos(8944, 14336, 224), 0);
  assert.equal(tstatesToBeamPos(14336, 14336, 224), (24 << 9) | 32);
  assert.equal(tstatesToBeamPos(14336 + 128, 14336, 224), (24 << 9) | 288);
  assert.equal(tstatesToBeamPos(14336 + 160, 14336, 224), (25 << 9) | 0);
  assert.equal(tstatesToBeamPos(62640, 14336, 224), 240 << 9);

  // 128K: firstActiveT=14364, tstatesPerLine=228
  assert.equal(tstatesToBeamPos(14364, 14364, 228), (24 << 9) | 32);

  // Pentagon 128: firstActiveT=17920, tstatesPerLine=224
  assert.equal(tstatesToBeamPos(17920, 17920, 224), (24 << 9) | 32);
});

test('renderBeamSpan across arbitrary unaligned spans matches renderStaticFrame pixel-for-pixel', () => {
  const scr = new Uint8Array(16384);
  for (let i = 0; i < 0x1800; i++) scr[i] = (i * 37 + 13) & 0xff;
  for (let i = 0x1800; i < 0x1b00; i++) scr[i] = ((i * 19) & 0x7f) | (i & 1 ? 0x80 : 0);

  const expected = new Uint32Array(BEAM_SCREEN_WIDTH * BEAM_SCREEN_HEIGHT);
  renderStaticFrame(expected, scr, 5, true, true);

  const actual = new Uint32Array(BEAM_SCREEN_WIDTH * BEAM_SCREEN_HEIGHT);
  const checkpoints = [
    0,
    (10 << 9) | 100,
    (24 << 9) | 34,   // 2px into cell 0 of row 0
    (24 << 9) | 42,   // mid cell 1 of row 0
    (24 << 9) | 286,  // 2px before right border
    (25 << 9) | 18,   // inside left border
    (120 << 9) | 150,
    (215 << 9) | 300, // bottom right border
    240 << 9,
  ];
  for (let i = 0; i < checkpoints.length - 1; i++) {
    renderBeamSpan(actual, scr, 5, true, checkpoints[i], checkpoints[i + 1]);
  }

  assert.deepEqual(actual, expected);
});

test('blendFrames5050 performs exact SWAR 50/50 channel averaging with alpha=0xff', () => {
  const a = new Uint32Array([0xff000000, 0xffffffff, 0xff0000ff, 0xffd70000]);
  const b = new Uint32Array([0xffffffff, 0xffffffff, 0xff00ff00, 0xff00d7d7]);
  const dst = new Uint32Array(4);

  blendFrames5050(a, b, dst);

  assert.equal(dst[0], 0xff7f7f7f); // Black + Bright White -> Gray
  assert.equal(dst[1], 0xffffffff); // Bright White + Bright White -> no dimming
  assert.equal(dst[2], 0xff007f7f); // Bright Red + Bright Green -> Amber/Yellow
  assert.equal((dst[3] >>> 24) & 0xff, 0xff); // Alpha preserved
  assert.equal(computeActiveFrameHash(dst) !== 0, true);
});

test('ZXSpectrum48 renders mid-frame & mid-scanline border bars via lazy beam-chase', () => {
  const speccy = new ZXSpectrum48('48k');
  speccy.setGigascreenMode('off');
  speccy.cpu.iff1 = 0;
  speccy.cpu.pc = 0x8000;

  // Program at 0x8000:
  //   LD A, 2 : OUT (0xFE), A   (red border at frame start)
  //   busy-wait until line ~24+96 (mid screen)
  //   LD A, 4 : OUT (0xFE), A   (green border)
  //   HALT
  assembleIntoRam(speccy, 0x8000, [
    0x3e, 0x02,       // LD A, 2 (Red)
    0xd3, 0xfe,       // OUT (0xFE), A
    0x01, 0x00, 0x05, // LD BC, 0x0500 (~1280 * 26T = 33280T -> around line 84)
    0x0b,             // loop: DEC BC (6T)
    0x78,             // LD A, B (4T)
    0xb1,             // OR C (4T)
    0x20, 0xfb,       // JR NZ, loop (12T) -> 26T/iter
    0x3e, 0x04,       // LD A, 4 (Green)
    0xd3, 0xfe,       // OUT (0xFE), A
    0x76,             // HALT
  ]);

  const dirty = speccy.stepFrame(true);
  assert.equal(dirty, true);

  // Top border row (y=0, x=0) must be Red (PALETTE_ABGR[2])
  assert.equal(speccy.frameBuffer[0], PALETTE_ABGR[2]);
  // Bottom border row (y=239, x=0) must be Green (PALETTE_ABGR[4])
  assert.equal(speccy.frameBuffer[239 * BEAM_SCREEN_WIDTH], PALETTE_ABGR[4]);
});

test('ZXSpectrum48 supports Nirvana-style 8x1 per-scanline attribute changes inside a single 8x8 cell', () => {
  const speccy = new ZXSpectrum48('48k');
  speccy.setGigascreenMode('off');
  speccy.cpu.iff1 = 0;
  speccy.cpu.pc = 0x8000;

  // Fill top-left 8x8 cell (col 0, rows 0..7) with solid INK pixels (0xFF)
  const scr = speccy.ramPages[5];
  for (let y = 0; y < 8; y++) {
    scr[y << 8] = 0xff;
  }
  // Initial attribute for (col 0, row 0) = Red INK (2)
  scr[0x1800] = 0x02;

  // Wait until line 0 col 0 has been drawn (~14416 T-states, before line 1 at 14560T),
  // then change 0x5800 to Green (4), wait 1 scanline (~224T), then change 0x5800 to Blue (1).
  // 554 iters * 26T = 14404T
  assembleIntoRam(speccy, 0x8000, [
    0x01, 0x2a, 0x02, // LD BC, 0x022a (554)
    0x0b, 0x78, 0xb1, 0x20, 0xfb, // wait ~14404T (after line 0 col 0, before line 1)
    0x3e, 0x04,       // LD A, 4 (Green)
    0x32, 0x00, 0x58, // LD (0x5800), A  (before line 1 scans)
    0x06, 0x0e,       // LD B, 14 (14 * 13T ≈ 182T + overhead ≈ 224T)
    0x10, 0xfe,       // DJNZ $
    0x3e, 0x01,       // LD A, 1 (Blue)
    0x32, 0x00, 0x58, // LD (0x5800), A  (before line 2 scans)
    0x76,             // HALT
  ]);

  const dirty = speccy.stepFrame(true);
  assert.equal(dirty, true);

  const pxLine0 = speccy.frameBuffer[BEAM_BORDER_Y * BEAM_SCREEN_WIDTH + BEAM_BORDER_X];
  const pxLine1 = speccy.frameBuffer[(BEAM_BORDER_Y + 1) * BEAM_SCREEN_WIDTH + BEAM_BORDER_X];
  const pxLine2 = speccy.frameBuffer[(BEAM_BORDER_Y + 2) * BEAM_SCREEN_WIDTH + BEAM_BORDER_X];

  assert.equal(pxLine0, PALETTE_ABGR[2]); // Line 0 inside cell (0,0) = Red
  assert.equal(pxLine1, PALETTE_ABGR[4]); // Line 1 inside cell (0,0) = Green
  assert.equal(pxLine2, PALETTE_ABGR[1]); // Line 2 inside cell (0,0) = Blue
});

test('ZXSpectrum48 supports 128K mid-frame screen bank split (Bank 5 top, Bank 7 bottom)', () => {
  const speccy = new ZXSpectrum48('128k');
  speccy.setGigascreenMode('off');
  speccy.cpu.iff1 = 0;
  speccy.cpu.pc = 0x8000;

  // Bank 5: solid Red (PAPER 2), Bank 7: solid Cyan (PAPER 5)
  speccy.ramPages[5].fill(0x10, 0x1800, 0x1b00);
  speccy.ramPages[7].fill(0x28, 0x1800, 0x1b00);

  // Switch port 0x7FFD bit 3 around mid-screen (~36000T -> 36000 / 26 ≈ 1385 = 0x0569)
  assembleIntoRam(speccy, 0x8000, [
    0x3e, 0x00,             // LD A, 0 (Bank 5)
    0x01, 0xfd, 0x7f,       // LD BC, 0x7FFD
    0xed, 0x79,             // OUT (C), A
    0x11, 0x69, 0x05,       // LD DE, 0x0569
    0x1b,                   // loop: DEC DE (6T)
    0x7a,                   // LD A, D (4T)
    0xb3,                   // OR E (4T)
    0x20, 0xfb,             // JR NZ, loop (12T)
    0x3e, 0x08,             // LD A, 8 (Bank 7)
    0xed, 0x79,             // OUT (C), A
    0x76,                   // HALT
  ]);

  speccy.stepFrame(true);

  const topPaper = speccy.frameBuffer[BEAM_BORDER_Y * BEAM_SCREEN_WIDTH + BEAM_BORDER_X];
  const botPaper =
    speccy.frameBuffer[(BEAM_BORDER_Y + BEAM_ACTIVE_HEIGHT - 1) * BEAM_SCREEN_WIDTH + BEAM_BORDER_X];

  assert.equal(topPaper, PALETTE_ABGR[2]); // Bank 5 Red on top
  assert.equal(botPaper, PALETTE_ABGR[5]); // Bank 7 Cyan on bottom
});

test('ZXSpectrum48 auto-Gigascreen blends alternating Bank 5/7 frames and settles cleanly when static', () => {
  const speccy = new ZXSpectrum48('128k');
  speccy.setGigascreenMode('auto');
  speccy.cpu.iff1 = 0;

  // Bank 5 = Bright Red PAPER (0x50 = bright + paper 2), Bank 7 = Bright Green PAPER (0x60 = bright + paper 4)
  speccy.ramPages[5].fill(0x50, 0x1800, 0x1b00);
  speccy.ramPages[7].fill(0x60, 0x1800, 0x1b00);

  // Run alternating frames: 5, 7, 5, 7
  const banks = [0x00, 0x08, 0x00, 0x08];
  for (const val of banks) {
    speccy.cpu.halted = false;
    speccy.cpu.pc = 0x8000;
    assembleIntoRam(speccy, 0x8000, [
      0x3e, val,
      0x01, 0xfd, 0x7f,
      0xed, 0x79,
      0x76,
    ]);
    speccy.stepFrame(true);
  }

  const centerPx =
    speccy.frameBuffer[(BEAM_BORDER_Y + 50) * BEAM_SCREEN_WIDTH + BEAM_BORDER_X + 50];
  const expectedBlend = new Uint32Array(1);
  blendFrames5050(
    new Uint32Array([PALETTE_ABGR[10]]),
    new Uint32Array([PALETTE_ABGR[12]]),
    expectedBlend
  );
  assert.equal(centerPx, expectedBlend[0]);

  // Now stop alternating (static Bank 7) -> settles cleanly back to crisp PALETTE_ABGR[12]
  speccy.cpu.halted = false;
  speccy.cpu.pc = 0x8000;
  assembleIntoRam(speccy, 0x8000, [0x76]);
  const settledDirty = speccy.stepFrame(true);
  assert.equal(settledDirty, true);
  const settledPx =
    speccy.frameBuffer[(BEAM_BORDER_Y + 50) * BEAM_SCREEN_WIDTH + BEAM_BORDER_X + 50];
  assert.equal(settledPx, PALETTE_ABGR[12]);
});

test('sanitizeEmulatorSettings validates gigascreenMode safely', () => {
  assert.equal(sanitizeEmulatorSettings({}).gigascreenMode, 'auto');
  assert.equal(sanitizeEmulatorSettings({ gigascreenMode: 'on' }).gigascreenMode, 'on');
  assert.equal(sanitizeEmulatorSettings({ gigascreenMode: 'off' }).gigascreenMode, 'off');
  assert.equal(sanitizeEmulatorSettings({ gigascreenMode: 'invalid' }).gigascreenMode, 'auto');
});
