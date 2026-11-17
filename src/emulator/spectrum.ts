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
import {
  GIGASCREEN_BAND_COUNT,
  GigascreenMode,
  blendFrames5050,
  computeActiveBandHashes,
  copyFrameWithDiff,
  renderBeamSpan,
  renderStaticFrame,
  tstatesToBeamPos,
} from './videoBeam';

export type { GigascreenMode };

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

  // 320x240 RGBA output buffer & ping-pong raw buffers for zero-copy Gigascreen blending
  public readonly frameBuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  private readonly bufA = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  private readonly bufB = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
  private currRaw: Uint32Array = this.bufA;
  private prevRaw: Uint32Array = this.bufB;
  private currTargetIsA = true;
  private paintedBorderOut = -1;
  private paintedBorderA = -1;
  private paintedBorderB = -1;
  private hasPrevRaw = false;
  private outputIsBlended = false;
  public hasRenderedFrame = false;
  public gigascreenMode: GigascreenMode = 'auto';

  // Auto-Gigascreen detection state (Bank 5/7 toggle + 8-band period-2 frame alternation)
  private prevScreenStartBank = 5;
  private prevScreenEndBank = 5;
  private frameStartScreenBank = 5;
  private bankFlipStreak = 0;
  private bandHash0 = new Uint32Array(GIGASCREEN_BAND_COUNT);
  private bandHash1 = new Uint32Array(GIGASCREEN_BAND_COUNT);
  private bandHash2 = new Uint32Array(GIGASCREEN_BAND_COUNT);
  private hasBandHash1 = false;
  private hasBandHash2 = false;
  private hashFlipStreak = 0;
  private autoBlendHold = 0;

  // Lazy ULA beam-chase state (0% overhead when frames have no mid-frame visible writes)
  private beamRenderEnabled = false;
  private beamActive = false;
  private beamPos = 0;
  private beamVisibleStartT = 0;
  private beamVisibleEndT = 0;
  private beamActiveStartUlaT = 0;
  private beamActiveEndUlaT = 0;
  private prevFrameUsedBeam = false;
  private beamTargetBuf: Uint32Array = this.frameBuffer;

  public borderColor = 7;
  public borderDirty = true;
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
    this.cpu.onScreenWrite = this.onBeamScreenWrite;
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
    this.paintedBorderOut = -1;
    this.paintedBorderA = -1;
    this.paintedBorderB = -1;
    this.hasPrevRaw = false;
    this.outputIsBlended = false;
    this.prevFrameUsedBeam = false;
    this.beamRenderEnabled = false;
    this.beamActive = false;
    this.beamPos = 0;
    this.cpu.beamActiveStartT = 0x7fffffff;
    this.cpu.beamActiveEndT = 0;
    this.prevScreenStartBank = 5;
    this.prevScreenEndBank = 5;
    this.frameStartScreenBank = 5;
    this.bankFlipStreak = 0;
    this.hasBandHash1 = false;
    this.hasBandHash2 = false;
    this.hashFlipStreak = 0;
    this.autoBlendHold = 0;
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

  public setGigascreenMode(mode: GigascreenMode): boolean {
    if (this.gigascreenMode === mode) return false;
    const prevMode = this.gigascreenMode;
    this.gigascreenMode = mode;

    if (prevMode === 'off') {
      if (this.hasRenderedFrame) {
        this.currRaw.set(this.frameBuffer);
      }
      this.hasPrevRaw = false;
      this.outputIsBlended = false;
      this.paintedBorderA = -1;
      this.paintedBorderB = -1;
      this.prevScreenStartBank = this.screenBankIdx;
      this.prevScreenEndBank = this.screenBankIdx;
      this.bankFlipStreak = 0;
      this.hashFlipStreak = 0;
      this.autoBlendHold = 0;
      this.hasBandHash1 = false;
      this.hasBandHash2 = false;
      return false;
    }
    if (mode === 'off') {
      let changed = false;
      if (this.outputIsBlended && this.hasRenderedFrame) {
        changed = copyFrameWithDiff(this.currRaw, this.frameBuffer);
      }
      this.outputIsBlended = false;
      this.hasPrevRaw = false;
      this.paintedBorderOut = -1;
      return changed;
    }

    this.bankFlipStreak = 0;
    this.hashFlipStreak = 0;
    this.autoBlendHold = 0;
    if (mode === 'on' && this.hasPrevRaw && this.hasRenderedFrame && !this.outputIsBlended) {
      const changed = blendFrames5050(this.currRaw, this.prevRaw, this.frameBuffer);
      this.outputIsBlended = true;
      return changed;
    }
    if (mode === 'auto' && this.outputIsBlended && this.hasRenderedFrame) {
      const changed = copyFrameWithDiff(this.currRaw, this.frameBuffer);
      this.outputIsBlended = false;
      return changed;
    }
    return false;
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
    this.paintedBorderOut = -1;
    this.paintedBorderA = -1;
    this.paintedBorderB = -1;
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
      const border = value & 0x07;
      if (border !== this.borderColor) {
        if (this.beamRenderEnabled) {
          const beamT = this.mapToFrameT(tstates, frameT);
          if (beamT > this.beamVisibleStartT) {
            this.flushBeamTo(tstates);
          }
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
          if (this.beamRenderEnabled) {
            const beamT = this.mapToFrameT(tstates, this.profile.tstatesPerFrame);
            if (beamT > this.beamActiveStartUlaT) {
              this.flushBeamTo(tstates);
            }
          }
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
  }

  private readonly onBeamScreenWrite = (tstates: number): void => {
    this.flushBeamTo(tstates);
  };

  private beginRawFrameTarget(): void {
    if (this.gigascreenMode === 'off') {
      this.beamTargetBuf = this.frameBuffer;
      return;
    }
    this.currTargetIsA = !this.currTargetIsA;
    this.currRaw = this.currTargetIsA ? this.bufA : this.bufB;
    this.prevRaw = this.currTargetIsA ? this.bufB : this.bufA;
    this.beamTargetBuf = this.currRaw;
  }

  private shouldPaintTargetBorder(borderIdx: number): boolean {
    if (this.gigascreenMode === 'off') {
      return this.paintedBorderOut !== borderIdx;
    }
    return (this.currTargetIsA ? this.paintedBorderA : this.paintedBorderB) !== borderIdx;
  }

  private markTargetBorderPainted(borderIdx: number): void {
    if (this.gigascreenMode === 'off') {
      this.paintedBorderOut = borderIdx;
    } else if (this.currTargetIsA) {
      this.paintedBorderA = borderIdx;
    } else {
      this.paintedBorderB = borderIdx;
    }
  }

  private invalidateTargetBorderCache(): void {
    if (this.gigascreenMode === 'off') {
      this.paintedBorderOut = -1;
    } else if (this.currTargetIsA) {
      this.paintedBorderA = -1;
    } else {
      this.paintedBorderB = -1;
    }
  }

  private flushBeamTo(cpuTstates: number): void {
    if (!this.beamRenderEnabled) return;
    const frameT = this.profile.tstatesPerFrame;
    const beamT = this.mapToFrameT(cpuTstates, frameT);
    const targetPos = tstatesToBeamPos(
      beamT,
      this.profile.firstActiveT,
      this.profile.tstatesPerLine
    );
    if (!this.beamActive) {
      if (targetPos <= 0) return;
      this.beamActive = true;
      this.beamPos = 0;
      this.beginRawFrameTarget();
    }
    if (targetPos <= this.beamPos) return;
    renderBeamSpan(
      this.beamTargetBuf,
      this.ramPages[this.screenBankIdx],
      this.borderColor,
      this.flashPhase,
      this.beamPos,
      targetPos
    );
    this.beamPos = targetPos;
  }

  private presentRenderedRawFrame(): boolean {
    const wasRendered = this.hasRenderedFrame;
    this.hasRenderedFrame = true;
    if (this.gigascreenMode === 'off') {
      this.outputIsBlended = false;
      return true;
    }

    let shouldBlend = false;
    if (this.gigascreenMode === 'on') {
      shouldBlend = this.hasPrevRaw;
    } else {
      const bankFlipped =
        this.hasPrevRaw &&
        (this.screenBankIdx !== this.prevScreenEndBank ||
          this.frameStartScreenBank !== this.prevScreenStartBank);
      if (bankFlipped) {
        this.bankFlipStreak++;
      } else {
        this.bankFlipStreak = 0;
      }
      this.prevScreenStartBank = this.frameStartScreenBank;
      this.prevScreenEndBank = this.screenBankIdx;

      computeActiveBandHashes(this.currRaw, this.bandHash0);
      if (this.hasBandHash2) {
        let period2Bands = 0;
        for (let b = 0; b < GIGASCREEN_BAND_COUNT; b++) {
          const h0 = this.bandHash0[b];
          if (h0 === this.bandHash2[b] && h0 !== this.bandHash1[b]) {
            period2Bands++;
          }
        }
        if (period2Bands >= 2) {
          this.hashFlipStreak++;
        } else {
          this.hashFlipStreak = 0;
        }
      } else {
        this.hashFlipStreak = 0;
      }

      // Rotate pre-allocated band-hash buffers with zero heap allocation
      const oldest = this.bandHash2;
      this.bandHash2 = this.bandHash1;
      this.bandHash1 = this.bandHash0;
      this.bandHash0 = oldest;
      this.hasBandHash2 = this.hasBandHash1;
      this.hasBandHash1 = true;

      if (this.bankFlipStreak >= 2 || this.hashFlipStreak >= 2) {
        this.autoBlendHold = 6;
      } else if (this.autoBlendHold > 0) {
        this.autoBlendHold--;
      }

      shouldBlend = this.hasPrevRaw && this.autoBlendHold > 0;
    }

    let outputChanged: boolean;
    if (shouldBlend) {
      outputChanged = blendFrames5050(this.currRaw, this.prevRaw, this.frameBuffer);
      this.outputIsBlended = true;
    } else {
      outputChanged = copyFrameWithDiff(this.currRaw, this.frameBuffer);
      this.outputIsBlended = false;
    }
    this.hasPrevRaw = true;
    return outputChanged || !wasRendered;
  }

  public stepFrame(render = true): boolean {
    this.tickAutoLoader();

    this.frameCount++;
    let flashChanged = false;
    if ((this.frameCount & 15) === 0) {
      this.flashPhase = !this.flashPhase;
      flashChanged = true;
    }

    this.tapeCursorT = 0;
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

    this.beamRenderEnabled = render;
    this.beamActive = false;
    this.beamPos = 0;
    this.frameStartScreenBank = this.screenBankIdx;
    if (render) {
      const tPerLine = this.profile.tstatesPerLine;
      const firstActiveT = this.profile.firstActiveT;
      this.beamVisibleStartT = firstActiveT - BORDER_Y * tPerLine - 16;
      this.beamVisibleEndT = firstActiveT + (SCREEN_HEIGHT - BORDER_Y - 1) * tPerLine + 144;
      this.beamActiveStartUlaT = firstActiveT;
      this.beamActiveEndUlaT = firstActiveT + ACTIVE_HEIGHT * tPerLine;
      if (cpuFrameT === frameT) {
        this.cpu.beamActiveStartT = this.beamActiveStartUlaT;
        this.cpu.beamActiveEndT = this.beamActiveEndUlaT;
      } else {
        this.cpu.beamActiveStartT = ((this.beamActiveStartUlaT * cpuFrameT) / frameT) | 0;
        this.cpu.beamActiveEndT = ((this.beamActiveEndUlaT * cpuFrameT) / frameT) | 0;
      }
    } else {
      this.cpu.beamActiveStartT = 0x7fffffff;
      this.cpu.beamActiveEndT = 0;
    }

    const tapeWasActive = this.tapePlayer.active;
    this.cpu.interrupt();
    this.cpu.runUntil(cpuFrameT);

    this.cpu.beamActiveStartT = 0x7fffffff;
    this.cpu.beamActiveEndT = 0;

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

    if (!render) {
      this.beamRenderEnabled = false;
      return false;
    }

    let rawRendered = false;
    if (this.beamActive) {
      if (this.beamPos < (SCREEN_HEIGHT << 9)) {
        renderBeamSpan(
          this.beamTargetBuf,
          this.ramPages[this.screenBankIdx],
          this.borderColor,
          this.flashPhase,
          this.beamPos,
          SCREEN_HEIGHT << 9
        );
      }
      this.invalidateTargetBorderCache();
      this.prevFrameUsedBeam = true;
      rawRendered = true;
    } else if (
      this.cpu.vramDirty ||
      this.borderDirty ||
      flashChanged ||
      this.prevFrameUsedBeam
    ) {
      this.beginRawFrameTarget();
      const borderIdx = this.borderColor & 0x07;
      const paintBorder = this.shouldPaintTargetBorder(borderIdx);
      renderStaticFrame(
        this.beamTargetBuf,
        this.ramPages[this.screenBankIdx],
        borderIdx,
        this.flashPhase,
        paintBorder
      );
      if (paintBorder) {
        this.markTargetBorderPainted(borderIdx);
      }
      this.prevFrameUsedBeam = false;
      rawRendered = true;
    }

    this.beamRenderEnabled = false;
    this.cpu.vramDirty = false;
    this.borderDirty = false;

    if (!rawRendered) {
      if (this.autoBlendHold > 0) {
        this.autoBlendHold--;
      }
      this.bankFlipStreak = 0;
      this.hashFlipStreak = 0;
      if (this.outputIsBlended && this.gigascreenMode !== 'off') {
        const changed = copyFrameWithDiff(this.currRaw, this.frameBuffer);
        this.prevRaw.set(this.currRaw);
        this.outputIsBlended = false;
        return changed;
      }
      return false;
    }

    return this.presentRenderedRawFrame();
  }

  public renderFrame(): void {
    this.hasPrevRaw = false;
    this.outputIsBlended = false;
    this.prevFrameUsedBeam = false;
    this.bankFlipStreak = 0;
    this.hashFlipStreak = 0;
    this.autoBlendHold = 0;
    this.hasBandHash1 = false;
    this.hasBandHash2 = false;
    this.prevScreenStartBank = this.screenBankIdx;
    this.prevScreenEndBank = this.screenBankIdx;
    this.frameStartScreenBank = this.screenBankIdx;

    const borderIdx = this.borderColor & 0x07;
    if (this.gigascreenMode === 'off') {
      renderStaticFrame(
        this.frameBuffer,
        this.ramPages[this.screenBankIdx],
        borderIdx,
        this.flashPhase,
        true
      );
      this.paintedBorderOut = borderIdx;
    } else {
      renderStaticFrame(
        this.currRaw,
        this.ramPages[this.screenBankIdx],
        borderIdx,
        this.flashPhase,
        true
      );
      if (this.currTargetIsA) {
        this.paintedBorderA = borderIdx;
        this.paintedBorderB = -1;
      } else {
        this.paintedBorderB = borderIdx;
        this.paintedBorderA = -1;
      }
      this.frameBuffer.set(this.currRaw);
    }
    this.hasRenderedFrame = true;
  }
}
