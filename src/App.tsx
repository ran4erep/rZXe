/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ZXSpectrum48,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  getBorderViewport,
} from './emulator/spectrum';
import { MachineId, getMachineProfile, getMachineFrameHz } from './emulator/machines';
import {
  createFramePacerState,
  resetFramePacerState,
  advanceFramePacer,
} from './emulator/framePacer';
import { SpectrumBeeper } from './emulator/beeper';
import { BuiltinGame } from './emulator/builtinGames';
import { createBlankTrdImage } from './emulator/betaDisk';
import {
  SavedDiskMeta,
  SessionDiskHistoryItem,
  listSavedDisks,
  getSavedDiskBytes,
  putSavedDisk,
  renameSavedDisk,
  deleteSavedDisk,
  generateNextDiskName,
  triggerDiskDownload,
  upsertSessionDiskHistory,
} from './emulator/diskStorage';
import { TopBar } from './components/TopBar';
import { SpectrumScreen } from './components/SpectrumScreen';
import { SpectrumKeyboard, CONTROL_BG_STYLE, preloadControlGraphics } from './components/SpectrumKeyboard';
import { GamesModal } from './components/GamesModal';
import { SettingsModal, EmulatorSettings } from './components/SettingsModal';
import { SaveStatesModal } from './components/SaveStatesModal';
import { loadEmulatorSettings, saveEmulatorSettings } from './emulator/settingsStorage';
import {
  SaveStateMeta,
  SaveStateSlot,
  buildSaveStateSlotId,
  sanitizeSaveStateSlot,
  loadSelectedSaveSlot,
  saveSelectedSaveSlot,
  listSaveStates,
  putSaveState,
  getSaveStateRecord,
  deleteSaveState,
  triggerSaveStateDownload,
  resolveSaveStateGameKey,
  doesSaveStateMatchGame,
  isReleaseScopedGameKey,
  extractZxArtProdIdFromKey,
} from './emulator/saveStateStorage';
import { ZxArtGameSummary } from './emulator/zxartCatalog';
import {
  ExtractedEntry,
  extractPlayableFiles,
  getFileExtension,
  getFormatBadge,
  isMountableDriveExtension,
} from './emulator/archiveExtractor';
import {
  SCREENSHOT_HEIGHT,
  SCREENSHOT_WIDTH,
  captureBorderless720pPngBlob,
  normalizeScreenshotFilename,
  triggerScreenshotDownload,
} from './emulator/screenshot';
import {
  loadFavorites,
  saveFavorites,
  toggleFavoriteGame,
} from './emulator/favoritesStorage';

type DriveMountSource =
  | { kind: 'none' }
  | { kind: 'external' }
  | { kind: 'blank' }
  | { kind: 'saved'; id: string; name: string; createdAt: number };

function detectTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse || window.innerWidth < 768;
}

export default function App() {
  // Singleton emulator & audio instances (never re-created on React renders)
  const spectrumRef = useRef<ZXSpectrum48 | null>(null);
  if (!spectrumRef.current) {
    spectrumRef.current = new ZXSpectrum48('128k');
  }
  const beeperRef = useRef<SpectrumBeeper | null>(null);
  if (!beeperRef.current) {
    beeperRef.current = new SpectrumBeeper();
  }

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [isTouchEnv, setIsTouchEnv] = useState<boolean>(() => detectTouchDevice());
  const [paused, setPaused] = useState(false);
  const [machineId, setMachineId] = useState<MachineId>('128k');
  const [gamesOpen, setGamesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveStatesOpen, setSaveStatesOpen] = useState(false);
  const [saveStates, setSaveStates] = useState<SaveStateMeta[]>([]);
  const [selectedSaveSlot, setSelectedSaveSlot] = useState<SaveStateSlot>(() =>
    loadSelectedSaveSlot()
  );
  const [activeGameTitle, setActiveGameTitle] = useState<string | null>(null);
  const [activeGameKey, setActiveGameKey] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [diskNames, setDiskNames] = useState<[string | null, string | null]>([null, null]);
  const [driveReading, setDriveReading] = useState<[boolean, boolean]>([false, false]);
  const [savedDisks, setSavedDisks] = useState<SavedDiskMeta[]>([]);
  const savedDisksRef = useRef<SavedDiskMeta[]>(savedDisks);
  savedDisksRef.current = savedDisks;
  const [sessionDiskHistory, setSessionDiskHistory] = useState<SessionDiskHistoryItem[]>([]);

  const [settings, setSettings] = useState<EmulatorSettings>(() => loadEmulatorSettings());
  const [favorites, setFavorites] = useState<ZxArtGameSummary[]>(() => loadFavorites());
  const [lastZxArtGame, setLastZxArtGame] = useState<ZxArtGameSummary | null>(null);
  const [catalogLaunch, setCatalogLaunch] = useState<{
    targetDrive: 0 | 1 | null;
    openNonce: number;
    initialGame: ZxArtGameSummary | null;
  }>({
    targetDrive: null,
    openNonce: 0,
    initialGame: null,
  });
  const [diskArchivePicker, setDiskArchivePicker] = useState<{
    drive: 0 | 1;
    archiveName: string;
    files: ExtractedEntry[];
  } | null>(null);

  // Refs synced with latest state so the RAF loop never restarts or allocates closures
  const anyModalOpen = gamesOpen || settingsOpen || saveStatesOpen || diskArchivePicker !== null;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = anyModalOpen;
  const loopSleepingRef = useRef(false);
  loopSleepingRef.current = paused || anyModalOpen;
  const paintFrameRef = useRef<(() => void) | null>(null);
  const hardwareGamepadActiveRef = useRef(false);

  const showStatus = useCallback((msg: string) => {
    setStatusBanner(msg);
  }, []);

  useEffect(() => {
    if (!statusBanner) return;
    const t = window.setTimeout(() => setStatusBanner(null), 2600);
    return () => window.clearTimeout(t);
  }, [statusBanner]);

  // Preload and decode all control panel images once on startup with minimal CPU overhead
  useEffect(() => {
    preloadControlGraphics();
  }, []);

  // Responsive touch/mobile detection
  useEffect(() => {
    const update = () => setIsTouchEnv(detectTouchDevice());
    const mq = window.matchMedia?.('(pointer: coarse)');
    mq?.addEventListener?.('change', update);
    window.addEventListener('resize', update);
    return () => {
      mq?.removeEventListener?.('change', update);
      window.removeEventListener('resize', update);
    };
  }, []);

  const unlockAudio = useCallback(() => {
    if (!settingsRef.current.soundEnabled) return;
    beeperRef.current?.start();
  }, []);

  const driveReadingRef = useRef<[boolean, boolean]>([false, false]);
  const driveTimersRef = useRef<[number | null, number | null]>([null, null]);
  const driveSourceRef = useRef<[DriveMountSource, DriveMountSource]>([
    { kind: 'none' },
    { kind: 'none' },
  ]);
  const diskSaveTimersRef = useRef<[number | null, number | null]>([null, null]);

  const flushDrivePersist = useCallback((drive: 0 | 1) => {
    if (diskSaveTimersRef.current[drive] !== null) {
      window.clearTimeout(diskSaveTimersRef.current[drive]!);
      diskSaveTimersRef.current[drive] = null;
    }
    const speccy = spectrumRef.current;
    const bytes = speccy?.bdi.disks[drive];
    if (!bytes) return;
    const src = driveSourceRef.current[drive];

    if (src.kind === 'blank') {
      const id =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `disk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const name = generateNextDiskName(savedDisksRef.current);
      const now = Date.now();
      const meta: SavedDiskMeta = { id, name, createdAt: now, updatedAt: now };

      driveSourceRef.current[drive] = { kind: 'saved', id, name, createdAt: now };
      savedDisksRef.current = [meta, ...savedDisksRef.current];
      setSavedDisks(savedDisksRef.current);
      setDiskNames((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]];
        next[drive] = name;
        return next;
      });
      void putSavedDisk(id, name, bytes, now);
    } else if (src.kind === 'saved') {
      const now = Date.now();
      const updatedMeta: SavedDiskMeta = {
        id: src.id,
        name: src.name,
        createdAt: src.createdAt,
        updatedAt: now,
      };
      const nextList = [
        updatedMeta,
        ...savedDisksRef.current.filter((item) => item.id !== src.id),
      ];
      savedDisksRef.current = nextList;
      setSavedDisks(nextList);
      void putSavedDisk(src.id, src.name, bytes, src.createdAt);
    }
  }, []);

  const scheduleDrivePersist = useCallback(
    (writeMask: number) => {
      for (const d of [0, 1] as const) {
        if ((writeMask & (1 << d)) === 0) continue;
        const src = driveSourceRef.current[d];
        if (src.kind !== 'blank' && src.kind !== 'saved') continue;
        if (diskSaveTimersRef.current[d] !== null) {
          window.clearTimeout(diskSaveTimersRef.current[d]!);
        }
        diskSaveTimersRef.current[d] = window.setTimeout(() => {
          diskSaveTimersRef.current[d] = null;
          flushDrivePersist(d);
        }, 400);
      }
    },
    [flushDrivePersist]
  );

  // Hydrate saved written disks & savestates from browser cache on startup
  useEffect(() => {
    let active = true;
    void listSavedDisks().then((list) => {
      if (active) {
        savedDisksRef.current = list;
        setSavedDisks(list);
      }
    });
    void listSaveStates().then((list) => {
      if (active) {
        setSaveStates(list);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const triggerDriveActivity = useCallback((mask: number) => {
    for (const d of [0, 1] as const) {
      if ((mask & (1 << d)) === 0) continue;
      if (driveTimersRef.current[d] !== null) {
        window.clearTimeout(driveTimersRef.current[d]!);
      }
      if (!driveReadingRef.current[d]) {
        driveReadingRef.current[d] = true;
        setDriveReading([driveReadingRef.current[0], driveReadingRef.current[1]]);
      }
      driveTimersRef.current[d] = window.setTimeout(() => {
        driveTimersRef.current[d] = null;
        if (driveReadingRef.current[d]) {
          driveReadingRef.current[d] = false;
          setDriveReading([driveReadingRef.current[0], driveReadingRef.current[1]]);
        }
      }, 220);
    }
  }, []);

  // Persist settings to localStorage whenever settings change
  useEffect(() => {
    saveEmulatorSettings(settings);
  }, [settings]);

  // Sync audio & emulator flags when settings change
  useEffect(() => {
    const speccy = spectrumRef.current!;
    const beeper = beeperRef.current!;
    speccy.soundEnabled = settings.soundEnabled;
    speccy.setFastTapeLoad(settings.fastTapeLoad);
    speccy.setCpuFreqMhz(settings.cpuFreqMhz);
    speccy.setGigascreenMode(settings.gigascreenMode);
    speccy.keyboard.setJoystickMode(settings.joystickMode);
    beeper.setVolume(settings.volume);
    beeper.setMuted(!settings.soundEnabled || paused || anyModalOpen, !settings.soundEnabled);
    if (paused || anyModalOpen) {
      speccy.keyboard.releaseAllPhysical();
    }
  }, [settings, paused, anyModalOpen]);

  // Main low-CPU 50Hz emulation loop (automatically sleeps when paused or tab is hidden)
  useEffect(() => {
    const speccy = spectrumRef.current!;
    const beeper = beeperRef.current!;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const vp = getBorderViewport(settings.borderMode);
    const vpOffsetX = vp.offsetX;
    const vpOffsetY = vp.offsetY;
    const vpWidth = vp.width;
    const vpHeight = vp.height;
    const isFullBorder = vpOffsetX === 0 && vpOffsetY === 0;

    // Allocate ImageData & Uint32 view ONCE sized cleanly to visible viewport
    const imageData = isFullBorder
      ? ctx.createImageData(SCREEN_WIDTH, SCREEN_HEIGHT)
      : ctx.createImageData(vpWidth, vpHeight);
    const pixels32 = new Uint32Array(imageData.data.buffer);
    const rowViews = isFullBorder
      ? null
      : Array.from({ length: vpHeight }, (_, y) =>
          speccy.frameBuffer.subarray(
            (vpOffsetY + y) * SCREEN_WIDTH + vpOffsetX,
            (vpOffsetY + y) * SCREEN_WIDTH + vpOffsetX + vpWidth
          )
        );

    const paintBuffer = () => {
      if (isFullBorder) {
        pixels32.set(speccy.frameBuffer);
      } else {
        for (let y = 0; y < vpHeight; y++) {
          pixels32.set(rowViews![y], y * vpWidth);
        }
      }
      ctx.putImageData(imageData, 0, 0);
    };
    paintFrameRef.current = paintBuffer;

    // Draw initial frame immediately if not yet rendered
    if (!speccy.hasRenderedFrame) {
      speccy.renderFrame();
    }
    paintBuffer();

    let rafId = 0;
    const pacer = createFramePacerState();

    const tick = (now: number) => {
      rafId = 0;
      if (loopSleepingRef.current || document.hidden) {
        return;
      }

      const frameHz = getMachineFrameHz(speccy.profile);

      if (speccy.tapePlayer.active && settingsRef.current.fastTapeLoad) {
        const prevSound = speccy.soundEnabled;
        const prevFreq = speccy.cpuFreqMhz;
        speccy.soundEnabled = false;
        speccy.cpuFreqMhz = 3.5;
        const deadline = now + 7;
        try {
          for (let k = 0; k < 16 && speccy.tapePlayer.active; k++) {
            speccy.stepFrame(false);
            if (performance.now() >= deadline) break;
          }
        } finally {
          speccy.cpuFreqMhz = prevFreq;
          speccy.soundEnabled = prevSound;
        }
        speccy.audioTransitionCount = 0;
        speccy.renderFrame();
        speccy.cpu.vramDirty = false;
        speccy.borderDirty = false;
        paintBuffer();
        resetFramePacerState(pacer, now);
      } else {
        const steps = advanceFramePacer(pacer, now, frameHz, 2);
        const soundOn = settingsRef.current.soundEnabled;
        const hasAY = speccy.profile.hasAY;
        const frameT = speccy.profile.tstatesPerFrame;
        const stereoMode = settingsRef.current.stereoMode;
        const ayClockHz = speccy.profile.ayClockHz;

        if (
          hardwareGamepadActiveRef.current &&
          typeof navigator !== 'undefined' &&
          typeof navigator.getGamepads === 'function'
        ) {
          speccy.keyboard.pollHardwareGamepads(navigator.getGamepads());
        }

        const needPrevRaw = settingsRef.current.gigascreenMode !== 'off';
        let anyDirty = false;
        for (let s = 0; s < steps; s++) {
          const isLastStep = s === steps - 1;
          const dirty = speccy.stepFrame(isLastStep || needPrevRaw);
          if (dirty) {
            anyDirty = true;
          }
          if (soundOn) {
            beeper.pushFrame(
              speccy.audioTransitionsT,
              speccy.audioTransitionsVal,
              speccy.audioTransitionCount,
              speccy.audioInitialLevel,
              hasAY ? speccy.ay : null,
              frameT,
              frameHz,
              1,
              stereoMode,
              ayClockHz
            );
          }
        }
        // Blit framebuffer once per RAF tick after frame stepping completes
        if (anyDirty) {
          paintBuffer();
        }
      }

      const diskMask = speccy.bdi.readActivityMask;
      if (diskMask !== 0) {
        speccy.bdi.readActivityMask = 0;
        triggerDriveActivity(diskMask);
      }

      const writeMask = speccy.bdi.writeDirtyMask;
      if (writeMask !== 0) {
        speccy.bdi.writeDirtyMask = 0;
        scheduleDrivePersist(writeMask);
      }

      rafId = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (!rafId && !loopSleepingRef.current && !document.hidden) {
        resetFramePacerState(pacer, 0);
        rafId = requestAnimationFrame(tick);
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        if (diskSaveTimersRef.current[0] !== null) flushDrivePersist(0);
        if (diskSaveTimersRef.current[1] !== null) flushDrivePersist(1);
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        beeper.setMuted(true, true);
        speccy.keyboard.releaseAllPhysical();
      } else {
        beeper.setMuted(!settingsRef.current.soundEnabled || loopSleepingRef.current, !settingsRef.current.soundEnabled);
        startLoop();
      }
    };

    const handlePageHide = () => {
      if (diskSaveTimersRef.current[0] !== null) flushDrivePersist(0);
      if (diskSaveTimersRef.current[1] !== null) flushDrivePersist(1);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', handlePageHide);
    if (!paused && !anyModalOpen) {
      startLoop();
    }

    return () => {
      paintFrameRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', handlePageHide);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [paused, anyModalOpen, settings.borderMode, flushDrivePersist, scheduleDrivePersist, triggerDriveActivity]);

  // Hardware Gamepad API connect/disconnect listeners (zero CPU polling when no controller connected)
  useEffect(() => {
    const speccy = spectrumRef.current!;
    const refreshGamepadPresence = () => {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
        hardwareGamepadActiveRef.current = false;
        return;
      }
      const pads = navigator.getGamepads();
      let active = false;
      if (pads) {
        for (let i = 0; i < pads.length; i++) {
          if (pads[i]?.connected) {
            active = true;
            break;
          }
        }
      }
      hardwareGamepadActiveRef.current = active;
      if (!active) {
        speccy.keyboard.pollHardwareGamepads(null);
      }
    };

    const onGamepadConnected = () => {
      hardwareGamepadActiveRef.current = true;
    };

    const onGamepadDisconnected = () => {
      refreshGamepadPresence();
    };

    refreshGamepadPresence();
    window.addEventListener('gamepadconnected', onGamepadConnected);
    window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
    window.addEventListener('focus', refreshGamepadPresence);
    return () => {
      window.removeEventListener('gamepadconnected', onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', onGamepadDisconnected);
      window.removeEventListener('focus', refreshGamepadPresence);
    };
  }, []);

  // Cleanup Web Audio and timers on unmount
  useEffect(() => {
    const beeper = beeperRef.current;
    const timers = driveTimersRef.current;
    const saveTimers = diskSaveTimersRef.current;
    return () => {
      beeper?.destroy();
      for (const t of timers) {
        if (t !== null) window.clearTimeout(t);
      }
      for (const t of saveTimers) {
        if (t !== null) window.clearTimeout(t);
      }
    };
  }, []);

  // Physical desktop keyboard handler
  useEffect(() => {
    const speccy = spectrumRef.current!;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (gamesOpen || settingsOpen || saveStatesOpen || diskArchivePicker !== null)) {
        setGamesOpen(false);
        setSettingsOpen(false);
        setSaveStatesOpen(false);
        setDiskArchivePicker(null);
        return;
      }
      if (modalOpenRef.current) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey) return;

      unlockAudio();
      const handled = speccy.keyboard.handlePhysicalKeyDown(e.code, e.key, e.shiftKey);
      if (handled) {
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      speccy.keyboard.handlePhysicalKeyUp(e.code);
    };

    const onBlur = () => {
      speccy.keyboard.releaseAllPhysical();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [gamesOpen, settingsOpen, saveStatesOpen, diskArchivePicker, unlockAudio]);

  const handleSelectMachine = useCallback(
    (id: MachineId) => {
      unlockAudio();
      const speccy = spectrumRef.current!;
      speccy.setMachine(id);
      setMachineId(speccy.machineId);
      setActiveGameTitle(null);
      setActiveGameKey(null);
      setLastZxArtGame(null);
      setPaused(false);
      showStatus(`BIOS: ${getMachineProfile(id).name}`);
    },
    [unlockAudio, showStatus]
  );

  const handleReset = useCallback(() => {
    unlockAudio();
    const speccy = spectrumRef.current!;
    speccy.hardReset();
    setActiveGameTitle(null);
    setActiveGameKey(null);
    setLastZxArtGame(null);
    setPaused(false);
    showStatus(`Сброс: ${speccy.profile.name}`);
  }, [unlockAudio, showStatus]);

  const handleLoadFile = useCallback(
    (
      filename: string,
      bytes: Uint8Array,
      displayTitle?: string,
      recommendedMachine?: MachineId | null,
      explicitGameKey?: string | null,
      zxArtGame?: ZxArtGameSummary | null
    ) => {
      unlockAudio();
      const speccy = spectrumRef.current!;
      const ext = getFileExtension(filename);
      const maybeDisk = isMountableDriveExtension(ext);
      if (recommendedMachine && speccy.machineId !== recommendedMachine) {
        speccy.setMachine(recommendedMachine);
      }
      if (maybeDisk) {
        if (diskSaveTimersRef.current[0] !== null) flushDrivePersist(0);
        driveSourceRef.current[0] = { kind: 'external' };
      }
      const msg = speccy.loadFile(filename, bytes, true);
      if (maybeDisk && speccy.bdi.disks[0] !== null) {
        setDiskNames((prev) => [filename, prev[1]]);
        setSessionDiskHistory((prev) => upsertSessionDiskHistory(prev, filename, bytes));
      }
      setMachineId(speccy.machineId);
      setActiveGameTitle(displayTitle ?? filename);
      setActiveGameKey(explicitGameKey ?? null);
      setLastZxArtGame(zxArtGame ?? null);
      setPaused(false);
      showStatus(msg);
    },
    [unlockAudio, showStatus, flushDrivePersist]
  );

  const handleSelectBuiltin = useCallback(
    (game: BuiltinGame) => {
      unlockAudio();
      const speccy = spectrumRef.current!;
      if (game.recommendedMachine && speccy.machineId !== game.recommendedMachine) {
        speccy.setMachine(game.recommendedMachine);
      }
      if (game.format === 'TRD') {
        if (diskSaveTimersRef.current[0] !== null) flushDrivePersist(0);
        driveSourceRef.current[0] = { kind: 'external' };
      }
      const bytes = game.buildBytes();
      const msg = speccy.loadFile(game.filename, bytes, true);
      if (game.format === 'TRD') {
        setDiskNames((prev) => [game.filename, prev[1]]);
      }
      setMachineId(speccy.machineId);
      setActiveGameTitle(game.title);
      setActiveGameKey(`builtin:${game.id}`);
      setLastZxArtGame(null);
      setPaused(false);
      showStatus(msg);
    },
    [unlockAudio, showStatus, flushDrivePersist]
  );

  const mountExtractedDisk = useCallback(
    (drive: 0 | 1, filename: string, bytes: Uint8Array) => {
      const speccy = spectrumRef.current!;
      if (diskSaveTimersRef.current[drive] !== null) flushDrivePersist(drive);
      speccy.mountDisk(drive, filename, bytes);
      driveSourceRef.current[drive] = { kind: 'external' };
      setSessionDiskHistory((prev) => upsertSessionDiskHistory(prev, filename, bytes));
      setDiskNames((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]];
        next[drive] = filename;
        return next;
      });
      showStatus(`Дискета ${drive === 0 ? 'A' : 'B'}: ${filename}`);
    },
    [showStatus, flushDrivePersist]
  );

  const handleInsertDiskFromCatalog = useCallback(
    (drive: 0 | 1, filename: string, bytes: Uint8Array) => {
      unlockAudio();
      mountExtractedDisk(drive, filename, bytes);
    },
    [unlockAudio, mountExtractedDisk]
  );

  const handleInsertDisk = useCallback(
    async (drive: 0 | 1, filename: string, bytes: Uint8Array) => {
      unlockAudio();
      try {
        const extracted = await extractPlayableFiles(filename, bytes, 'disk');
        if (extracted.kind === 'single') {
          mountExtractedDisk(drive, extracted.file.name, extracted.file.bytes);
        } else {
          setDiskArchivePicker({
            drive,
            archiveName: extracted.archiveName,
            files: extracted.files,
          });
        }
      } catch (err) {
        showStatus(err instanceof Error ? err.message : 'Ошибка образа дискеты');
      }
    },
    [unlockAudio, showStatus, mountExtractedDisk]
  );

  const handleSelectHistoryDisk = useCallback(
    (drive: 0 | 1, item: SessionDiskHistoryItem) => {
      unlockAudio();
      const speccy = spectrumRef.current!;
      try {
        if (diskSaveTimersRef.current[drive] !== null) flushDrivePersist(drive);
        speccy.mountDisk(drive, item.name, item.bytes);
        driveSourceRef.current[drive] = { kind: 'external' };
        setDiskNames((prev) => {
          const next: [string | null, string | null] = [prev[0], prev[1]];
          next[drive] = item.name;
          return next;
        });
        showStatus(`Дискета ${drive === 0 ? 'A' : 'B'}: ${item.name}`);
      } catch (err) {
        showStatus(err instanceof Error ? err.message : 'Ошибка образа дискеты');
      }
    },
    [unlockAudio, showStatus, flushDrivePersist]
  );

  const handleInsertBlankDisk = useCallback(
    (drive: 0 | 1) => {
      unlockAudio();
      const speccy = spectrumRef.current!;
      if (diskSaveTimersRef.current[drive] !== null) flushDrivePersist(drive);
      const blankBytes = createBlankTrdImage('BLANK');
      speccy.bdi.insertDisk(drive, blankBytes);
      driveSourceRef.current[drive] = { kind: 'blank' };
      setDiskNames((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]];
        next[drive] = 'Чистая дискета';
        return next;
      });
      showStatus(`Дискета ${drive === 0 ? 'A' : 'B'}: Чистая дискета`);
    },
    [unlockAudio, showStatus, flushDrivePersist]
  );

  const handleMountSavedDisk = useCallback(
    async (drive: 0 | 1, id: string) => {
      unlockAudio();
      const meta = savedDisksRef.current.find((d) => d.id === id);
      if (!meta) return;
      if (diskSaveTimersRef.current[drive] !== null) flushDrivePersist(drive);
      const bytes = await getSavedDiskBytes(id);
      if (!bytes) {
        showStatus('Не удалось загрузить дискету из кэша');
        return;
      }
      const speccy = spectrumRef.current!;
      speccy.bdi.insertDisk(drive, bytes);
      driveSourceRef.current[drive] = {
        kind: 'saved',
        id: meta.id,
        name: meta.name,
        createdAt: meta.createdAt,
      };
      setDiskNames((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]];
        next[drive] = meta.name;
        return next;
      });
      showStatus(`Дискета ${drive === 0 ? 'A' : 'B'}: ${meta.name}`);
    },
    [unlockAudio, showStatus, flushDrivePersist]
  );

  const handleRenameSavedDisk = useCallback(
    async (id: string, newName: string) => {
      const updated = await renameSavedDisk(id, newName);
      if (!updated) return;
      const nextList = [
        updated,
        ...savedDisksRef.current.filter((item) => item.id !== id),
      ];
      savedDisksRef.current = nextList;
      setSavedDisks(nextList);

      for (const d of [0, 1] as const) {
        const src = driveSourceRef.current[d];
        if (src.kind === 'saved' && src.id === id) {
          driveSourceRef.current[d] = { ...src, name: updated.name };
          setDiskNames((prev) => {
            const next: [string | null, string | null] = [prev[0], prev[1]];
            next[d] = updated.name;
            return next;
          });
        }
      }
    },
    []
  );

  const handleDownloadSavedDisk = useCallback(
    async (id: string) => {
      const meta = savedDisksRef.current.find((d) => d.id === id);
      if (!meta) return;
      const speccy = spectrumRef.current!;
      for (const d of [0, 1] as const) {
        const src = driveSourceRef.current[d];
        if (src.kind === 'saved' && src.id === id && speccy.bdi.disks[d]) {
          if (diskSaveTimersRef.current[d] !== null) flushDrivePersist(d);
          triggerDiskDownload(meta.name, speccy.bdi.disks[d]!);
          return;
        }
      }
      const bytes = await getSavedDiskBytes(id);
      if (bytes) {
        triggerDiskDownload(meta.name, bytes);
      }
    },
    [flushDrivePersist]
  );

  const handleDeleteSavedDisk = useCallback(async (id: string) => {
    await deleteSavedDisk(id);
    const nextList = savedDisksRef.current.filter((item) => item.id !== id);
    savedDisksRef.current = nextList;
    setSavedDisks(nextList);
    for (const d of [0, 1] as const) {
      const src = driveSourceRef.current[d];
      if (src.kind === 'saved' && src.id === id) {
        if (diskSaveTimersRef.current[d] !== null) {
          window.clearTimeout(diskSaveTimersRef.current[d]!);
          diskSaveTimersRef.current[d] = null;
        }
        driveSourceRef.current[d] = { kind: 'external' };
      }
    }
  }, []);

  const handleEjectDisk = useCallback(
    (drive: 0 | 1) => {
      if (diskSaveTimersRef.current[drive] !== null) flushDrivePersist(drive);
      const speccy = spectrumRef.current!;
      speccy.ejectDisk(drive);
      driveSourceRef.current[drive] = { kind: 'none' };
      setDiskNames((prev) => {
        const next: [string | null, string | null] = [prev[0], prev[1]];
        next[drive] = null;
        return next;
      });
      if (driveTimersRef.current[drive] !== null) {
        window.clearTimeout(driveTimersRef.current[drive]!);
        driveTimersRef.current[drive] = null;
      }
      driveReadingRef.current[drive] = false;
      setDriveReading([driveReadingRef.current[0], driveReadingRef.current[1]]);
      showStatus(`Дискета ${drive === 0 ? 'A' : 'B'} извлечена`);
    },
    [showStatus, flushDrivePersist]
  );

  const handleSelectSaveSlot = useCallback((slot: SaveStateSlot) => {
    const normalized = sanitizeSaveStateSlot(slot);
    setSelectedSaveSlot(normalized);
    saveSelectedSaveSlot(normalized);
  }, []);

  const handleSaveState = useCallback(async () => {
    unlockAudio();
    const speccy = spectrumRef.current!;
    const snaBytes = speccy.createSnaSnapshot();
    let screenshotDataUrl = '';
    const canvas = canvasRef.current;
    if (canvas) {
      try {
        screenshotDataUrl = canvas.toDataURL('image/webp', 0.72);
      } catch {
        screenshotDataUrl = '';
      }
    }
    const slot = sanitizeSaveStateSlot(selectedSaveSlot);
    const title = activeGameTitle ?? diskNames[0] ?? getMachineProfile(speccy.machineId).name;
    const gameKey = resolveSaveStateGameKey(
      activeGameTitle,
      diskNames[0],
      speccy.machineId,
      activeGameKey
    );
    const id = buildSaveStateSlotId(gameKey, slot);
    const meta = await putSaveState({
      id,
      slot,
      title,
      gameKey,
      machineId: speccy.machineId,
      screenshotDataUrl,
      snaBytes,
    });
    setSaveStates((prev) => [meta, ...prev.filter((item) => item.id !== meta.id)]);
    showStatus(`Сохранено в слот ${slot}`);
  }, [selectedSaveSlot, activeGameTitle, activeGameKey, diskNames, unlockAudio, showStatus]);

  const handleLoadSaveState = useCallback(
    async (id: string, zxArtGame?: ZxArtGameSummary | null) => {
      unlockAudio();
      const rec = await getSaveStateRecord(id);
      if (!rec) {
        showStatus('Не удалось загрузить сохранение');
        return;
      }
      const speccy = spectrumRef.current!;
      if (speccy.machineId !== rec.machineId) {
        speccy.setMachine(rec.machineId);
      }
      speccy.loadFile('savestate.sna', rec.snaBytes, false);
      paintFrameRef.current?.();
      setMachineId(speccy.machineId);
      setActiveGameTitle(rec.title);
      setActiveGameKey(rec.gameKey ?? null);
      if (zxArtGame !== undefined) {
        setLastZxArtGame(zxArtGame);
      } else {
        const loadedProdId = extractZxArtProdIdFromKey(rec.gameKey ?? '');
        setLastZxArtGame((prev) => (prev && loadedProdId === prev.id ? prev : null));
      }
      setPaused(false);
      setSaveStatesOpen(false);
      setGamesOpen(false);
      showStatus(`Загружено: ${rec.title}`);
    },
    [unlockAudio, showStatus]
  );

  const handleDeleteSaveState = useCallback(async (id: string) => {
    await deleteSaveState(id);
    setSaveStates((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleDownloadSaveState = useCallback(
    async (id: string) => {
      const rec = await getSaveStateRecord(id);
      if (!rec) {
        showStatus('Не удалось скачать сохранение');
        return;
      }
      const downloadBase = rec.slot !== undefined ? `${rec.title}_slot${rec.slot}` : rec.title;
      triggerSaveStateDownload(downloadBase, rec.snaBytes);
    },
    [showStatus]
  );

  const currentGameKey = resolveSaveStateGameKey(
    activeGameTitle,
    diskNames[0],
    machineId,
    activeGameKey
  );
  const visibleSaveStates = useMemo(
    () =>
      saveStates.filter((item) =>
        doesSaveStateMatchGame(item, {
          gameKey: currentGameKey,
          title: activeGameTitle ?? diskNames[0],
          machineId,
        })
      ),
    [saveStates, currentGameKey, activeGameTitle, diskNames, machineId]
  );

  const isVersionScoped = isReleaseScopedGameKey(activeGameKey);

  const handleTogglePause = useCallback(() => {
    unlockAudio();
    setPaused((p) => !p);
  }, [unlockAudio]);

  const handleToggleSound = useCallback(() => {
    const next = !settingsRef.current.soundEnabled;
    if (next) {
      beeperRef.current?.setMuted(false);
      beeperRef.current?.start();
    }
    setSettings((s) => ({ ...s, soundEnabled: next }));
  }, []);

  const handleOpenGames = useCallback(() => {
    unlockAudio();
    setCatalogLaunch((prev) => ({
      targetDrive: null,
      openNonce: prev.openNonce + 1,
      initialGame: null,
    }));
    setGamesOpen(true);
  }, [unlockAudio]);

  const handleOpenCatalogForDrive = useCallback(
    (drive: 0 | 1) => {
      unlockAudio();
      setCatalogLaunch((prev) => ({
        targetDrive: drive,
        openNonce: prev.openNonce + 1,
        initialGame: lastZxArtGame,
      }));
      setGamesOpen(true);
    },
    [unlockAudio, lastZxArtGame]
  );

  const handleCloseGames = useCallback(() => setGamesOpen(false), []);

  const handleSaveStateClick = useCallback(() => {
    void handleSaveState();
  }, [handleSaveState]);

  const handleCaptureScreenshot = useCallback(async () => {
    const speccy = spectrumRef.current;
    if (!speccy) return;
    if (!speccy.hasRenderedFrame) {
      speccy.renderFrame();
    }
    const blob = await captureBorderless720pPngBlob(speccy.frameBuffer);
    if (!blob) {
      showStatus('Не удалось создать скриншот');
      return;
    }
    const title = activeGameTitle ?? diskNames[0] ?? getMachineProfile(speccy.machineId).name;
    triggerScreenshotDownload(normalizeScreenshotFilename(title), blob);
    showStatus(`Скриншот ${SCREENSHOT_WIDTH}×${SCREENSHOT_HEIGHT} сохранён`);
  }, [activeGameTitle, diskNames, showStatus]);

  const handleCaptureScreenshotClick = useCallback(() => {
    void handleCaptureScreenshot();
  }, [handleCaptureScreenshot]);

  const handleOpenSaveStates = useCallback(() => {
    unlockAudio();
    setSaveStatesOpen(true);
  }, [unlockAudio]);

  const handleCloseSaveStates = useCallback(() => setSaveStatesOpen(false), []);

  const handleOpenSettings = useCallback(() => {
    unlockAudio();
    setSettingsOpen(true);
  }, [unlockAudio]);

  const handleCloseSettings = useCallback(() => setSettingsOpen(false), []);

  const handleSettingsChange = useCallback((patch: Partial<EmulatorSettings>) => {
    if (patch.soundEnabled) {
      beeperRef.current?.setMuted(false);
      beeperRef.current?.start();
    }
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleToggleKeyboardLayout = useCallback(() => {
    setSettings((prev) => ({
      ...prev,
      keyboardLayout: prev.keyboardLayout === 'ru' ? 'en' : 'ru',
    }));
  }, []);

  const handleLoadSaveStateVoid = useCallback(
    (id: string, zxArtGame?: ZxArtGameSummary | null) => {
      void handleLoadSaveState(id, zxArtGame);
    },
    [handleLoadSaveState]
  );

  const handleDeleteSaveStateVoid = useCallback(
    (id: string) => {
      void handleDeleteSaveState(id);
    },
    [handleDeleteSaveState]
  );

  const handleDownloadSaveStateVoid = useCallback(
    (id: string) => {
      void handleDownloadSaveState(id);
    },
    [handleDownloadSaveState]
  );

  const handleToggleFavorite = useCallback((game: ZxArtGameSummary) => {
    setFavorites((prev) => {
      const { favorites: next } = toggleFavoriteGame(prev, game);
      saveFavorites(next);
      return next;
    });
  }, []);

  const showKeyboard =
    settings.keyboardMode === 'show' ||
    (settings.keyboardMode === 'auto' && isTouchEnv);

  return (
    <main
      onPointerDownCapture={unlockAudio}
      className="h-dvh w-screen overflow-hidden bg-[#0e0f12] flex flex-col"
      data-testid="emulator-root"
      data-keyboard-visible={showKeyboard ? 'true' : 'false'}
      data-machine-id={machineId}
    >
      <TopBar
        paused={paused}
        soundEnabled={settings.soundEnabled}
        machineId={machineId}
        activeGameTitle={activeGameTitle}
        diskNames={diskNames}
        driveReading={driveReading}
        savedDisks={savedDisks}
        sessionDiskHistory={sessionDiskHistory}
        onSelectMachine={handleSelectMachine}
        onInsertDisk={handleInsertDisk}
        onInsertBlankDisk={handleInsertBlankDisk}
        onSelectHistoryDisk={handleSelectHistoryDisk}
        onMountSavedDisk={handleMountSavedDisk}
        onRenameSavedDisk={handleRenameSavedDisk}
        onDownloadSavedDisk={handleDownloadSavedDisk}
        onDeleteSavedDisk={handleDeleteSavedDisk}
        onEjectDisk={handleEjectDisk}
        onTogglePause={handleTogglePause}
        onToggleSound={handleToggleSound}
        onReset={handleReset}
        onOpenGames={handleOpenGames}
        onOpenCatalogForDrive={handleOpenCatalogForDrive}
        selectedSaveSlot={selectedSaveSlot}
        onSaveState={handleSaveStateClick}
        onCaptureScreenshot={handleCaptureScreenshotClick}
        onOpenSaveStates={handleOpenSaveStates}
        onOpenSettings={handleOpenSettings}
      />

      <div
        className="flex-1 min-h-0 w-full flex flex-col overflow-hidden"
        style={!isTouchEnv ? CONTROL_BG_STYLE : undefined}
      >
        <SpectrumScreen
          canvasRef={canvasRef}
          keyboard={spectrumRef.current.keyboard}
          scanlines={settings.scanlines}
          borderMode={settings.borderMode}
          screenScale={settings.screenScale}
          paused={paused}
          modalOpen={anyModalOpen}
          showKeyboard={showKeyboard}
          statusBanner={statusBanner}
          onUnlockAudio={unlockAudio}
        />

        {showKeyboard && (
          <SpectrumKeyboard
            keyboard={spectrumRef.current.keyboard}
            onUnlockAudio={unlockAudio}
            transparentBackground={!isTouchEnv}
            activeGameKey={activeGameKey ?? activeGameTitle ?? diskNames[0] ?? null}
            fallbackGameKey={isVersionScoped ? null : (activeGameTitle ?? diskNames[0] ?? null)}
            activeGameLabel={activeGameTitle ?? diskNames[0] ?? null}
            joystickMode={settings.joystickMode}
            keyboardLayout={settings.keyboardLayout}
            onToggleKeyboardLayout={handleToggleKeyboardLayout}
          />
        )}
      </div>

      <GamesModal
        open={gamesOpen}
        targetDrive={catalogLaunch.targetDrive}
        openNonce={catalogLaunch.openNonce}
        initialZxArtGame={catalogLaunch.initialGame}
        currentMachineId={machineId}
        saveStates={saveStates}
        favorites={favorites}
        onToggleFavorite={handleToggleFavorite}
        onClose={handleCloseGames}
        onSelectBuiltin={handleSelectBuiltin}
        onLoadFile={handleLoadFile}
        onInsertDiskFile={handleInsertDiskFromCatalog}
        onLoadSaveState={handleLoadSaveStateVoid}
        onDeleteSaveState={handleDeleteSaveStateVoid}
      />

      <SaveStatesModal
        open={saveStatesOpen}
        saveStates={visibleSaveStates}
        allSaveStates={saveStates}
        selectedSlot={selectedSaveSlot}
        activeGameLabel={activeGameTitle ?? diskNames[0] ?? null}
        isVersionScoped={isVersionScoped}
        onSelectSlot={handleSelectSaveSlot}
        onClose={handleCloseSaveStates}
        onLoadSaveState={handleLoadSaveStateVoid}
        onDownloadSaveState={handleDownloadSaveStateVoid}
        onDeleteSaveState={handleDeleteSaveStateVoid}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onChange={handleSettingsChange}
        onClose={handleCloseSettings}
      />

      {diskArchivePicker && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="disk-archive-picker-title"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDiskArchivePicker(null);
          }}
        >
          <div className="w-full sm:max-w-md bg-[#181a20] border-t sm:border border-white/12 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85dvh]">
            <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/10">
              <h2 id="disk-archive-picker-title" className="text-sm font-bold text-zinc-100 truncate">
                Дисковод {diskArchivePicker.drive === 0 ? 'A' : 'B'}: {diskArchivePicker.archiveName}
              </h2>
              <button
                type="button"
                onClick={() => setDiskArchivePicker(null)}
                aria-label="Закрыть"
                className="px-2.5 h-8 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-300 cursor-pointer"
              >
                Отмена
              </button>
            </div>
            <div className="p-4 space-y-1.5 overflow-y-auto">
              {diskArchivePicker.files.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    try {
                      mountExtractedDisk(diskArchivePicker.drive, entry.name, entry.bytes);
                      setDiskArchivePicker(null);
                    } catch (err) {
                      showStatus(err instanceof Error ? err.message : 'Ошибка образа дискеты');
                    }
                  }}
                  className="w-full rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-white/10 px-3 py-2.5 flex items-center justify-between gap-3 text-left cursor-pointer"
                >
                  <span className="text-sm font-semibold text-zinc-100 truncate">{entry.name}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold shrink-0 bg-zinc-800 text-zinc-300 border border-white/10">
                    {getFormatBadge(entry.name)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
