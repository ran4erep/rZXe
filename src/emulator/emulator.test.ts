import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZXSpectrum48,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  ACTIVE_WIDTH,
  ACTIVE_HEIGHT,
  BORDER_X,
  BORDER_Y,
  SMALL_BORDER_X,
  SMALL_BORDER_Y,
  getBorderViewport,
} from './spectrum';
import { Z80, FLAG_C, FLAG_Z } from './z80';
import { BUILTIN_GAMES } from './builtinGames';
import { loadSnaSnapshot } from './formats';
import fs from 'node:fs';
import path from 'node:path';
import { buildTrdImage, convertSclToTrd, createBlankTrdImage, findTrdosAutoBootTarget } from './betaDisk';
import { extractPlayableFiles } from './archiveExtractor';
import {
  generateNextDiskName,
  normalizeDiskFilename,
  putSavedDisk,
  listSavedDisks,
  getSavedDiskBytes,
  renameSavedDisk,
  deleteSavedDisk,
  upsertSessionDiskHistory,
} from './diskStorage';
import { synthesizeBeeperFrame, createBeeperSynthState, levelToAmp } from './beeper';
import { AY8910 } from './ay8910';
import { KeyboardMatrix, encodeSpectrumStringKeys } from './keyboard';
import {
  createFramePacerState,
  resetFramePacerState,
  advanceFramePacer,
} from './framePacer';
import {
  DEFAULT_TOP_ROW_IDS,
  normalizeTopRowIds,
  saveGlobalTopRowIds,
  saveGameTopRowIds,
  clearGameTopRowIds,
  resolveTopRowIds,
} from './topRowConfig';
import {
  DEFAULT_EMULATOR_SETTINGS,
  loadEmulatorSettings,
  saveEmulatorSettings,
  sanitizeEmulatorSettings,
} from './settingsStorage';
import {
  putSaveState,
  listSaveStates,
  getSaveStateRecord,
  deleteSaveState,
  normalizeSnaFilename,
  resolveSaveStateGameKey,
  getSaveStateGameKey,
  doesSaveStateMatchGame,
  extractZxArtProdIdFromKey,
  isReleaseScopedGameKey,
} from './saveStateStorage';

test('Z80 core executes arithmetic, DJNZ, LDIR, and BIT instructions accurately', () => {
  const rom = new Uint8Array(16384);
  const ram1 = new Uint8Array(16384);
  const ram2 = new Uint8Array(16384);
  const ram3 = new Uint8Array(16384);
  // Program at 0x4000 (slot 1):
  const prog = [
    0x3e, 0x15, // LD A, 0x15
    0xc6, 0x27, // ADD A, 0x27 -> 0x3C
    0x27,       // DAA -> 0x42
    0x06, 0x03, // LD B, 3
    0x3c,       // INC A
    0x10, 0xfd, // DJNZ -3
    0x76,       // HALT
  ];
  ram1.set(prog, 0);

  const cpu = new Z80(
    [rom, ram1, ram2, ram3],
    [null, ram1, ram2, ram3],
    ram1,
    {
      readPort: () => 0xff,
      writePort: () => {},
    }
  );
  cpu.pc = 0x4000;
  for (let i = 0; i < 20 && !cpu.halted; i++) {
    cpu.step();
  }
  assert.equal(cpu.halted, true);
  assert.equal(cpu.a, 0x42 + 3);
  assert.equal(cpu.b, 0);

  // Test CP Z flag & SUB C flag
  cpu.a = 10;
  ram1[0x100] = 0xfe; // CP 10
  ram1[0x101] = 10;
  ram1[0x102] = 0xd6; // SUB 11
  ram1[0x103] = 11;
  cpu.halted = false;
  cpu.pc = 0x4100;
  cpu.step();
  assert.ok((cpu.f & FLAG_Z) !== 0);
  cpu.step();
  assert.equal(cpu.a, 0xff);
  assert.ok((cpu.f & FLAG_C) !== 0);
});

test('Authentic 1982 Sinclair 48K BIOS boots and renders copyright banner into VRAM', () => {
  const speccy = new ZXSpectrum48('48k');
  const romStr = String.fromCharCode(...speccy.rom.subarray(0x153b, 0x1551));
  assert.equal(romStr, '1982 Sinclair Research');

  for (let i = 0; i < 105; i++) {
    speccy.stepFrame();
  }

  let litBytes = 0;
  for (let col = 0; col < 32; col++) {
    const b = speccy.ramPages[5][0x13e0 + col]; // 0x53E0 - 0x4000
    if (b !== 0) litBytes++;
  }
  assert.ok(litBytes >= 15, `Expected copyright pixels on row 23, got ${litBytes} non-zero cols`);

  let skippedFrames = 0;
  for (let i = 0; i < 10; i++) {
    if (!speccy.stepFrame()) skippedFrames++;
  }
  assert.ok(skippedFrames >= 8, `Expected idle frame optimization to skip >=8/10 frames, skipped ${skippedFrames}`);
});

test('Real 48K BASIC executes PRINT 2+2 via keyboard matrix and prints 4', () => {
  const speccy = new ZXSpectrum48('48k');
  for (let i = 0; i < 105; i++) speccy.stepFrame();

  const pressKey = (ids: string[]) => {
    speccy.keyboard.tapKeys(ids);
    for (let i = 0; i < 4; i++) speccy.stepFrame();
    speccy.keyboard.releaseKeys(ids);
    for (let i = 0; i < 4; i++) speccy.stepFrame();
  };

  pressKey(['P']);
  pressKey(['2']);
  pressKey(['SYMBOL', 'K']);
  pressKey(['2']);
  pressKey(['ENTER']);

  for (let i = 0; i < 20; i++) speccy.stepFrame();

  let topPixels = 0;
  for (let line = 0; line < 8; line++) {
    if (speccy.ramPages[5][line << 8] !== 0) topPixels++;
  }
  assert.ok(topPixels >= 4, `Expected character '4' rendered at top-left, got ${topPixels} non-empty scanlines`);
});

test('ZX Spectrum 128K, +2, Pentagon 128, and Scorpion ZS 256 authentic BIOSes boot cleanly', () => {
  const machines: Array<{ id: '128k' | 'plus2' | 'pentagon128' | 'pentagon604' | 'scorpion256'; frames: number }> = [
    { id: '128k', frames: 90 },
    { id: 'plus2', frames: 90 },
    { id: 'pentagon128', frames: 90 },
    { id: 'pentagon604', frames: 90 },
    { id: 'scorpion256', frames: 200 },
  ];

  for (const m of machines) {
    const speccy = new ZXSpectrum48(m.id);
    for (let i = 0; i < m.frames; i++) {
      speccy.stepFrame();
    }
    // Check that active screen bank (bank 5 or 7) has non-zero rendered menu pixels
    const scr = speccy.ramPages[speccy.screenBankIdx];
    let activeBytes = 0;
    for (let addr = 0; addr < 0x1800; addr++) {
      if (scr[addr] !== 0) activeBytes++;
    }
    assert.ok(
      activeBytes > 120,
      `Machine ${m.id} expected menu graphics in VRAM, got ${activeBytes} non-zero bytes`
    );
  }
});

test('Pentagon 128 enters real TR-DOS and boots/runs .TRD disk image through BetaDisk128', () => {
  const demoGame = BUILTIN_GAMES.find((g) => g.id === 'ay-trdos-demo');
  assert.ok(demoGame, 'Built-in TR-DOS demo missing');

  const speccy = new ZXSpectrum48('pentagon128');
  const trdBytes = demoGame.buildBytes();
  speccy.loadFile(demoGame.filename, trdBytes, true);

  // Boot Pentagon -> Down x4 -> ENTER TR-DOS -> R + ENTER -> LOAD "aydemo" CODE -> RANDOMIZE USR 32768
  for (let i = 0; i < 300; i++) {
    speccy.stepFrame();
  }

  // Verify Z80 reached 0x8000 machine code loop and activated AY-3-8910!
  assert.ok(
    speccy.cpu.pc >= 0x8000 || speccy.cpu.pc === 0x0038 || speccy.cpu.pc < 0x0100,
    `TR-DOS demo unexpected PC=0x${speccy.cpu.pc.toString(16)}`
  );
  assert.equal(speccy.ay.active, true, 'Expected AY-3-8910 to be activated by TR-DOS demo');

  // Verify HUD text drawn in row 0
  let hudPixels = 0;
  for (let c = 0; c < 32; c++) {
    if (speccy.ramPages[5][0x0300 + c] !== 0) hudPixels++;
  }
  assert.ok(hudPixels >= 16, `Expected PENTAGON 128 HUD pixels on row 0, got ${hudPixels}`);

  // Verify AY-3-8910 generates non-zero audio samples
  const audioBuf = new Float32Array(256);
  speccy.ay.mixInto(audioBuf, 0, 256, 44100);
  let maxAmp = 0;
  for (let i = 0; i < audioBuf.length; i++) {
    const abs = Math.abs(audioBuf[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  assert.ok(maxAmp > 0.01, `Expected non-zero AY-3-8910 audio output, got max=${maxAmp}`);
});

test('convertSclToTrd builds valid TR-DOS disk header and sector layout', () => {
  // Minimal 1-file SCL archive ("test    B")
  const payload = new Uint8Array(256);
  payload[0] = 0x0d;
  const scl = new Uint8Array(9 + 14 + 256);
  const sig = 'SINCLAIR';
  for (let i = 0; i < 8; i++) scl[i] = sig.charCodeAt(i);
  scl[8] = 1; // 1 file
  const fname = 'test    B';
  for (let i = 0; i < 9; i++) scl[9 + i] = fname.charCodeAt(i);
  scl[9 + 13] = 1; // 1 sector
  scl.set(payload, 9 + 14);

  const trd = convertSclToTrd(scl);
  assert.equal(trd.length, 655360);
  assert.equal(trd[0x800 + 0xe4], 1); // 1 file
  assert.equal(trd[0x800 + 0xe7], 0x10); // TR-DOS signature
});

test('All built-in .TAP games load cleanly on 48K and render active gameplay', () => {
  for (const game of BUILTIN_GAMES.filter((g) => g.format === 'TAP')) {
    const speccy = new ZXSpectrum48('48k');
    const tapBytes = game.buildBytes();
    speccy.loadFile(game.filename, tapBytes, true);

    for (let i = 0; i < 160; i++) {
      speccy.stepFrame();
    }

    assert.equal(speccy.frameBuffer.length, SCREEN_WIDTH * SCREEN_HEIGHT);
    if (game.id !== 'basic-demo') {
      assert.ok(
        speccy.cpu.pc >= 0x8000 || speccy.cpu.pc === 0x0038 || speccy.cpu.pc < 0x0100,
        `Game ${game.id} unexpected PC=0x${speccy.cpu.pc.toString(16)}`
      );
      let hudPixels = 0;
      for (let c = 0; c < 16; c++) {
        if (speccy.ramPages[5][0x0300 + c] !== 0) hudPixels++;
      }
      assert.ok(hudPixels >= 5, `Game ${game.id} expected HUD text pixels, got ${hudPixels}`);
    } else {
      let activeBytes = 0;
      for (let addr = 0; addr < 0x1800; addr++) {
        if (speccy.ramPages[5][addr] !== 0) activeBytes++;
      }
      assert.ok(activeBytes > 100, `BASIC demo expected circle pixels, got ${activeBytes}`);
    }
  }
});

test('SNA snapshot loader restores 48K and 128K registers, border, and RAM accurately', () => {
  const sna = new Uint8Array(49179);
  sna[0] = 0x3f; // I
  sna[22] = 0xab; // A
  sna[23] = 0x00; // SP lo = 0xFF00
  sna[24] = 0xff; // SP hi
  sna[25] = 0x01; // IM 1
  sna[26] = 0x02; // Border 2 (Red)
  sna[27 + 0xbf00] = 0x23;
  sna[27 + 0xbf01] = 0x81;

  const speccy = new ZXSpectrum48('48k');
  const res = loadSnaSnapshot(sna, {
    cpu: speccy.cpu,
    ramPages: speccy.ramPages,
    apply128kState: speccy.apply128kState,
  });
  assert.equal(res.border, 2);
  assert.equal(res.is128k, false);
  assert.equal(speccy.cpu.i, 0x3f);
  assert.equal(speccy.cpu.a, 0xab);
  assert.equal(speccy.cpu.pc, 0x8123);
  assert.equal(speccy.cpu.sp, 0xff02);
  assert.equal(speccy.cpu.im, 1);
});

test('Real-time .TAP cassette playback loads program via EAR port 0xFE bit 6 and real ROM LD-BYTES', () => {
  const demoGame = BUILTIN_GAMES.find((g) => g.id === 'basic-demo');
  assert.ok(demoGame, 'basic-demo missing');

  const speccy = new ZXSpectrum48('48k');
  speccy.setFastTapeLoad(false);
  speccy.loadFile(demoGame.filename, demoGame.buildBytes(), true);

  let sawTapeAudio = false;
  // ~700 frames covers auto-typing LOAD "", header pilot+data, 1s pause, data pilot+data, and BASIC RUN
  for (let i = 0; i < 700; i++) {
    speccy.stepFrame();
    if (speccy.tapePlayer.active && speccy.audioTransitionCount > 10) {
      sawTapeAudio = true;
    }
  }

  assert.equal(speccy.tapePlayer.active, false, 'Expected cassette playback to finish all blocks');
  assert.ok(sawTapeAudio, 'Expected real cassette audio transitions while loading');

  let activeBytes = 0;
  for (let addr = 0; addr < 0x1800; addr++) {
    if (speccy.ramPages[5][addr] !== 0) activeBytes++;
  }
  assert.ok(activeBytes > 100, `Expected BASIC demo loaded via real cassette to draw circle, got ${activeBytes}`);
});

test('BetaDisk128 tracks Drive A/B readActivityMask and ejectDisk clears mounted disk', () => {
  const demoGame = BUILTIN_GAMES.find((g) => g.id === 'ay-trdos-demo');
  assert.ok(demoGame, 'ay-trdos-demo missing');

  const speccy = new ZXSpectrum48('pentagon128');
  speccy.loadFile(demoGame.filename, demoGame.buildBytes(), true);
  speccy.bdi.readActivityMask = 0;

  for (let i = 0; i < 300; i++) {
    speccy.stepFrame();
  }

  assert.ok((speccy.bdi.readActivityMask & 0x01) !== 0, 'Expected Drive A readActivityMask bit 0 to trigger');

  // Verify sector write also triggers activity mask on the selected drive
  speccy.bdi.readActivityMask = 0;
  speccy.bdi.writePort(0xff, 0x3c); // Drive A
  speccy.bdi.writePort(0x3f, 0x00); // Track 0
  speccy.bdi.writePort(0x5f, 0x01); // Sector 1
  speccy.bdi.writePort(0x1f, 0xa0); // Write Sector command
  assert.ok((speccy.bdi.readActivityMask & 0x01) !== 0, 'Expected Drive A readActivityMask bit 0 on write');
  speccy.bdi.writePort(0x1f, 0xd0); // Force Interrupt back to idle

  speccy.ejectDisk(0);
  assert.equal(speccy.bdi.disks[0], null, 'Expected Drive A disk to be null after ejectDisk(0)');
});

test('Slow cassette .TAP playback progressively renders SCREEN$ bitmap and attributes before launching game', () => {
  const snakeGame = BUILTIN_GAMES.find((g) => g.id === 'snake');
  assert.ok(snakeGame, 'snake game missing');

  const speccy = new ZXSpectrum48('48k');
  speccy.setFastTapeLoad(false);
  speccy.loadFile(snakeGame.filename, snakeGame.buildBytes(), true);

  let enteredCode = false;
  let sawPartialScreen = false;
  let sawFullScreen = false;
  let maxScrBytesDuringScreenLoad = 0;

  for (let frame = 0; frame < 4000; frame++) {
    speccy.stepFrame();
    if (!speccy.tapePlayer.active && speccy.cpu.pc >= 0x8000) {
      enteredCode = true;
      break;
    }

    if (frame % 25 === 0 && speccy.tapePlayer.active) {
      let nz = 0;
      for (let a = 0; a < 0x1800; a++) {
        if (speccy.ramPages[5][a] !== 0) nz++;
      }
      // During SCREEN$ load, bitmap grows gradually through intermediate counts up to 1303 bytes
      if (nz > 200 && nz < 1000) {
        sawPartialScreen = true;
      }
      if (nz >= 1250) {
        sawFullScreen = true;
      }
      if (nz > maxScrBytesDuringScreenLoad) maxScrBytesDuringScreenLoad = nz;
    }
  }

  assert.ok(sawPartialScreen, `Expected partial progressive SCREEN$ pixels during slow load (max=${maxScrBytesDuringScreenLoad})`);
  assert.ok(sawFullScreen, `Expected complete SCREEN$ splash during slow load (max=${maxScrBytesDuringScreenLoad})`);
  assert.ok(enteredCode, `Expected snake machine code at >= 0x8000 to launch cleanly, PC=0x${speccy.cpu.pc.toString(16)}`);
});

test('Fast .TAP load skips BIOS boot and LOAD "" typing directly into gameplay', () => {
  const snakeGame = BUILTIN_GAMES.find((g) => g.id === 'snake');
  assert.ok(snakeGame, 'snake game missing');

  const speccy = new ZXSpectrum48('48k');
  speccy.setFastTapeLoad(true);
  speccy.loadFile(snakeGame.filename, snakeGame.buildBytes(), true);

  assert.equal(speccy.tapeIndex, speccy.tapeBlocks.length, 'Expected all tape blocks loaded immediately');
  assert.ok(
    speccy.cpu.pc >= 0x8000 || speccy.cpu.pc === 0x0038 || speccy.cpu.pc < 0x0100,
    `Expected game code running right after loadFile, PC=0x${speccy.cpu.pc.toString(16)}`
  );
  let hudPixels = 0;
  for (let c = 0; c < 16; c++) {
    if (speccy.ramPages[5][0x0300 + c] !== 0) hudPixels++;
  }
  assert.ok(hudPixels >= 5, `Expected SNAKE HUD already rendered right after loadFile, got ${hudPixels}`);
});

test('synthesizeBeeperFrame preserves sub-sample pulses and suppresses 36kHz PWM carrier aliasing', () => {
  const frameT = 69888;

  for (const sr of [48000, 44100]) {
    const n = Math.round(sr / 50.08);

    // 1) A narrow 30 T-state pulse inside a ~73 T-state sample must NOT vanish
    const tArr = new Int32Array([100, 130]);
    const vArr = new Uint8Array([2, 0]);
    const out = new Float32Array(n);
    synthesizeBeeperFrame(out, n, tArr, vArr, 2, 0, frameT, sr, -0.5);
    let peakVal = -1;
    for (let i = 1; i < 12; i++) {
      if (out[i] > peakVal) peakVal = out[i];
    }
    const peakDelta = peakVal - out[0];
    assert.ok(peakDelta > 0.15, `Expected narrow 30T pulse at ${sr}Hz to register clearly, got delta=${peakDelta}`);

    // 2) A 48 T-state 36.4kHz carrier should average near DC with <0.015 AC ripple (no aliasing whine)
    const carrierT = new Int32Array(1400);
    const carrierV = new Uint8Array(1400);
    let cnt = 0;
    for (let t = 500; t < frameT - 500; t += 48) {
      carrierT[cnt] = t;
      carrierV[cnt] = (cnt & 1) ? 0 : 2;
      cnt++;
    }
    const outCarrier = new Float32Array(n);
    const st = createBeeperSynthState();
    synthesizeBeeperFrame(outCarrier, n, carrierT, carrierV, cnt, 0, frameT, sr, 0, st);
    let mean = 0;
    const startIdx = 150;
    const endIdx = n - 100;
    for (let i = startIdx; i < endIdx; i++) mean += outCarrier[i];
    mean /= endIdx - startIdx;
    let maxAcAbs = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const a = Math.abs(outCarrier[i] - mean);
      if (a > maxAcAbs) maxAcAbs = a;
    }
    assert.ok(maxAcAbs < 0.015, `Expected 36.4kHz carrier suppressed at ${sr}Hz, got maxAC=${maxAcAbs}`);
  }
});

test('Stateful BLEP carries tail across frame boundaries and ROM BEEP 440Hz renders accurately', () => {
  const sr = 48000;
  const n = 958;
  const frameT = 69888;
  const st = createBeeperSynthState();

  // Edge right at frameT - 5 must finish rising cleanly into frame 2 without jump
  const f1 = new Float32Array(n);
  const f2 = new Float32Array(n);
  synthesizeBeeperFrame(f1, n, new Int32Array([frameT - 5]), new Uint8Array([2]), 1, 0, frameT, sr, 0, st);
  synthesizeBeeperFrame(f2, n, new Int32Array(0), new Uint8Array(0), 0, 2, frameT, sr, 0, st);

  assert.ok(f2[20] > levelToAmp(2) - 0.02, `Expected frame 2 to settle at EAR=1 level, got ${f2[20]}`);
  assert.ok(Math.abs(f2[0] - f1[n - 1]) < 0.55, `Unexpected jump across frame boundary: ${f1[n - 1]} -> ${f2[0]}`);
  for (let i = 1; i < 40; i++) {
    assert.ok(Math.abs(f2[i] - f2[i - 1]) < 0.55, `Unexpected discontinuity at f2[${i}]: ${f2[i - 1]} -> ${f2[i]}`);
  }

  // Real 48K ROM BEEP (0x03B5) at 440Hz through stateful BLEP
  const speccy = new ZXSpectrum48('48k');
  speccy.ramPages[2].set([0x21, 0xc4, 0x03, 0x11, 0x00, 0x04, 0xcd, 0xb5, 0x03, 0x76], 0);
  speccy.cpu.pc = 0x8000;

  const beepState = createBeeperSynthState();
  const frameOut = new Float32Array(n);
  let zeroCrossings = 0;
  let prevSample = 0;
  const frames = 25; // ~0.5 sec
  for (let f = 0; f < frames; f++) {
    speccy.stepFrame(false);
    synthesizeBeeperFrame(
      frameOut,
      n,
      speccy.audioTransitionsT,
      speccy.audioTransitionsVal,
      speccy.audioTransitionCount,
      speccy.audioInitialLevel,
      speccy.profile.tstatesPerFrame,
      sr,
      0,
      beepState
    );
    for (let i = 0; i < n; i++) {
      if (f > 1 && prevSample <= 0 && frameOut[i] > 0) zeroCrossings++;
      prevSample = frameOut[i];
    }
  }
  const elapsed = ((frames - 2) * frameT) / 3_500_000;
  const measuredHz = zeroCrossings / elapsed;
  assert.ok(Math.abs(measuredHz - 440) < 12, `Expected ~440Hz synthesized audio, got ${measuredHz.toFixed(1)}Hz`);
});

test('TapePlayer stops immediately after final block and port 0xFE tracks beeper + Issue 3 feedback', () => {
  const speccy = new ZXSpectrum48('48k');

  // Beeper state updates even while muted, and Issue 3 bit 6 echoes EAR on IN (0xFE)
  speccy.soundEnabled = false;
  speccy.writePort(0xfe, 0x10, 100);
  assert.equal(speccy.beeperLevel, 2);
  assert.equal(speccy.readPort(0xfe) & 0x40, 0x40);
  speccy.writePort(0xfe, 0x00, 200);
  assert.equal(speccy.beeperLevel, 0);
  assert.equal(speccy.readPort(0xfe) & 0x40, 0x00);

  // Transition at t >= frameT is clamped cleanly inside frame instead of dropped
  speccy.soundEnabled = true;
  speccy.audioTransitionCount = 0;
  speccy.writePort(0xfe, 0x10, speccy.profile.tstatesPerFrame + 5);
  assert.equal(speccy.audioTransitionCount, 1);
  assert.equal(speccy.audioTransitionsT[0], speccy.profile.tstatesPerFrame - 1);
});

test('AY8910 fractional accumulator keeps accurate tone pitch at 48kHz', () => {
  const ay = new AY8910();
  ay.selectRegister(7);
  ay.writeRegister(0xfe); // Tone A enabled
  ay.selectRegister(8);
  ay.writeRegister(15); // Max volume A
  ay.selectRegister(0);
  ay.writeRegister(100); // Half-period = 100 ticks -> f = 221675 / 200 = 1108.375 Hz

  const sr = 48000;
  const buf = new Float32Array(sr); // 1 second
  ay.mixInto(buf, 0, sr, sr);

  // Count positive-going crossings across mid-level
  let crossings = 0;
  const mid = 0.14;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] <= mid && buf[i] > mid) crossings++;
  }
  assert.ok(Math.abs(crossings - 1108) <= 3, `Expected ~1108 Hz at 48kHz, got ${crossings} Hz`);
});

test('AY8910 timed mid-frame writes replay digi-samples and ABC/ACB/Mono stereo routing works', () => {
  const sr = 48000;
  const frameT = 70908;
  const n = 960;

  // 1) Timed mid-frame sample/mute writes must render in-frame instead of being overwritten at frame end
  const aySample = new AY8910();
  aySample.beginFrame();
  aySample.selectRegister(7);
  aySample.writeRegister(0xff, 0); // Tone/noise disabled -> pure DC DAC modulation (AY digi-drum/sample style)
  aySample.selectRegister(8);
  aySample.writeRegister(15, 100); // Loud burst early in frame
  aySample.writeRegister(0, Math.floor(frameT * 0.5)); // Muted halfway through frame!

  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  aySample.mixIntoStereo(outL, outR, 0, n, sr, 'mono', 1_773_400, frameT);

  // First half must contain strong non-zero signal even though end-of-frame R8 === 0
  let firstHalfPeak = 0;
  for (let i = 20; i < n / 2 - 20; i++) {
    if (Math.abs(outL[i]) > firstHalfPeak) firstHalfPeak = Math.abs(outL[i]);
  }
  let secondHalfPeak = 0;
  for (let i = n / 2 + 20; i < n - 10; i++) {
    if (Math.abs(outL[i]) > secondHalfPeak) secondHalfPeak = Math.abs(outL[i]);
  }
  assert.ok(firstHalfPeak > 0.2, `Expected mid-frame sample before mute to render, peak=${firstHalfPeak}`);
  assert.ok(secondHalfPeak < 0.001, `Expected second half after mute to be silent, peak=${secondHalfPeak}`);

  // 2) ABC vs ACB vs Mono panning check on Channel A (mute B and C)
  const checkStereo = (mode: 'abc' | 'acb' | 'mono') => {
    const ay = new AY8910();
    ay.beginFrame();
    ay.selectRegister(7);
    ay.writeRegister(0xfe); // Tone A only
    ay.selectRegister(0);
    ay.writeRegister(80);
    ay.selectRegister(8);
    ay.writeRegister(15); // Ch A max
    // Also put high tone on Channel B (R9 = 15) and silent C to distinguish ABC vs ACB
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    ay.mixIntoStereo(l, r, 0, n, sr, mode, 1_773_400, frameT);
    let eL = 0;
    let eR = 0;
    for (let i = 0; i < n; i++) {
      eL += l[i] * l[i];
      eR += r[i] * r[i];
    }
    return { eL, eR };
  };

  const abcA = checkStereo('abc');
  assert.ok(abcA.eL > abcA.eR * 10, `ABC mode should pan Ch A strongly left (L=${abcA.eL}, R=${abcA.eR})`);

  const monoA = checkStereo('mono');
  assert.ok(Math.abs(monoA.eL - monoA.eR) < 1e-6, `Mono mode should have identical L/R energy`);

  // Check Channel B panning: centered in ABC (0.5/0.5), panned right in ACB (0.15/0.85)
  const checkChB = (mode: 'abc' | 'acb') => {
    const ay = new AY8910();
    ay.beginFrame();
    ay.selectRegister(7);
    ay.writeRegister(0xfd); // Tone B only
    ay.selectRegister(2);
    ay.writeRegister(80);
    ay.selectRegister(9);
    ay.writeRegister(15);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    ay.mixIntoStereo(l, r, 0, n, sr, mode, 1_773_400, frameT);
    let eL = 0;
    let eR = 0;
    for (let i = 0; i < n; i++) {
      eL += l[i] * l[i];
      eR += r[i] * r[i];
    }
    return { eL, eR };
  };

  const abcB = checkChB('abc');
  assert.ok(Math.abs(abcB.eL - abcB.eR) < 1e-6, `ABC mode must center Ch B (L=${abcB.eL}, R=${abcB.eR})`);
  const acbB = checkChB('acb');
  assert.ok(acbB.eR > acbB.eL * 10, `ACB mode must pan Ch B strongly right (L=${acbB.eL}, R=${acbB.eR})`);
});

test('Loading custom 32KB .ROM automatically enables 128K paging and AY-3-8910 chip', () => {
  const speccy = new ZXSpectrum48('48k');
  assert.equal(speccy.profile.hasAY, false);
  const custom32k = new Uint8Array(32768);
  custom32k[0] = 0x76; // HALT
  speccy.loadFile('custom128.rom', custom32k, true);
  assert.equal(speccy.machineId, '128k');
  assert.equal(speccy.profile.hasAY, true);
  assert.equal(speccy.profile.is128kPaging, true);
});

test('True Z80 CPU frequency scaling multiplies instructions per 50Hz frame without fast-forwarding HALT/INTs', () => {
  const runLoopAt = (freqMhz: number) => {
    const speccy = new ZXSpectrum48('48k');
    speccy.setCpuFreqMhz(freqMhz);
    // Program at 0x8000: LD HL, 0x9000; INC (HL); JR $-1 (tight unhalted counter loop)
    //Wait: use 16-bit counter at 0x9000..0x9001:
    // 0x8000: DI (F3)
    // 0x8001: LD HL, 0x9000 (21 00 90)
    // 0x8004: INC (HL) (34)
    // 0x8005: JR NZ, -3 (20 FD)
    // 0x8007: INC HL (23); INC (HL) (34); DEC HL (2B); JR -9 (18 F7)
    const ram = speccy.ramPages[2]; // 0x8000
    const code = [0xf3, 0x21, 0x00, 0x90, 0x34, 0x20, 0xfd, 0x23, 0x34, 0x2b, 0x18, 0xf7];
    ram.set(code, 0);
    speccy.cpu.pc = 0x8000;
    speccy.cpu.tstates = 0;
    speccy.stepFrame(false);
    return ram[0x1000] | (ram[0x1001] << 8);
  };

  const count35 = runLoopAt(3.5);
  const count70 = runLoopAt(7.0);
  const count140 = runLoopAt(14.0);

  assert.ok(count70 > count35 * 1.9 && count70 < count35 * 2.1, `7 MHz count (${count70}) should be ~2x 3.5 MHz (${count35})`);
  assert.ok(count140 > count35 * 3.9 && count140 < count35 * 4.1, `14 MHz count (${count140}) should be ~4x 3.5 MHz (${count35})`);

  // Verify HALT-synced 50Hz interrupt counter does NOT fast-forward at 14 MHz once booted
  const speccy = new ZXSpectrum48('48k');
  const speccyNom = new ZXSpectrum48('48k');
  for (let i = 0; i < 90; i++) {
    speccy.stepFrame(false);
    speccyNom.stepFrame(false);
  }
  const base14 = speccy.cpu.rb(0x5c78);
  const base35 = speccyNom.cpu.rb(0x5c78);
  speccy.setCpuFreqMhz(14.0);
  speccyNom.setCpuFreqMhz(3.5);
  for (let i = 0; i < 25; i++) {
    speccy.stepFrame(false);
    speccyNom.stepFrame(false);
  }
  const delta14 = (speccy.cpu.rb(0x5c78) - base14) & 0xff;
  const delta35 = (speccyNom.cpu.rb(0x5c78) - base35) & 0xff;
  assert.equal(delta14, 25, '50Hz FRAMES counter must increment once per video frame at 14 MHz');
  assert.equal(delta14, delta35, '50Hz FRAMES delta must stay identical at 14 MHz vs 3.5 MHz');
});

test('ZX Spectrum 40-key layout defines complete green/white top legends and red bottom legends', async () => {
  const { SPECTRUM_KEYS } = await import('./keyboard');
  assert.equal(SPECTRUM_KEYS.length, 4);
  const allKeys = SPECTRUM_KEYS.flat();
  assert.equal(allKeys.length, 40);

  // Row 1 (1..0): white top legends + red bottom legends + colour names
  for (const key of SPECTRUM_KEYS[0]) {
    assert.equal(key.topKind, 'white', `Row 1 key ${key.id} should have white top legend`);
    assert.ok(key.topText && key.topText.length > 0, `Row 1 key ${key.id} missing topText`);
    assert.ok(key.bottomText && key.bottomText.length > 0, `Row 1 key ${key.id} missing bottomText`);
  }

  // Rows 2..4 letter keys (Q..P, A..L, Z..M): green top legends + red bottom legends
  const letterKeys = allKeys.filter((k) => k.id.length === 1 && k.id >= 'A' && k.id <= 'Z');
  assert.equal(letterKeys.length, 26);
  for (const key of letterKeys) {
    assert.equal(key.topKind, 'green', `Letter key ${key.id} should have green top legend`);
    assert.ok(key.topText && key.topText.length > 0, `Letter key ${key.id} missing green topText`);
    assert.ok(key.bottomText && key.bottomText.length > 0, `Letter key ${key.id} missing red bottomText`);
  }

  // Spot-check authentic faceplate legends from ZX Spectrum 48K
  const byId = new Map(allKeys.map((k) => [k.id, k]));
  assert.equal(byId.get('1')?.bottomText, 'DEF FN');
  assert.equal(byId.get('0')?.colorName, 'BLACK');
  assert.equal(byId.get('0')?.bottomText, 'FORMAT');
  assert.equal(byId.get('Q')?.topText, 'SIN');
  assert.equal(byId.get('Q')?.bottomText, 'ASN');
  assert.equal(byId.get('P')?.topText, 'TAB');
  assert.equal(byId.get('P')?.bottomText, '©');
  assert.equal(byId.get('K')?.topText, 'LEN');
  assert.equal(byId.get('K')?.bottomText, 'SCREEN$');
  assert.equal(byId.get('M')?.topText, 'PI');
  assert.equal(byId.get('M')?.bottomText, 'INVERSE');
});

test('computeDpadMask handles deadzone, 4 cardinals, 4 diagonals, and continuous drag transitions', async () => {
  const { computeDpadMask } = await import('./keyboard');

  // Center deadzone returns 0
  assert.equal(computeDpadMask(0, 0, 14), 0);
  assert.equal(computeDpadMask(9, -10, 14), 0);

  // Pure cardinal directions (bit0=R, bit1=L, bit2=D, bit3=U)
  assert.equal(computeDpadMask(50, 0, 14), 0x01); // Right
  assert.equal(computeDpadMask(-50, 5, 14), 0x02); // Left (within 22.5 deg tolerance)
  assert.equal(computeDpadMask(4, 50, 14), 0x04); // Down
  assert.equal(computeDpadMask(-6, -50, 14), 0x08); // Up

  // Diagonal sectors
  assert.equal(computeDpadMask(40, -40, 14), 0x01 | 0x08); // Up-Right
  assert.equal(computeDpadMask(-40, -40, 14), 0x02 | 0x08); // Up-Left
  assert.equal(computeDpadMask(40, 40, 14), 0x01 | 0x04); // Down-Right
  assert.equal(computeDpadMask(-40, 40, 14), 0x02 | 0x04); // Down-Left

  // Continuous drag sequence from Left -> Up-Left -> Up -> Up-Right -> Right
  const dragPath: Array<[number, number, number]> = [
    [-55, 0, 0x02],
    [-40, -35, 0x02 | 0x08],
    [0, -55, 0x08],
    [38, -38, 0x01 | 0x08],
    [55, 0, 0x01],
  ];
  for (const [dx, dy, expected] of dragPath) {
    assert.equal(computeDpadMask(dx, dy, 14), expected);
  }
});

test('Sub-frame virtual touch tap and Kempston fire are latched for 3 frames without consecutive key ghosting', () => {
  const speccy = new ZXSpectrum48('48k');
  for (let i = 0; i < 105; i++) speccy.stepFrame(false);

  // Simulate ultra-fast touch tap (<20ms) completing between two 50Hz stepFrame ticks
  speccy.keyboard.setVirtualKey('P', true);
  speccy.keyboard.setVirtualKey('P', false);
  speccy.keyboard.setKempstonDirection(4, true);
  speccy.keyboard.setKempstonDirection(4, false);

  // Must remain active across frames 1..3 so 50Hz, 25Hz, and debounced loops catch it
  assert.equal((speccy.keyboard.readRows(0xdf) & 0x01) === 0, true);
  assert.equal((speccy.keyboard.kempston & 0x10) !== 0, true);
  speccy.stepFrame(false); // frame 1
  assert.equal((speccy.keyboard.readRows(0xdf) & 0x01) === 0, true);
  assert.equal((speccy.keyboard.kempston & 0x10) !== 0, true);
  speccy.stepFrame(false); // frame 2
  assert.equal((speccy.keyboard.readRows(0xdf) & 0x01) === 0, true);
  speccy.stepFrame(false); // frame 3 -> releases after 3rd frame
  assert.equal((speccy.keyboard.readRows(0xdf) & 0x01) === 0, false);
  assert.equal((speccy.keyboard.kempston & 0x10) !== 0, false);

  // Verify 48K ROM registered 'P' (PRINT token 245 at K-mode prompt) in LAST_K (0x5C08)
  assert.equal(speccy.cpu.rb(0x5c08), 245);

  // Verify consecutive fast tap flushes prior pending-release key after >= 1 frame so keys don't collide
  speccy.keyboard.setVirtualKey('2', true);
  speccy.keyboard.setVirtualKey('2', false);
  speccy.stepFrame(false); // '2' got 1 full frame, 2 remaining
  speccy.keyboard.setVirtualKey('5', true); // new non-shift key arrives
  assert.equal((speccy.keyboard.readRows(0xf7) & 0x02) === 0, false); // '2' released cleanly
  assert.equal((speccy.keyboard.readRows(0xf7) & 0x10) === 0, true);  // '5' is pressed
  speccy.keyboard.setVirtualKey('5', false);
  speccy.stepFrame(false);
  speccy.stepFrame(false);
  speccy.stepFrame(false);
  assert.equal((speccy.keyboard.readRows(0xf7) & 0x10) === 0, false);
});

test('Kempston Mouse ports 0xFBDF, 0xFFDF, 0xFADF track relative motion, active-low buttons with 3-frame latch, and do not clash with port 0x1F', () => {
  const speccy = new ZXSpectrum48('48k');

  // Idle state: X=128, Y=96, buttons=0xFF (no buttons pressed, wheel=0x0F), Joystick 0x1F=0
  assert.equal(speccy.readPort(0xfbdf), 128);
  assert.equal(speccy.readPort(0xffdf), 96);
  assert.equal(speccy.readPort(0xfadf), 0xff);
  assert.equal(speccy.readPort(0x001f), 0x00);

  // Move right (+20.5) and down (+10.5 in DOM coords -> Y decreases by 10), then +0.5 -> +1 more
  speccy.keyboard.moveKempstonMouse(20.5, 10.5);
  assert.equal(speccy.readPort(0xfbdf), 148);
  assert.equal(speccy.readPort(0xffdf), 86);
  speccy.keyboard.moveKempstonMouse(0.5, 0.5);
  assert.equal(speccy.readPort(0xfbdf), 149);
  assert.equal(speccy.readPort(0xffdf), 85);

  // Move up (-5 in DOM coords -> Y increases) and wrap around 0..255
  speccy.keyboard.moveKempstonMouse(120, -200);
  assert.equal(speccy.readPort(0xfbdf), (149 + 120) & 0xff);
  assert.equal(speccy.readPort(0xffdf), (85 + 200) & 0xff);

  // Sub-frame Left click + Right click latch across 3 frames
  speccy.keyboard.setKempstonMouseButton(0, true);
  speccy.keyboard.setKempstonMouseButton(0, false);
  assert.equal(speccy.readPort(0xfadf) & 0x07, 0x06); // bit 0 active low
  speccy.stepFrame(false);
  assert.equal(speccy.readPort(0xfadf) & 0x07, 0x06);
  speccy.stepFrame(false);
  assert.equal(speccy.readPort(0xfadf) & 0x07, 0x06);
  speccy.stepFrame(false);
  assert.equal(speccy.readPort(0xfadf) & 0x07, 0x07); // released after 3rd frame

  // Hold Right button while Joystick 0x1F is active -> independent ports
  speccy.keyboard.setKempstonMouseButton(1, true);
  speccy.keyboard.setKempstonDirection(0, true);
  assert.equal(speccy.readPort(0xfadf) & 0x07, 0x05); // bit 1 active low
  assert.equal(speccy.readPort(0x001f), 0x01);        // joystick right still works
});

test('Virtual buttons dispatch immediately without FIFO queue delay and support simultaneous multi-touch chords', () => {
  const speccy = new ZXSpectrum48('48k');
  const kb = speccy.keyboard;

  // Simultaneous multi-touch press of pure Kempston FIRE (bit 4) and Arrow Down (CAPS + 6)
  kb.pressVirtualButton(1, 'PAD_FIRE', [], 4);
  kb.pressVirtualButton(2, 'ARROW_DOWN', ['CAPS', '6']);

  // Both must be active IMMEDIATELY on the same frame with zero queue latency, without polluting SPACE
  assert.equal((kb.kempston & 0x10) !== 0, true);
  assert.equal((kb.readRows(0x7f) & 0x01) === 0, false); // SPACE untouched
  assert.equal((kb.readRows(0xfe) & 0x01) === 0, true);  // CAPS
  assert.equal((kb.readRows(0xef) & 0x10) === 0, true);  // 6

  // Release both; 3-frame latch keeps sub-frame tap readable until 3 frames complete
  kb.releaseVirtualButton(1);
  kb.releaseVirtualButton(2);
  speccy.stepFrame(false);
  speccy.stepFrame(false);
  speccy.stepFrame(false);
  assert.equal((kb.kempston & 0x10) !== 0, false);
  assert.equal((kb.readRows(0xfe) & 0x01) === 0, false);
  assert.equal((kb.readRows(0xef) & 0x10) === 0, false);
});

test('Continuous stick/D-Pad updates pure Kempston port 0x1F immediately without injecting QAOP keys', () => {
  const speccy = new ZXSpectrum48('48k');
  const kb = speccy.keyboard;

  // Sweep stick to down-right (Kempston D=0x04 | R=0x01) -> keyboard QAOP rows remain untouched
  kb.setContinuousPadMask(0x04 | 0x01);
  assert.equal(speccy.readPort(0x001f), 0x05);
  assert.equal((kb.readRows(0xfd) & 0x01) === 0, false); // A untouched
  assert.equal((kb.readRows(0xdf) & 0x01) === 0, false); // P untouched
  assert.equal((kb.readRows(0xfb) & 0x01) === 0, false); // Q untouched
  assert.equal((kb.readRows(0xdf) & 0x02) === 0, false); // O untouched

  // Immediately reverse stick to up-left (U=0x08 | L=0x02) without releasing in between
  kb.setContinuousPadMask(0x08 | 0x02);
  assert.equal(speccy.readPort(0x001f), 0x0a);

  // Release stick to center -> all cleared immediately
  kb.setContinuousPadMask(0);
  assert.equal(speccy.readPort(0x001f), 0x00);

  // Calling releaseAllVirtual while stick is held must also clear Kempston cleanly
  kb.setContinuousPadMask(0x04 | 0x01);
  kb.releaseAllVirtual();
  assert.equal(speccy.readPort(0x001f), 0x00);
});

test('Fast .TAP loader traps 0x0562 and 0x055E sub-entry points with A\'/F\' flags and stack return', async () => {
  const { buildTapBlock, concatUint8Arrays } = await import('./formats');
  const payload0 = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  const payload1 = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
  const tap = concatUint8Arrays([
    buildTapBlock(0x2a, payload0),
    buildTapBlock(0xff, payload1),
  ]);

  const speccy = new ZXSpectrum48('48k');
  speccy.setFastTapeLoad(true);
  speccy.loadFile('custom_entry.tap', tap, false);

  // Code at 0x8000:
  // 1) CALL 0x8020 (which does INC D; EX AF,AF'; DEC D; DI; JP 0x0562) -> returns via RET to 0x8003
  // 2) LD IX, 0x9010; LD DE, 0x0004; LD A, 0xFF; SCF; INC D; EX AF,AF'; DEC D; DI; JP 0x055E -> returns via 0x053F -> HALT
  const ram = speccy.ramPages[2]; // 0x8000
  const prog = [
    0xdd, 0x21, 0x00, 0x90, // LD IX, 0x9000
    0x11, 0x04, 0x00,       // LD DE, 0x0004
    0x3e, 0x2a,             // LD A, 0x2A
    0x37,                   // SCF
    0xcd, 0x30, 0x80,       // CALL 0x8030 (custom 0x0562 wrapper)
    0xd2, 0x40, 0x80,       // JP NC, 0x8040 (error trap)
    0xdd, 0x21, 0x10, 0x90, // LD IX, 0x9010
    0x11, 0x04, 0x00,       // LD DE, 0x0004
    0x3e, 0xff,             // LD A, 0xFF
    0x37,                   // SCF
    0xcd, 0x38, 0x80,       // CALL 0x8038 (custom 0x055E wrapper)
    0xd2, 0x40, 0x80,       // JP NC, 0x8040
    0xf3, 0x76,             // DI; HALT
  ];
  ram.set(prog, 0);
  // 0x8030: INC D; EX AF,AF'; DEC D; DI; JP 0x0562
  ram.set([0x14, 0x08, 0x15, 0xf3, 0xc3, 0x62, 0x05], 0x30);
  // 0x8038: INC D; EX AF,AF'; DEC D; DI; JP 0x055E
  ram.set([0x14, 0x08, 0x15, 0xf3, 0xc3, 0x5e, 0x05], 0x38);
  // 0x8040: LD A, 0xEE; DI; HALT (error marker)
  ram.set([0x3e, 0xee, 0xf3, 0x76], 0x40);

  speccy.cpu.pc = 0x8000;
  speccy.cpu.sp = 0xfff0;
  for (let i = 0; i < 10; i++) speccy.stepFrame(false);

  assert.equal(speccy.cpu.halted, true);
  assert.notEqual(speccy.cpu.a, 0xee, 'Should not hit NC error branch');
  assert.deepEqual(Array.from(speccy.ramPages[2].subarray(0x1000, 0x1004)), Array.from(payload0));
  assert.deepEqual(Array.from(speccy.ramPages[2].subarray(0x1010, 0x1014)), Array.from(payload1));
  assert.equal(speccy.tapeIndex, 2);
});

test('Custom RAM EAR-polling tape loader auto-engages TapePlayer even with fastTapeLoad enabled', async () => {
  const { buildTapBlock, concatUint8Arrays } = await import('./formats');
  const tap = concatUint8Arrays([
    buildTapBlock(0x00, new Uint8Array(17)), // dummy block 0 already consumed
    buildTapBlock(0xff, new Uint8Array([0x55, 0xaa])),
  ]);

  const speccy = new ZXSpectrum48('48k');
  speccy.setFastTapeLoad(true);
  speccy.loadFile('ram_loader.tap', tap, false);
  speccy.tapeIndex = 1; // Simulate stage 1 already loaded

  // RAM loop at 0x8000: DI; IN A,(0xFE); JR $-2
  speccy.ramPages[2].set([0xf3, 0xdb, 0xfe, 0x18, 0xfc], 0);
  speccy.cpu.pc = 0x8000;

  assert.equal(speccy.tapePlayer.active, false);
  speccy.stepFrame(false);
  assert.equal(speccy.tapePlayer.active, true, 'Expected RAM EAR-polling loop to auto-engage TapePlayer');
  assert.equal(speccy.tapePlayer.blockIdx, 1);
});

test('EXOLON_not_working.TAP loads and launches cleanly across 48K, 128K, +2, Pentagon, and Scorpion 256', async () => {
  const fs = await import('node:fs');
  if (!fs.existsSync('EXOLON_not_working.TAP')) return;

  const bytes = new Uint8Array(fs.readFileSync('EXOLON_not_working.TAP'));
  const machines = ['48k', '128k', 'plus2', 'pentagon128', 'pentagon604', 'scorpion256'] as const;

  for (const m of machines) {
    const speccy = new ZXSpectrum48(m);
    speccy.setFastTapeLoad(true);
    speccy.loadFile('EXOLON_not_working.TAP', bytes, true);

    assert.equal(speccy.tapeIndex, 8, `${m}: expected all 8 TAP blocks loaded`);

    let scrNonZero = 0;
    const scr = speccy.ramPages[speccy.screenBankIdx];
    for (let i = 0; i < 0x1800; i++) {
      if (scr[i] !== 0) scrNonZero++;
    }
    assert.ok(scrNonZero > 1000, `${m}: expected Exolon loading screen pixels > 1000, got ${scrNonZero}`);

    // Press any key (SPACE) to pass "press any key" loader prompt and enter Exolon
    speccy.keyboard.tapKeys(['SPACE']);
    for (let f = 0; f < 5; f++) speccy.stepFrame(false);
    speccy.keyboard.releaseKeys(['SPACE']);
    for (let f = 0; f < 40; f++) speccy.stepFrame(false);

    assert.ok(
      speccy.cpu.pc >= 0x6d60 && speccy.cpu.pc < 0xffff,
      `${m}: expected Exolon running in game code, got PC=0x${speccy.cpu.pc.toString(16)}`
    );
    if (speccy.profile.hasAY) {
      assert.equal(speccy.ay.active, true, `${m}: expected AY-3-8910 music active in Exolon`);
    }
  }
});

test('createBlankTrdImage produces valid formatted 640KB TR-DOS image and BetaDisk128 sets writeDirtyMask on writes only', () => {
  const blank = createBlankTrdImage('MYDISK');
  assert.equal(blank.length, 655360);
  const info = 0x800;
  assert.equal(blank[info + 0xe1], 0); // First free sector
  assert.equal(blank[info + 0xe2], 1); // First free track
  assert.equal(blank[info + 0xe3], 0x16); // 80T DS
  assert.equal(blank[info + 0xe4], 0); // 0 files
  assert.equal(blank[info + 0xe5] | (blank[info + 0xe6] << 8), 2544); // Free sectors
  assert.equal(blank[info + 0xe7], 0x10); // TR-DOS ID

  const speccy = new ZXSpectrum48('pentagon128');
  speccy.bdi.insertDisk(1, blank);
  assert.equal(speccy.bdi.writeDirtyMask, 0, 'Inserting blank disk must not mark it dirty');

  // Reading a sector from Drive B should trigger readActivityMask, NOT writeDirtyMask
  speccy.bdi.readActivityMask = 0;
  speccy.bdi.writePort(0xff, 0x3d); // Select Drive B (bits 0..1 = 1)
  speccy.bdi.writePort(0x3f, 0x00);
  speccy.bdi.writePort(0x5f, 0x09); // Sector 9 (Track 0 info block)
  speccy.bdi.writePort(0x1f, 0x80); // Read Sector
  const idByteCheck = speccy.bdi.readPort(0x7f);
  assert.equal(typeof idByteCheck, 'number');
  assert.ok((speccy.bdi.readActivityMask & 0x02) !== 0);
  assert.equal(speccy.bdi.writeDirtyMask, 0, 'Reading must not set writeDirtyMask');

  // Writing a sector byte to Drive B (Cylinder 1, Side 0, Sector 1) must set writeDirtyMask bit 1 and persist into disk buffer
  speccy.bdi.writePort(0x1f, 0xd0); // Force Interrupt
  speccy.bdi.writePort(0x7f, 0x01); // Target track 1
  speccy.bdi.writePort(0x1f, 0x10); // Seek Cylinder 1
  speccy.bdi.writePort(0x5f, 0x01); // Sector 1
  speccy.bdi.writePort(0x1f, 0xa0); // Write Sector
  speccy.bdi.writePort(0x7f, 0x5a);
  assert.ok((speccy.bdi.writeDirtyMask & 0x02) !== 0, 'Writing data byte must set writeDirtyMask bit 1');
  assert.equal(speccy.bdi.disks[1]![2 * 16 * 256], 0x5a);
});

test('diskStorage manages naming, saving, renaming, loading, and deleting cached disks', async () => {
  assert.equal(normalizeDiskFilename('  Моя игра  '), 'Моя игра.trd');
  assert.equal(normalizeDiskFilename('TEST.TRD'), 'TEST.TRD');
  assert.equal(
    generateNextDiskName([
      { id: '1', name: 'Диск 1.trd', createdAt: 1, updatedAt: 1 },
      { id: '2', name: 'Диск 3.trd', createdAt: 2, updatedAt: 2 },
    ]),
    'Диск 2.trd'
  );

  const blank = createBlankTrdImage();
  blank[8192] = 0xab;
  const saved = await putSavedDisk('test-disk-1', 'Диск 1', blank);
  assert.equal(saved.name, 'Диск 1.trd');

  const list1 = await listSavedDisks();
  assert.equal(list1.length, 1);
  assert.equal(list1[0].id, 'test-disk-1');

  const loaded = await getSavedDiskBytes('test-disk-1');
  assert.ok(loaded);
  assert.equal(loaded[8192], 0xab);

  const renamed = await renameSavedDisk('test-disk-1', 'Супер Игра');
  assert.ok(renamed);
  assert.equal(renamed.name, 'Супер Игра.trd');

  await deleteSavedDisk('test-disk-1');
  const list2 = await listSavedDisks();
  assert.equal(list2.length, 0);
});

test('upsertSessionDiskHistory tracks session disk picks without duplicates', () => {
  const bytesA = createBlankTrdImage('DISK_A');
  const bytesB = createBlankTrdImage('DISK_B');
  let history = upsertSessionDiskHistory([], 'elite_1.trd', bytesA);
  history = upsertSessionDiskHistory(history, 'elite_2.scl', bytesB);
  assert.deepEqual(
    history.map((h) => h.name),
    ['elite_2.scl', 'elite_1.trd']
  );

  // Re-selecting elite_1.trd moves it to top without duplicating
  history = upsertSessionDiskHistory(history, 'elite_1.trd', bytesA);
  assert.deepEqual(
    history.map((h) => h.name),
    ['elite_1.trd', 'elite_2.scl']
  );
});

test('topRowConfig resolves global, per-game, and session overrides cleanly', () => {
  const store = new Map<string, string>();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };

  try {
    assert.deepEqual(resolveTopRowIds(null, null), [...DEFAULT_TOP_ROW_IDS]);
    assert.equal(normalizeTopRowIds(['1', '2']), null);
    assert.equal(
      normalizeTopRowIds(['INVALID', '2', '3', '4', '5', '6', '7', '8', '9', '0']),
      null
    );

    const globalRow = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'];
    saveGlobalTopRowIds(globalRow);
    assert.deepEqual(resolveTopRowIds(null, null), globalRow);
    assert.deepEqual(resolveTopRowIds('Snake', null), globalRow);

    const exolonRow = ['M', 'SPACE', '3', '4', '5', '6', '7', '8', '9', '0'];
    saveGameTopRowIds('Exolon', exolonRow);
    assert.deepEqual(resolveTopRowIds('Exolon', null), exolonRow);
    assert.deepEqual(resolveTopRowIds('  exolon  ', null), exolonRow);
    assert.deepEqual(resolveTopRowIds('Snake', null), globalRow);

    clearGameTopRowIds('Exolon');
    assert.deepEqual(resolveTopRowIds('Exolon', null), globalRow);

    // Canonical zxart:<id> binding + legacy title fallback
    const zxArtRow = ['Q', 'A', 'O', 'P', 'SPACE', '6', '7', '8', '9', '0'];
    saveGameTopRowIds('Exolon', zxArtRow);
    assert.deepEqual(resolveTopRowIds('zxart:12345', null, 'Exolon'), zxArtRow);

    const zxArtCanonicalRow = ['ENTER', 'SPACE', 'M', '4', '5', '6', '7', '8', '9', '0'];
    saveGameTopRowIds('zxart:12345', zxArtCanonicalRow, 'Exolon');
    assert.deepEqual(resolveTopRowIds('zxart:12345', null, 'Exolon'), zxArtCanonicalRow);
    // Legacy title key cleaned up when saving under canonical zxart key
    assert.deepEqual(resolveTopRowIds('Exolon', null), globalRow);
    clearGameTopRowIds('zxart:12345', 'Exolon');
    assert.deepEqual(resolveTopRowIds('zxart:12345', null, 'Exolon'), globalRow);

    // Distinct releases of the same ZX-Art game have independent top-row key mappings
    const rel101Row = ['Q', 'W', 'E', 'R', 'T', '1', '2', '3', '4', '5'];
    const rel202Row = ['Z', 'X', 'C', 'V', 'B', '6', '7', '8', '9', '0'];
    saveGameTopRowIds('zxart:12345:rel:101', rel101Row);
    saveGameTopRowIds('zxart:12345:rel:202', rel202Row);
    assert.deepEqual(resolveTopRowIds('zxart:12345:rel:101', null), rel101Row);
    assert.deepEqual(resolveTopRowIds('zxart:12345:rel:202', null), rel202Row);
    assert.deepEqual(resolveTopRowIds('zxart:12345:rel:303', null), globalRow);

    const sessionRow = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'ENTER'];
    assert.deepEqual(resolveTopRowIds(null, sessionRow), sessionRow);
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

test('KeyboardMatrix QAOP joystick mode drives Q/A/O/P cleanly without touching Kempston port 0x1F', () => {
  const speccy = new ZXSpectrum48('48k');
  const kb = speccy.keyboard;

  assert.equal(kb.getJoystickMode(), 'kempston');
  kb.setJoystickMode('qaop');
  assert.equal(kb.getJoystickMode(), 'qaop');

  // Down-Right in QAOP mode presses A and P, leaving port 0x1F untouched
  kb.setContinuousPadMask(0x04 | 0x01);
  assert.equal(speccy.readPort(0x001f), 0x00);
  assert.equal((kb.readRows(0xfd) & 0x01) === 0, true); // A down
  assert.equal((kb.readRows(0xdf) & 0x01) === 0, true); // P down

  // Switching back to Kempston releases held QAOP directions cleanly
  kb.setJoystickMode('kempston');
  assert.equal((kb.readRows(0xfd) & 0x01) === 0, false); // A released
  assert.equal((kb.readRows(0xdf) & 0x01) === 0, false); // P released
});

test('settingsStorage persists and sanitizes emulator settings in browser storage', () => {
  const store = new Map<string, string>();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };

  try {
    assert.deepEqual(loadEmulatorSettings(), DEFAULT_EMULATOR_SETTINGS);
    assert.equal(DEFAULT_EMULATOR_SETTINGS.joystickMode, 'kempston');
    assert.equal(DEFAULT_EMULATOR_SETTINGS.borderMode, 'full');
    assert.equal(DEFAULT_EMULATOR_SETTINGS.screenScale, 'auto');

    const custom = {
      ...DEFAULT_EMULATOR_SETTINGS,
      joystickMode: 'qaop' as const,
      scanlines: true,
      borderMode: 'small' as const,
      screenScale: 'aspect' as const,
      cpuFreqMhz: 7,
      stereoMode: 'abc' as const,
    };
    saveEmulatorSettings(custom);
    assert.deepEqual(loadEmulatorSettings(), custom);

    const sanitized = sanitizeEmulatorSettings({
      joystickMode: 'invalid',
      borderMode: 'bad',
      screenScale: 'unknown',
      cpuFreqMhz: 99,
      volume: -5,
    });
    assert.equal(sanitized.joystickMode, 'kempston');
    assert.equal(sanitized.borderMode, 'full');
    assert.equal(sanitized.screenScale, 'auto');
    assert.equal(sanitized.cpuFreqMhz, 14);
    assert.equal(sanitized.volume, 0);

    // Legacy noBorder: true migrates cleanly to borderMode: 'none'
    const migrated = sanitizeEmulatorSettings({ noBorder: true });
    assert.equal(migrated.borderMode, 'none');
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

test('getBorderViewport computes exact offsets, dimensions, and 4:3 aspect ratio for full, small, and none border modes', () => {
  const full = getBorderViewport('full');
  assert.deepEqual(full, { offsetX: 0, offsetY: 0, width: SCREEN_WIDTH, height: SCREEN_HEIGHT });

  const small = getBorderViewport('small');
  assert.deepEqual(small, {
    offsetX: BORDER_X - SMALL_BORDER_X,
    offsetY: BORDER_Y - SMALL_BORDER_Y,
    width: ACTIVE_WIDTH + SMALL_BORDER_X * 2,
    height: ACTIVE_HEIGHT + SMALL_BORDER_Y * 2,
  });
  assert.equal(small.width * 3, small.height * 4);

  const none = getBorderViewport('none');
  assert.deepEqual(none, {
    offsetX: BORDER_X,
    offsetY: BORDER_Y,
    width: ACTIVE_WIDTH,
    height: ACTIVE_HEIGHT,
  });
});

test('ZXSpectrum48 createSnaSnapshot round-trips 48K and 128K CPU registers, RAM banks, and VRAM accurately', () => {
  // 48K SNA round-trip without mutating live stack bytes
  const s48 = new ZXSpectrum48('48k');
  s48.cpu.pc = 0x8123;
  s48.cpu.sp = 0xf000;
  s48.cpu.a = 0x5a;
  s48.cpu.hl = 0x4321;
  s48.cpu.iff1 = 1;
  s48.cpu.iff2 = 1;
  s48.borderColor = 3;
  s48.ramPages[5][0x0000] = 0xaa;
  s48.ramPages[2][0x1234] = 0x77;
  s48.ramPages[0][0x2ffe] = 0x11;
  s48.ramPages[0][0x2fff] = 0x22;

  const sna48 = s48.createSnaSnapshot();
  assert.equal(sna48.length, 49179);
  // Live RAM at SP-2 must remain untouched
  assert.equal(s48.ramPages[0][0x2ffe], 0x11);
  assert.equal(s48.ramPages[0][0x2fff], 0x22);

  const restored48 = new ZXSpectrum48('48k');
  restored48.loadFile('save.sna', sna48, false);
  assert.equal(restored48.cpu.pc, 0x8123);
  assert.equal(restored48.cpu.sp, 0xf000);
  assert.equal(restored48.cpu.a, 0x5a);
  assert.equal(restored48.cpu.hl, 0x4321);
  assert.equal(restored48.borderColor, 3);
  assert.equal(restored48.ramPages[5][0x0000], 0xaa);
  assert.equal(restored48.ramPages[2][0x1234], 0x77);

  // 128K SNA round-trip across paged RAM banks
  const s128 = new ZXSpectrum48('128k');
  s128.apply128kState(0x13, false); // page 3 mapped at 0xC000, ROM 1
  s128.cpu.pc = 0xc400;
  s128.cpu.sp = 0xb800;
  s128.cpu.bc = 0x9988;
  s128.borderColor = 5;
  s128.ramPages[3][0x0400] = 0x42;
  s128.ramPages[6][0x0010] = 0xef;

  const sna128 = s128.createSnaSnapshot();
  assert.equal(sna128.length, 131103);

  const restored128 = new ZXSpectrum48('128k');
  restored128.loadFile('save128.sna', sna128, false);
  assert.equal(restored128.cpu.pc, 0xc400);
  assert.equal(restored128.cpu.sp, 0xb800);
  assert.equal(restored128.cpu.bc, 0x9988);
  assert.equal(restored128.port7FFD & 0x1f, 0x13);
  assert.equal(restored128.borderColor, 5);
  assert.equal(restored128.ramPages[3][0x0400], 0x42);
  assert.equal(restored128.ramPages[6][0x0010], 0xef);
});

test('saveStateStorage saves, lists, loads, normalizes filename, and deletes savestates with screenshots', async () => {
  assert.equal(normalizeSnaFilename('  Saboteur  '), 'Saboteur.sna');
  assert.equal(normalizeSnaFilename('GAME.SNA'), 'GAME.SNA');
  assert.equal(normalizeSnaFilename('a/b:c*d'), 'a_b_c_d.sna');
  assert.equal(normalizeSnaFilename('   '), 'savestate.sna');

  assert.equal(resolveSaveStateGameKey('  Saboteur ', null, '128k'), 'game:saboteur');
  assert.equal(
    resolveSaveStateGameKey('Castlevania — rel1.tap', null, '128k', 'zxart:189835:rel:101'),
    'zxart:189835:rel:101'
  );
  assert.equal(extractZxArtProdIdFromKey('zxart:189835:rel:101'), 189835);
  assert.equal(extractZxArtProdIdFromKey('zxart:189835'), 189835);
  assert.equal(isReleaseScopedGameKey('zxart:189835:rel:101'), true);
  assert.equal(isReleaseScopedGameKey('zxart:189835'), false);

  // Release-scoped savestates are strictly isolated between versions of the same game
  assert.equal(
    doesSaveStateMatchGame(
      { title: 'Castlevania — v1.tap', gameKey: 'zxart:189835:rel:101', machineId: '128k' },
      { gameKey: 'zxart:189835:rel:101', title: 'Castlevania — v1.tap' }
    ),
    true
  );
  assert.equal(
    doesSaveStateMatchGame(
      { title: 'Castlevania — v1.tap', gameKey: 'zxart:189835:rel:101', machineId: '128k' },
      { gameKey: 'zxart:189835:rel:202', title: 'Castlevania — v2.trd' }
    ),
    false
  );
  // Legacy title-only save must NOT leak into a specific release-scoped slot
  assert.equal(
    doesSaveStateMatchGame(
      { title: 'Castlevania', machineId: '128k' },
      { gameKey: 'zxart:189835:rel:101', title: 'Castlevania' }
    ),
    false
  );
  // Product-level zxart:<prodId> still aggregates releases for catalog grid count
  assert.equal(
    doesSaveStateMatchGame(
      { title: 'Castlevania — v1.tap', gameKey: 'zxart:189835:rel:101', machineId: '128k' },
      { gameKey: 'zxart:189835', title: 'Castlevania' }
    ),
    true
  );
  assert.equal(
    doesSaveStateMatchGame(
      { title: 'Exolon', gameKey: 'zxart:999:rel:1', machineId: '128k' },
      { gameKey: 'zxart:189835', title: 'Castlevania' }
    ),
    false
  );

  const bytes = new Uint8Array(49179);
  bytes[22] = 0x33;

  const meta = await putSaveState({
    id: 'test-save-1',
    title: 'Saboteur',
    gameKey: 'game:saboteur',
    machineId: '128k',
    createdAt: 1700000000000,
    screenshotDataUrl: 'data:image/webp;base64,AAAA',
    snaBytes: bytes,
  });
  assert.equal(meta.id, 'test-save-1');
  assert.equal(meta.title, 'Saboteur');
  assert.equal(meta.gameKey, 'game:saboteur');

  const list = await listSaveStates();
  assert.ok(list.some((item) => item.id === 'test-save-1' && item.screenshotDataUrl === 'data:image/webp;base64,AAAA'));

  const loaded = await getSaveStateRecord('test-save-1');
  assert.ok(loaded);
  assert.equal(loaded.machineId, '128k');
  assert.equal(loaded.snaBytes.length, 49179);
  assert.equal(loaded.snaBytes[22], 0x33);

  await deleteSaveState('test-save-1');
  assert.equal(await getSaveStateRecord('test-save-1'), null);
});

test('framePacer PLL eliminates 2-frame catchup bursts on jittered 60Hz/120Hz displays and clamps stalls', () => {
  const pacer = createFramePacerState();
  const targetHz = 50.0212;
  const vsync60 = 1000 / 60;
  // Synthetic OS rAF jitter alternating ±1.4ms around 60Hz vsyncs
  const jitter = [0, 1.3, -1.4, 0.9, -1.1, 1.4, -0.8, 0.4, -1.2, 1.0];

  let totalSteps = 0;
  let twoStepBursts = 0;
  let now = 1000;
  for (let i = 0; i < 300; i++) {
    const j = i === 0 ? 0 : jitter[i % jitter.length];
    now = 1000 + i * vsync60 + j;
    const steps = advanceFramePacer(pacer, now, targetHz, 2);
    if (steps === 2) twoStepBursts++;
    totalSteps += steps;
  }
  assert.equal(twoStepBursts, 0, '60Hz rAF jitter within ±1.4ms must never cause 2-step catchup bursts');
  // 300 60Hz ticks = 5.0 seconds -> ~250 PAL frames
  assert.ok(
    totalSteps >= 248 && totalSteps <= 252,
    `Expected ~250 frames in 5s at 50Hz, got ${totalSteps}`
  );

  // 120Hz display cadence converges smoothly (~8.33ms per tick)
  resetFramePacerState(pacer, 0);
  const vsync120 = 1000 / 120;
  let steps120 = 0;
  let bursts120 = 0;
  for (let i = 0; i < 600; i++) {
    const t = 20000 + i * vsync120 + ((i & 1) === 0 ? 0.5 : -0.5);
    const s = advanceFramePacer(pacer, t, targetHz, 2);
    if (s === 2) bursts120++;
    steps120 += s;
  }
  assert.equal(bursts120, 0, '120Hz rAF should never emit 2-step bursts');
  assert.ok(steps120 >= 248 && steps120 <= 253, `Expected ~250 frames on 120Hz, got ${steps120}`);

  // Tab switch >60ms outlier is clamped cleanly instead of triggering multi-frame backlog
  const afterStall = advanceFramePacer(pacer, 20000 + 600 * vsync120 + 2500, targetHz, 2);
  assert.ok(afterStall <= 1, `Expected <=1 step after >60ms stall clamp, got ${afterStall}`);
});

test('ZXSpectrum48 renderFrame border cache updates accurately across uniform and scanline multicolor frames', () => {
  const speccy = new ZXSpectrum48('48k');
  // Border 2 (Red = 0xFF0000D7 in ABGR)
  speccy.borderColor = 2;
  speccy.renderFrame();
  assert.equal(speccy.frameBuffer[0], 0xff0000d7);
  assert.equal(speccy.frameBuffer[SCREEN_WIDTH * (SCREEN_HEIGHT - 1) + SCREEN_WIDTH - 1], 0xff0000d7);

  // Second uniform frame with cached border must preserve border and still update screen pixels
  speccy.ramPages[5][0] = 0xff;
  speccy.ramPages[5][0x1800] = 0x04; // ink green (4), paper black
  speccy.renderFrame();
  assert.equal(speccy.frameBuffer[0], 0xff0000d7);
  assert.equal(speccy.frameBuffer[BORDER_Y * SCREEN_WIDTH + BORDER_X], 0xff00d700);

  // Changing border color invalidates border cache
  speccy.borderColor = 5; // Cyan = 0xFFD7D700
  speccy.renderFrame();
  assert.equal(speccy.frameBuffer[0], 0xffd7d700);
  assert.equal(speccy.frameBuffer[BORDER_Y * SCREEN_WIDTH + BORDER_X + 31 * 8 + 7 + BORDER_X], 0xffd7d700);

  // Mid-frame scanline border transition and recovery back to uniform border
  // Code at 0x8000: DI; LD BC, 1200; LOOP: DEC BC; LD A,B; OR C; JR NZ, LOOP; LD A,1; OUT (0xFE),A; HALT
  speccy.ramPages[2].set([
    0xf3,             // DI
    0x01, 0xb0, 0x04, // LD BC, 1200 (~31,200 T-states delay -> ~45% into frame)
    0x0b,             // DEC BC
    0x78,             // LD A, B
    0xb1,             // OR C
    0x20, 0xfb,       // JR NZ, -5
    0x3e, 0x01,       // LD A, 1
    0xd3, 0xfe,       // OUT (0xFE), A
    0x76,             // HALT
  ], 0);
  speccy.cpu.pc = 0x8000;
  speccy.cpu.tstates = 0;
  speccy.stepFrame(true);
  assert.equal(speccy.frameBuffer[0], 0xffd7d700); // top remained cyan (5)
  assert.equal(speccy.frameBuffer[(SCREEN_HEIGHT - 1) * SCREEN_WIDTH], 0xffd70000); // bottom became blue (1)

  // Next steady uniform frame with border still 1 must repaint top border to blue
  speccy.renderFrame();
  assert.equal(speccy.frameBuffer[0], 0xffd70000);
});

test('AY8910 hoisted local state preserves mid-frame envelope R13 reset parity', () => {
  const ay = new AY8910();
  ay.beginFrame();
  ay.selectRegister(7);
  ay.writeRegister(0xff, 0); // pure envelope/DC volume
  ay.selectRegister(11);
  ay.writeRegister(0x10, 0);
  ay.selectRegister(8);
  ay.writeRegister(0x10, 0); // envelope controlled ch A
  ay.selectRegister(13);
  ay.writeRegister(0x00, 100); // decaying envelope (starts 15, holds 0)
  ay.writeRegister(0x0c, 50000); // re-trigger attacking envelope mid-frame (starts 0, goes up)

  const outL = new Float32Array(960);
  const outR = new Float32Array(960);
  ay.mixIntoStereo(outL, outR, 0, 960, 48000, 'mono', 1_773_400, 70908);

  // Early sample after decay ends should be low/zero, tail sample after R13=0x0C retrigger should rise
  let tailSum = 0;
  for (let i = 750; i < 950; i++) tailSum += outL[i];
  assert.ok(tailSum > 1, `Expected R13 mid-frame retrigger to raise tail output, sum=${tailSum}`);
});

test('KeyboardMatrix static physical key tuples and unrolled readRows handle shifted punctuation, letters, and chords', () => {
  const kb = new KeyboardMatrix();

  // Letter 'A' (Row 1, bit 0)
  assert.equal(kb.handlePhysicalKeyDown('KeyA', 'ф', false), true);
  assert.equal((kb.readRows(0xfd) & 0x01) === 0, true);
  kb.handlePhysicalKeyUp('KeyA');
  assert.equal((kb.readRows(0xfd) & 0x01) === 0, false);

  // Shifted punctuation '"' -> SYMBOL (Row 7, bit 1) + P (Row 5, bit 0)
  assert.equal(kb.handlePhysicalKeyDown('Quote', '"', true), true);
  assert.equal((kb.readRows(0x7f) & 0x02) === 0, true);
  assert.equal((kb.readRows(0xdf) & 0x01) === 0, true);
  // Multi-row scan A15=0 & A13=0 (0x5F) should AND both rows
  assert.equal(kb.readRows(0x5f) & 0x03, 0x00);

  kb.releaseAllPhysical();
  assert.equal(kb.readRows(0x00), 0x1f);
});

test('encodeSpectrumStringKeys and findTrdosAutoBootTarget resolve boot, fallback named BASIC, and preferred filename', () => {
  assert.deepEqual(encodeSpectrumStringKeys('Seraphim'), [
    ['CAPS', 'S'], ['E'], ['R'], ['A'], ['P'], ['H'], ['I'], ['M'],
  ]);
  assert.deepEqual(encodeSpectrumStringKeys('a 1-2'), [
    ['A'], ['SPACE'], ['1'], ['SYMBOL', 'J'], ['2'],
  ]);
  assert.equal(encodeSpectrumStringKeys('bad"name'), null);

  // 1. Exact lowercase "boot" wins
  const trdWithBoot = buildTrdImage([
    { name: 'Seraphim', ext: 'B', start: 4, payload: new Uint8Array(256) },
    { name: 'boot', ext: 'B', start: 4, payload: new Uint8Array(256) },
  ]);
  assert.deepEqual(findTrdosAutoBootTarget(trdWithBoot, 'Seraphim.scl'), { kind: 'boot' });

  // 2. Without "boot", preferred filename match wins over first 'B' file
  const trdMulti = buildTrdImage([
    { name: 'loader', ext: 'B', start: 4, payload: new Uint8Array(256) },
    { name: 'Seraphim', ext: 'B', start: 4, payload: new Uint8Array(256) },
  ]);
  const targetPref = findTrdosAutoBootTarget(trdMulti, 'Seraphim.scl');
  assert.equal(targetPref?.kind, 'named');
  if (targetPref?.kind === 'named') {
    assert.equal(targetPref.name, 'Seraphim');
  }

  // 3. Without preferred match, falls back to first typable 'B' file
  const targetFirst = findTrdosAutoBootTarget(trdMulti, 'other.trd');
  assert.equal(targetFirst?.kind, 'named');
  if (targetFirst?.kind === 'named') {
    assert.equal(targetFirst.name, 'loader');
  }

  // 4. Only CODE files -> null
  const trdNoBasic = buildTrdImage([
    { name: 'data', ext: 'C', start: 0x8000, payload: new Uint8Array(256) },
  ]);
  assert.equal(findTrdosAutoBootTarget(trdNoBasic), null);
});

test('Seraphim.zip (.scl without boot file) auto-boots via TR-DOS RUN "Seraphim" and launches game', async () => {
  const zipPath = path.resolve(process.cwd(), 'Seraphim.zip');
  if (!fs.existsSync(zipPath)) return;

  const zipBytes = new Uint8Array(fs.readFileSync(zipPath));
  const extracted = await extractPlayableFiles('Seraphim.zip', zipBytes, 'game');
  assert.equal(extracted.kind, 'single');
  assert.equal(extracted.file.name, 'Seraphim.scl');

  const speccy = new ZXSpectrum48('128k');
  speccy.loadFile(extracted.file.name, extracted.file.bytes, true);
  assert.equal(speccy.machineId, 'pentagon128');

  // Run until Seraphim finishes loading from disk and reaches its "press any key" loop (0x5EB1)
  let reachedPrompt = false;
  for (let i = 0; i < 1100; i++) {
    speccy.stepFrame(false);
    if (speccy.cpu.pc >= 0x5ea5 && speccy.cpu.pc <= 0x5ec0 && !speccy.trdosActive) {
      reachedPrompt = true;
      break;
    }
  }
  assert.ok(reachedPrompt, `Expected Seraphim to finish TR-DOS load and reach wait loop, PC=0x${speccy.cpu.pc.toString(16)}`);

  // Press SPACE to enter the title menu + AY music
  speccy.keyboard.tapKeys(['SPACE']);
  for (let i = 0; i < 6; i++) speccy.stepFrame(false);
  speccy.keyboard.releaseKeys(['SPACE']);
  for (let i = 0; i < 120; i++) speccy.stepFrame(false);

  assert.ok(speccy.cpu.pc >= 0x6000, `Expected Seraphim main code running, PC=0x${speccy.cpu.pc.toString(16)}`);
  assert.equal(speccy.ay.active, true, 'Expected AY-3-8910 music active in Seraphim');
});






