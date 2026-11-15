import { ACTIVE_HEIGHT, ACTIVE_WIDTH, BORDER_X, BORDER_Y, SCREEN_WIDTH } from './spectrum';

export const SCREENSHOT_TARGET_HEIGHT = 720;

export interface ScreenshotDimensions {
  readonly width: number;
  readonly height: number;
}

export function calculate720pDimensions(
  srcWidth: number = ACTIVE_WIDTH,
  srcHeight: number = ACTIVE_HEIGHT,
  targetHeight: number = SCREENSHOT_TARGET_HEIGHT
): ScreenshotDimensions {
  const safeW = Math.max(1, Math.round(srcWidth));
  const safeH = Math.max(1, Math.round(srcHeight));
  const safeTargetH = Math.max(1, Math.round(targetHeight));
  return {
    width: Math.max(1, Math.round((safeW * safeTargetH) / safeH)),
    height: safeTargetH,
  };
}

export const SCREENSHOT_WIDTH = calculate720pDimensions().width; // 960 (exact 4:3 of 256x192)
export const SCREENSHOT_HEIGHT = SCREENSHOT_TARGET_HEIGHT; // 720

// Precompute source X/Y coordinate maps once at module load for zero-division upscaling
const X_SRC_OFFSET_960 = new Uint16Array(SCREENSHOT_WIDTH);
for (let dx = 0; dx < SCREENSHOT_WIDTH; dx++) {
  X_SRC_OFFSET_960[dx] = BORDER_X + (((dx * ACTIVE_WIDTH) / SCREENSHOT_WIDTH) | 0);
}

const Y_SRC_INDEX_720 = new Uint16Array(SCREENSHOT_HEIGHT);
for (let dy = 0; dy < SCREENSHOT_HEIGHT; dy++) {
  Y_SRC_INDEX_720[dy] = BORDER_Y + (((dy * ACTIVE_HEIGHT) / SCREENSHOT_HEIGHT) | 0);
}

/**
 * Extracts only the borderless 256x192 active ZX Spectrum screen from a 320x240 ABGR framebuffer
 * and upscales it with crisp nearest-neighbor scaling to 960x720 (4:3 720p).
 * Renders each unique source row once and duplicates repeated rows via TypedArray.copyWithin.
 */
export function renderBorderless720pInto(
  frameBuffer: Uint32Array,
  dst32: Uint32Array
): void {
  let prevSrcY = -1;
  let prevDstRowBase = 0;

  for (let dy = 0; dy < SCREENSHOT_HEIGHT; dy++) {
    const srcY = Y_SRC_INDEX_720[dy];
    const dstRowBase = dy * SCREENSHOT_WIDTH;

    if (srcY === prevSrcY) {
      dst32.copyWithin(dstRowBase, prevDstRowBase, prevDstRowBase + SCREENSHOT_WIDTH);
      continue;
    }

    const srcRowBase = srcY * SCREEN_WIDTH;
    for (let dx = 0; dx < SCREENSHOT_WIDTH; dx++) {
      dst32[dstRowBase + dx] = frameBuffer[srcRowBase + X_SRC_OFFSET_960[dx]];
    }

    prevSrcY = srcY;
    prevDstRowBase = dstRowBase;
  }
}

export function normalizeScreenshotFilename(
  rawTitle: string | null | undefined,
  nowMs: number = Date.now()
): string {
  const cleaned = (rawTitle ?? '')
    .trim()
    .replace(/\.(?:scl|trd|fdi|td0|udi|dsk|mgt|img|opd|opu|d40|d80|mdr|tap|tzx|pzx|csw|wav|voc|sna|z80|szx|sp|slt|snx|sem|sit|ach|frz|prg|zx82|zx|dck|rom|scr|bin|raw|zip|rar|7z|tar|gz|bz2|arj|lha|\$[a-z0-9])$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  const base = cleaned.length > 0 ? cleaned : 'zx-spectrum';
  const d = new Date(nowMs);
  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

  return `${base}-${stamp}.png`;
}

export function captureBorderless720pPngBlob(frameBuffer: Uint32Array): Promise<Blob | null> {
  if (typeof document === 'undefined') {
    return Promise.resolve(null);
  }
  const canvas = document.createElement('canvas');
  canvas.width = SCREENSHOT_WIDTH;
  canvas.height = SCREENSHOT_HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    return Promise.resolve(null);
  }

  const imageData = ctx.createImageData(SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
  const dst32 = new Uint32Array(imageData.data.buffer);
  renderBorderless720pInto(frameBuffer, dst32);
  ctx.putImageData(imageData, 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

export function triggerScreenshotDownload(filename: string, blob: Blob): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
