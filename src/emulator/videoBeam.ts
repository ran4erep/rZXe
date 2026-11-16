// Zero-allocation ULA beam-synchronized rasterizer & SWAR Gigascreen phosphor blender

export const BEAM_SCREEN_WIDTH = 320;
export const BEAM_SCREEN_HEIGHT = 240;
export const BEAM_ACTIVE_WIDTH = 256;
export const BEAM_ACTIVE_HEIGHT = 192;
export const BEAM_BORDER_X = 32;
export const BEAM_BORDER_Y = 24;

export type GigascreenMode = 'auto' | 'on' | 'off';

// Authentic ZX Spectrum 16-color palette in little-endian ABGR (0xAABBGGRR) for Uint32Array ImageData
export const PALETTE_ABGR = new Uint32Array([
  0xff000000, // 0 Black
  0xffd70000, // 1 Blue
  0xff0000d7, // 2 Red
  0xffd700d7, // 3 Magenta
  0xff00d700, // 4 Green
  0xffd7d700, // 5 Cyan
  0xff00d7d7, // 6 Yellow
  0xffd7d7d7, // 7 White
  0xff000000, // 8 Bright Black
  0xffff0000, // 9 Bright Blue
  0xff0000ff, // 10 Bright Red
  0xffff00ff, // 11 Bright Magenta
  0xff00ff00, // 12 Bright Green
  0xffffff00, // 13 Bright Cyan
  0xff00ffff, // 14 Bright Yellow
  0xffffffff, // 15 Bright White
]);

// Precomputed screen pixel row -> 16KB bank offset (0x0000..0x17FF) & attribute offset (0x1800..0x1AFF)
export const Y_TO_PIXEL_OFF = new Uint16Array(192);
export const Y_TO_ATTR_OFF = new Uint16Array(192);
for (let y = 0; y < 192; y++) {
  const high = ((y & 0xc0) >> 3) | (y & 0x07);
  const low = (y & 0x38) << 2;
  Y_TO_PIXEL_OFF[y] = (high << 8) | low;
  Y_TO_ATTR_OFF[y] = 0x1800 + ((y >> 3) << 5);
}

/**
 * Converts a frame-normalized ULA T-state to a packed visible beam coordinate `(row << 9) | x`.
 * `row` is in [0..240], `x` is even in [0..318] (0 when row === 240).
 */
export function tstatesToBeamPos(
  beamT: number,
  firstActiveT: number,
  tstatesPerLine: number
): number {
  const row0LeftT = firstActiveT - BEAM_BORDER_Y * tstatesPerLine - 16;
  const rel = beamT - row0LeftT;
  if (rel <= 0) return 0;

  const row = (rel / tstatesPerLine) | 0;
  if (row >= BEAM_SCREEN_HEIGHT) return BEAM_SCREEN_HEIGHT << 9;

  const inRowT = rel - row * tstatesPerLine;
  if (inRowT >= 160) return (row + 1) << 9;

  return (row << 9) | (inRowT << 1);
}

function drawPartialActiveLine(
  fb: Uint32Array,
  scr: Uint8Array,
  borderPx: number,
  flash: boolean,
  row: number,
  x0: number,
  x1: number
): void {
  const rowBase = row * BEAM_SCREEN_WIDTH;

  if (row < BEAM_BORDER_Y || row >= BEAM_BORDER_Y + BEAM_ACTIVE_HEIGHT) {
    fb.fill(borderPx, rowBase + x0, rowBase + x1);
    return;
  }

  // Left border segment [0..32)
  if (x0 < BEAM_BORDER_X) {
    const bx1 = x1 < BEAM_BORDER_X ? x1 : BEAM_BORDER_X;
    fb.fill(borderPx, rowBase + x0, rowBase + bx1);
  }

  // Active paper segment [32..288)
  const paperRight = BEAM_BORDER_X + BEAM_ACTIVE_WIDTH;
  if (x1 > BEAM_BORDER_X && x0 < paperRight) {
    let ax = x0 > BEAM_BORDER_X ? x0 - BEAM_BORDER_X : 0;
    const axEnd = x1 < paperRight ? x1 - BEAM_BORDER_X : BEAM_ACTIVE_WIDTH;
    const y = row - BEAM_BORDER_Y;
    const pixOff = Y_TO_PIXEL_OFF[y];
    const attrOff = Y_TO_ATTR_OFF[y];
    let dst = rowBase + BEAM_BORDER_X + ax;

    // Unaligned leading pixels inside the first character cell
    const leadBits = ax & 7;
    if (leadBits !== 0) {
      const col = ax >> 3;
      const pixels = scr[pixOff + col];
      const attr = scr[attrOff + col];
      const bright = (attr & 0x40) >> 3;
      let ink = PALETTE_ABGR[(attr & 0x07) | bright];
      let paper = PALETTE_ABGR[((attr >> 3) & 0x07) | bright];
      if ((attr & 0x80) !== 0 && flash) {
        const tmp = ink;
        ink = paper;
        paper = tmp;
      }
      const cellEnd = (col + 1) << 3;
      const segEnd = axEnd < cellEnd ? axEnd : cellEnd;
      let mask = 0x80 >> leadBits;
      while (ax < segEnd) {
        fb[dst++] = (pixels & mask) !== 0 ? ink : paper;
        mask >>= 1;
        ax++;
      }
    }

    // Aligned 8-pixel character cells
    while (ax + 8 <= axEnd) {
      const col = ax >> 3;
      const pixels = scr[pixOff + col];
      const attr = scr[attrOff + col];
      const bright = (attr & 0x40) >> 3;
      let ink = PALETTE_ABGR[(attr & 0x07) | bright];
      let paper = PALETTE_ABGR[((attr >> 3) & 0x07) | bright];
      if ((attr & 0x80) !== 0 && flash) {
        const tmp = ink;
        ink = paper;
        paper = tmp;
      }
      fb[dst]     = (pixels & 0x80) ? ink : paper;
      fb[dst + 1] = (pixels & 0x40) ? ink : paper;
      fb[dst + 2] = (pixels & 0x20) ? ink : paper;
      fb[dst + 3] = (pixels & 0x10) ? ink : paper;
      fb[dst + 4] = (pixels & 0x08) ? ink : paper;
      fb[dst + 5] = (pixels & 0x04) ? ink : paper;
      fb[dst + 6] = (pixels & 0x02) ? ink : paper;
      fb[dst + 7] = (pixels & 0x01) ? ink : paper;
      dst += 8;
      ax += 8;
    }

    // Unaligned trailing pixels inside the last character cell
    if (ax < axEnd) {
      const col = ax >> 3;
      const pixels = scr[pixOff + col];
      const attr = scr[attrOff + col];
      const bright = (attr & 0x40) >> 3;
      let ink = PALETTE_ABGR[(attr & 0x07) | bright];
      let paper = PALETTE_ABGR[((attr >> 3) & 0x07) | bright];
      if ((attr & 0x80) !== 0 && flash) {
        const tmp = ink;
        ink = paper;
        paper = tmp;
      }
      let mask = 0x80;
      while (ax < axEnd) {
        fb[dst++] = (pixels & mask) !== 0 ? ink : paper;
        mask >>= 1;
        ax++;
      }
    }
  }

  // Right border segment [288..320)
  if (x1 > paperRight) {
    const rx0 = x0 > paperRight ? x0 : paperRight;
    fb.fill(borderPx, rowBase + rx0, rowBase + x1);
  }
}

/**
 * Renders only the pixel span from packed `startPos` to `endPos` (exclusive).
 * Each pixel in the 320x240 frame is touched at most once when advancing monotonically.
 */
export function renderBeamSpan(
  fb: Uint32Array,
  scr: Uint8Array,
  borderColor: number,
  flash: boolean,
  startPos: number,
  endPos: number
): void {
  if (endPos <= startPos) return;

  const borderPx = PALETTE_ABGR[borderColor & 0x07];
  let row = startPos >> 9;
  const startX = startPos & 0x1ff;
  const endRow = endPos >> 9;
  const endX = endPos & 0x1ff;

  if (row === endRow) {
    drawPartialActiveLine(fb, scr, borderPx, flash, row, startX, endX);
    return;
  }

  if (startX > 0) {
    drawPartialActiveLine(fb, scr, borderPx, flash, row, startX, BEAM_SCREEN_WIDTH);
    row++;
  }

  // Batch contiguous top or bottom border rows in a single TypedArray.fill
  if (row < BEAM_BORDER_Y && endRow > row) {
    const topEnd = endRow < BEAM_BORDER_Y ? endRow : BEAM_BORDER_Y;
    fb.fill(borderPx, row * BEAM_SCREEN_WIDTH, topEnd * BEAM_SCREEN_WIDTH);
    row = topEnd;
  }

  const activeEndRow = BEAM_BORDER_Y + BEAM_ACTIVE_HEIGHT;
  const loopEnd = endRow < activeEndRow ? endRow : activeEndRow;
  while (row < loopEnd) {
    const rowBase = row * BEAM_SCREEN_WIDTH;
    fb.fill(borderPx, rowBase, rowBase + BEAM_BORDER_X);
    let dst = rowBase + BEAM_BORDER_X;

    const y = row - BEAM_BORDER_Y;
    const pixOff = Y_TO_PIXEL_OFF[y];
    const attrOff = Y_TO_ATTR_OFF[y];

    for (let col = 0; col < 32; col++) {
      const pixels = scr[pixOff + col];
      const attr = scr[attrOff + col];
      const bright = (attr & 0x40) >> 3;
      let ink = PALETTE_ABGR[(attr & 0x07) | bright];
      let paper = PALETTE_ABGR[((attr >> 3) & 0x07) | bright];

      if ((attr & 0x80) !== 0 && flash) {
        const tmp = ink;
        ink = paper;
        paper = tmp;
      }

      fb[dst]     = (pixels & 0x80) ? ink : paper;
      fb[dst + 1] = (pixels & 0x40) ? ink : paper;
      fb[dst + 2] = (pixels & 0x20) ? ink : paper;
      fb[dst + 3] = (pixels & 0x10) ? ink : paper;
      fb[dst + 4] = (pixels & 0x08) ? ink : paper;
      fb[dst + 5] = (pixels & 0x04) ? ink : paper;
      fb[dst + 6] = (pixels & 0x02) ? ink : paper;
      fb[dst + 7] = (pixels & 0x01) ? ink : paper;
      dst += 8;
    }

    fb.fill(borderPx, dst, dst + BEAM_BORDER_X);
    row++;
  }

  if (row >= activeEndRow && endRow > row) {
    const botEnd = endRow < BEAM_SCREEN_HEIGHT ? endRow : BEAM_SCREEN_HEIGHT;
    fb.fill(borderPx, row * BEAM_SCREEN_WIDTH, botEnd * BEAM_SCREEN_WIDTH);
    row = botEnd;
  }

  if (endRow < BEAM_SCREEN_HEIGHT && endX > 0) {
    drawPartialActiveLine(fb, scr, borderPx, flash, endRow, 0, endX);
  }
}

/**
 * Fast whole-frame renderer when no mid-frame visible beam mutations occurred.
 */
export function renderStaticFrame(
  fb: Uint32Array,
  scr: Uint8Array,
  borderColor: number,
  flash: boolean,
  paintBorder: boolean
): void {
  const borderPx = PALETTE_ABGR[borderColor & 0x07];

  if (paintBorder) {
    fb.fill(borderPx, 0, BEAM_BORDER_Y * BEAM_SCREEN_WIDTH);
  }

  for (let y = 0; y < BEAM_ACTIVE_HEIGHT; y++) {
    const rowBase = (y + BEAM_BORDER_Y) * BEAM_SCREEN_WIDTH;
    if (paintBorder) {
      fb.fill(borderPx, rowBase, rowBase + BEAM_BORDER_X);
    }
    let dst = rowBase + BEAM_BORDER_X;

    const pixOff = Y_TO_PIXEL_OFF[y];
    const attrOff = Y_TO_ATTR_OFF[y];

    for (let col = 0; col < 32; col++) {
      const pixels = scr[pixOff + col];
      const attr = scr[attrOff + col];
      const bright = (attr & 0x40) >> 3;
      let ink = PALETTE_ABGR[(attr & 0x07) | bright];
      let paper = PALETTE_ABGR[((attr >> 3) & 0x07) | bright];

      if ((attr & 0x80) !== 0 && flash) {
        const tmp = ink;
        ink = paper;
        paper = tmp;
      }

      fb[dst]     = (pixels & 0x80) ? ink : paper;
      fb[dst + 1] = (pixels & 0x40) ? ink : paper;
      fb[dst + 2] = (pixels & 0x20) ? ink : paper;
      fb[dst + 3] = (pixels & 0x10) ? ink : paper;
      fb[dst + 4] = (pixels & 0x08) ? ink : paper;
      fb[dst + 5] = (pixels & 0x04) ? ink : paper;
      fb[dst + 6] = (pixels & 0x02) ? ink : paper;
      fb[dst + 7] = (pixels & 0x01) ? ink : paper;
      dst += 8;
    }

    if (paintBorder) {
      fb.fill(borderPx, dst, dst + BEAM_BORDER_X);
    }
  }

  if (paintBorder) {
    fb.fill(
      borderPx,
      (BEAM_BORDER_Y + BEAM_ACTIVE_HEIGHT) * BEAM_SCREEN_WIDTH,
      BEAM_SCREEN_HEIGHT * BEAM_SCREEN_WIDTH
    );
  }
}

/**
 * Exact SWAR 50/50 channel average of two ABGR Uint32Array framebuffers.
 * Preserves alpha=0xff with zero branching and zero bit-unpacking.
 */
export function blendFrames5050(
  srcA: Uint32Array,
  srcB: Uint32Array,
  dst: Uint32Array
): void {
  const len = dst.length;
  for (let i = 0; i < len; i++) {
    const a = srcA[i];
    const b = srcB[i];
    dst[i] = ((a & b) + (((a ^ b) & 0xfefefefe) >>> 1)) >>> 0;
  }
}

/**
 * Fast 256-sample FNV-1a signature across the 256x192 active area for auto-Gigascreen detection.
 */
export function computeActiveFrameHash(fb: Uint32Array): number {
  let hash = 0x811c9dc5;
  for (let y = 6; y < BEAM_ACTIVE_HEIGHT; y += 12) {
    const rowBase = (y + BEAM_BORDER_Y) * BEAM_SCREEN_WIDTH + BEAM_BORDER_X;
    for (let x = 8; x < BEAM_ACTIVE_WIDTH; x += 16) {
      hash = Math.imul(hash ^ fb[rowBase + x], 0x01000193);
    }
  }
  return hash >>> 0;
}
