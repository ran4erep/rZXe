import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_HEIGHT,
  ACTIVE_WIDTH,
  BORDER_X,
  BORDER_Y,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
} from './spectrum';
import {
  SCREENSHOT_HEIGHT,
  SCREENSHOT_WIDTH,
  calculate720pDimensions,
  normalizeScreenshotFilename,
  renderBorderless720pInto,
} from './screenshot';

test('calculate720pDimensions preserves 4:3 ZX Spectrum active aspect ratio at 720p', () => {
  const dims = calculate720pDimensions(ACTIVE_WIDTH, ACTIVE_HEIGHT);
  assert.deepEqual(dims, { width: 960, height: 720 });
  assert.equal(SCREENSHOT_WIDTH, 960);
  assert.equal(SCREENSHOT_HEIGHT, 720);
  assert.equal(dims.width * ACTIVE_HEIGHT, dims.height * ACTIVE_WIDTH);
});

test('renderBorderless720pInto strips all border pixels and upscales active 256x192 screen cleanly', () => {
  const frameBuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  const BORDER_RED = 0xff0000d7;
  const ACTIVE_BG = 0xffd7d700;
  const TOP_LEFT_PX = 0xffffffff;
  const TOP_RIGHT_PX = 0xff00ff00;
  const BOTTOM_LEFT_PX = 0xffff00ff;
  const BOTTOM_RIGHT_PX = 0xff00ffff;
  const CENTER_PX = 0xff000000;

  // Fill entire 320x240 frameBuffer with distinctive border color
  frameBuffer.fill(BORDER_RED);

  // Fill strictly active 256x192 region with ACTIVE_BG
  for (let y = 0; y < ACTIVE_HEIGHT; y++) {
    const rowStart = (BORDER_Y + y) * SCREEN_WIDTH + BORDER_X;
    frameBuffer.fill(ACTIVE_BG, rowStart, rowStart + ACTIVE_WIDTH);
  }

  // Place corner and center markers inside active region
  frameBuffer[BORDER_Y * SCREEN_WIDTH + BORDER_X] = TOP_LEFT_PX;
  frameBuffer[BORDER_Y * SCREEN_WIDTH + BORDER_X + ACTIVE_WIDTH - 1] = TOP_RIGHT_PX;
  frameBuffer[(BORDER_Y + ACTIVE_HEIGHT - 1) * SCREEN_WIDTH + BORDER_X] = BOTTOM_LEFT_PX;
  frameBuffer[(BORDER_Y + ACTIVE_HEIGHT - 1) * SCREEN_WIDTH + BORDER_X + ACTIVE_WIDTH - 1] =
    BOTTOM_RIGHT_PX;
  frameBuffer[(BORDER_Y + 96) * SCREEN_WIDTH + BORDER_X + 128] = CENTER_PX;

  const dst32 = new Uint32Array(SCREENSHOT_WIDTH * SCREENSHOT_HEIGHT);
  renderBorderless720pInto(frameBuffer, dst32);

  // Verify ZERO border pixels leaked into output
  for (let i = 0; i < dst32.length; i++) {
    assert.notEqual(dst32[i], BORDER_RED, `Border pixel leaked at output index ${i}`);
  }

  // Verify exact upscaled corner blocks & center marker
  assert.equal(dst32[0], TOP_LEFT_PX);
  assert.equal(dst32[SCREENSHOT_WIDTH - 1], TOP_RIGHT_PX);
  assert.equal(dst32[(SCREENSHOT_HEIGHT - 1) * SCREENSHOT_WIDTH], BOTTOM_LEFT_PX);
  assert.equal(
    dst32[(SCREENSHOT_HEIGHT - 1) * SCREENSHOT_WIDTH + (SCREENSHOT_WIDTH - 1)],
    BOTTOM_RIGHT_PX
  );
  assert.equal(dst32[360 * SCREENSHOT_WIDTH + 480], CENTER_PX);
});

test('normalizeScreenshotFilename strips game extensions, sanitizes chars, and appends .png timestamp', () => {
  const fixedTime = new Date(2026, 10, 15, 9, 5, 3).getTime();
  assert.equal(normalizeScreenshotFilename('Seraphim.scl', fixedTime), 'Seraphim-20261115-090503.png');
  assert.equal(normalizeScreenshotFilename('Exolon (1987).tap', fixedTime), 'Exolon (1987)-20261115-090503.png');
  assert.equal(normalizeScreenshotFilename('Game: Part/1?', fixedTime), 'Game_ Part_1_-20261115-090503.png');
  assert.equal(normalizeScreenshotFilename('   ', fixedTime), 'zx-spectrum-20261115-090503.png');
});
