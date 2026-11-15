// Built-in playable ZX Spectrum .TAP programs compiled cleanly into authentic Z80 + BASIC tape images

import { buildTapBlock, buildTapHeader, concatUint8Arrays } from './formats';
import { buildTrdImage } from './betaDisk';
import { getRomBytes } from './roms';
import { MachineId } from './machines';

export interface BuiltinGame {
  id: string;
  title: string;
  subtitle: string;
  controls: string;
  filename: string;
  format: 'TAP' | 'TRD';
  recommendedMachine?: MachineId;
  buildBytes: () => Uint8Array;
}

// --- Minimal Symbolic Z80 Assembler for Built-in Machine Code Games ---
class Z80Asm {
  private org: number;
  private bytes: number[] = [];
  private labels = new Map<string, number>();
  private fixups: Array<{ pos: number; label: string; kind: 'abs16' | 'rel8' }> = [];

  constructor(org = 0x8000) {
    this.org = org;
  }

  public get pc(): number {
    return this.org + this.bytes.length;
  }

  public label(name: string): void {
    this.labels.set(name, this.pc);
  }

  public db(...vals: number[]): void {
    for (const v of vals) this.bytes.push(v & 0xff);
  }

  public dw(...vals: number[]): void {
    for (const v of vals) {
      this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    }
  }

  public ascii(str: string): void {
    for (let i = 0; i < str.length; i++) {
      this.bytes.push(str.charCodeAt(i) & 0xff);
    }
  }

  public ld16(op: number, labelOrVal: string | number): void {
    this.bytes.push(op);
    if (typeof labelOrVal === 'number') {
      this.dw(labelOrVal);
    } else {
      this.fixups.push({ pos: this.bytes.length, label: labelOrVal, kind: 'abs16' });
      this.dw(0);
    }
  }

  public jp(op: number, label: string): void {
    this.bytes.push(op);
    this.fixups.push({ pos: this.bytes.length, label, kind: 'abs16' });
    this.dw(0);
  }

  public call(labelOrAddr: string | number): void {
    this.bytes.push(0xcd);
    if (typeof labelOrAddr === 'number') {
      this.dw(labelOrAddr);
    } else {
      this.fixups.push({ pos: this.bytes.length, label: labelOrAddr, kind: 'abs16' });
      this.dw(0);
    }
  }

  public jr(op: number, label: string): void {
    this.bytes.push(op);
    this.fixups.push({ pos: this.bytes.length, label, kind: 'rel8' });
    this.bytes.push(0);
  }

  public finish(): Uint8Array {
    for (const f of this.fixups) {
      const target = this.labels.get(f.label);
      if (target === undefined) {
        throw new Error(`Unknown Z80 asm label: ${f.label}`);
      }
      if (f.kind === 'abs16') {
        this.bytes[f.pos] = target & 0xff;
        this.bytes[f.pos + 1] = (target >> 8) & 0xff;
      } else {
        const from = this.org + f.pos + 1;
        const delta = target - from;
        if (delta < -128 || delta > 127) {
          throw new Error(`JR out of range to ${f.label}: ${delta}`);
        }
        this.bytes[f.pos] = delta & 0xff;
      }
    }
    return new Uint8Array(this.bytes);
  }
}

// --- Sinclair BASIC Line & TAP Builder ---
// Sinclair BASIC tokens:
const TOK = {
  RND: 0xa5,
  INKEY: 0xa6,
  PI: 0xa7,
  CLEAR: 0xfd,
  LOAD: 0xef,
  SCREEN: 0xaa,
  CODE: 0xaf,
  RANDOMIZE: 0xf9,
  USR: 0xc0,
  BORDER: 0xe7,
  PAPER: 0xda,
  INK: 0xd9,
  BRIGHT: 0xdc,
  CLS: 0xfb,
  PRINT: 0xf5,
  AT: 0xac,
  PLOT: 0xf6,
  DRAW: 0xe3,
  CIRCLE: 0xd8,
  BEEP: 0xd7,
  FOR: 0xeb,
  TO: 0xcc,
  NEXT: 0xf3,
  PAUSE: 0xf2,
  GOTO: 0xec,
  REM: 0xea,
  LET: 0xf1,
};

function encodeBasicNumber(n: number): number[] {
  const s = String(n);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  out.push(0x0e, 0x00, 0x00, n & 0xff, (n >> 8) & 0xff, 0x00);
  return out;
}

function encodeBasicLine(lineNum: number, tokens: Array<number | string>): number[] {
  const body: number[] = [];
  for (const t of tokens) {
    if (typeof t === 'number') {
      body.push(t & 0xff);
    } else {
      for (let i = 0; i < t.length; i++) body.push(t.charCodeAt(i) & 0xff);
    }
  }
  body.push(0x0d); // ENTER
  const len = body.length;
  return [
    (lineNum >> 8) & 0xff,
    lineNum & 0xff,
    len & 0xff,
    (len >> 8) & 0xff,
    ...body,
  ];
}

function setScreenPixel(scr: Uint8Array, x: number, y: number): void {
  if (x < 0 || x >= 256 || y < 0 || y >= 192) return;
  const high = ((y & 0xc0) >> 3) | (y & 0x07);
  const low = (y & 0x38) << 2;
  const addr = (high << 8) | low | (x >> 3);
  scr[addr] |= 0x80 >> (x & 7);
}

function setScreenAttr(scr: Uint8Array, cx: number, cy: number, attr: number): void {
  if (cx < 0 || cx >= 32 || cy < 0 || cy >= 24) return;
  scr[0x1800 + cy * 32 + cx] = attr & 0xff;
}

function drawScreenText2x(
  scr: Uint8Array,
  rom48: Uint8Array,
  text: string,
  startX: number,
  startY: number
): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 127) continue;
    const glyphBase = 0x3d00 + (code - 32) * 8;
    const gx = startX + i * 16;
    for (let row = 0; row < 8; row++) {
      const bits = rom48[glyphBase + row];
      for (let col = 0; col < 8; col++) {
        if ((bits & (0x80 >> col)) !== 0) {
          const px = gx + col * 2;
          const py = startY + row * 2;
          setScreenPixel(scr, px, py);
          setScreenPixel(scr, px + 1, py);
          setScreenPixel(scr, px, py + 1);
          setScreenPixel(scr, px + 1, py + 1);
        }
      }
    }
  }
}

function drawScreenText1x(
  scr: Uint8Array,
  rom48: Uint8Array,
  text: string,
  cx: number,
  cy: number
): void {
  const baseY = cy * 8;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 || code > 127) continue;
    const glyphBase = 0x3d00 + (code - 32) * 8;
    const bx = (cx + i) * 8;
    for (let row = 0; row < 8; row++) {
      const bits = rom48[glyphBase + row];
      for (let col = 0; col < 8; col++) {
        if ((bits & (0x80 >> col)) !== 0) {
          setScreenPixel(scr, bx + col, baseY + row);
        }
      }
    }
  }
}

function buildLoadingScreen(name: string): Uint8Array {
  const scr = new Uint8Array(6912);
  const rom48 = getRomBytes('rom48');

  // Default black paper, bright cyan/white ink
  scr.fill(0x47, 0x1800, 0x1b00);

  // Outer pixel frame (starting at y=16 so row 0..1 stays clear for ROM "Bytes:" line)
  for (let x = 8; x < 248; x++) {
    setScreenPixel(scr, x, 16);
    setScreenPixel(scr, x, 18);
    setScreenPixel(scr, x, 181);
    setScreenPixel(scr, x, 183);
  }
  for (let y = 16; y <= 183; y++) {
    setScreenPixel(scr, 8, y);
    setScreenPixel(scr, 10, y);
    setScreenPixel(scr, 245, y);
    setScreenPixel(scr, 247, y);
  }

  // Classic diagonal Sinclair rainbow stripes in top-right corner
  const stripeColors = [0x42, 0x46, 0x44, 0x45]; // Bright Red, Yellow, Green, Cyan
  for (let s = 0; s < 4; s++) {
    const bx = 188 + s * 12;
    for (let dy = 0; dy < 24; dy++) {
      for (let dx = 0; dx < 10; dx++) {
        setScreenPixel(scr, bx + dx - (dy >> 1), 22 + dy);
      }
    }
    for (let cy = 2; cy <= 5; cy++) {
      setScreenAttr(scr, 23 + s, cy, stripeColors[s]);
    }
  }

  // Scaled 2x game title banner in upper third
  const titleX = Math.max(20, 128 - name.length * 8);
  drawScreenText2x(scr, rom48, name, titleX, 56);
  for (let cx = 2; cx < 30; cx++) {
    setScreenAttr(scr, cx, 7, 0x46); // Bright yellow top half
    setScreenAttr(scr, cx, 8, 0x47); // Bright white bottom half
  }

  // Retro geometric artwork in middle third
  for (let x = 24; x < 232; x += 16) {
    for (let dy = 0; dy < 12; dy++) {
      for (let dx = 0; dx < 12; dx++) {
        if (dx === 0 || dx === 11 || dy === 0 || dy === 11 || ((dx + dy) & 2) === 0) {
          setScreenPixel(scr, x + dx, 96 + dy);
        }
      }
    }
  }
  for (let cx = 3; cx < 29; cx++) {
    const col = ((cx - 3) % 4) + 2; // Red..Cyan blocks
    setScreenAttr(scr, cx, 12, 0x40 | col);
    setScreenAttr(scr, cx, 13, 0x40 | col);
  }

  // Horizontal scanline bars & cassette loading caption in lower third
  for (let x = 24; x < 232; x++) {
    if ((x & 3) !== 0) {
      setScreenPixel(scr, x, 132);
      setScreenPixel(scr, x, 134);
    }
  }
  drawScreenText1x(scr, rom48, 'ZX SPECTRUM 48K / 128K', 5, 19);
  drawScreenText1x(scr, rom48, 'LOADING...', 11, 21);
  for (let cx = 5; cx < 27; cx++) {
    setScreenAttr(scr, cx, 19, 0x45); // Bright cyan
    setScreenAttr(scr, cx, 21, 0x42); // Bright red
  }

  return scr;
}

function wrapMachineCodeTap(name: string, code: Uint8Array, org = 0x8000): Uint8Array {
  // 10 CLEAR 32767 : BORDER 0 : PAPER 0 : INK 7 : CLS : LOAD "" SCREEN$ : LOAD "" CODE 32768 : RANDOMIZE USR 32768
  const line10 = encodeBasicLine(10, [
    TOK.CLEAR, ...encodeBasicNumber(org - 1), ':',
    TOK.BORDER, ...encodeBasicNumber(0), ':',
    TOK.PAPER, ...encodeBasicNumber(0), ':',
    TOK.INK, ...encodeBasicNumber(7), ':',
    TOK.CLS, ':',
    TOK.LOAD, '""', TOK.SCREEN, ':',
    TOK.LOAD, '""', TOK.CODE, ...encodeBasicNumber(org), ':',
    TOK.RANDOMIZE, TOK.USR, ...encodeBasicNumber(org),
  ]);
  const basicBytes = new Uint8Array(line10);
  const screenBytes = buildLoadingScreen(name);
  return concatUint8Arrays([
    buildTapHeader(0, name, basicBytes.length, 10, basicBytes.length),
    buildTapBlock(0xff, basicBytes),
    buildTapHeader(3, 'SCREEN', screenBytes.length, 16384, 32768),
    buildTapBlock(0xff, screenBytes),
    buildTapHeader(3, name + 'C', code.length, org, 0x8000),
    buildTapBlock(0xff, code),
  ]);
}

function wrapMachineCodeTrd(codeName: string, code: Uint8Array, org = 0x8000, diskLabel = 'PENTAGON'): Uint8Array {
  // 10 CLEAR 32767 : RANDOMIZE USR 15619 : REM : LOAD "codeName" CODE
  // 20 RANDOMIZE USR 32768
  const line10 = encodeBasicLine(10, [
    TOK.CLEAR, ...encodeBasicNumber(org - 1), ':',
    TOK.RANDOMIZE, TOK.USR, ...encodeBasicNumber(15619), ':',
    TOK.REM, ':',
    TOK.LOAD, `"${codeName}"`, TOK.CODE,
  ]);
  const line20 = encodeBasicLine(20, [
    TOK.RANDOMIZE, TOK.USR, ...encodeBasicNumber(org),
  ]);
  const basicProg = new Uint8Array([...line10, ...line20]);
  // TR-DOS BASIC payload appends 0x80, 0xAA, lineLo, lineHi for autostart
  const bootPayload = new Uint8Array(basicProg.length + 4);
  bootPayload.set(basicProg, 0);
  bootPayload[basicProg.length] = 0x80;
  bootPayload[basicProg.length + 1] = 0xaa;
  bootPayload[basicProg.length + 2] = 10; // autostart line 10
  bootPayload[basicProg.length + 3] = 0;

  return buildTrdImage(
    [
      {
        name: 'boot',
        ext: 'B',
        start: basicProg.length,
        lengthOverride: basicProg.length,
        payload: bootPayload,
      },
      {
        name: codeName,
        ext: 'C',
        start: org,
        payload: code,
      },
    ],
    diskLabel
  );
}

// ============================================================================
// 1. ZX SNAKE (Змейка) — Full Z80 Machine Code Game @ 0x8000
// ============================================================================
function buildSnakeTapClean(): Uint8Array {
  const a = new Z80Asm(0x8000);

  a.label('START');
  a.db(0xfb); // EI
  a.db(0x3e, 0x00, 0xd3, 0xfe); // black border
  a.call('INIT_GAME');

  a.label('MAIN_LOOP');
  a.db(0x76); // HALT
  a.call('READ_INPUT');
  a.ld16(0x3a, 'TICK_CNT');
  a.db(0x3d); // DEC A
  a.ld16(0x32, 'TICK_CNT');
  a.jr(0x20, 'MAIN_LOOP');

  a.ld16(0x3a, 'SPEED');
  a.ld16(0x32, 'TICK_CNT');
  a.call('STEP_SNAKE');
  a.jr(0x18, 'MAIN_LOOP');

  // --- INIT_GAME ---
  a.label('INIT_GAME');
  a.ld16(0x21, 0x4000);
  a.ld16(0x11, 0x4001);
  a.ld16(0x01, 0x17ff);
  a.db(0x36, 0x00);
  a.db(0xed, 0xb0);

  a.ld16(0x21, 0x5800);
  a.ld16(0x11, 0x5801);
  a.ld16(0x01, 0x02ff);
  a.db(0x36, 0x07); // black paper, white ink
  a.db(0xed, 0xb0);

  // Top wall row y=1 (0x5820..0x583F)
  a.ld16(0x21, 0x5820);
  a.db(0x06, 32);
  a.label('TW');
  a.db(0x36, 0x49); // bright blue block
  a.db(0x23);
  a.jr(0x10, 'TW');

  // Bottom wall row y=23 (0x5AE0..0x5AFF)
  a.ld16(0x21, 0x5ae0);
  a.db(0x06, 32);
  a.label('BW');
  a.db(0x36, 0x49);
  a.db(0x23);
  a.jr(0x10, 'BW');

  // Side walls y=2..22
  a.ld16(0x21, 0x5840);
  a.ld16(0x11, 31);
  a.db(0x06, 21);
  a.label('SW');
  a.db(0x36, 0x49); // left
  a.db(0x19); // ADD HL, DE (+31)
  a.db(0x36, 0x49); // right
  a.db(0x23); // INC HL -> start of next row
  a.jr(0x10, 'SW');

  // Draw HUD title "SNAKE  SCORE:000" at row 0 using ROM font!
  a.ld16(0x21, 'HUD_TEXT');
  a.db(0x1e, 0x00); // LD E, 0 (col = 0)
  a.call('DRAW_STR_ROW0');

  // Init vars
  a.db(0x3e, 0x01); // DIR = 1 (Right: 0=U,1=R,2=D,3=L)
  a.ld16(0x32, 'DIR');
  a.ld16(0x32, 'NEXT_DIR');
  a.db(0x3e, 0x07); // SPEED = 7 (~7 moves/sec)
  a.ld16(0x32, 'SPEED');
  a.ld16(0x32, 'TICK_CNT');
  a.db(0x3e, 0x04); // LEN = 4
  a.ld16(0x32, 'LEN');
  a.db(0xaf); // XOR A -> SCORE = 0
  a.ld16(0x32, 'SCORE_LO');
  a.ld16(0x32, 'SCORE_HI');

  // Initial segments: (5,12), (6,12), (7,12), (8,12) -> HEAD_IDX=3, TAIL_IDX=0
  a.ld16(0x21, 'SNAKE_X');
  a.db(0x36, 5, 0x23, 0x36, 6, 0x23, 0x36, 7, 0x23, 0x36, 8);
  a.ld16(0x21, 'SNAKE_Y');
  a.db(0x36, 12, 0x23, 0x36, 12, 0x23, 0x36, 12, 0x23, 0x36, 12);

  a.db(0x3e, 3);
  a.ld16(0x32, 'HEAD_IDX');
  a.db(0xaf);
  a.ld16(0x32, 'TAIL_IDX');

  // Draw initial 4 segments in bright green (0x64 = paper 4, ink 4, bright 1)
  a.db(0x06, 5, 0x0e, 12, 0x3e, 0x64); a.call('SET_ATTR');
  a.db(0x06, 6, 0x0e, 12, 0x3e, 0x64); a.call('SET_ATTR');
  a.db(0x06, 7, 0x0e, 12, 0x3e, 0x64); a.call('SET_ATTR');
  a.db(0x06, 8, 0x0e, 12, 0x3e, 0x76); a.call('SET_ATTR'); // yellow head

  a.call('SPAWN_FOOD');
  a.call('DRAW_SCORE');
  a.db(0xc9); // RET

  // --- READ_INPUT --- (reads Q/A/O/P, 7/6/5/8, Kempston 0x1F)
  a.label('READ_INPUT');
  a.ld16(0x3a, 'DIR');
  a.db(0x4f); // C = current DIR

  // Check Kempston port 0x1F
  a.db(0xdb, 0x1f); // IN A, (1Fh)
  a.db(0xe6, 0x1f);
  a.db(0xcb, 0x5f); // BIT 3, A (Up)
  a.jr(0x20, 'TRY_UP');
  a.db(0xcb, 0x57); // BIT 2, A (Down)
  a.jr(0x20, 'TRY_DOWN');
  a.db(0xcb, 0x4f); // BIT 1, A (Left)
  a.jr(0x20, 'TRY_LEFT');
  a.db(0xcb, 0x47); // BIT 0, A (Right)
  a.jr(0x20, 'TRY_RIGHT');

  // Check Q (port 0xFBFE bit 0) / 7 (0xEFFE bit 3)
  a.db(0x3e, 0xfb, 0xdb, 0xfe); // IN A, (FBFE)
  a.db(0xcb, 0x47); // BIT 0, A (Q)
  a.jr(0x28, 'TRY_UP');
  a.db(0x3e, 0xef, 0xdb, 0xfe); // IN A, (EFFE)
  a.db(0xcb, 0x5f); // BIT 3, A (7)
  a.jr(0x28, 'TRY_UP');

  // Check A (0xFDFE bit 0) / 6 (0xEFFE bit 4)
  a.db(0x3e, 0xfd, 0xdb, 0xfe);
  a.db(0xcb, 0x47); // BIT 0, A (A)
  a.jr(0x28, 'TRY_DOWN');
  a.db(0x3e, 0xef, 0xdb, 0xfe);
  a.db(0xcb, 0x67); // BIT 4, A (6)
  a.jr(0x28, 'TRY_DOWN');

  // Check O (0xDFFE bit 1) / 5 (0xF7FE bit 4)
  a.db(0x3e, 0xdf, 0xdb, 0xfe);
  a.db(0xcb, 0x4f); // BIT 1, A (O)
  a.jr(0x28, 'TRY_LEFT');
  a.db(0x3e, 0xf7, 0xdb, 0xfe);
  a.db(0xcb, 0x67); // BIT 4, A (5)
  a.jr(0x28, 'TRY_LEFT');

  // Check P (0xDFFE bit 0) / 8 (0xEFFE bit 2)
  a.db(0x3e, 0xdf, 0xdb, 0xfe);
  a.db(0xcb, 0x47); // BIT 0, A (P)
  a.jr(0x28, 'TRY_RIGHT');
  a.db(0x3e, 0xef, 0xdb, 0xfe);
  a.db(0xcb, 0x57); // BIT 2, A (8)
  a.jr(0x28, 'TRY_RIGHT');
  a.db(0xc9); // RET

  a.label('TRY_UP');
  a.db(0x79, 0xfe, 0x02, 0xc8); // LD A,C : CP 2 : RET Z (no 180 flip)
  a.db(0x3e, 0x00); a.ld16(0x32, 'NEXT_DIR'); a.db(0xc9);
  a.label('TRY_RIGHT');
  a.db(0x79, 0xfe, 0x03, 0xc8);
  a.db(0x3e, 0x01); a.ld16(0x32, 'NEXT_DIR'); a.db(0xc9);
  a.label('TRY_DOWN');
  a.db(0x79, 0xfe, 0x00, 0xc8);
  a.db(0x3e, 0x02); a.ld16(0x32, 'NEXT_DIR'); a.db(0xc9);
  a.label('TRY_LEFT');
  a.db(0x79, 0xfe, 0x01, 0xc8);
  a.db(0x3e, 0x03); a.ld16(0x32, 'NEXT_DIR'); a.db(0xc9);

  // --- STEP_SNAKE ---
  a.label('STEP_SNAKE');
  a.ld16(0x3a, 'NEXT_DIR');
  a.ld16(0x32, 'DIR');

  // Read current head (X in B, Y in C)
  a.ld16(0x3a, 'HEAD_IDX');
  a.db(0x5f, 0x16, 0x00); // LD E, A : LD D, 0
  a.ld16(0x21, 'SNAKE_X');
  a.db(0x19, 0x46); // ADD HL, DE : LD B, (HL)
  a.ld16(0x21, 'SNAKE_Y');
  a.db(0x19, 0x4e); // ADD HL, DE : LD C, (HL)

  // Paint old head as green body (0x64)
  a.db(0xc5); // PUSH BC
  a.db(0x3e, 0x64);
  a.call('SET_ATTR');
  a.db(0xc1); // POP BC (B=x, C=y)

  // Move (B,C) according to DIR
  a.ld16(0x3a, 'DIR');
  a.db(0xfe, 0x00); a.jr(0x28, 'MV_U');
  a.db(0xfe, 0x01); a.jr(0x28, 'MV_R');
  a.db(0xfe, 0x02); a.jr(0x28, 'MV_D');
  a.db(0x05); // DEC B (Left)
  a.jr(0x18, 'MV_DONE');
  a.label('MV_U'); a.db(0x0d); a.jr(0x18, 'MV_DONE'); // DEC C
  a.label('MV_R'); a.db(0x04); a.jr(0x18, 'MV_DONE'); // INC B
  a.label('MV_D'); a.db(0x0c); // INC C
  a.label('MV_DONE');

  // Inspect attr at new (B, C)
  a.db(0xc5); // PUSH BC
  a.call('GET_ATTR'); // returns A = attr
  a.db(0xc1); // POP BC

  // Check food (0x52 = bright red food!)
  a.db(0xfe, 0x52);
  a.jr(0x28, 'ATE_FOOD');
  // Check empty space (0x07)
  a.db(0xfe, 0x07);
  a.jr(0x28, 'MOVE_OK');

  // Collision! Game Over
  a.jp(0xc3, 'GAME_OVER');

  a.label('ATE_FOOD');
  // Increment score & spawn new food & do NOT advance tail!
  a.call('BEEP_EAT');
  a.ld16(0x21, 'SCORE_LO');
  a.db(0x34); // INC (HL)
  a.jr(0x20, 'NO_SC_CARRY');
  a.ld16(0x21, 'SCORE_HI');
  a.db(0x34);
  a.label('NO_SC_CARRY');
  a.call('DRAW_SCORE');
  a.call('PUSH_HEAD');
  a.call('SPAWN_FOOD');
  a.db(0xc9); // RET

  a.label('MOVE_OK');
  // Erase tail segment
  a.db(0xc5); // PUSH BC (new head)
  a.ld16(0x3a, 'TAIL_IDX');
  a.db(0x5f, 0x16, 0x00); // DE = tail idx
  a.ld16(0x21, 'SNAKE_X'); a.db(0x19, 0x46); // B = tail x
  a.ld16(0x21, 'SNAKE_Y'); a.db(0x19, 0x4e); // C = tail y
  a.db(0x3e, 0x07);
  a.call('SET_ATTR');
  a.ld16(0x3a, 'TAIL_IDX');
  a.db(0x3c); // INC A (mod 256)
  a.ld16(0x32, 'TAIL_IDX');
  a.db(0xc1); // POP BC (new head)
  a.call('PUSH_HEAD');
  a.db(0xc9);

  // PUSH_HEAD: stores B,C at HEAD_IDX+1 and draws yellow head (0x76)
  a.label('PUSH_HEAD');
  a.ld16(0x3a, 'HEAD_IDX');
  a.db(0x3c); // INC A (mod 256)
  a.ld16(0x32, 'HEAD_IDX');
  a.db(0x5f, 0x16, 0x00);
  a.ld16(0x21, 'SNAKE_X'); a.db(0x19, 0x70); // LD (HL), B
  a.ld16(0x21, 'SNAKE_Y'); a.db(0x19, 0x71); // LD (HL), C
  a.db(0x3e, 0x76); // bright yellow block for head
  a.call('SET_ATTR');
  a.db(0xc9);

  // --- SPAWN_FOOD ---
  a.label('SPAWN_FOOD');
  a.db(0xed, 0x5f); // LD A, R
  a.ld16(0x21, 'SEED');
  a.db(0xae); // XOR (HL)
  a.db(0x3c); // INC A
  a.db(0x77); // LD (HL), A
  a.db(0xe6, 0x1f); // 0..31
  a.db(0xfe, 0x00); a.jr(0x28, 'SPAWN_FOOD');
  a.db(0xfe, 0x1f); a.jr(0x28, 'SPAWN_FOOD');
  a.db(0x47); // B = X (1..30)

  a.db(0xed, 0x5f); // LD A, R
  a.db(0x87); // ADD A, A
  a.db(0x80); // ADD A, B
  a.db(0xe6, 0x1f);
  a.db(0xfe, 0x02); a.jr(0x38, 'SPAWN_FOOD'); // < 2
  a.db(0xfe, 23); a.jr(0x30, 'SPAWN_FOOD'); // >= 23
  a.db(0x4f); // C = Y (2..22)

  a.db(0xc5);
  a.call('GET_ATTR');
  a.db(0xc1);
  a.db(0xfe, 0x07); // must be empty
  a.jr(0x20, 'SPAWN_FOOD');

  a.db(0x3e, 0x52); // bright red food (paper 2, ink 2, bright 1)
  a.call('SET_ATTR');
  a.db(0xc9);

  // --- GAME_OVER ---
  a.label('GAME_OVER');
  a.call('BEEP_DIE');
  a.ld16(0x21, 'GO_TEXT');
  a.db(0x1e, 20); // col 20 row 0
  a.call('DRAW_STR_ROW0');

  a.label('WAIT_SPACE');
  a.db(0x76); // HALT
  a.db(0x3e, 0x7f, 0xdb, 0xfe); // SPACE row
  a.db(0xcb, 0x47); // BIT 0, A
  a.jr(0x20, 'WAIT_SPACE'); // wait until SPACE pressed
  a.jp(0xc3, 'START');

  // --- SET_ATTR (B=x 0..31, C=y 0..23, A=attr) ---
  a.label('SET_ATTR');
  a.db(0xf5); // PUSH AF
  a.call('CALC_ATTR');
  a.db(0xf1); // POP AF
  a.db(0x77); // LD (HL), A
  a.db(0xc9);

  // --- GET_ATTR (B=x, C=y -> A=attr) ---
  a.label('GET_ATTR');
  a.call('CALC_ATTR');
  a.db(0x7e); // LD A, (HL)
  a.db(0xc9);

  // --- CALC_ATTR (B=x, C=y -> HL = 0x5800 + y*32 + x) ---
  a.label('CALC_ATTR');
  a.db(0x69); // LD L, C
  a.db(0x26, 0x00); // LD H, 0
  a.db(0x29, 0x29, 0x29, 0x29, 0x29); // ADD HL, HL x5 (*32)
  a.db(0x7d, 0x80, 0x6f); // LD A,L : ADD A,B : LD L,A
  a.db(0x7c, 0xc6, 0x58, 0x67); // LD A,H : ADD A,58h : LD H,A
  a.db(0xc9);

  // --- DRAW_STR_ROW0 (HL = null-term string, E = start col) ---
  a.label('DRAW_STR_ROW0');
  a.db(0x7e); // LD A, (HL)
  a.db(0xb7, 0xc8); // OR A : RET Z
  a.db(0xe5, 0xd5); // PUSH HL, DE
  a.call('DRAW_CHAR_ROW0');
  a.db(0xd1, 0xe1); // POP DE, HL
  a.db(0x23, 0x1c); // INC HL : INC E
  a.jr(0x18, 'DRAW_STR_ROW0');

  // --- DRAW_CHAR_ROW0 (A = ASCII, E = col 0..31) ---
  a.label('DRAW_CHAR_ROW0');
  // Font glyph at 0x3D00 + (A - 32) * 8
  a.db(0xd6, 32); // SUB 32
  a.db(0x6f, 0x26, 0x00); // LD L, A : LD H, 0
  a.db(0x29, 0x29, 0x29); // *8
  a.ld16(0x01, 0x3d00);
  a.db(0x09); // ADD HL, BC -> glyph ptr
  // Screen row 0 col E = 0x4000 + E, +0x100 per pixel line
  a.db(0x16, 0x40); // LD D, 40h
  a.db(0x06, 8);
  a.label('CH_LP');
  a.db(0x7e); // LD A, (HL)
  a.db(0x12); // LD (DE), A
  a.db(0x23, 0x14); // INC HL : INC D
  a.jr(0x10, 'CH_LP');
  a.db(0xc9);

  // --- DRAW_SCORE (prints 3-digit score at col 13..15 row 0) ---
  a.label('DRAW_SCORE');
  a.ld16(0x21, 'SCORE_LO');
  a.db(0x7e); // A = score (0..255)
  a.db(0x06, 0x30); // B = '0' hundreds
  a.label('HUND');
  a.db(0xfe, 100); a.jr(0x38, 'HUND_DONE');
  a.db(0xd6, 100, 0x04); a.jr(0x18, 'HUND');
  a.label('HUND_DONE');
  a.db(0xf5); // save rem
  a.db(0x78, 0x1e, 13); a.call('DRAW_CHAR_ROW0'); // print B at col 13
  a.db(0xf1); // restore rem
  a.db(0x06, 0x30); // B = '0' tens
  a.label('TENS');
  a.db(0xfe, 10); a.jr(0x38, 'TENS_DONE');
  a.db(0xd6, 10, 0x04); a.jr(0x18, 'TENS');
  a.label('TENS_DONE');
  a.db(0xf5);
  a.db(0x78, 0x1e, 14); a.call('DRAW_CHAR_ROW0');
  a.db(0xf1);
  a.db(0xc6, 0x30, 0x1e, 15); a.call('DRAW_CHAR_ROW0');
  a.db(0xc9);

  // --- BEEP_EAT / BEEP_DIE ---
  a.label('BEEP_EAT');
  a.db(0x06, 20);
  a.label('BE1');
  a.db(0x3e, 0x10, 0xd3, 0xfe);
  a.db(0x0e, 45); a.label('BE2'); a.db(0x0d); a.jr(0x20, 'BE2');
  a.db(0x3e, 0x00, 0xd3, 0xfe);
  a.db(0x0e, 45); a.label('BE3'); a.db(0x0d); a.jr(0x20, 'BE3');
  a.jr(0x10, 'BE1');
  a.db(0xc9);

  a.label('BEEP_DIE');
  a.db(0x06, 35);
  a.label('BD1');
  a.db(0x3e, 0x12, 0xd3, 0xfe); // red border flash + ear
  a.db(0x0e, 140); a.label('BD2'); a.db(0x0d); a.jr(0x20, 'BD2');
  a.db(0x3e, 0x00, 0xd3, 0xfe);
  a.db(0x0e, 140); a.label('BD3'); a.db(0x0d); a.jr(0x20, 'BD3');
  a.jr(0x10, 'BD1');
  a.db(0xc9);

  // Data
  a.label('HUD_TEXT'); a.ascii('SNAKE  SCORE:000'); a.db(0);
  a.label('GO_TEXT'); a.ascii('OVER! SPACE'); a.db(0);
  a.label('DIR'); a.db(1);
  a.label('NEXT_DIR'); a.db(1);
  a.label('SPEED'); a.db(7);
  a.label('TICK_CNT'); a.db(7);
  a.label('HEAD_IDX'); a.db(3);
  a.label('TAIL_IDX'); a.db(0);
  a.label('LEN'); a.db(4);
  a.label('SCORE_LO'); a.db(0);
  a.label('SCORE_HI'); a.db(0);
  a.label('SEED'); a.db(0x5a);
  a.label('SNAKE_X'); for (let i = 0; i < 256; i++) a.db(0);
  a.label('SNAKE_Y'); for (let i = 0; i < 256; i++) a.db(0);

  return wrapMachineCodeTap('SNAKE', a.finish(), 0x8000);
}

// ============================================================================
// 2. BRICK BREAKER (Арканоид) — Full Z80 Machine Code Game @ 0x8000
// ============================================================================
function buildBreakoutTap(): Uint8Array {
  const a = new Z80Asm(0x8000);

  a.label('START');
  a.db(0xfb); // EI
  a.db(0x3e, 0x00, 0xd3, 0xfe);
  a.call('INIT_GAME');

  a.label('LOOP');
  a.db(0x76); // HALT (50Hz)
  a.call('MOVE_PADDLE');

  // Move ball every 3 frames
  a.ld16(0x3a, 'BTICK');
  a.db(0x3d);
  a.ld16(0x32, 'BTICK');
  a.jr(0x20, 'LOOP');
  a.db(0x3e, 3);
  a.ld16(0x32, 'BTICK');
  a.call('STEP_BALL');
  a.jr(0x18, 'LOOP');

  // --- INIT_GAME ---
  a.label('INIT_GAME');
  a.ld16(0x21, 0x4000); a.ld16(0x11, 0x4001); a.ld16(0x01, 0x17ff);
  a.db(0x36, 0x00, 0xed, 0xb0);
  a.ld16(0x21, 0x5800); a.ld16(0x11, 0x5801); a.ld16(0x01, 0x02ff);
  a.db(0x36, 0x07, 0xed, 0xb0);

  // HUD row 0
  a.ld16(0x21, 'HUD'); a.db(0x1e, 0x00); a.call('DRAW_STR');

  // Draw 4 rows of colorful bricks (rows 3..6, cols 1..30)
  // Row 3: red (0x52), Row 4: yellow (0x76), Row 5: green (0x64), Row 6: cyan (0x6d)
  a.db(0x0e, 3, 0x3e, 0x52); a.call('FILL_ROW');
  a.db(0x0e, 4, 0x3e, 0x76); a.call('FILL_ROW');
  a.db(0x0e, 5, 0x3e, 0x64); a.call('FILL_ROW');
  a.db(0x0e, 6, 0x3e, 0x6d); a.call('FILL_ROW');

  // Init paddle x=13 (width 5 at row 22), ball at (15, 20), dx=1, dy=-1
  a.db(0x3e, 13); a.ld16(0x32, 'PAD_X');
  a.db(0x3e, 15); a.ld16(0x32, 'BALL_X');
  a.db(0x3e, 20); a.ld16(0x32, 'BALL_Y');
  a.db(0x3e, 1); a.ld16(0x32, 'BALL_DX');
  a.db(0x3e, 0xff); a.ld16(0x32, 'BALL_DY');
  a.db(0x3e, 3); a.ld16(0x32, 'BTICK');
  a.db(0xaf); a.ld16(0x32, 'SCORE');

  a.call('DRAW_PAD');
  a.call('DRAW_BALL');
  a.call('DRAW_SCORE');
  a.db(0xc9);

  // FILL_ROW: C=row, A=attr -> fills cols 1..30 (leaving 0 and 31 empty? No, full width 0..31!)
  a.label('FILL_ROW');
  a.db(0xf5);
  a.db(0x06, 0x00); a.call('CALC_ATTR');
  a.db(0xf1);
  a.db(0x06, 32);
  a.label('FR_LP');
  a.db(0x77, 0x23);
  a.jr(0x10, 'FR_LP');
  a.db(0xc9);

  // --- MOVE_PADDLE (O/P, 5/8, Kempston) ---
  a.label('MOVE_PADDLE');
  a.db(0x06, 0x00); // B = delta (0)
  // Kempston
  a.db(0xdb, 0x1f, 0xe6, 0x1f);
  a.db(0xcb, 0x4f); a.jr(0x20, 'MP_L'); // bit 1 left
  a.db(0xcb, 0x47); a.jr(0x20, 'MP_R'); // bit 0 right
  // O (0xDFFE bit 1) / 5 (0xF7FE bit 4)
  a.db(0x3e, 0xdf, 0xdb, 0xfe, 0xcb, 0x4f); a.jr(0x28, 'MP_L');
  a.db(0x3e, 0xf7, 0xdb, 0xfe, 0xcb, 0x67); a.jr(0x28, 'MP_L');
  // P (0xDFFE bit 0) / 8 (0xEFFE bit 2)
  a.db(0x3e, 0xdf, 0xdb, 0xfe, 0xcb, 0x47); a.jr(0x28, 'MP_R');
  a.db(0x3e, 0xef, 0xdb, 0xfe, 0xcb, 0x57); a.jr(0x28, 'MP_R');
  a.db(0xc9);

  a.label('MP_L');
  a.ld16(0x3a, 'PAD_X');
  a.db(0xb7, 0xc8); // if 0 ret
  a.call('ERASE_PAD');
  a.ld16(0x3a, 'PAD_X'); a.db(0x3d); a.ld16(0x32, 'PAD_X');
  a.call('DRAW_PAD');
  a.db(0xc9);

  a.label('MP_R');
  a.ld16(0x3a, 'PAD_X');
  a.db(0xfe, 27, 0xc8); // max 27 (27+5=32)
  a.call('ERASE_PAD');
  a.ld16(0x3a, 'PAD_X'); a.db(0x3c); a.ld16(0x32, 'PAD_X');
  a.call('DRAW_PAD');
  a.db(0xc9);

  a.label('ERASE_PAD');
  a.db(0x3e, 0x07);
  a.jr(0x18, 'PAD_FILL');
  a.label('DRAW_PAD');
  a.db(0x3e, 0x7f); // bright white block
  a.label('PAD_FILL');
  a.db(0xf5);
  a.ld16(0x3a, 'PAD_X'); a.db(0x47); // B = PAD_X
  a.db(0x0e, 22); // C = 22
  a.call('CALC_ATTR');
  a.db(0xf1);
  a.db(0x06, 5);
  a.label('PF_LP'); a.db(0x77, 0x23); a.jr(0x10, 'PF_LP');
  a.db(0xc9);

  // --- STEP_BALL ---
  a.label('STEP_BALL');
  a.call('ERASE_BALL');

  // New X = BALL_X + BALL_DX
  a.ld16(0x3a, 'BALL_X'); a.db(0x47);
  a.ld16(0x3a, 'BALL_DX'); a.db(0x80); // A = X + DX
  a.db(0xfe, 32); a.jr(0x38, 'BX_OK'); // < 32? (handles -1 as 255 >= 32!)
  // Flip DX
  a.ld16(0x3a, 'BALL_DX'); a.db(0xed, 0x44); a.ld16(0x32, 'BALL_DX'); // NEG
  a.ld16(0x3a, 'BALL_X');
  a.jr(0x18, 'BX_SET');
  a.label('BX_OK');
  a.ld16(0x32, 'BALL_X');
  a.label('BX_SET');

  // New Y = BALL_Y + BALL_DY
  a.ld16(0x3a, 'BALL_Y'); a.db(0x47);
  a.ld16(0x3a, 'BALL_DY'); a.db(0x80); // A = Y + DY
  a.db(0xfe, 1); a.jr(0x30, 'BY_NOT_TOP'); // >= 1
  // Hit top (y < 1) -> bounce down
  a.db(0x3e, 1); a.ld16(0x32, 'BALL_DY');
  a.db(0x3e, 1);
  a.jr(0x18, 'BY_SET');

  a.label('BY_NOT_TOP');
  a.db(0xfe, 24); a.jr(0x38, 'BY_SET');
  // Missed paddle (y >= 24) -> Game Over!
  a.jp(0xc3, 'GAME_OVER');

  a.label('BY_SET');
  a.ld16(0x32, 'BALL_Y');

  // Check attr at (BALL_X, BALL_Y)
  a.ld16(0x3a, 'BALL_X'); a.db(0x47);
  a.ld16(0x3a, 'BALL_Y'); a.db(0x4f);
  a.call('CALC_ATTR');
  a.db(0x7e); // A = attr at ball pos
  a.db(0xfe, 0x07); a.jr(0x28, 'BALL_DONE');

  // Hit paddle (0x7f) or brick!
  a.db(0xfe, 0x7f); a.jr(0x28, 'HIT_PAD');

  // Hit brick: erase brick, score++, bounce DY
  a.db(0x36, 0x07); // erase brick
  a.ld16(0x21, 'SCORE'); a.db(0x34);
  a.call('DRAW_SCORE');
  a.call('BEEP_HIT');
  a.ld16(0x3a, 'BALL_DY'); a.db(0xed, 0x44); a.ld16(0x32, 'BALL_DY');
  a.jr(0x18, 'BALL_DONE');

  a.label('HIT_PAD');
  a.call('BEEP_PAD');
  a.db(0x3e, 0xff); a.ld16(0x32, 'BALL_DY');
  a.db(0x3e, 21); a.ld16(0x32, 'BALL_Y');

  a.label('BALL_DONE');
  a.call('DRAW_BALL');
  a.db(0xc9);

  a.label('ERASE_BALL');
  a.db(0x3e, 0x07);
  a.jr(0x18, 'BALL_ATTR');
  a.label('DRAW_BALL');
  a.db(0x3e, 0x7f); // bright white ball
  a.label('BALL_ATTR');
  a.db(0xf5);
  a.ld16(0x3a, 'BALL_X'); a.db(0x47);
  a.ld16(0x3a, 'BALL_Y'); a.db(0x4f);
  a.call('CALC_ATTR');
  a.db(0xf1, 0x77);
  a.db(0xc9);

  a.label('GAME_OVER');
  a.ld16(0x21, 'GO_MSG'); a.db(0x1e, 18); a.call('DRAW_STR');
  a.label('WAIT_SPC');
  a.db(0x76);
  a.db(0x3e, 0x7f, 0xdb, 0xfe, 0xcb, 0x47);
  a.jr(0x20, 'WAIT_SPC');
  a.jp(0xc3, 'START');

  // Helpers
  a.label('CALC_ATTR');
  a.db(0x69, 0x26, 0x00, 0x29, 0x29, 0x29, 0x29, 0x29);
  a.db(0x7d, 0x80, 0x6f, 0x7c, 0xc6, 0x58, 0x67, 0xc9);

  a.label('DRAW_STR');
  a.db(0x7e, 0xb7, 0xc8);
  a.db(0xe5, 0xd5); a.call('DRAW_CH'); a.db(0xd1, 0xe1);
  a.db(0x23, 0x1c); a.jr(0x18, 'DRAW_STR');

  a.label('DRAW_CH');
  a.db(0xd6, 32, 0x6f, 0x26, 0x00, 0x29, 0x29, 0x29);
  a.ld16(0x01, 0x3d00); a.db(0x09, 0x16, 0x40, 0x06, 8);
  a.label('DC_LP'); a.db(0x7e, 0x12, 0x23, 0x14); a.jr(0x10, 'DC_LP'); a.db(0xc9);

  a.label('DRAW_SCORE');
  a.ld16(0x3a, 'SCORE');
  a.db(0x06, 0x30);
  a.label('DS_H'); a.db(0xfe, 100); a.jr(0x38, 'DS_HD'); a.db(0xd6, 100, 0x04); a.jr(0x18, 'DS_H');
  a.label('DS_HD'); a.db(0xf5, 0x78, 0x1e, 12); a.call('DRAW_CH'); a.db(0xf1);
  a.db(0x06, 0x30);
  a.label('DS_T'); a.db(0xfe, 10); a.jr(0x38, 'DS_TD'); a.db(0xd6, 10, 0x04); a.jr(0x18, 'DS_T');
  a.label('DS_TD'); a.db(0xf5, 0x78, 0x1e, 13); a.call('DRAW_CH'); a.db(0xf1);
  a.db(0xc6, 0x30, 0x1e, 14); a.call('DRAW_CH'); a.db(0xc9);

  a.label('BEEP_HIT');
  a.db(0x06, 12);
  a.label('BH1'); a.db(0x3e, 0x10, 0xd3, 0xfe, 0x0e, 30); a.label('BH2'); a.db(0x0d); a.jr(0x20, 'BH2');
  a.db(0x3e, 0x00, 0xd3, 0xfe, 0x0e, 30); a.label('BH3'); a.db(0x0d); a.jr(0x20, 'BH3');
  a.jr(0x10, 'BH1'); a.db(0xc9);

  a.label('BEEP_PAD');
  a.db(0x06, 10);
  a.label('BP1'); a.db(0x3e, 0x10, 0xd3, 0xfe, 0x0e, 60); a.label('BP2'); a.db(0x0d); a.jr(0x20, 'BP2');
  a.db(0x3e, 0x00, 0xd3, 0xfe, 0x0e, 60); a.label('BP3'); a.db(0x0d); a.jr(0x20, 'BP3');
  a.jr(0x10, 'BP1'); a.db(0xc9);

  a.label('HUD'); a.ascii('BRICK SCORE:000'); a.db(0);
  a.label('GO_MSG'); a.ascii('GAME OVER!SPC'); a.db(0);
  a.label('PAD_X'); a.db(13);
  a.label('BALL_X'); a.db(15);
  a.label('BALL_Y'); a.db(20);
  a.label('BALL_DX'); a.db(1);
  a.label('BALL_DY'); a.db(0xff);
  a.label('BTICK'); a.db(3);
  a.label('SCORE'); a.db(0);

  return wrapMachineCodeTap('BRICKS', a.finish(), 0x8000);
}

// ============================================================================
// 3. SPACE DODGE (Метеор) — Z80 Arcade Dodger @ 0x8000
// ============================================================================
function buildSpaceDodgeTap(): Uint8Array {
  const a = new Z80Asm(0x8000);

  a.label('START');
  a.db(0xfb, 0x3e, 0x00, 0xd3, 0xfe);
  a.call('INIT_GAME');

  a.label('LOOP');
  a.db(0x76); // HALT
  a.call('MOVE_SHIP');
  a.ld16(0x3a, 'TICK'); a.db(0x3d); a.ld16(0x32, 'TICK');
  a.jr(0x20, 'LOOP');
  a.db(0x3e, 3); a.ld16(0x32, 'TICK');
  a.call('SCROLL_METEORS');
  a.jr(0x18, 'LOOP');

  a.label('INIT_GAME');
  a.ld16(0x21, 0x4000); a.ld16(0x11, 0x4001); a.ld16(0x01, 0x17ff); a.db(0x36, 0x00, 0xed, 0xb0);
  a.ld16(0x21, 0x5800); a.ld16(0x11, 0x5801); a.ld16(0x01, 0x02ff); a.db(0x36, 0x07, 0xed, 0xb0);
  a.ld16(0x21, 'HUD'); a.db(0x1e, 0x00); a.call('DRAW_STR');
  a.db(0x3e, 15); a.ld16(0x32, 'SHIP_X');
  a.db(0x3e, 3); a.ld16(0x32, 'TICK');
  a.db(0xaf); a.ld16(0x32, 'SCORE');
  a.call('DRAW_SHIP');
  a.call('DRAW_SCORE');
  a.db(0xc9);

  a.label('MOVE_SHIP');
  a.db(0xdb, 0x1f, 0xe6, 0x1f);
  a.db(0xcb, 0x4f); a.jr(0x20, 'MS_L');
  a.db(0xcb, 0x47); a.jr(0x20, 'MS_R');
  a.db(0x3e, 0xdf, 0xdb, 0xfe, 0xcb, 0x4f); a.jr(0x28, 'MS_L');
  a.db(0x3e, 0xf7, 0xdb, 0xfe, 0xcb, 0x67); a.jr(0x28, 'MS_L');
  a.db(0x3e, 0xdf, 0xdb, 0xfe, 0xcb, 0x47); a.jr(0x28, 'MS_R');
  a.db(0x3e, 0xef, 0xdb, 0xfe, 0xcb, 0x57); a.jr(0x28, 'MS_R');
  a.db(0xc9);

  a.label('MS_L');
  a.ld16(0x3a, 'SHIP_X'); a.db(0xb7, 0xc8);
  a.call('ERASE_SHIP');
  a.ld16(0x3a, 'SHIP_X'); a.db(0x3d); a.ld16(0x32, 'SHIP_X');
  a.call('DRAW_SHIP');
  a.db(0xc9);

  a.label('MS_R');
  a.ld16(0x3a, 'SHIP_X'); a.db(0xfe, 31, 0xc8);
  a.call('ERASE_SHIP');
  a.ld16(0x3a, 'SHIP_X'); a.db(0x3c); a.ld16(0x32, 'SHIP_X');
  a.call('DRAW_SHIP');
  a.db(0xc9);

  a.label('ERASE_SHIP'); a.db(0x3e, 0x07); a.jr(0x18, 'SHIP_A');
  a.label('DRAW_SHIP'); a.db(0x3e, 0x6d); // bright cyan ship
  a.label('SHIP_A');
  a.db(0xf5);
  a.ld16(0x3a, 'SHIP_X'); a.db(0x47, 0x0e, 22); a.call('CALC_ATTR');
  a.db(0xf1, 0x77, 0xc9);

  // Scroll attr rows 22 down from row 1 using LDDR from 0x5AD0-1 down to 0x5820!
  a.label('SCROLL_METEORS');
  // First check collision at ship position (row 21, SHIP_X)
  a.ld16(0x3a, 'SHIP_X'); a.db(0x47, 0x0e, 21); a.call('CALC_ATTR');
  a.db(0x7e, 0xfe, 0x52); // bright red meteor right above ship?
  a.jp(0xca, 'GAME_OVER');

  // Copy rows 1..22 down to 2..23 (22 * 32 = 704 bytes)
  a.ld16(0x21, 0x5adf); // end of row 22
  a.ld16(0x11, 0x5aff); // end of row 23
  a.ld16(0x01, 22 * 32);
  a.db(0xed, 0xb8); // LDDR

  // Clear row 1 (0x5820..0x583F)
  a.ld16(0x21, 0x5820); a.ld16(0x11, 0x5821); a.ld16(0x01, 31);
  a.db(0x36, 0x07, 0xed, 0xb0);

  // Spawn 2 random meteors on row 1
  a.db(0xed, 0x5f); a.ld16(0x21, 'SEED'); a.db(0xaa, 0x3c, 0x77);
  a.db(0xe6, 0x1f, 0x47, 0x0e, 1); a.call('CALC_ATTR'); a.db(0x36, 0x52);
  a.db(0xed, 0x5f, 0x87, 0x3c, 0xe6, 0x1f, 0x47, 0x0e, 1); a.call('CALC_ATTR'); a.db(0x36, 0x52);

  // Redraw ship on row 22
  a.call('DRAW_SHIP');
  a.ld16(0x21, 'SCORE'); a.db(0x34);
  a.call('DRAW_SCORE');
  a.db(0xc9);

  a.label('GAME_OVER');
  a.ld16(0x21, 'GO_MSG'); a.db(0x1e, 18); a.call('DRAW_STR');
  a.label('WAIT_S');
  a.db(0x76, 0x3e, 0x7f, 0xdb, 0xfe, 0xcb, 0x47); a.jr(0x20, 'WAIT_S');
  a.jp(0xc3, 'START');

  a.label('CALC_ATTR');
  a.db(0x69, 0x26, 0x00, 0x29, 0x29, 0x29, 0x29, 0x29);
  a.db(0x7d, 0x80, 0x6f, 0x7c, 0xc6, 0x58, 0x67, 0xc9);

  a.label('DRAW_STR');
  a.db(0x7e, 0xb7, 0xc8);
  a.db(0xe5, 0xd5); a.call('DRAW_CH'); a.db(0xd1, 0xe1);
  a.db(0x23, 0x1c); a.jr(0x18, 'DRAW_STR');

  a.label('DRAW_CH');
  a.db(0xd6, 32, 0x6f, 0x26, 0x00, 0x29, 0x29, 0x29);
  a.ld16(0x01, 0x3d00); a.db(0x09, 0x16, 0x40, 0x06, 8);
  a.label('DC'); a.db(0x7e, 0x12, 0x23, 0x14); a.jr(0x10, 'DC'); a.db(0xc9);

  a.label('DRAW_SCORE');
  a.ld16(0x3a, 'SCORE');
  a.db(0x06, 0x30);
  a.label('SH'); a.db(0xfe, 100); a.jr(0x38, 'SHD'); a.db(0xd6, 100, 0x04); a.jr(0x18, 'SH');
  a.label('SHD'); a.db(0xf5, 0x78, 0x1e, 12); a.call('DRAW_CH'); a.db(0xf1);
  a.db(0x06, 0x30);
  a.label('ST'); a.db(0xfe, 10); a.jr(0x38, 'STD'); a.db(0xd6, 10, 0x04); a.jr(0x18, 'ST');
  a.label('STD'); a.db(0xf5, 0x78, 0x1e, 13); a.call('DRAW_CH'); a.db(0xf1);
  a.db(0xc6, 0x30, 0x1e, 14); a.call('DRAW_CH'); a.db(0xc9);

  a.label('HUD'); a.ascii('DODGE SCORE:000'); a.db(0);
  a.label('GO_MSG'); a.ascii('CRASH! SPC'); a.db(0);
  a.label('SHIP_X'); a.db(15);
  a.label('TICK'); a.db(3);
  a.label('SCORE'); a.db(0);
  a.label('SEED'); a.db(0x37);

  return wrapMachineCodeTap('DODGE', a.finish(), 0x8000);
}

// ============================================================================
// 4. SINCLAIR BASIC GRAPHICS & BEEPER DEMO (.TAP)
// ============================================================================
function buildBasicDemoTap(): Uint8Array {
  const lines = [
    ...encodeBasicLine(10, [
      TOK.BORDER, ...encodeBasicNumber(0), ':',
      TOK.PAPER, ...encodeBasicNumber(0), ':',
      TOK.INK, ...encodeBasicNumber(7), ':',
      TOK.CLS,
    ]),
    ...encodeBasicLine(20, [
      TOK.PRINT, TOK.AT, ...encodeBasicNumber(1), ',', ...encodeBasicNumber(4), ';',
      '"ZX SPECTRUM 48K BASIC"',
    ]),
    ...encodeBasicLine(30, [
      TOK.FOR, 'r=', ...encodeBasicNumber(10), TOK.TO, ...encodeBasicNumber(75), ' STEP ', ...encodeBasicNumber(8),
    ]),
    ...encodeBasicLine(40, [
      TOK.INK, ...encodeBasicNumber(6), ':',
      TOK.CIRCLE, ...encodeBasicNumber(128), ',', ...encodeBasicNumber(88), ',', 'r',
    ]),
    ...encodeBasicLine(50, [
      TOK.BEEP, ...encodeBasicNumber(0), '.05,r/3',
    ]),
    ...encodeBasicLine(60, [
      TOK.NEXT, 'r',
    ]),
    ...encodeBasicLine(70, [
      TOK.PRINT, TOK.AT, ...encodeBasicNumber(20), ',', ...encodeBasicNumber(2), ';',
      '"CAPS+SPACE = BREAK / LIST"',
    ]),
  ];
  const basicBytes = new Uint8Array(lines);
  return concatUint8Arrays([
    buildTapHeader(0, 'DEMO', basicBytes.length, 10, basicBytes.length),
    buildTapBlock(0xff, basicBytes),
  ]);
}

// ============================================================================
// 5. PENTAGON 128 TR-DOS + AY-3-8910 CHIPTUNE & RASTER DEMO (.TRD)
// ============================================================================
function buildAyTrdDemo(): Uint8Array {
  const a = new Z80Asm(0x8000);

  a.label('START');
  a.db(0xfb); // EI
  a.db(0x3e, 0x00, 0xd3, 0xfe); // black border

  // Clear pixels & attrs
  a.ld16(0x21, 0x4000); a.ld16(0x11, 0x4001); a.ld16(0x01, 0x17ff);
  a.db(0x36, 0x00, 0xed, 0xb0);
  a.ld16(0x21, 0x5800); a.ld16(0x11, 0x5801); a.ld16(0x01, 0x02ff);
  a.db(0x36, 0x47, 0xed, 0xb0); // bright white on black

  // Draw HUD row 0 & footer row 2
  a.ld16(0x21, 'TXT_TOP'); a.db(0x1e, 0x00); a.call('DRAW_STR_R0');

  // Enable AY channels A, B, C tone (reg 7 = 0b11111000 = 0xF8)
  a.db(0x3e, 0x07, 0x06, 0xf8); a.call('AY_OUT');
  // Volumes A=12, B=10, C=10
  a.db(0x3e, 0x08, 0x06, 0x0c); a.call('AY_OUT');
  a.db(0x3e, 0x09, 0x06, 0x0a); a.call('AY_OUT');
  a.db(0x3e, 0x0a, 0x06, 0x0a); a.call('AY_OUT');

  a.label('MAIN');
  a.db(0x76); // HALT (50Hz)

  // Increment frame counter & advance music every 8 frames
  a.ld16(0x3a, 'FRAME');
  a.db(0x3c); // INC A
  a.ld16(0x32, 'FRAME');
  a.db(0xe6, 0x07);
  a.jr(0x20, 'ANIMATE');

  // Advance note index (0..15)
  a.ld16(0x3a, 'NOTE_IDX');
  a.db(0x3c, 0xe6, 0x0f);
  a.ld16(0x32, 'NOTE_IDX');
  a.db(0x87); // *2 for word table
  a.db(0x5f, 0x16, 0x00); // DE = idx*2

  // Channel A bass note
  a.ld16(0x21, 'BASS_TBL');
  a.db(0x19);
  a.db(0x46, 0x3e, 0x00); a.call('AY_OUT'); // R0 = lo
  a.db(0x23, 0x46, 0x3e, 0x01); a.call('AY_OUT'); // R1 = hi

  // Channel B lead note
  a.ld16(0x21, 'LEAD_TBL');
  a.db(0x19);
  a.db(0x46, 0x3e, 0x02); a.call('AY_OUT'); // R2 = lo
  a.db(0x23, 0x46, 0x3e, 0x03); a.call('AY_OUT'); // R3 = hi

  // Channel C arpeggio (shifted)
  a.ld16(0x21, 'ARP_TBL');
  a.db(0x19);
  a.db(0x46, 0x3e, 0x04); a.call('AY_OUT'); // R4 = lo
  a.db(0x23, 0x46, 0x3e, 0x05); a.call('AY_OUT'); // R5 = hi

  // Animate colorful attribute bars on rows 6..18
  a.label('ANIMATE');
  a.ld16(0x3a, 'PHASE');
  a.db(0x3c);
  a.ld16(0x32, 'PHASE');
  a.db(0x4f); // C = phase

  a.ld16(0x21, 0x5800 + 6 * 32); // row 6
  a.db(0x06, 12); // 12 rows
  a.label('ROW_LP');
  a.db(0xc5); // PUSH BC (save row count & phase)
  a.db(0x79, 0x80, 0xe6, 0x07); // color = (phase + row) & 7
  a.db(0xfe, 0x00); a.jr(0x20, 'COL_OK'); a.db(0x3e, 0x01); // avoid black
  a.label('COL_OK');
  a.db(0x07, 0x07, 0x07); // paper = color << 3
  a.db(0xf6, 0x47); // bright + white ink
  a.db(0x06, 32);
  a.label('COL_LP');
  a.db(0x77, 0x23); // LD (HL), A : INC HL
  a.jr(0x10, 'COL_LP');
  a.db(0xc1); // POP BC
  a.jr(0x10, 'ROW_LP');

  a.jp(0xc3, 'MAIN');

  // AY_OUT: A = register, B = value
  a.label('AY_OUT');
  a.db(0xc5); // PUSH BC
  a.db(0x01, 0xfd, 0xff); // LD BC, 0xFFFD
  a.db(0xed, 0x79); // OUT (C), A
  a.db(0xc1); // POP BC
  a.db(0x78); // LD A, B
  a.db(0x01, 0xfd, 0xbf); // LD BC, 0xBFFD
  a.db(0xed, 0x79); // OUT (C), A
  a.db(0xc9);

  // DRAW_STR_R0: HL = null-term string, E = start col
  a.label('DRAW_STR_R0');
  a.db(0x7e, 0xb7, 0xc8);
  a.db(0xe5, 0xd5); a.call('DRAW_CH_R0'); a.db(0xd1, 0xe1);
  a.db(0x23, 0x1c); a.jr(0x18, 'DRAW_STR_R0');

  a.label('DRAW_CH_R0');
  a.db(0xd6, 32, 0x6f, 0x26, 0x00, 0x29, 0x29, 0x29);
  a.ld16(0x01, 0x3d00); a.db(0x09, 0x16, 0x40, 0x06, 8);
  a.label('DCR0'); a.db(0x7e, 0x12, 0x23, 0x14); a.jr(0x10, 'DCR0'); a.db(0xc9);

  a.label('TXT_TOP'); a.ascii('PENTAGON 128  TR-DOS + AY-3-8910'); a.db(0);
  a.label('FRAME'); a.db(0);
  a.label('NOTE_IDX'); a.db(0);
  a.label('PHASE'); a.db(0);

  // AY 12-bit divider tables (lo, hi) for 16 steps
  a.label('BASS_TBL');
  a.dw(0x01ac, 0x01ac, 0x017d, 0x017d, 0x0153, 0x0153, 0x011d, 0x011d, 0x00fd, 0x00fd, 0x011d, 0x011d, 0x0153, 0x0153, 0x017d, 0x017d);
  a.label('LEAD_TBL');
  a.dw(0x00d6, 0x00b4, 0x008e, 0x007f, 0x00be, 0x00a0, 0x007f, 0x006b, 0x00a9, 0x008e, 0x0071, 0x005f, 0x00be, 0x00a0, 0x007f, 0x006b);
  a.label('ARP_TBL');
  a.dw(0x006b, 0x005a, 0x0047, 0x003f, 0x005f, 0x0050, 0x003f, 0x0035, 0x0054, 0x0047, 0x0038, 0x002f, 0x005f, 0x0050, 0x003f, 0x0035);

  return wrapMachineCodeTrd('aydemo', a.finish(), 0x8000, 'PENTAGON');
}

export const BUILTIN_GAMES: BuiltinGame[] = [
  {
    id: 'ay-trdos-demo',
    title: 'Pentagon AY + TR-DOS Демо',
    subtitle: 'Дискета .TRD · Загрузка через ПЗУ TR-DOS + музыка AY-3-8910',
    controls: 'Автозапуск через TR-DOS (A> RUN) на Pentagon 128',
    filename: 'aydemo.trd',
    format: 'TRD',
    recommendedMachine: 'pentagon128',
    buildBytes: buildAyTrdDemo,
  },
  {
    id: 'snake',
    title: 'ZX Змейка',
    subtitle: 'Классическая аркада на Z80 в ассемблере',
    controls: 'Q / A / O / P или 7 / 6 / 5 / 8, SPACE — рестарт',
    filename: 'snake.tap',
    format: 'TAP',
    buildBytes: buildSnakeTapClean,
  },
  {
    id: 'bricks',
    title: 'Арканоид',
    subtitle: 'Разбей цветную стену блоков мячом',
    controls: 'O / P или 5 / 8 (влево / вправо), SPACE — рестарт',
    filename: 'bricks.tap',
    format: 'TAP',
    buildBytes: buildBreakoutTap,
  },
  {
    id: 'dodge',
    title: 'Метеор',
    subtitle: 'Уклоняйся от падающих метеоров',
    controls: 'O / P или 5 / 8 (влево / вправо), SPACE — рестарт',
    filename: 'dodge.tap',
    format: 'TAP',
    buildBytes: buildSpaceDodgeTap,
  },
  {
    id: 'basic-demo',
    title: 'Sinclair BASIC Демо',
    subtitle: 'Нативная графика CIRCLE и музыка BEEP в ПЗУ 1982 г.',
    controls: 'CAPS+SPACE — остановка и просмотр кода (LIST)',
    filename: 'demo.tap',
    format: 'TAP',
    buildBytes: buildBasicDemoTap,
  },
];
