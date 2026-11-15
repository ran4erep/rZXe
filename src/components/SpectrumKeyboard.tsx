import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  Gamepad2,
  Keyboard,
  Joystick,
  Grid2X2,
  Mouse,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  ArrowRight,
  Settings,
} from 'lucide-react';
import {
  SPECTRUM_KEYS,
  SpectrumKeySpec,
  KeyboardMatrix,
  JoystickMode,
  computeDpadMask,
} from '../emulator/keyboard';
import {
  DEFAULT_TOP_ROW_IDS,
  KEY_SPEC_BY_ID,
  normalizeGameMappingKey,
  resolveTopRowIds,
  saveGlobalTopRowIds,
  saveGameTopRowIds,
  clearGameTopRowIds,
} from '../emulator/topRowConfig';
import { isReleaseScopedGameKey } from '../emulator/saveStateStorage';
import controlBg from '../../assets/bg.webp';
import keycapRubberImg from '../assets/images/keycap_rubber_sym_1794677202991.jpg';
import joystickBaseImg from '../assets/images/joystick_base_1794670388626.jpg';
import joystickKnobImg from '../assets/images/joystick_knob_1794670387428.jpg';
import gamepadDpadImg from '../assets/images/gamepad_dpad_1794670388831.jpg';
import gamepadFireBtnImg from '../assets/images/gamepad_fire_btn_1794670389899.jpg';
import mouseBtnRetroImg from '../assets/images/mouse_button_clean_1794743369844.jpg';

const PRELOAD_FG_ASSETS: readonly string[] = [
  joystickKnobImg,
  joystickBaseImg,
  gamepadFireBtnImg,
  gamepadDpadImg,
  mouseBtnRetroImg,
];

const CONTROL_IMAGE_ASSETS: readonly string[] = [
  ...PRELOAD_FG_ASSETS,
  keycapRubberImg,
  controlBg,
];

let graphicsPreloaded = false;
let graphicsReady = false;
const preloadedImages: HTMLImageElement[] = [];
const resolvedAssetUrls = new Map<string, string>();
const readyListeners = new Set<() => void>();

export function getControlAssetSrc(src: string): string {
  return resolvedAssetUrls.get(src) ?? src;
}

function preloadSingleImageFallback(src: string): Promise<void> {
  const img = new Image();
  img.decoding = 'sync';
  img.src = src;
  preloadedImages.push(img);
  if (typeof img.decode === 'function') {
    return img.decode().catch(() => {});
  }
  return Promise.resolve();
}

export function preloadControlGraphics(): void {
  if (graphicsPreloaded || typeof window === 'undefined' || typeof Image === 'undefined') {
    return;
  }
  graphicsPreloaded = true;

  const jobs = CONTROL_IMAGE_ASSETS.map(async (src) => {
    if (
      src !== controlBg &&
      typeof fetch === 'function' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      try {
        const res = await fetch(src);
        if (res.ok) {
          const blob = await res.blob();
          const blobUrl = URL.createObjectURL(blob);
          const img = new Image();
          img.decoding = 'sync';
          img.src = blobUrl;
          if (typeof img.decode === 'function') {
            await img.decode().catch(() => {});
          }
          resolvedAssetUrls.set(src, blobUrl);
          preloadedImages.push(img);
          return;
        }
      } catch {
        // Fallback to standard Image preload below
      }
    }
    await preloadSingleImageFallback(src);
  });

  void Promise.all(jobs).then(() => {
    graphicsReady = true;
    for (const listener of readyListeners) {
      listener();
    }
    readyListeners.clear();
  });
}

// Start preloading immediately at module evaluation time instead of waiting for post-render effects
preloadControlGraphics();

interface SpectrumKeyboardProps {
  keyboard: KeyboardMatrix;
  onUnlockAudio: () => void;
  transparentBackground?: boolean;
  activeGameKey?: string | null;
  fallbackGameKey?: string | null;
  activeGameLabel?: string | null;
  joystickMode?: JoystickMode;
}

const STICK_MAX_R = 46;
const STICK_DEADZONE = 13;
const DPAD_DEADZONE = 14;
const TOUCHPAD_SENSITIVITY = 1.25;
const EMPTY_KEYS: readonly string[] = [];

const SINGLE_KEY_TUPLES = new Map<string, readonly string[]>();
for (const row of SPECTRUM_KEYS) {
  for (const k of row) {
    SINGLE_KEY_TUPLES.set(k.id, [k.id]);
  }
}

const NUMBER_ROW = SPECTRUM_KEYS[0];
const ENTER_KEYS: readonly string[] = ['ENTER'];
const SPACE_KEYS: readonly string[] = ['SPACE'];

const ARROW_BUTTONS = [
  { id: 'ARROW_LEFT', Icon: ArrowLeft, ariaLabel: 'Стрелка влево (Shift + 5)', keys: ['CAPS', '5'] },
  { id: 'ARROW_DOWN', Icon: ArrowDown, ariaLabel: 'Стрелка вниз (Shift + 6)', keys: ['CAPS', '6'] },
  { id: 'ARROW_UP', Icon: ArrowUp, ariaLabel: 'Стрелка вверх (Shift + 7)', keys: ['CAPS', '7'] },
  { id: 'ARROW_RIGHT', Icon: ArrowRight, ariaLabel: 'Стрелка вправо (Shift + 8)', keys: ['CAPS', '8'] },
] as const;

interface SpectrumKeyCellProps {
  spec: SpectrumKeySpec;
  isFirstRow: boolean;
  isActive: boolean;
  isEditPulse?: boolean;
  uniformWidth?: boolean;
  slotIndex?: number;
  onKeyDown: (
    e: React.PointerEvent<HTMLButtonElement>,
    spec: SpectrumKeySpec,
    slotIndex?: number
  ) => void;
  onKeyUp: (e: React.PointerEvent<HTMLButtonElement>) => void;
}

const SpectrumKeyCell = React.memo<SpectrumKeyCellProps>(
  ({
    spec,
    isFirstRow,
    isActive,
    isEditPulse = false,
    uniformWidth = false,
    slotIndex,
    onKeyDown,
    onKeyUp,
  }) => {
    const isLetterKey = spec.id.length === 1 && spec.id >= 'A' && spec.id <= 'Z';

    const handlePointerDown = useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => onKeyDown(e, spec, slotIndex),
      [onKeyDown, spec, slotIndex]
    );

    return (
      <div
        className={`flex-1 ${uniformWidth ? '' : spec.widthClass ?? ''} min-w-0 flex flex-col items-center`}
      >
        {/* Faceplate legend ABOVE the keycap */}
        <div
          aria-hidden="true"
          className={`w-full flex flex-col items-center justify-end pb-[1px] leading-none ${
            isFirstRow ? 'h-[19px] sm:h-[21px]' : 'h-[9px] sm:h-[11px]'
          }`}
        >
          {isFirstRow && (
            <span
              className={`text-[5.5px] sm:text-[7.5px] font-bold tracking-tight leading-none mb-[1px] ${
                spec.colorName === 'BLACK'
                  ? 'bg-zinc-100 text-zinc-950 px-1 rounded-[2px]'
                  : ''
              }`}
              style={
                spec.colorName && spec.colorName !== 'BLACK'
                  ? { color: spec.colorNameHex }
                  : undefined
              }
            >
              {spec.colorName ?? '\u00A0'}
            </span>
          )}
          <span
            className={`text-center font-semibold leading-none tracking-tight ${
              spec.topKind === 'green'
                ? 'text-[6.5px] sm:text-[9px] text-[#34d399] whitespace-nowrap'
                : 'text-[5.5px] sm:text-[8px] text-zinc-100 whitespace-nowrap'
            }`}
          >
            {spec.topText ?? '\u00A0'}
          </span>
        </div>

        {/* Rubber keycap */}
        <button
          type="button"
          aria-label={spec.label}
          aria-pressed={isActive}
          onPointerDown={handlePointerDown}
          onPointerUp={onKeyUp}
          onPointerCancel={onKeyUp}
          className={`relative overflow-hidden w-full h-[43px] sm:h-[48px] rounded-md border flex flex-col items-center justify-center gap-[1.5px] sm:gap-[2px] pt-[6px] pb-[8px] px-0.5 sm:pt-[6px] sm:pb-[9px] sm:px-2 transition-transform duration-75 cursor-pointer bg-[#1a1c22] ${
            isEditPulse
              ? 'border-white/95 text-white'
              : isActive
              ? 'border-zinc-200 text-white translate-y-[1px]'
              : spec.id === 'SYMBOL'
              ? 'border-red-900/70 text-red-200'
              : spec.id === 'CAPS'
              ? 'border-zinc-500/60 text-zinc-100'
              : 'border-white/15 text-zinc-100'
          }`}
        >
          <img
            src={getControlAssetSrc(keycapRubberImg)}
            alt=""
            aria-hidden="true"
            draggable={false}
            decoding="sync"
            referrerPolicy="no-referrer"
            className="pointer-events-none select-none absolute inset-0 w-full h-full object-fill scale-x-[1.28] scale-y-[1.31] opacity-95"
          />
          {spec.id === 'SYMBOL' && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-red-950/40"
            />
          )}
          {isActive && !isEditPulse && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-white/15"
            />
          )}
          {isEditPulse && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[5px] border-2 border-white bg-white/30 animate-keycap-edit-pulse"
            />
          )}

          {isLetterKey ? (
            <>
              <span className="relative z-10 text-[6.5px] sm:text-[8px] font-semibold text-[#ff6b6b] truncate max-w-full leading-none tracking-tight zx-text-shadow">
                {spec.symbol ?? '\u00A0'}
              </span>
              <span className="relative z-10 text-[11px] sm:text-[13.5px] font-bold leading-none zx-text-shadow">
                {spec.label}
              </span>
              <span className="relative z-10 text-[5.5px] sm:text-[7px] font-semibold text-zinc-200 truncate max-w-full leading-none tracking-tighter zx-text-shadow">
                {spec.keyword ?? '\u00A0'}
              </span>
            </>
          ) : spec.subLabel ? (
            <div className="relative z-10 w-full h-full flex flex-col items-center justify-center gap-0.5 leading-none zx-text-shadow">
              {spec.id === 'SPACE' ? (
                <>
                  <span className="text-[6px] sm:text-[7.5px] font-semibold text-zinc-200 tracking-tight">
                    {spec.subLabel}
                  </span>
                  <span className="text-[9px] sm:text-[10.5px] font-bold tracking-tight">
                    {spec.label}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-[6.5px] sm:text-[9px] font-bold tracking-tighter">
                    {spec.label}
                  </span>
                  <span className="text-[6px] sm:text-[8px] font-semibold tracking-tight">
                    {spec.subLabel}
                  </span>
                </>
              )}
            </div>
          ) : spec.id === 'ENTER' ? (
            <div className="relative z-10 w-full h-full flex items-center justify-center leading-none zx-text-shadow">
              <span className="text-[8px] sm:text-[10px] font-bold tracking-tight">
                {spec.label}
              </span>
            </div>
          ) : (
            <div className="relative z-10 w-full h-full flex items-center justify-center gap-0.5 sm:gap-1 leading-none zx-text-shadow">
              <span className="text-[11.5px] sm:text-[13.5px] font-bold">
                {spec.label}
              </span>
              {spec.symbol && (
                <span className="text-[8.5px] sm:text-[10px] font-semibold text-[#ff6b6b] leading-none">
                  {spec.symbol}
                </span>
              )}
            </div>
          )}
        </button>

        {/* Red Extended+Symbol legend BELOW the keycap */}
        <div
          aria-hidden="true"
          className="w-full h-[9px] sm:h-[11px] flex items-start justify-center pt-[1px] leading-none"
        >
          <span className="text-[6px] sm:text-[8.5px] font-semibold text-[#ff5252] tracking-tight whitespace-nowrap leading-none">
            {spec.bottomText ?? '\u00A0'}
          </span>
        </div>
      </div>
    );
  }
);

export const CONTROL_BG_STYLE: React.CSSProperties = {
  backgroundImage: `linear-gradient(rgba(14, 16, 20, 0.91), rgba(14, 16, 20, 0.93)), url(${controlBg})`,
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  backgroundRepeat: 'no-repeat',
};

const CONTROL_AREA_STYLE: React.CSSProperties = {
  touchAction: 'none',
  ...CONTROL_BG_STYLE,
};

const CONTROL_AREA_TRANSPARENT_STYLE: React.CSSProperties = {
  touchAction: 'none',
};

function triggerHaptic(ms = 10): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate(ms);
  } catch {
    // Ignore if blocked before user gesture
  }
}

function preventDefaultEvent(e: React.SyntheticEvent): void {
  e.preventDefault();
}

export const SpectrumKeyboard: React.FC<SpectrumKeyboardProps> = React.memo(({
  keyboard,
  onUnlockAudio,
  transparentBackground = false,
  activeGameKey = null,
  fallbackGameKey = null,
  activeGameLabel = null,
  joystickMode = 'kempston',
}) => {
  const [padMode, setPadMode] = useState<'qwerty' | 'gamepad' | 'mouse'>('qwerty');
  const [gamepadType, setGamepadType] = useState<'stick' | 'dpad'>('stick');
  const [pressedIds, setPressedIds] = useState<Set<string>>(() => new Set());
  const [dpadMask, setDpadMask] = useState(0);
  const [, setAssetsDecoded] = useState(graphicsReady);

  const normalizedGameKey = normalizeGameMappingKey(activeGameKey);
  const normalizedFallbackKey = normalizeGameMappingKey(fallbackGameKey);

  const [sessionTopRowOverride, setSessionTopRowOverride] = useState<string[] | null>(null);
  const [activeTopRowIds, setActiveTopRowIds] = useState<string[]>(() =>
    resolveTopRowIds(normalizedGameKey, null, normalizedFallbackKey)
  );
  const [isEditingTopRow, setIsEditingTopRow] = useState(false);
  const [draftTopRowIds, setDraftTopRowIds] = useState<string[]>(() => [...DEFAULT_TOP_ROW_IDS]);
  const [pickingSlotIndex, setPickingSlotIndex] = useState<number | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);

  const gearMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (graphicsReady) return;
    const onReady = () => setAssetsDecoded(true);
    readyListeners.add(onReady);
    return () => {
      readyListeners.delete(onReady);
    };
  }, []);

  useEffect(() => {
    setSessionTopRowOverride(null);
    setActiveTopRowIds(resolveTopRowIds(normalizedGameKey, null, normalizedFallbackKey));
    setIsEditingTopRow(false);
    setPickingSlotIndex(null);
    setSaveMenuOpen(false);
  }, [normalizedGameKey, normalizedFallbackKey]);

  useEffect(() => {
    if (!saveMenuOpen && pickingSlotIndex === null) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (saveMenuOpen && gearMenuRef.current && !gearMenuRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false);
      }
    };
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickingSlotIndex !== null) {
          setPickingSlotIndex(null);
        } else if (saveMenuOpen) {
          setSaveMenuOpen(false);
        }
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onDocKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onDocKeyDown);
    };
  }, [saveMenuOpen, pickingSlotIndex]);

  const sectionRef = useRef<HTMLElement | null>(null);
  // Track pointerId -> pressed buttonId for crisp visual pressed state
  const activePointers = useRef(new Map<number, string>());

  // Virtual stick refs (direct transform updates avoid React re-renders per pointermove)
  const stickBaseRef = useRef<HTMLDivElement | null>(null);
  const stickKnobRef = useRef<HTMLDivElement | null>(null);
  const stickPointerIdRef = useRef<number | null>(null);
  const stickCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const stickMaskRef = useRef(0);

  // Continuous D-Pad tracking refs (only re-renders when 4-bit direction mask changes)
  const dpadBaseRef = useRef<HTMLDivElement | null>(null);
  const dpadPointerIdRef = useRef<number | null>(null);
  const dpadCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dpadMaskRef = useRef(0);

  // Laptop-style Kempston touchpad refs (direct DOM transform avoids React re-renders during drag)
  const touchpadRef = useRef<HTMLDivElement | null>(null);
  const touchpadGlowRef = useRef<HTMLDivElement | null>(null);
  const touchpadPointerIdRef = useRef<number | null>(null);
  const touchpadLastPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const touchpadDownMetaRef = useRef<{ time: number; travel: number }>({ time: 0, travel: 0 });

  const applyStickMask = useCallback(
    (nextMask: number) => {
      const prevMask = stickMaskRef.current;
      if (prevMask === nextMask) return;
      stickMaskRef.current = nextMask;
      keyboard.setContinuousPadMask(nextMask);
      if ((nextMask & ~prevMask) !== 0) {
        triggerHaptic(6);
      }
    },
    [keyboard]
  );

  const applyDpadMask = useCallback(
    (nextMask: number) => {
      const prevMask = dpadMaskRef.current;
      if (prevMask === nextMask) return;
      dpadMaskRef.current = nextMask;
      keyboard.setContinuousPadMask(nextMask);
      if ((nextMask & ~prevMask) !== 0) {
        triggerHaptic(7);
      }
      setDpadMask(nextMask);
    },
    [keyboard]
  );

  const resetStick = useCallback(() => {
    stickPointerIdRef.current = null;
    applyStickMask(0);
    if (stickKnobRef.current) {
      stickKnobRef.current.style.transform = 'translate3d(0px, 0px, 0px)';
    }
  }, [applyStickMask]);

  const resetDpad = useCallback(() => {
    dpadPointerIdRef.current = null;
    applyDpadMask(0);
  }, [applyDpadMask]);

  const resetTouchpad = useCallback(() => {
    touchpadPointerIdRef.current = null;
    if (touchpadGlowRef.current) {
      touchpadGlowRef.current.style.opacity = '0';
    }
  }, []);

  const syncPressedState = useCallback(() => {
    setPressedIds((prev) => {
      const ptrs = activePointers.current;
      if (ptrs.size === 0) {
        return prev.size === 0 ? prev : new Set();
      }
      const next = new Set<string>();
      for (const buttonId of ptrs.values()) {
        next.add(buttonId);
      }
      if (next.size === prev.size) {
        let same = true;
        for (const id of next) {
          if (!prev.has(id)) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  const releasePointerById = useCallback(
    (pointerId: number) => {
      if (!activePointers.current.has(pointerId)) return;
      activePointers.current.delete(pointerId);
      keyboard.releaseVirtualButton(pointerId);
      syncPressedState();
    },
    [keyboard, syncPressedState]
  );

  const releaseAllPointers = useCallback(() => {
    if (activePointers.current.size > 0) {
      activePointers.current.clear();
      setPressedIds(new Set());
    }
    resetStick();
    resetDpad();
    resetTouchpad();
    keyboard.releaseAllVirtual();
  }, [keyboard, resetDpad, resetStick, resetTouchpad]);

  // Ensure stick / dpad / touchpad / buttons release cleanly if user switches mode
  useEffect(() => {
    if (activePointers.current.size > 0) {
      activePointers.current.clear();
      setPressedIds(new Set());
      keyboard.releaseAllVirtual();
    }
    if (padMode !== 'gamepad' || gamepadType !== 'stick') {
      resetStick();
    }
    if (padMode !== 'gamepad' || gamepadType !== 'dpad') {
      resetDpad();
    }
    if (padMode !== 'mouse') {
      resetTouchpad();
    }
    if (padMode === 'qwerty') {
      setIsEditingTopRow(false);
      setPickingSlotIndex(null);
      setSaveMenuOpen(false);
    }
  }, [padMode, gamepadType, keyboard, resetStick, resetDpad, resetTouchpad]);

  const updateStickFromClientPos = useCallback(
    (clientX: number, clientY: number) => {
      let dx = clientX - stickCenterRef.current.x;
      let dy = clientY - stickCenterRef.current.y;
      const dist = Math.hypot(dx, dy);
      if (dist > STICK_MAX_R) {
        const scale = STICK_MAX_R / dist;
        dx *= scale;
        dy *= scale;
      }

      if (stickKnobRef.current) {
        stickKnobRef.current.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0px)`;
      }

      applyStickMask(computeDpadMask(dx, dy, STICK_DEADZONE));
    },
    [applyStickMask]
  );

  // Global pointermove/pointerup/pointercancel/blur safety net ensures Stick/D-Pad never lose tracking or stick
  useEffect(() => {
    const onWindowPointerMove = (e: PointerEvent) => {
      if (stickPointerIdRef.current === e.pointerId) {
        updateStickFromClientPos(e.clientX, e.clientY);
      } else if (dpadPointerIdRef.current === e.pointerId) {
        applyDpadMask(
          computeDpadMask(
            e.clientX - dpadCenterRef.current.x,
            e.clientY - dpadCenterRef.current.y,
            DPAD_DEADZONE
          )
        );
      }
    };
    const onWindowPointerUp = (e: PointerEvent) => {
      if (activePointers.current.has(e.pointerId)) {
        releasePointerById(e.pointerId);
      }
      if (stickPointerIdRef.current === e.pointerId) {
        resetStick();
      }
      if (dpadPointerIdRef.current === e.pointerId) {
        resetDpad();
      }
      if (touchpadPointerIdRef.current === e.pointerId) {
        resetTouchpad();
      }
    };
    const onWindowBlur = () => {
      releaseAllPointers();
    };
    const onVisibility = () => {
      if (document.hidden) {
        releaseAllPointers();
      }
    };

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [applyDpadMask, releaseAllPointers, releasePointerById, resetDpad, resetStick, resetTouchpad, updateStickFromClientPos]);

  // Suppress native browser long-press gesture & system vibration on touch screens
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const blockBrowserLongPress = (e: Event) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchstart', blockBrowserLongPress, { passive: false });
    el.addEventListener('contextmenu', blockBrowserLongPress, { passive: false });
    return () => {
      el.removeEventListener('touchstart', blockBrowserLongPress);
      el.removeEventListener('contextmenu', blockBrowserLongPress);
    };
  }, []);

  const handleStickDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      onUnlockAudio();
      if (stickPointerIdRef.current !== null && stickPointerIdRef.current !== e.pointerId) {
        resetStick();
      }
      triggerHaptic(8);
      const base = stickBaseRef.current;
      if (!base) return;
      const rect = base.getBoundingClientRect();
      stickCenterRef.current = {
        x: rect.left + rect.width * 0.5,
        y: rect.top + rect.height * 0.5,
      };
      stickPointerIdRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Window pointermove fallback still tracks if capture is unsupported
      }
      updateStickFromClientPos(e.clientX, e.clientY);
    },
    [onUnlockAudio, resetStick, updateStickFromClientPos]
  );

  const handleStickMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (stickPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      updateStickFromClientPos(e.clientX, e.clientY);
    },
    [updateStickFromClientPos]
  );

  const handleStickUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (stickPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      resetStick();
    },
    [resetStick]
  );

  const pressVirtualButton = useCallback(
    (
      e: React.PointerEvent<HTMLButtonElement>,
      buttonId: string,
      keys: readonly string[],
      hapticMs: number,
      kempstonBit?: number,
      mouseButton?: 0 | 1 | 2
    ) => {
      e.preventDefault();
      onUnlockAudio();
      triggerHaptic(hapticMs);
      if (activePointers.current.has(e.pointerId)) {
        releasePointerById(e.pointerId);
      }

      activePointers.current.set(e.pointerId, buttonId);
      keyboard.pressVirtualButton(e.pointerId, buttonId, keys, kempstonBit, mouseButton);
      syncPressedState();
    },
    [keyboard, onUnlockAudio, releasePointerById, syncPressedState]
  );

  const releaseVirtualButton = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      releasePointerById(e.pointerId);
    },
    [releasePointerById]
  );

  const handleArrowDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const idxAttr = e.currentTarget.dataset.arrowIdx;
      const idx = idxAttr !== undefined ? Number(idxAttr) : -1;
      const arrow = ARROW_BUTTONS[idx];
      if (!arrow) return;
      pressVirtualButton(e, arrow.id, arrow.keys, 9);
    },
    [pressVirtualButton]
  );

  const handlePadEnterDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => pressVirtualButton(e, 'PAD_ENTER', ENTER_KEYS, 12),
    [pressVirtualButton]
  );

  const handlePadSpaceDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => pressVirtualButton(e, 'PAD_SPACE', SPACE_KEYS, 12),
    [pressVirtualButton]
  );

  const handlePadFireDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) =>
      joystickMode === 'qaop'
        ? pressVirtualButton(e, 'PAD_FIRE', SPACE_KEYS, 14)
        : pressVirtualButton(e, 'PAD_FIRE', EMPTY_KEYS, 14, 4),
    [joystickMode, pressVirtualButton]
  );

  const handleMouseLeftDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) =>
      pressVirtualButton(e, 'MOUSE_LEFT', EMPTY_KEYS, 10, undefined, 0),
    [pressVirtualButton]
  );

  const handleMouseRightDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) =>
      pressVirtualButton(e, 'MOUSE_RIGHT', EMPTY_KEYS, 10, undefined, 1),
    [pressVirtualButton]
  );

  const handleKeyDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, spec: SpectrumKeySpec) => {
      const keys = SINGLE_KEY_TUPLES.get(spec.id) ?? [spec.id];
      const hapticMs = spec.isShift || spec.id === 'ENTER' || spec.id === 'SPACE' ? 12 : 9;
      pressVirtualButton(e, spec.id, keys, hapticMs);
    },
    [pressVirtualButton]
  );

  const handleKeyUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      releaseVirtualButton(e);
    },
    [releaseVirtualButton]
  );

  const handleTopRowKeyDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, spec: SpectrumKeySpec, slotIndex?: number) => {
      if (isEditingTopRow) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        if (slotIndex === undefined) return;
        triggerHaptic(8);
        setSaveMenuOpen(false);
        setPickingSlotIndex(slotIndex);
        return;
      }
      const keys = SINGLE_KEY_TUPLES.get(spec.id) ?? [spec.id];
      const hapticMs = spec.isShift || spec.id === 'ENTER' || spec.id === 'SPACE' ? 12 : 9;
      const buttonId = slotIndex !== undefined ? `TOP_${slotIndex}` : spec.id;
      pressVirtualButton(e, buttonId, keys, hapticMs);
    },
    [isEditingTopRow, pressVirtualButton]
  );

  const handlePickKeyDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, spec: SpectrumKeySpec) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      triggerHaptic(10);
      setDraftTopRowIds((prev) => {
        if (pickingSlotIndex === null || pickingSlotIndex < 0 || pickingSlotIndex >= prev.length) {
          return prev;
        }
        const next = [...prev];
        next[pickingSlotIndex] = spec.id;
        return next;
      });
      setPickingSlotIndex(null);
    },
    [pickingSlotIndex]
  );

  const handlePickKeyUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
  }, []);

  const handleGearPress = useCallback(() => {
    if (!isEditingTopRow) {
      setDraftTopRowIds([...activeTopRowIds]);
      setIsEditingTopRow(true);
      setSaveMenuOpen(false);
      setPickingSlotIndex(null);
    } else {
      setSaveMenuOpen((o) => !o);
    }
  }, [isEditingTopRow, activeTopRowIds]);

  const handleApplyGlobal = useCallback(() => {
    saveGlobalTopRowIds(draftTopRowIds);
    if (normalizedGameKey || normalizedFallbackKey) {
      clearGameTopRowIds(normalizedGameKey ?? '', normalizedFallbackKey);
    }
    setSessionTopRowOverride(null);
    setActiveTopRowIds([...draftTopRowIds]);
    setSaveMenuOpen(false);
    setIsEditingTopRow(false);
    setPickingSlotIndex(null);
  }, [draftTopRowIds, normalizedGameKey, normalizedFallbackKey]);

  const handleApplyForGame = useCallback(() => {
    if (normalizedGameKey) {
      saveGameTopRowIds(normalizedGameKey, draftTopRowIds, normalizedFallbackKey);
    } else if (normalizedFallbackKey) {
      saveGameTopRowIds(normalizedFallbackKey, draftTopRowIds);
    } else {
      setSessionTopRowOverride([...draftTopRowIds]);
    }
    setActiveTopRowIds([...draftTopRowIds]);
    setSaveMenuOpen(false);
    setIsEditingTopRow(false);
    setPickingSlotIndex(null);
  }, [draftTopRowIds, normalizedGameKey, normalizedFallbackKey]);

  const handleExitEditMode = useCallback(() => {
    setSaveMenuOpen(false);
    setIsEditingTopRow(false);
    setPickingSlotIndex(null);
    setDraftTopRowIds([...activeTopRowIds]);
  }, [activeTopRowIds]);

  const displayedTopIds = isEditingTopRow ? draftTopRowIds : activeTopRowIds;

  // Continuous single-surface D-Pad handlers allow sliding finger across directions seamlessly
  const handleDpadDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      onUnlockAudio();
      if (dpadPointerIdRef.current !== null) return;
      const base = dpadBaseRef.current;
      if (!base) return;
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width * 0.5;
      const cy = rect.top + rect.height * 0.5;
      dpadCenterRef.current = { x: cx, y: cy };
      dpadPointerIdRef.current = e.pointerId;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if unsupported
      }
      applyDpadMask(computeDpadMask(e.clientX - cx, e.clientY - cy, DPAD_DEADZONE));
    },
    [applyDpadMask, onUnlockAudio]
  );

  const handleDpadMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dpadPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const mask = computeDpadMask(
        e.clientX - dpadCenterRef.current.x,
        e.clientY - dpadCenterRef.current.y,
        DPAD_DEADZONE
      );
      applyDpadMask(mask);
    },
    [applyDpadMask]
  );

  const handleDpadUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dpadPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      resetDpad();
    },
    [resetDpad]
  );

  // Laptop-style relative Kempston touchpad handlers (supports multi-touch drag + tap-to-click)
  const updateTouchpadGlow = useCallback((clientX: number, clientY: number, visible: boolean) => {
    const glow = touchpadGlowRef.current;
    const pad = touchpadRef.current;
    if (!glow || !pad) return;
    if (!visible) {
      glow.style.opacity = '0';
      return;
    }
    const rect = pad.getBoundingClientRect();
    const lx = clientX - rect.left - 36;
    const ly = clientY - rect.top - 36;
    glow.style.transform = `translate3d(${lx.toFixed(1)}px, ${ly.toFixed(1)}px, 0px)`;
    glow.style.opacity = '1';
  }, []);

  const handleTouchpadDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      onUnlockAudio();
      if (touchpadPointerIdRef.current !== null) return;
      touchpadPointerIdRef.current = e.pointerId;
      touchpadLastPosRef.current = { x: e.clientX, y: e.clientY };
      touchpadDownMetaRef.current = { time: performance.now(), travel: 0 };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if unsupported
      }
      updateTouchpadGlow(e.clientX, e.clientY, true);
    },
    [onUnlockAudio, updateTouchpadGlow]
  );

  const handleTouchpadMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (touchpadPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      const dx = e.clientX - touchpadLastPosRef.current.x;
      const dy = e.clientY - touchpadLastPosRef.current.y;
      touchpadLastPosRef.current = { x: e.clientX, y: e.clientY };
      touchpadDownMetaRef.current.travel += Math.abs(dx) + Math.abs(dy);
      if (dx !== 0 || dy !== 0) {
        keyboard.moveKempstonMouse(dx * TOUCHPAD_SENSITIVITY, dy * TOUCHPAD_SENSITIVITY);
      }
      updateTouchpadGlow(e.clientX, e.clientY, true);
    },
    [keyboard, updateTouchpadGlow]
  );

  const handleTouchpadUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (touchpadPointerIdRef.current !== e.pointerId) return;
      e.preventDefault();
      const elapsed = performance.now() - touchpadDownMetaRef.current.time;
      const travel = touchpadDownMetaRef.current.travel;
      resetTouchpad();
      if (e.type !== 'pointercancel' && elapsed < 220 && travel < 8) {
        triggerHaptic(9);
        keyboard.pressVirtualButton(e.pointerId, 'TOUCHPAD_TAP', EMPTY_KEYS, undefined, 0);
        keyboard.releaseVirtualButton(e.pointerId);
      }
    },
    [keyboard, resetTouchpad]
  );

  return (
    <section
      ref={sectionRef}
      aria-label="Клавиатура ZX Spectrum"
      className={`control-surface flex-1 sm:flex-none w-full ${
        transparentBackground ? 'bg-transparent' : 'bg-[#13151a]'
      } border-t border-white/10 flex flex-col justify-start gap-2 px-1.5 pt-2 pb-[max(8px,env(safe-area-inset-bottom))] select-none touch-none`}
      style={transparentBackground ? CONTROL_AREA_TRANSPARENT_STYLE : CONTROL_AREA_STYLE}
      onContextMenu={preventDefaultEvent}
      onDragStart={preventDefaultEvent}
    >
      {/* Compact utility strip above keys */}
      <div className="w-full max-w-4xl mx-auto flex items-center justify-between gap-2 px-0.5 shrink-0">
        {pickingSlotIndex !== null ? (
          <>
            <span className="text-xs font-medium text-zinc-200 truncate">
              Кнопка {pickingSlotIndex + 1} («
              {KEY_SPEC_BY_ID.get(draftTopRowIds[pickingSlotIndex])?.label ?? ''}»): выберите новую клавишу
            </span>
            <button
              type="button"
              onPointerDown={(e) => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                e.preventDefault();
                triggerHaptic(8);
                setPickingSlotIndex(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setPickingSlotIndex(null);
                }
              }}
              className="h-8 px-2.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 cursor-pointer shrink-0"
            >
              Отмена
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return;
                  e.preventDefault();
                  triggerHaptic(8);
                  setPadMode('qwerty');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPadMode('qwerty');
                  }
                }}
                className={`h-8 px-2.5 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                  padMode === 'qwerty'
                    ? 'bg-zinc-700 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Keyboard className="w-3.5 h-3.5" />
                <span>QWERTY</span>
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return;
                  e.preventDefault();
                  triggerHaptic(8);
                  setPadMode('gamepad');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPadMode('gamepad');
                  }
                }}
                className={`h-8 px-2.5 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                  padMode === 'gamepad'
                    ? 'bg-zinc-700 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Gamepad2 className="w-3.5 h-3.5" />
                <span>Джойстик</span>
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return;
                  e.preventDefault();
                  triggerHaptic(8);
                  setPadMode('mouse');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPadMode('mouse');
                  }
                }}
                className={`h-8 px-2.5 rounded-md text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                  padMode === 'mouse'
                    ? 'bg-zinc-700 text-white'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Mouse className="w-3.5 h-3.5" />
                <span>Мышь</span>
              </button>
            </div>

            {padMode !== 'qwerty' && (
              <div ref={gearMenuRef} className="relative shrink-0">
                <button
                  type="button"
                  data-testid="top-row-edit-btn"
                  aria-label={
                    isEditingTopRow
                      ? 'Сохранить раскладку верхнего ряда'
                      : 'Настроить верхний ряд кнопок'
                  }
                  aria-expanded={isEditingTopRow ? saveMenuOpen : undefined}
                  aria-pressed={isEditingTopRow}
                  onPointerDown={(e) => {
                    if (e.pointerType === 'mouse' && e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    triggerHaptic(8);
                    handleGearPress();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleGearPress();
                    }
                  }}
                  className={`h-8 w-8 rounded-md flex items-center justify-center transition-colors cursor-pointer ${
                    isEditingTopRow
                      ? 'bg-white text-zinc-950 shadow-[0_0_10px_rgba(255,255,255,0.45)]'
                      : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Settings className="w-4 h-4" />
                </button>

                {isEditingTopRow && saveMenuOpen && (
                  <div
                    role="menu"
                    data-testid="top-row-save-menu"
                    aria-label="Применить раскладку"
                    className="absolute right-0 top-full mt-1.5 w-44 bg-[#1a1d24] border border-white/15 rounded-xl shadow-2xl p-1 z-50 space-y-0.5"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onPointerDown={(e) => {
                        if (e.pointerType === 'mouse' && e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        triggerHaptic(10);
                        handleApplyGlobal();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleApplyGlobal();
                        }
                      }}
                      className="w-full px-2.5 py-2 rounded-lg text-left text-xs font-medium text-zinc-100 hover:bg-zinc-800 active:bg-zinc-700 transition-colors cursor-pointer"
                    >
                      Для всего
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onPointerDown={(e) => {
                        if (e.pointerType === 'mouse' && e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        triggerHaptic(10);
                        handleApplyForGame();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleApplyForGame();
                        }
                      }}
                      className="w-full px-2.5 py-2 rounded-lg text-left text-xs font-medium text-zinc-100 hover:bg-zinc-800 active:bg-zinc-700 transition-colors cursor-pointer"
                    >
                      <span className="block">
                        {isReleaseScopedGameKey(normalizedGameKey)
                          ? 'Для этой версии'
                          : 'Для этой игры'}
                      </span>
                      {activeGameLabel && (
                        <span className="block text-[10px] text-zinc-400 truncate mt-0.5">
                          {activeGameLabel}
                        </span>
                      )}
                    </button>
                    <div className="my-0.5 border-t border-white/10" />
                    <button
                      type="button"
                      role="menuitem"
                      onPointerDown={(e) => {
                        if (e.pointerType === 'mouse' && e.button !== 0) return;
                        e.preventDefault();
                        e.stopPropagation();
                        triggerHaptic(8);
                        handleExitEditMode();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleExitEditMode();
                        }
                      }}
                      className="w-full px-2.5 py-2 rounded-lg text-left text-xs font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 active:bg-zinc-700 transition-colors cursor-pointer"
                    >
                      Выйти
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {pickingSlotIndex !== null ? (
        <div
          key="top-row-key-picker"
          data-testid="top-row-key-picker"
          className="w-full max-w-4xl mx-auto flex-1 flex flex-col justify-center gap-1.5 min-h-0"
        >
          {SPECTRUM_KEYS.map((row, rIdx) => (
            <div key={rIdx} className="flex items-stretch gap-1 shrink-0">
              {row.map((spec) => (
                <SpectrumKeyCell
                  key={spec.id}
                  spec={spec}
                  isFirstRow={rIdx === 0}
                  isActive={draftTopRowIds[pickingSlotIndex] === spec.id}
                  onKeyDown={handlePickKeyDown}
                  onKeyUp={handlePickKeyUp}
                />
              ))}
            </div>
          ))}
        </div>
      ) : padMode === 'qwerty' ? (
        <div
          key="pad-mode-qwerty"
          className="w-full max-w-4xl mx-auto flex-1 flex flex-col justify-center gap-1.5 min-h-0"
        >
          {SPECTRUM_KEYS.map((row, rIdx) => (
            <div key={rIdx} className="flex items-stretch gap-1 shrink-0">
              {row.map((spec) => (
                <SpectrumKeyCell
                  key={spec.id}
                  spec={spec}
                  isFirstRow={rIdx === 0}
                  isActive={pressedIds.has(spec.id)}
                  onKeyDown={handleKeyDown}
                  onKeyUp={handleKeyUp}
                />
              ))}
            </div>
          ))}

          {/* Dedicated cursor arrows row (Shift + 5..8) */}
          <div className="h-[36px] sm:h-[38px] flex items-stretch gap-1.5 shrink-0 pt-0.5">
            {ARROW_BUTTONS.map((arrow, arrowIdx) => {
              const isActive = pressedIds.has(arrow.id);
              const ArrowIcon = arrow.Icon;
              return (
                <button
                  key={arrow.id}
                  type="button"
                  data-arrow-idx={arrowIdx}
                  aria-label={arrow.ariaLabel}
                  aria-pressed={isActive}
                  onPointerDown={handleArrowDown}
                  onPointerUp={releaseVirtualButton}
                  onPointerCancel={releaseVirtualButton}
                  className={`relative overflow-hidden flex-1 rounded-md border flex items-center justify-center pt-[3px] pb-[5px] transition-transform duration-75 cursor-pointer bg-[#1a1c22] ${
                    isActive
                      ? 'border-zinc-200 text-white translate-y-[1px]'
                      : 'border-white/15 text-zinc-100'
                  }`}
                >
                  <img
                    src={getControlAssetSrc(keycapRubberImg)}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    decoding="sync"
                    referrerPolicy="no-referrer"
                    className="pointer-events-none select-none absolute inset-0 w-full h-full object-fill scale-x-[1.28] scale-y-[1.31] opacity-95"
                  />
                  {isActive && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-white/15"
                    />
                  )}
                  <ArrowIcon
                    aria-hidden="true"
                    className="relative z-10 w-4 h-4 stroke-[2.75]"
                  />
                </button>
              );
            })}
          </div>
        </div>
      ) : padMode === 'gamepad' ? (
        /* Ergonomic Mobile Arcade Joystick / D-Pad + Number Row + Fire */
        <div
          key="pad-mode-gamepad"
          className="w-full max-w-4xl mx-auto flex-1 flex flex-col justify-between gap-2 min-h-0"
        >
          {/* Top quick-access row */}
          <div className="flex items-stretch gap-1 shrink-0">
            {displayedTopIds.map((keyId, slotIdx) => {
              const spec = KEY_SPEC_BY_ID.get(keyId) ?? NUMBER_ROW[slotIdx];
              return (
                <SpectrumKeyCell
                  key={slotIdx}
                  spec={spec}
                  isFirstRow
                  uniformWidth
                  slotIndex={slotIdx}
                  isEditPulse={isEditingTopRow}
                  isActive={pressedIds.has(`TOP_${slotIdx}`)}
                  onKeyDown={handleTopRowKeyDown}
                  onKeyUp={handleKeyUp}
                />
              );
            })}
          </div>

          <div className="relative flex-1 flex items-center justify-between gap-3 px-2.5 py-1 min-h-0">
            {gamepadType === 'stick' ? (
              /* Authentic Kempston Stick */
              <div
                key="gamepad-stick-base"
                ref={stickBaseRef}
                data-testid="kempston-stick"
                onPointerDown={handleStickDown}
                onPointerMove={handleStickMove}
                onPointerUp={handleStickUp}
                onPointerCancel={handleStickUp}
                onLostPointerCapture={handleStickUp}
                className="relative w-44 h-44 rounded-full overflow-hidden bg-[#14161b] border border-white/15 shadow-2xl flex items-center justify-center touch-none cursor-grab active:cursor-grabbing shrink-0"
              >
                <img
                  src={getControlAssetSrc(joystickBaseImg)}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  loading="eager"
                  decoding="sync"
                  className="pointer-events-none select-none absolute inset-0 w-full h-full object-cover scale-[1.24]"
                />

                {/* Movable Kempston Stick Knob */}
                <div
                  ref={stickKnobRef}
                  className="pointer-events-none relative z-10 w-16 h-16 rounded-full overflow-hidden shadow-[0_8px_18px_rgba(0,0,0,0.85)] flex items-center justify-center will-change-transform"
                >
                  <img
                    src={getControlAssetSrc(joystickKnobImg)}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    loading="eager"
                    decoding="sync"
                    className="pointer-events-none select-none w-full h-full object-cover scale-[1.47]"
                  />
                </div>
              </div>
            ) : (
              /* Continuous 8-way D-Pad (supports sliding finger between directions + tactile visual feedback) */
              (() => {
                const dpadR = (dpadMask & 0x01) !== 0;
                const dpadL = (dpadMask & 0x02) !== 0;
                const dpadD = (dpadMask & 0x04) !== 0;
                const dpadU = (dpadMask & 0x08) !== 0;
                const tiltX = (dpadU ? 9 : 0) - (dpadD ? 9 : 0);
                const tiltY = (dpadR ? 9 : 0) - (dpadL ? 9 : 0);

                return (
                  <div
                    key="gamepad-dpad-base"
                    ref={dpadBaseRef}
                    data-testid="kempston-dpad"
                    data-dpad-mask={dpadMask}
                    role="group"
                    aria-label="Крестовина"
                    onPointerDown={handleDpadDown}
                    onPointerMove={handleDpadMove}
                    onPointerUp={handleDpadUp}
                    onPointerCancel={handleDpadUp}
                    onLostPointerCapture={handleDpadUp}
                    style={
                      dpadMask !== 0
                        ? {
                            transform: `perspective(320px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale(0.97)`,
                          }
                        : undefined
                    }
                    className="relative w-44 h-44 rounded-full overflow-hidden bg-[#14161b] border border-white/15 shadow-2xl touch-none cursor-pointer transition-transform duration-75 shrink-0"
                  >
                    <img
                      src={getControlAssetSrc(gamepadDpadImg)}
                      alt=""
                      aria-hidden="true"
                      draggable={false}
                      loading="eager"
                      decoding="sync"
                      className="pointer-events-none select-none absolute inset-0 w-full h-full object-cover scale-[1.66]"
                    />
                    {dpadU && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-[15%] left-1/2 -translate-x-1/2 w-[23%] h-[25%] rounded-t-lg bg-white/20 border border-zinc-200/80 shadow-[0_0_8px_rgba(255,255,255,0.28)]"
                      />
                    )}
                    {dpadD && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-[15%] left-1/2 -translate-x-1/2 w-[23%] h-[25%] rounded-b-lg bg-white/20 border border-zinc-200/80 shadow-[0_0_8px_rgba(255,255,255,0.28)]"
                      />
                    )}
                    {dpadL && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-[15%] top-1/2 -translate-y-1/2 w-[25%] h-[23%] rounded-l-lg bg-white/20 border border-zinc-200/80 shadow-[0_0_8px_rgba(255,255,255,0.28)]"
                      />
                    )}
                    {dpadR && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute right-[15%] top-1/2 -translate-y-1/2 w-[25%] h-[23%] rounded-r-lg bg-white/20 border border-zinc-200/80 shadow-[0_0_8px_rgba(255,255,255,0.28)]"
                      />
                    )}
                  </div>
                );
              })()
            )}

            {/* Right column: ENTER/SPACE + Fire button + Stick/D-Pad toggle in bottom-right corner */}
            <div className="flex flex-col items-end justify-between self-stretch py-0.5 gap-1.5">
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  aria-label="ENTER"
                  aria-pressed={pressedIds.has('PAD_ENTER')}
                  onPointerDown={handlePadEnterDown}
                  onPointerUp={releaseVirtualButton}
                  onPointerCancel={releaseVirtualButton}
                  className={`relative overflow-hidden h-10 px-3.5 rounded-xl bg-[#1a1c22] border text-xs font-semibold transition-transform duration-75 cursor-pointer ${
                    pressedIds.has('PAD_ENTER')
                      ? 'translate-y-[1px] border-zinc-200 text-white'
                      : 'border-white/15 text-zinc-100'
                  }`}
                >
                  <img
                    src={getControlAssetSrc(keycapRubberImg)}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    loading="eager"
                    decoding="sync"
                    className="pointer-events-none select-none absolute inset-0 w-full h-full object-fill scale-x-[1.28] scale-y-[1.31] opacity-95"
                  />
                  {pressedIds.has('PAD_ENTER') && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-white/20"
                    />
                  )}
                  <span className="relative z-10 zx-text-shadow">
                    ENTER
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="SPACE"
                  aria-pressed={pressedIds.has('PAD_SPACE')}
                  onPointerDown={handlePadSpaceDown}
                  onPointerUp={releaseVirtualButton}
                  onPointerCancel={releaseVirtualButton}
                  className={`relative overflow-hidden h-10 px-3.5 rounded-xl bg-[#1a1c22] border text-xs font-semibold transition-transform duration-75 cursor-pointer ${
                    pressedIds.has('PAD_SPACE')
                      ? 'translate-y-[1px] border-zinc-200 text-white'
                      : 'border-white/15 text-zinc-100'
                  }`}
                >
                  <img
                    src={getControlAssetSrc(keycapRubberImg)}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    loading="eager"
                    decoding="sync"
                    referrerPolicy="no-referrer"
                    className="pointer-events-none select-none absolute inset-0 w-full h-full object-fill scale-x-[1.28] scale-y-[1.31] opacity-95"
                  />
                  {pressedIds.has('PAD_SPACE') && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-white/20"
                    />
                  )}
                  <span className="relative z-10 zx-text-shadow">
                    SPACE
                  </span>
                </button>
              </div>

              <button
                type="button"
                aria-label="FIRE"
                aria-pressed={pressedIds.has('PAD_FIRE')}
                onPointerDown={handlePadFireDown}
                onPointerUp={releaseVirtualButton}
                onPointerCancel={releaseVirtualButton}
                className={`relative overflow-hidden w-28 h-[74px] sm:h-20 rounded-2xl bg-[#14161b] border text-sm font-bold text-white transition-transform duration-75 cursor-pointer shrink-0 ${
                  pressedIds.has('PAD_FIRE')
                    ? 'translate-y-[2px] scale-[0.95] border-red-200/90 ring-2 ring-red-400/75 shadow-[0_0_18px_rgba(239,68,68,0.65)]'
                    : 'border-white/15 shadow-2xl'
                }`}
              >
                <img
                  src={getControlAssetSrc(gamepadFireBtnImg)}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  loading="eager"
                  decoding="sync"
                  className="pointer-events-none select-none absolute inset-0 w-full h-full object-cover scale-[1.64]"
                />
                {pressedIds.has('PAD_FIRE') && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-white/25"
                  />
                )}
                <span className="relative z-10 tracking-wider zx-fire-shadow">
                  FIRE
                </span>
              </button>

              <button
                type="button"
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return;
                  e.preventDefault();
                  triggerHaptic(8);
                  setGamepadType((t) => (t === 'stick' ? 'dpad' : 'stick'));
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setGamepadType((t) => (t === 'stick' ? 'dpad' : 'stick'));
                  }
                }}
                aria-label={gamepadType === 'stick' ? 'Переключить на крестовину' : 'Переключить на стик'}
                className="h-7 px-2.5 rounded-md bg-zinc-800/90 hover:bg-zinc-700 border border-white/10 text-[11px] font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer shrink-0"
              >
                {gamepadType === 'stick' ? (
                  <>
                    <Grid2X2 className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Крестовина</span>
                  </>
                ) : (
                  <>
                    <Joystick className="w-3.5 h-3.5 text-red-400" />
                    <span>Стик</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Laptop-style Kempston Mouse Touchpad + Number Row + 50/50 split LMB/RMB bottom buttons */
        <div
          key="pad-mode-mouse"
          className="w-full max-w-4xl mx-auto flex-1 flex flex-col gap-1.5 min-h-0"
        >
          {/* Top quick-access row */}
          <div className="flex items-stretch gap-1 shrink-0">
            {displayedTopIds.map((keyId, slotIdx) => {
              const spec = KEY_SPEC_BY_ID.get(keyId) ?? NUMBER_ROW[slotIdx];
              return (
                <SpectrumKeyCell
                  key={slotIdx}
                  spec={spec}
                  isFirstRow
                  uniformWidth
                  slotIndex={slotIdx}
                  isEditPulse={isEditingTopRow}
                  isActive={pressedIds.has(`TOP_${slotIdx}`)}
                  onKeyDown={handleTopRowKeyDown}
                  onKeyUp={handleKeyUp}
                />
              );
            })}
          </div>

          <div
            key="mouse-touchpad-surface"
            ref={touchpadRef}
            data-testid="kempston-touchpad"
            role="application"
            aria-label="Сенсорная панель Kempston мыши"
            onPointerDown={handleTouchpadDown}
            onPointerMove={handleTouchpadMove}
            onPointerUp={handleTouchpadUp}
            onPointerCancel={handleTouchpadUp}
            className="relative flex-1 min-h-[108px] w-full rounded-xl bg-white/[0.03] border border-white/20 shadow-[inset_0_1px_14px_rgba(0,0,0,0.45)] overflow-hidden touch-none cursor-crosshair"
          >
            <div
              key="mouse-touchpad-glow"
              ref={touchpadGlowRef}
              aria-hidden="true"
              className="pointer-events-none absolute top-0 left-0 w-[72px] h-[72px] rounded-full bg-white/20 blur-md opacity-0 transition-opacity duration-100 will-change-transform"
            />
          </div>

          <div className="-mx-1.5 sm:mx-0 w-[calc(100%+0.75rem)] sm:w-full p-[3px] rounded-xl bg-[#08090c] border border-white/10 shadow-[inset_0_2px_6px_rgba(0,0,0,0.95)] grid grid-cols-2 gap-[3px] shrink-0">
            <button
              type="button"
              aria-label="Левая кнопка мыши"
              aria-pressed={pressedIds.has('MOUSE_LEFT')}
              onPointerDown={handleMouseLeftDown}
              onPointerUp={releaseVirtualButton}
              onPointerCancel={releaseVirtualButton}
              className={`relative overflow-hidden w-full h-14 sm:h-16 rounded-l-[9px] rounded-r-[3px] border flex items-center justify-center text-xs font-semibold tracking-wider transition-transform duration-75 cursor-pointer bg-[#1a1c22] ${
                pressedIds.has('MOUSE_LEFT')
                  ? 'translate-y-[2.5px] scale-[0.97] border-black/85 text-zinc-300 shadow-[inset_0_6px_14px_rgba(0,0,0,0.94),inset_0_0_0_1px_rgba(0,0,0,0.7)]'
                  : 'border-white/15 text-zinc-100 shadow-[0_3px_5px_rgba(0,0,0,0.85),0_1px_0_rgba(255,255,255,0.08)]'
              }`}
            >
              <img
                src={getControlAssetSrc(mouseBtnRetroImg)}
                alt=""
                aria-hidden="true"
                draggable={false}
                loading="eager"
                decoding="sync"
                referrerPolicy="no-referrer"
                className={`pointer-events-none select-none absolute inset-0 w-full h-full object-fill scale-x-[1.35] scale-y-[1.60] transition-[filter] duration-75 ${
                  pressedIds.has('MOUSE_LEFT')
                    ? 'brightness-[0.72] contrast-[1.08]'
                    : 'opacity-95'
                }`}
              />
              {pressedIds.has('MOUSE_LEFT') && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-black/5 shadow-[inset_0_4px_10px_rgba(0,0,0,0.85)]"
                />
              )}
              <span className="relative z-10 zx-text-shadow">ЛКМ</span>
            </button>
            <button
              type="button"
              aria-label="Правая кнопка мыши"
              aria-pressed={pressedIds.has('MOUSE_RIGHT')}
              onPointerDown={handleMouseRightDown}
              onPointerUp={releaseVirtualButton}
              onPointerCancel={releaseVirtualButton}
              className={`relative overflow-hidden w-full h-14 sm:h-16 rounded-r-[9px] rounded-l-[3px] border flex items-center justify-center text-xs font-semibold tracking-wider transition-transform duration-75 cursor-pointer bg-[#1a1c22] ${
                pressedIds.has('MOUSE_RIGHT')
                  ? 'translate-y-[2.5px] scale-[0.97] border-black/85 text-zinc-300 shadow-[inset_0_6px_14px_rgba(0,0,0,0.94),inset_0_0_0_1px_rgba(0,0,0,0.7)]'
                  : 'border-white/15 text-zinc-100 shadow-[0_3px_5px_rgba(0,0,0,0.85),0_1px_0_rgba(255,255,255,0.08)]'
              }`}
            >
              <img
                src={getControlAssetSrc(mouseBtnRetroImg)}
                alt=""
                aria-hidden="true"
                draggable={false}
                loading="eager"
                decoding="sync"
                referrerPolicy="no-referrer"
                className={`pointer-events-none select-none absolute inset-0 w-full h-full object-fill -scale-x-[1.35] scale-y-[1.60] transition-[filter] duration-75 ${
                  pressedIds.has('MOUSE_RIGHT')
                    ? 'brightness-[0.72] contrast-[1.08]'
                    : 'opacity-95'
                }`}
              />
              {pressedIds.has('MOUSE_RIGHT') && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-black/20 to-black/5 shadow-[inset_0_4px_10px_rgba(0,0,0,0.85)]"
                />
              )}
              <span className="relative z-10 zx-text-shadow">ПКМ</span>
            </button>
          </div>
        </div>
      )}

      {/* Keep off-tab control textures decoded & resident in compositor GPU cache for 0ms tab switches */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed top-0 left-0 w-4 h-4 overflow-hidden opacity-[0.004] -z-50"
      >
        {PRELOAD_FG_ASSETS.map((src) => (
          <img
            key={src}
            src={getControlAssetSrc(src)}
            alt=""
            width={16}
            height={16}
            loading="eager"
            decoding="sync"
          />
        ))}
      </div>
    </section>
  );
});
