// Complete ZX Spectrum 48K / 128K / +2 / Pentagon 128 / Scorpion ZS-256 Machine

import { getRomBytes } from './roms';
import { getMachineProfile, MachineId, MachineProfile } from './machines';
import { Z80, Z80IO } from './z80';
import { KeyboardMatrix } from './keyboard';
import { AY8910 } from './ay8910';
import { BetaDisk128, findTrdosAutoBootTarget } from './betaDisk';
import { TapePlayer } from './tapePlayer';
import {
  SnapshotTarget,
  TapeBlock,
  buildSnaSnapshot,
  detectSzxMachine,
  loadAchSnapshot,
  loadFrzSnapshot,
  loadPrgSnapshot,
  loadScrScreen,
  loadSemSnapshot,
  loadSitSnapshot,
  loadSnaSnapshot,
  loadSnxSnapshot,
  loadSpSnapshot,
  loadSzxSnapshot,
  loadZ80Snapshot,
  loadZx82Snapshot,
  loadZxSnapshot,
  parseDckCartridge,
} from './formats';
import { ParsedTapeImage, parseTapeImage, wrapCodeBytesAsTap } from './tapeFormats';
import { isHobetaExtension, parseDiskOrMediaImage } from './diskFormats';

export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 240;
export const ACTIVE_WIDTH = 256;
export const ACTIVE_HEIGHT = 192;
export const BORDER_X = 32;
export const BORDER_Y = 24;
export const SMALL_BORDER_X = 12;
export const SMALL_BORDER_Y = 9;
export const SMALL_SCREEN_WIDTH = ACTIVE_WIDTH + SMALL_BORDER_X * 2;
export const SMALL_SCREEN_HEIGHT = ACTIVE_HEIGHT + SMALL_BORDER_Y * 2;
export const TSTATES_PER_FRAME = 69888; // Default 48K baseline; machine profiles override per frame

export type BorderMode = 'full' | 'small' | 'none';

export interface BorderViewport {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

const VIEWPORT_FULL: BorderViewport = {
  offsetX: 0,
  offsetY: 0,
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
};

const VIEWPORT_SMALL: BorderViewport = {
  offsetX: BORDER_X - SMALL_BORDER_X,
  offsetY: BORDER_Y - SMALL_BORDER_Y,
  width: SMALL_SCREEN_WIDTH,
  height: SMALL_SCREEN_HEIGHT,
};

const VIEWPORT_NONE: BorderViewport = {
  offsetX: BORDER_X,
  offsetY: BORDER_Y,
  width: ACTIVE_WIDTH,
  height: ACTIVE_HEIGHT,
};

export function getBorderViewport(mode: BorderMode): BorderViewport {
  if (mode === 'none') return VIEWPORT_NONE;
  if (mode === 'small') return VIEWPORT_SMALL;
  return VIEWPORT_FULL;
}

// Authentic ZX Spectrum 16-color palette in little-endian ABGR (0xAABBGGRR) for Uint32Array ImageData
const PALETTE_ABGR = new Uint32Array([
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

// Precomputed screen pixel row -> 16KB bank offset (0x0000..0x17FF)
const Y_TO_PIXEL_OFF = new Uint16Array(192);
const Y_TO_ATTR_OFF = new Uint16Array(192);
for (let y = 0; y < 192; y++) {
  const high = ((y & 0xc0) >> 3) | (y & 0x07);
  const low = (y & 0x38) << 2;
  Y_TO_PIXEL_OFF[y] = (high << 8) | low;
  Y_TO_ATTR_OFF[y] = 0x1800 + ((y >> 3) << 5);
}

export class ZXSpectrum48 implements Z80IO {
  // Up to 16 x 16KB RAM pages (256 KB for Scorpion ZS 256)
  public readonly ramPages: Uint8Array[] = Array.from({ length: 16 }, () => new Uint8Array(16384));
  // ROM banks (1..3 x 16KB) + optional 16KB TR-DOS ROM
  public romBanks: Uint8Array[] = [];
  public trdosRom: Uint8Array | null = null;

  public readBanks: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  public writeBanks: [Uint8Array | null, Uint8Array, Uint8Array, Uint8Array];

  public readonly cpu: Z80;
  public readonly keyboard = new KeyboardMatrix();
  public readonly ay = new AY8910();
  public readonly bdi = new BetaDisk128();

  public machineId: MachineId = '48k';
  public profile: MachineProfile = getMachineProfile('48k');

  // 128K / Scorpion / TR-DOS paging state
  public port7FFD = 0;
  public port1FFD = 0;
  public romSelect = 0;
  public ramPage3 = 0;
  public screenBankIdx = 5;
  public pagingLocked = false;
  public trdosActive = false;

  // 320x240 RGBA buffer
  public readonly frameBuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);

  public borderColor = 7;
  public borderDirty = true;
  private paintedBorderColor = -1;
  private paintedWasScanline = true;
  private readonly borderLines = new Uint8Array(SCREEN_HEIGHT);
  private lastBorderLine = 0;
  public frameCount = 0;
  private flashPhase = false;

  // Beeper state (0..3 = EAR<<1 | MIC; 4..5 = tape EAR; 8..15 = mixed)
  public beeperLevel = 0;
  private readonly maxTransitions = 16384;
  public readonly audioTransitionsT = new Int32Array(16384);
  public readonly audioTransitionsVal = new Uint8Array(16384);
  public audioTransitionCount = 0;
  public audioInitialLevel = 0;
  public soundEnabled = true;
  public cpuFreqMhz = 3.5;
  private currentCpuFrameT = TSTATES_PER_FRAME;

  // Tape deck state
  public tapeImage: ParsedTapeImage | null = null;
  public tapeBlocks: TapeBlock[] = [];
  public tapeIndex = 0;
  public fastTapeLoad = true;
  public readonly tapePlayer = new TapePlayer();
  private tapeCursorT = 0;
  private ramEarPollCount = 0;
  private autoQueue: Array<{ keys: readonly string[]; hold?: number }> = [];
  private autoTimer = 0;
  private autoPhase: 'idle' | 'down' | 'up' = 'idle';
  private activeAutoKeys: readonly string[] = [];
  private autoWaitIff1 = true;

  // Convenience getter for 48K unit tests inspecting flat 64KB address space
  public get mem(): Uint8Array {
    // Returns a snapshot view when needed; prefer cpu.rb(addr) for paged access
    const flat = new Uint8Array(65536);
    flat.set(this.readBanks[0], 0x0000);
    flat.set(this.readBanks[1], 0x4000);
    flat.set(this.readBanks[2], 0x8000);
    flat.set(this.readBanks[3], 0xc000);
    return flat;
  }

  public get rom(): Uint8Array {
    return this.romBanks[0];
  }

  constructor(initialMachine: MachineId = '48k') {
    this.readBanks = [
      new Uint8Array(16384),
      this.ramPages[5],
      this.ramPages[2],
      this.ramPages[0],
    ];
    this.writeBanks = [
      null,
      this.ramPages[5],
      this.ramPages[2],
      this.ramPages[0],
    ];
    this.cpu = new Z80(this.readBanks, this.writeBanks, this.ramPages[5], this);
    this.setMachine(initialMachine);
  }

  public setMachine(id: MachineId): void {
    this.machineId = id;
    this.profile = getMachineProfile(id);

    const loadedRoms: Uint8Array[] = [];
    for (const key of this.profile.romKeys) {
      const bytes = getRomBytes(key);
      if (bytes.length === 32768) {
        loadedRoms.push(bytes.subarray(0, 16384));
        loadedRoms.push(bytes.subarray(16384, 32768));
      } else {
        loadedRoms.push(bytes);
      }
    }
    this.romBanks = loadedRoms;
    this.trdosRom = this.profile.trdosRomKey ? getRomBytes(this.profile.trdosRomKey) : null;
    this.cpu.trdosEnabled = this.profile.hasTrdos && this.trdosRom !== null;
    this.hardReset();
  }

  public hardReset(): void {
    for (let i = 0; i < this.ramPages.length; i++) {
      this.ramPages[i].fill(0);
    }
    this.port7FFD = 0;
    this.port1FFD = 0;
    this.romSelect = 0;
    this.ramPage3 = 0;
    this.screenBankIdx = 5;
    this.pagingLocked = false;
    this.trdosActive = false;
    this.updateMemoryBanks();

    this.cpu.reset();
    this.keyboard.clearAll();
    this.ay.reset();
    this.bdi.reset();

    this.borderColor = 7;
    this.borderDirty = true;
    this.paintedBorderColor = -1;
    this.paintedWasScanline = true;
    this.lastBorderLine = 0;
    this.borderLines.fill(7);
    this.frameCount = 0;
    this.flashPhase = false;
    this.beeperLevel = 0;
    this.audioTransitionCount = 0;
    this.tapePlayer.stop();
    this.tapePlayer.is48kMachine = !this.profile.is128kPaging;
    this.tapeCursorT = 0;
    this.tapeIndex = 0;
    this.ramEarPollCount = 0;
    this.autoQueue = [];
    this.autoPhase = 'idle';
    this.activeAutoKeys = [];
    this.autoWaitIff1 = true;
  }

  private updateMemoryBanks(): void {
    const isScorpion = this.profile.isScorpionPaging;
    const ram0At0 = isScorpion && (this.port1FFD & 0x01) !== 0;

    if (ram0At0) {
      this.readBanks[0] = this.ramPages[0];
      this.writeBanks[0] = this.ramPages[0];
    } else if (this.trdosActive && this.trdosRom) {
      this.readBanks[0] = this.trdosRom;
      this.writeBanks[0] = null;
    } else {
      let romIdx = this.romSelect;
      if (isScorpion && (this.port1FFD & 0x02) !== 0) {
        romIdx = 2; // Scorpion ProfROM / Shadow Monitor
      }
      const bank = this.romBanks[romIdx % this.romBanks.length];
      this.readBanks[0] = bank;
      this.writeBanks[0] = null;
    }

    this.readBanks[1] = this.ramPages[5];
    this.writeBanks[1] = this.ramPages[5];
    this.readBanks[2] = this.ramPages[2];
    this.writeBanks[2] = this.ramPages[2];

    const page3 = this.ramPage3 % this.profile.ramPages;
    this.readBanks[3] = this.ramPages[page3];
    this.writeBanks[3] = this.ramPages[page3];

    this.cpu.screenBank = this.ramPages[this.screenBankIdx];
    this.cpu.trdosActive = this.trdosActive;

    // Enable 0x0556 LD-BYTES entry trap when 48K ROM is mapped and a tape is loaded
    const is48kRomActive =
      !this.trdosActive &&
      !ram0At0 &&
      (this.romBanks.length === 1 || this.romSelect === 1);
    const hasTape =
      this.tapeBlocks.length > 0 ||
      (this.tapeImage !== null && this.tapeImage.segments.length > 0);
    this.cpu.romTrapActive = is48kRomActive && hasTape;
  }

  public setFastTapeLoad(enabled: boolean): void {
    this.fastTapeLoad = enabled;
    if (enabled) {
      this.tapePlayer.stop();
    }
    this.updateMemoryBanks();
  }

  public mountDisk(driveIdx: 0 | 1, filename: string, bytes: Uint8Array): void {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const parsed = parseDiskOrMediaImage(ext, bytes);
    if (parsed.kind !== 'disk') {
      throw new Error(
        `Файл .${ext.toUpperCase()} не является дискетой для дисковода — откройте его через «Игры и файлы»`
      );
    }
    this.bdi.insertDisk(driveIdx, parsed.trdBytes, parsed.customImage);
  }

  public ejectDisk(driveIdx: 0 | 1): void {
    this.bdi.ejectDisk(driveIdx);
  }

  public apply128kState = (port7FFD: number, trdosActive: boolean): void => {
    this.port7FFD = port7FFD & 0xff;
    this.port1FFD = 0;
    if (this.profile.is128kPaging) {
      this.ramPage3 = port7FFD & 0x07;
      this.screenBankIdx = (port7FFD & 0x08) ? 7 : 5;
      this.romSelect = (port7FFD >> 4) & 0x01;
      this.pagingLocked = (port7FFD & 0x20) !== 0;
    } else {
      this.ramPage3 = 0;
      this.screenBankIdx = 5;
      this.romSelect = 0;
      this.pagingLocked = true;
    }
    this.trdosActive = trdosActive && this.cpu.trdosEnabled;
    this.updateMemoryBanks();
  };

  public applyAyState = (selectedReg: number, regs: Uint8Array): void => {
    this.ay.reset();
    for (let r = 0; r < 16; r++) {
      this.ay.selectRegister(r);
      this.ay.writeRegister(regs[r], -1);
    }
    this.ay.selectRegister(selectedReg);
  };

  public applyScorpion1FFD = (port1FFD: number): void => {
    if (!this.profile.isScorpionPaging) return;
    this.port1FFD = port1FFD & 0xff;
    const pageLow = this.port7FFD & 0x07;
    const pageHigh = (this.port1FFD & 0x10) !== 0 ? 8 : 0;
    this.ramPage3 = pageLow | pageHigh;
    this.updateMemoryBanks();
  };

  public loadRom(customRom: Uint8Array): void {
    if (customRom.length === 16384) {
      this.romBanks = [new Uint8Array(customRom)];
      this.machineId = '48k';
      this.profile = getMachineProfile('48k');
      this.cpu.trdosEnabled = false;
      this.hardReset();
      return;
    }
    if (customRom.length === 32768) {
      if (!this.profile.is128kPaging) {
        this.machineId = '128k';
        this.profile = getMachineProfile('128k');
        this.cpu.trdosEnabled = false;
      }
      this.romBanks = [
        new Uint8Array(customRom.subarray(0, 16384)),
        new Uint8Array(customRom.subarray(16384, 32768)),
      ];
      this.hardReset();
      return;
    }
    throw new Error('ПЗУ должно быть 16384 байта (48K) или 32768 байт (128K)');
  }

  public createSnaSnapshot(): Uint8Array {
    return buildSnaSnapshot({
      cpu: this.cpu,
      ramPages: this.ramPages,
      is128k: this.profile.is128kPaging,
      port7FFD: this.port7FFD,
      trdosActive: this.trdosActive,
      borderColor: this.borderColor,
    });
  }

  private finishSnapshotLoad(border: number): void {
    this.borderColor = border & 0x07;
    this.borderDirty = true;
    this.paintedBorderColor = -1;
    this.paintedWasScanline = true;
    this.renderFrame();
  }

  private loadTapeImageInternal(img: ParsedTapeImage, autoLoad: boolean): string {
    this.hardReset();
    this.tapeImage = img;
    this.tapeBlocks = img.blocks;
    this.tapeIndex = 0;
    this.updateMemoryBanks();
    const countLabel =
      img.blocks.length > 0 ? `${img.blocks.length} бл.` : `${img.segments.length} сегм.`;
    if (autoLoad) {
      this.queueAutoLoadTap();
      if (this.fastTapeLoad && img.fastLoadable) {
        this.warpFastTapLoad();
      }
      return `Лента .${img.formatLabel} (${countLabel}) — запуск`;
    }
    return `Лента .${img.formatLabel} готова (${countLabel})`;
  }

  public loadFile(filename: string, bytes: Uint8Array, autoLoad = true): string {
    const ext = filename.toLowerCase().split('.').pop() || '';
    const snapTarget: SnapshotTarget = {
      cpu: this.cpu,
      ramPages: this.ramPages,
      apply128kState: this.apply128kState,
      applyAyState: this.applyAyState,
      applyScorpion1FFD: this.applyScorpion1FFD,
    };

    // Clear previous tape when switching to snapshot/screen/ROM/disk
    const clearTape = () => {
      this.tapeImage = null;
      this.tapeBlocks = [];
      this.tapeIndex = 0;
    };

    // --- Snapshots ---
    if (ext === 'sna') {
      clearTape();
      const is128kSnap = bytes.length >= 131103;
      if (is128kSnap && !this.profile.is128kPaging) {
        this.setMachine('pentagon128');
      } else {
        this.hardReset();
      }
      const res = loadSnaSnapshot(bytes, snapTarget);
      this.finishSnapshotLoad(res.border);
      return res.is128k ? 'Снимок 128K .SNA загружен' : 'Снимок .SNA загружен';
    }

    if (ext === 'z80' || ext === 'slt') {
      clearTape();
      this.hardReset();
      let res = loadZ80Snapshot(bytes, snapTarget);
      if (res.is128k && !this.profile.is128kPaging) {
        this.setMachine('128k');
        res = loadZ80Snapshot(bytes, snapTarget);
      }
      this.finishSnapshotLoad(res.border);
      const label = ext.toUpperCase();
      return res.is128k ? `Снимок 128K .${label} загружен` : `Снимок .${label} загружен`;
    }

    if (ext === 'szx') {
      clearTape();
      const targetMachine = detectSzxMachine(bytes);
      if (targetMachine && this.machineId !== targetMachine) {
        this.setMachine(targetMachine);
      } else {
        this.hardReset();
      }
      const res = loadSzxSnapshot(bytes, snapTarget);
      this.finishSnapshotLoad(res.border);
      return res.is128k ? 'Снимок 128K .SZX загружен' : 'Снимок .SZX загружен';
    }

    if (ext === 'sp' || ext === 'sit' || ext === 'snx' || ext === 'zx' || ext === 'ach' || ext === 'prg' || ext === 'sem' || ext === 'frz' || ext === 'zx82') {
      clearTape();
      this.hardReset();
      const loadFn =
        ext === 'sp'
          ? loadSpSnapshot
          : ext === 'sit'
            ? loadSitSnapshot
            : ext === 'snx'
              ? loadSnxSnapshot
              : ext === 'zx'
                ? loadZxSnapshot
                : ext === 'ach'
                  ? loadAchSnapshot
                  : ext === 'prg'
                    ? loadPrgSnapshot
                    : ext === 'sem'
                      ? loadSemSnapshot
                      : ext === 'frz'
                        ? loadFrzSnapshot
                        : loadZx82Snapshot;
      let res = loadFn(bytes, snapTarget);
      if (res.is128k && !this.profile.is128kPaging) {
        this.setMachine('128k');
        res = loadFn(bytes, snapTarget);
      }
      this.finishSnapshotLoad(res.border);
      return res.is128k
        ? `Снимок 128K .${ext.toUpperCase()} загружен`
        : `Снимок .${ext.toUpperCase()} загружен`;
    }

    // --- Screen$ (.SCR) ---
    if (ext === 'scr') {
      clearTape();
      if (this.machineId !== '48k') {
        this.setMachine('48k');
      } else {
        this.hardReset();
      }
      const border = loadScrScreen(bytes, snapTarget);
      this.finishSnapshotLoad(border);
      return 'Экран .SCR загружен';
    }

    // --- Cartridges & Custom ROMs (.ROM / .IF2 / .DCK) ---
    if (ext === 'rom' || ext === 'if2') {
      clearTape();
      this.loadRom(bytes);
      return `ПЗУ / картридж .${ext.toUpperCase()} загружен`;
    }
    if (ext === 'dck') {
      clearTape();
      this.loadRom(parseDckCartridge(bytes));
      return 'Картридж .DCK загружен';
    }

    // --- Cassette Tapes (.TAP/.BLK/.TZX/.CDT/.PZX/.CSW/.WAV/.VOC) ---
    if (
      ext === 'tap' ||
      ext === 'blk' ||
      ext === 'tzx' ||
      ext === 'cdt' ||
      ext === 'pzx' ||
      ext === 'csw' ||
      ext === 'wav' ||
      ext === 'voc'
    ) {
      const img = parseTapeImage(ext, bytes);
      return this.loadTapeImageInternal(img, autoLoad);
    }

    // --- Floppy Disks, Hobeta, Microdrive ---
    if (
      ext === 'trd' ||
      ext === 'scl' ||
      ext === 'fdi' ||
      ext === 'td0' ||
      ext === 'udi' ||
      ext === 'dsk' ||
      ext === 'mgt' ||
      ext === 'img' ||
      ext === 'opd' ||
      ext === 'opu' ||
      ext === 'd40' ||
      ext === 'd80' ||
      ext === 'mdr' ||
      isHobetaExtension(ext)
    ) {
      const parsed = parseDiskOrMediaImage(ext, bytes);
      if (parsed.kind === 'sna') {
        if (!this.profile.is128kPaging && parsed.snaBytes.length >= 131103) {
          this.setMachine('pentagon128');
        } else {
          this.hardReset();
        }
        const res = loadSnaSnapshot(parsed.snaBytes, snapTarget);
        this.finishSnapshotLoad(res.border);
        return `Снимок .${parsed.formatLabel} загружен`;
      }
      if (parsed.kind === 'tap') {
        const img = parseTapeImage('tap', parsed.tapBytes);
        return this.loadTapeImageInternal(img, autoLoad);
      }
      clearTape();
      // Ensure machine has Beta Disk + TR-DOS
      if (!this.profile.hasTrdos) {
        this.setMachine('pentagon128');
      } else {
        this.hardReset();
      }
      this.bdi.insertDisk(0, parsed.trdBytes, parsed.customImage);
      if (autoLoad) {
        this.queueAutoBootTrdos(true, filename);
        return `Диск .${parsed.formatLabel} в приводе A: — запуск TR-DOS`;
      }
      return `Диск .${parsed.formatLabel} вставлен в привод A:`;
    }

    // --- Raw Binary (.BIN / .RAW) with heuristic autodetect ---
    if (ext === 'bin' || ext === 'raw') {
      if (bytes.length === 16384 || bytes.length === 32768) {
        clearTape();
        this.loadRom(bytes);
        return `ПЗУ .${ext.toUpperCase()} (${bytes.length / 1024}K) загружено`;
      }
      if (bytes.length === 6912) {
        clearTape();
        this.hardReset();
        this.finishSnapshotLoad(loadScrScreen(bytes, snapTarget));
        return `Экран .${ext.toUpperCase()} (6912 байт) загружен`;
      }
      if (bytes.length === 49179 || bytes.length === 131103 || bytes.length === 147487) {
        return this.loadFile(`${filename}.sna`, bytes, autoLoad);
      }
      const baseName = filename.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'CODE';
      const tapBytes = wrapCodeBytesAsTap(baseName, bytes, 0x8000);
      return this.loadTapeImageInternal(parseTapeImage('tap', tapBytes), autoLoad);
    }

    throw new Error(`Неподдерживаемый формат: .${ext}`);
  }

  /**
   * Enters TR-DOS directly from the current machine (like pressing Magic/TR-DOS menu).
   */
  public enterTrdos(): void {
    if (!this.cpu.trdosEnabled) {
      this.setMachine('pentagon128');
    }
    this.hardReset();
    this.queueAutoBootTrdos(false);
  }

  private queueAutoLoadTap(): void {
    if (!this.profile.is128kPaging) {
      // 48K: wait for IFF1=1, type J (LOAD), ", ", ENTER
      this.autoWaitIff1 = true;
      this.autoQueue = [
        { keys: ['J'] },
        { keys: ['SYMBOL', 'P'] },
        { keys: ['SYMBOL', 'P'] },
        { keys: ['ENTER'] },
      ];
      this.autoTimer = 12;
      this.autoPhase = 'idle';
    } else if (this.machineId === 'scorpion256') {
      // Scorpion 256 menu (ready at ~180 frames): 0=128 TR-DOS, 1=128 BASIC, 2=Calculator, 3=48 BASIC, 4=48 TR-DOS
      // Enter 48 BASIC (Down x3 + ENTER), then LOAD ""
      this.autoWaitIff1 = false;
      this.autoQueue = [
        { keys: ['CAPS', '6'] },
        { keys: ['CAPS', '6'] },
        { keys: ['CAPS', '6'] },
        { keys: ['ENTER'] },
        { keys: [], hold: 75 },
        { keys: ['J'] },
        { keys: ['SYMBOL', 'P'] },
        { keys: ['SYMBOL', 'P'] },
        { keys: ['ENTER'] },
      ];
      this.autoTimer = 195;
      this.autoPhase = 'idle';
    } else {
      // 128K / +2 / Pentagon 128: Item 0 is Tape Loader! Just press ENTER!
      this.autoWaitIff1 = true;
      this.autoQueue = [{ keys: ['ENTER'] }];
      this.autoTimer = 25;
      this.autoPhase = 'idle';
    }
  }

  private queueAutoBootTrdos(runBoot = true, sourceFilename?: string): void {
    const isScorpion = this.machineId === 'scorpion256';
    if (isScorpion) {
      // Scorpion 256 menu (ready at ~180 frames): Item 0 is already 128 TR-DOS
      this.autoWaitIff1 = false;
      this.autoQueue = [{ keys: ['ENTER'] }];
      this.autoTimer = 195;
    } else {
      // Pentagon 128 menu: 0=Tape Loader, 1=128 BASIC, 2=Calculator, 3=48 BASIC, 4=TR-DOS
      this.autoWaitIff1 = true;
      this.autoQueue = [
        { keys: ['CAPS', '6'] },
        { keys: ['CAPS', '6'] },
        { keys: ['CAPS', '6'] },
        { keys: ['CAPS', '6'] },
        { keys: ['ENTER'] },
      ];
      this.autoTimer = 25;
    }
    if (runBoot) {
      // Wait for TR-DOS Ver 5.03 banner & disk init to reach A>K prompt, then run "boot" or named BASIC file
      const disk0 = this.bdi.disks[0];
      const target = disk0 ? findTrdosAutoBootTarget(disk0, sourceFilename) : null;
      if (target && target.kind === 'named') {
        this.autoQueue.push(
          { keys: [], hold: isScorpion ? 85 : 45 },
          { keys: ['R'], hold: 4 },
          { keys: ['SYMBOL', 'P'], hold: 4 }
        );
        for (let i = 0; i < target.keyChords.length; i++) {
          this.autoQueue.push({ keys: target.keyChords[i], hold: 3 });
        }
        this.autoQueue.push(
          { keys: ['SYMBOL', 'P'], hold: 4 },
          { keys: ['ENTER'], hold: 4 }
        );
      } else if (!isScorpion) {
        // Scorpion 128 TR-DOS auto-runs "boot" automatically; Pentagon needs explicit RUN + ENTER
        this.autoQueue.push(
          { keys: [], hold: 45 },
          { keys: ['R'], hold: 4 },
          { keys: ['ENTER'], hold: 4 }
        );
      }
    }
    this.autoPhase = 'idle';
  }

  private tickAutoLoader(): void {
    if (this.autoPhase === 'idle' && this.autoQueue.length === 0) return;

    if (this.autoWaitIff1 && this.cpu.iff1 === 0) {
      return;
    }

    if (this.autoTimer > 0) {
      this.autoTimer--;
      return;
    }

    if (this.autoPhase === 'idle') {
      const next = this.autoQueue.shift();
      if (next) {
        this.activeAutoKeys = next.keys;
        this.keyboard.tapKeys(next.keys);
        this.autoPhase = 'down';
        this.autoTimer = next.hold ?? 3;
      }
    } else if (this.autoPhase === 'down') {
      this.keyboard.releaseKeys(this.activeAutoKeys);
      this.activeAutoKeys = [];
      this.autoPhase = 'up';
      this.autoTimer = 4;
    } else if (this.autoPhase === 'up') {
      this.autoPhase = 'idle';
      this.autoTimer = 4;
    }
  }

  // Called by Z80 when PC hits 0x3Dxx or exits ROM while trdosActive
  public onTrdosCheck = (pc: number): void => {
    if (!this.trdosActive) {
      const is48kRomActive =
        this.romBanks.length === 1 || this.romSelect === 1;
      if (is48kRomActive && (pc & 0xff00) === 0x3d00) {
        this.trdosActive = true;
        this.updateMemoryBanks();
      }
    } else if (pc >= 0x4000) {
      this.trdosActive = false;
      this.updateMemoryBanks();
    }
  };

  public readPort(port: number): number {
    // Beta Disk Interface ports (ONLY active while TR-DOS ROM is paged in!)
    if (this.trdosActive) {
      const low = port & 0xff;
      if (low === 0x1f || low === 0x3f || low === 0x5f || low === 0x7f || low === 0xff) {
        return this.bdi.readPort(low);
      }
    }

    // Scorpion ZS 256 Shadow Monitor ROM (1FFD bit 1 = 1, bit 0 = 0):
    // Kempston joystick is not mapped here; ProfROM 0x0237 polls IN A,(0x1F) AND 0xE0
    // right after FDC command 0xC4 and hangs forever if bits 5..7 read as 0.
    if (
      this.profile.isScorpionPaging &&
      (this.port1FFD & 0x03) === 0x02 &&
      (port & 0xff) === 0x1f
    ) {
      return 0x20;
    }

    // ULA even port (A0 == 0)
    if ((port & 0x01) === 0) {
      const high = (port >> 8) & 0xff;
      let earBit = 0;
      if (this.tapePlayer.active) {
        this.advanceTapeTo(this.mapToFrameT(this.cpu.tstates, this.profile.tstatesPerFrame));
        earBit = this.tapePlayer.earLevel << 6;
      } else {
        if (
          this.fastTapeLoad &&
          this.cpu.iff1 === 0 &&
          this.cpu.pc >= 0x4000 &&
          ((this.tapeIndex > 0 && this.tapeIndex < this.tapeBlocks.length) ||
            this.hasRemainingTapeSegments())
        ) {
          this.ramEarPollCount++;
        }
        earBit = (this.beeperLevel & 0x02) !== 0 ? 0x40 : 0;
      }
      return 0xa0 | earBit | this.keyboard.readRows(high);
    }

    // AY-3-8910 read (0xFFFD)
    if (this.profile.hasAY && (port & 0xc002) === 0xc000) {
      return this.ay.readRegister();
    }

    // Kempston Mouse ports: 0xFADF (buttons+wheel), 0xFBDF (X), 0xFFDF (Y)
    // Must be checked before Kempston Joystick ((port & 0x20) === 0) because 0xDF has bit 5 = 0.
    if ((port & 0x00ff) === 0xdf) {
      const hi = port & 0x0500;
      if (hi === 0x0000) {
        return this.keyboard.readMouseButtons();
      }
      if (hi === 0x0100) {
        return this.keyboard.mouseX & 0xff;
      }
      if (hi === 0x0500) {
        return this.keyboard.mouseY & 0xff;
      }
    }

    // Kempston joystick port 0x1F
    if ((port & 0x20) === 0) {
      return this.keyboard.kempston & 0x1f;
    }

    return 0xff;
  }

  public writePort(port: number, value: number, tstates: number): void {
    // Beta Disk Interface ports (ONLY active while TR-DOS ROM is paged in!)
    if (this.trdosActive) {
      const low = port & 0xff;
      if (low === 0x1f || low === 0x3f || low === 0x5f || low === 0x7f || low === 0xff) {
        this.bdi.writePort(low, value);
        return;
      }
    }

    // ULA even port (A0 == 0)
    if ((port & 0x01) === 0) {
      const frameT = this.profile.tstatesPerFrame;
      const cpuFrameT = this.currentCpuFrameT;
      const border = value & 0x07;
      if (border !== this.borderColor) {
        const line = Math.max(
          0,
          Math.min(SCREEN_HEIGHT - 1, ((tstates * SCREEN_HEIGHT) / cpuFrameT) | 0)
        );
        if (line > this.lastBorderLine) {
          this.borderLines.fill(this.borderColor, this.lastBorderLine, line);
          this.lastBorderLine = line;
        }
        this.borderColor = border;
        this.borderDirty = true;
      }
      const level = (value >> 3) & 0x03; // bit 1 = EAR (bit 4), bit 0 = MIC (bit 3)
      if (level !== this.beeperLevel) {
        this.beeperLevel = level;
        if (this.soundEnabled && this.audioTransitionCount < this.maxTransitions) {
          const clampedT = this.mapToFrameT(tstates, frameT);
          const encoded = this.tapePlayer.isAudioActive()
            ? (level === 0 ? 4 + this.tapePlayer.earLevel : (this.tapePlayer.earLevel ? 12 + level : 8 + level))
            : level;
          this.audioTransitionsT[this.audioTransitionCount] = clampedT;
          this.audioTransitionsVal[this.audioTransitionCount] = encoded;
          this.audioTransitionCount++;
        }
      }
      return;
    }

    // Scorpion ZS 256 extended paging port 0x1FFD
    if (this.profile.isScorpionPaging && (port & 0xf002) === 0x1000) {
      if (!this.pagingLocked) {
        this.port1FFD = value & 0xff;
        const pageLow = this.port7FFD & 0x07;
        const pageHigh = (value & 0x10) ? 8 : 0;
        this.ramPage3 = pageLow | pageHigh;
        this.updateMemoryBanks();
      }
      return;
    }

    // Standard 128K / Pentagon paging port 0x7FFD
    if (this.profile.is128kPaging) {
      const match7FFD = this.profile.isScorpionPaging
        ? (port & 0xc002) === 0x4000
        : (port & 0x8002) === 0x0000;

      if (match7FFD && !this.pagingLocked) {
        this.port7FFD = value & 0xff;
        const pageHigh = this.profile.isScorpionPaging && (this.port1FFD & 0x10) ? 8 : 0;
        this.ramPage3 = (value & 0x07) | pageHigh;
        const nextScreen = (value & 0x08) ? 7 : 5;
        if (nextScreen !== this.screenBankIdx) {
          this.screenBankIdx = nextScreen;
          this.cpu.vramDirty = true;
        }
        this.romSelect = (value >> 4) & 0x01;
        this.pagingLocked = (value & 0x20) !== 0;
        this.updateMemoryBanks();
        return;
      }
    }

    // AY-3-8910 / YM2149 ports (0xFFFD select, 0xBFFD write)
    if (this.profile.hasAY) {
      if ((port & 0xc002) === 0xc000) {
        this.ay.selectRegister(value);
      } else if ((port & 0xc002) === 0x8000) {
        const frameT = this.profile.tstatesPerFrame;
        const clampedT = this.mapToFrameT(tstates, frameT);
        this.ay.writeRegister(value, this.soundEnabled ? clampedT : -1);
      }
    }
  }

  public setCpuFreqMhz(mhz: number): void {
    this.cpuFreqMhz = Math.max(0.25, Math.min(28, mhz));
  }

  private mapToFrameT(tstates: number, frameT: number): number {
    const cpuFrameT = this.currentCpuFrameT;
    const mapped = cpuFrameT === frameT ? tstates : ((tstates * frameT) / cpuFrameT) | 0;
    return mapped < 0 ? 0 : mapped >= frameT ? frameT - 1 : mapped;
  }

  private readonly onTapeEdge = (t: number, ear: number): void => {
    if (this.soundEnabled && this.audioTransitionCount < this.maxTransitions) {
      const frameT = this.profile.tstatesPerFrame;
      const clampedT = t < 0 ? 0 : t >= frameT ? frameT - 1 : t;
      const b = this.beeperLevel;
      const encoded = b === 0 ? 4 + ear : (ear ? 12 + b : 8 + b);
      this.audioTransitionsT[this.audioTransitionCount] = clampedT;
      this.audioTransitionsVal[this.audioTransitionCount] = encoded;
      this.audioTransitionCount++;
    }
  };

  private advanceTapeTo(targetT: number): void {
    const delta = targetT - this.tapeCursorT;
    if (delta > 0) {
      this.tapePlayer.advance(delta, this.tapeCursorT, this.onTapeEdge);
      this.tapeCursorT = targetT;
    }
  }

  private getSegmentIdxForBlock(blockIndex: number): number {
    const img = this.tapeImage;
    if (!img || img.segments.length === 0) return 0;
    if (blockIndex < img.blockToSegmentIdx.length) {
      return img.blockToSegmentIdx[blockIndex];
    }
    if (img.blockToSegmentIdx.length === 0) return 0;
    let idx = img.blockToSegmentIdx[img.blockToSegmentIdx.length - 1];
    while (idx < img.segments.length && img.segments[idx].kind !== 'data') {
      idx++;
    }
    return idx < img.segments.length ? idx + 1 : img.segments.length;
  }

  private hasRemainingTapeSegments(): boolean {
    const img = this.tapeImage;
    if (!img || img.segments.length === 0) return false;
    return this.getSegmentIdxForBlock(this.tapeIndex) < img.segments.length;
  }

  private startTapePlayerAtCurrentPosition(startT: number): void {
    const img = this.tapeImage;
    if (img && img.segments.length > 0) {
      const segIdx = this.getSegmentIdxForBlock(this.tapeIndex);
      if (segIdx < img.segments.length) {
        this.tapePlayer.startSegments(img.segments, segIdx, this.tapeIndex);
        this.tapeCursorT = startT;
        return;
      }
    }
    if (this.tapeBlocks.length > 0) {
      const startIdx = this.tapeIndex < this.tapeBlocks.length ? this.tapeIndex : 0;
      this.tapePlayer.start(this.tapeBlocks, startIdx);
      this.tapeCursorT = startT;
    }
  }

  // ROM trap at 0x0556..0x056C (LD-BYTES and direct sub-entry points in 48K ROM)
  public onRomTrap = (cpu: Z80): boolean => {
    const segCount = this.tapeImage?.segments.length ?? 0;
    if (this.tapeBlocks.length === 0 && segCount === 0) {
      return false;
    }

    const pc = cpu.pc;
    // Recognize standard 0x0556/0x0557, pre-pushed-0x053F entries (0x0558..0x055E),
    // and direct custom-loader entries after PUSH 0x053F (0x0562/0x0569/0x056B/0x056C)
    let useAltAF = false;
    let returnViaStack = false;
    switch (pc) {
      case 0x0556:
      case 0x0557:
        break;
      case 0x0558:
      case 0x0559:
      case 0x055a:
      case 0x055c:
      case 0x055e:
        useAltAF = true;
        break;
      case 0x0562:
      case 0x0569:
      case 0x056b:
      case 0x056c:
        useAltAF = true;
        returnViaStack = true;
        break;
      default:
        return false;
    }

    if (
      !this.fastTapeLoad ||
      this.tapeBlocks.length === 0 ||
      (this.tapeIndex >= this.tapeBlocks.length && this.hasRemainingTapeSegments())
    ) {
      if (!this.tapePlayer.active) {
        this.startTapePlayerAtCurrentPosition(cpu.tstates);
      } else {
        this.tapePlayer.syncOnLoaderReady();
      }
      return false; // Let real 48K ROM LD-BYTES load bit-by-bit via port 0xFE bit 6
    }

    const expectedFlag = useAltAF ? cpu.a_ : cpu.a;
    const isLoad = ((useAltAF ? cpu.f_ : cpu.f) & 0x01) !== 0;

    const finishTrap = () => {
      if (returnViaStack) {
        const lo = cpu.rb(cpu.sp);
        const hi = cpu.rb((cpu.sp + 1) & 0xffff);
        cpu.sp = (cpu.sp + 2) & 0xffff;
        cpu.pc = lo | (hi << 8);
      } else {
        cpu.pc = 0x053f;
      }
    };

    while (this.tapeIndex < this.tapeBlocks.length) {
      const block = this.tapeBlocks[this.tapeIndex++];
      if (block.raw.length >= 2 && block.flag === expectedFlag) {
        const dest = cpu.ix;
        const reqLen = cpu.de;
        const payload = block.data;
        const copyLen = Math.min(reqLen, payload.length);

        if (isLoad) {
          for (let i = 0; i < copyLen; i++) {
            cpu.wb((dest + i) & 0xffff, payload[i]);
          }
        }

        cpu.ix = (dest + copyLen) & 0xffff;
        cpu.de = (reqLen - copyLen) & 0xffff;
        if (copyLen === reqLen) {
          cpu.h = 0;
          cpu.l = 1;
          cpu.a = 0;
          cpu.f = (cpu.f & ~0x40) | 0x13; // Carry=1, N=1, H=1, Z=0 (LD A,H; CP 1)
        } else {
          cpu.f &= ~0x01;
        }

        finishTrap();
        this.borderDirty = true;
        return true;
      }
    }

    this.tapeIndex = 0;
    cpu.f &= ~0x01;
    finishTrap();
    return true;
  };

  private warpFastTapLoad(): void {
    const prevSound = this.soundEnabled;
    const prevFreq = this.cpuFreqMhz;
    this.soundEnabled = false;
    this.cpuFreqMhz = 3.5;

    let lastTapeIdx = this.tapeIndex;
    let idleAfterAuto = 0;

    try {
      for (let f = 0; f < 640; f++) {
        this.stepFrame(false);

        if (this.tapePlayer.active) {
          // Custom RAM loader took over via TapePlayer: let RAF turbo loop stream it cleanly
          break;
        }

        if (this.autoQueue.length > 0 || this.autoPhase !== 'idle') {
          idleAfterAuto = 0;
          lastTapeIdx = this.tapeIndex;
          continue;
        }

        if (this.tapeIndex !== lastTapeIdx) {
          lastTapeIdx = this.tapeIndex;
          idleAfterAuto = 0;
        } else {
          idleAfterAuto++;
        }

        if (this.tapeIndex >= this.tapeBlocks.length && !this.hasRemainingTapeSegments() && idleAfterAuto >= 2) {
          break;
        }
        // Support multi-load tapes where main program enters game before trailing blocks
        if (this.tapeIndex > 0 && idleAfterAuto >= 35) {
          break;
        }
      }
    } finally {
      this.cpuFreqMhz = prevFreq;
      this.soundEnabled = prevSound;
    }

    this.audioTransitionCount = 0;
    this.renderFrame();
    // Keep dirty flags set so the next RAF tick paints the warped frame immediately
    this.cpu.vramDirty = true;
    this.borderDirty = true;
    this.lastBorderLine = 0;
  }

  public stepFrame(render = true): boolean {
    this.tickAutoLoader();

    this.tapeCursorT = 0;
    this.lastBorderLine = 0;
    if (this.profile.hasAY && this.soundEnabled) {
      this.ay.beginFrame();
    }
    if (this.tapePlayer.isAudioActive()) {
      const b = this.beeperLevel;
      const ear = this.tapePlayer.earLevel;
      this.audioInitialLevel = b === 0 ? 4 + ear : (ear ? 12 + b : 8 + b);
    } else {
      this.audioInitialLevel = this.beeperLevel;
    }
    this.audioTransitionCount = 0;

    const frameT = this.profile.tstatesPerFrame;
    const cpuFrameT = Math.max(1000, Math.round(frameT * (this.cpuFreqMhz / 3.5)));
    this.currentCpuFrameT = cpuFrameT;
    this.ramEarPollCount = 0;
    const tapeWasActive = this.tapePlayer.active;
    this.cpu.interrupt();
    this.cpu.runUntil(cpuFrameT);
    if (this.tapePlayer.active) {
      this.advanceTapeTo(frameT);
    }
    if (tapeWasActive || this.tapePlayer.active) {
      this.tapeIndex = this.tapePlayer.blockIdx;
    } else if (
      this.fastTapeLoad &&
      this.ramEarPollCount >= 200 &&
      this.autoQueue.length === 0 &&
      this.autoPhase === 'idle' &&
      ((this.tapeIndex > 0 && this.tapeIndex < this.tapeBlocks.length) ||
        this.hasRemainingTapeSegments())
    ) {
      // Auto-engage real-time TapePlayer if a custom RAM loader polls port 0xFE directly
      this.startTapePlayerAtCurrentPosition(0);
    }
    this.cpu.tstates -= cpuFrameT;
    this.keyboard.endVirtualFrame();

    if (this.lastBorderLine > 0) {
      this.borderLines.fill(this.borderColor, this.lastBorderLine, SCREEN_HEIGHT);
    }

    this.frameCount++;
    let flashChanged = false;
    if ((this.frameCount & 15) === 0) {
      this.flashPhase = !this.flashPhase;
      flashChanged = true;
    }

    if (!render) {
      return false;
    }

    if (!this.cpu.vramDirty && !this.borderDirty && !flashChanged) {
      return false;
    }

    this.renderFrame();
    this.cpu.vramDirty = false;
    this.borderDirty = false;
    this.lastBorderLine = 0;
    return true;
  }

  public renderFrame(): void {
    const fb = this.frameBuffer;
    const scr = this.ramPages[this.screenBankIdx];
    const borderIdx = this.borderColor & 0x07;
    const borderPx = PALETTE_ABGR[borderIdx];
    const hasScanlineBorder = this.lastBorderLine > 0;
    const paintBorder =
      hasScanlineBorder || this.paintedWasScanline || this.paintedBorderColor !== borderIdx;
    const bLines = this.borderLines;
    const flash = this.flashPhase;

    if (paintBorder) {
      if (hasScanlineBorder) {
        for (let y = 0; y < BORDER_Y; y++) {
          const dst = y * SCREEN_WIDTH;
          fb.fill(PALETTE_ABGR[bLines[y] & 0x07], dst, dst + SCREEN_WIDTH);
        }
      } else {
        fb.fill(borderPx, 0, BORDER_Y * SCREEN_WIDTH);
      }
    }

    for (let y = 0; y < 192; y++) {
      const screenRow = y + BORDER_Y;
      const rowBase = screenRow * SCREEN_WIDTH;
      let rowBorderPx = borderPx;
      if (paintBorder) {
        rowBorderPx = hasScanlineBorder ? PALETTE_ABGR[bLines[screenRow] & 0x07] : borderPx;
        fb.fill(rowBorderPx, rowBase, rowBase + BORDER_X);
      }
      let dst = rowBase + BORDER_X;

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
        fb.fill(rowBorderPx, dst, dst + BORDER_X);
      }
    }

    if (paintBorder) {
      if (hasScanlineBorder) {
        for (let y = BORDER_Y + ACTIVE_HEIGHT; y < SCREEN_HEIGHT; y++) {
          const dst = y * SCREEN_WIDTH;
          fb.fill(PALETTE_ABGR[bLines[y] & 0x07], dst, dst + SCREEN_WIDTH);
        }
        this.paintedBorderColor = -1;
        this.paintedWasScanline = true;
      } else {
        fb.fill(borderPx, (BORDER_Y + ACTIVE_HEIGHT) * SCREEN_WIDTH, SCREEN_HEIGHT * SCREEN_WIDTH);
        this.paintedBorderColor = borderIdx;
        this.paintedWasScanline = false;
      }
    }
  }
}
