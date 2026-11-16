import { StereoMode } from './ay8910';
import { JoystickMode } from './keyboard';
import { BorderMode } from './spectrum';

export type { JoystickMode, BorderMode };
export type KeyboardMode = 'auto' | 'show' | 'hide';
export type ScreenScaleMode = 'auto' | 'aspect' | 'stretch';
export type DesktopMouseMode = 'cursor' | 'lock' | 'off';

export interface EmulatorSettings {
  soundEnabled: boolean;
  volume: number;
  stereoMode: StereoMode;
  scanlines: boolean;
  borderMode: BorderMode;
  screenScale: ScreenScaleMode;
  cpuFreqMhz: number;
  keyboardMode: KeyboardMode;
  joystickMode: JoystickMode;
  desktopMouseMode: DesktopMouseMode;
  fastTapeLoad: boolean;
}

export const DEFAULT_EMULATOR_SETTINGS: EmulatorSettings = {
  soundEnabled: true,
  volume: 1,
  stereoMode: 'acb',
  scanlines: false,
  borderMode: 'full',
  screenScale: 'auto',
  cpuFreqMhz: 3.5,
  keyboardMode: 'auto',
  joystickMode: 'kempston',
  desktopMouseMode: 'cursor',
  fastTapeLoad: true,
};

const SETTINGS_STORAGE_KEY = 'zx_emulator_settings_v1';

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

export function sanitizeEmulatorSettings(raw: unknown): EmulatorSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_EMULATOR_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;

  const volume =
    typeof obj.volume === 'number' && Number.isFinite(obj.volume)
      ? Math.min(1, Math.max(0, obj.volume))
      : DEFAULT_EMULATOR_SETTINGS.volume;

  const soundEnabled =
    typeof obj.soundEnabled === 'boolean'
      ? obj.soundEnabled
      : DEFAULT_EMULATOR_SETTINGS.soundEnabled;

  const stereoMode: StereoMode =
    obj.stereoMode === 'abc' || obj.stereoMode === 'acb' || obj.stereoMode === 'mono'
      ? obj.stereoMode
      : DEFAULT_EMULATOR_SETTINGS.stereoMode;

  const scanlines =
    typeof obj.scanlines === 'boolean' ? obj.scanlines : DEFAULT_EMULATOR_SETTINGS.scanlines;

  const borderMode: BorderMode =
    obj.borderMode === 'full' || obj.borderMode === 'small' || obj.borderMode === 'none'
      ? obj.borderMode
      : obj.noBorder === true
      ? 'none'
      : DEFAULT_EMULATOR_SETTINGS.borderMode;

  const screenScale: ScreenScaleMode =
    obj.screenScale === 'auto' || obj.screenScale === 'aspect' || obj.screenScale === 'stretch'
      ? obj.screenScale
      : DEFAULT_EMULATOR_SETTINGS.screenScale;

  const cpuFreqMhz =
    typeof obj.cpuFreqMhz === 'number' && Number.isFinite(obj.cpuFreqMhz)
      ? Math.min(14, Math.max(0.5, Math.round(obj.cpuFreqMhz * 4) / 4))
      : DEFAULT_EMULATOR_SETTINGS.cpuFreqMhz;

  const keyboardMode: KeyboardMode =
    obj.keyboardMode === 'auto' || obj.keyboardMode === 'show' || obj.keyboardMode === 'hide'
      ? obj.keyboardMode
      : DEFAULT_EMULATOR_SETTINGS.keyboardMode;

  const joystickMode: JoystickMode =
    obj.joystickMode === 'kempston' || obj.joystickMode === 'qaop'
      ? obj.joystickMode
      : DEFAULT_EMULATOR_SETTINGS.joystickMode;

  const desktopMouseMode: DesktopMouseMode =
    obj.desktopMouseMode === 'cursor' ||
    obj.desktopMouseMode === 'lock' ||
    obj.desktopMouseMode === 'off'
      ? obj.desktopMouseMode
      : DEFAULT_EMULATOR_SETTINGS.desktopMouseMode;

  const fastTapeLoad =
    typeof obj.fastTapeLoad === 'boolean'
      ? obj.fastTapeLoad
      : DEFAULT_EMULATOR_SETTINGS.fastTapeLoad;

  return {
    soundEnabled,
    volume,
    stereoMode,
    scanlines,
    borderMode,
    screenScale,
    cpuFreqMhz,
    keyboardMode,
    joystickMode,
    desktopMouseMode,
    fastTapeLoad,
  };
}

export function loadEmulatorSettings(): EmulatorSettings {
  const storage = getSafeStorage();
  if (!storage) return { ...DEFAULT_EMULATOR_SETTINGS };
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_EMULATOR_SETTINGS };
    return sanitizeEmulatorSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_EMULATOR_SETTINGS };
  }
}

export function saveEmulatorSettings(settings: EmulatorSettings): void {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitizeEmulatorSettings(settings)));
  } catch {
    // Ignore quota errors
  }
}
