import React, { useCallback, useEffect, useRef } from 'react';
import { BorderMode, getBorderViewport } from '../emulator/spectrum';
import { ScreenScaleMode } from '../emulator/settingsStorage';
import {
  KeyboardMatrix,
  computeDesktopMouseAxisDelta,
  mapMouseButtonToKempstonBit,
} from '../emulator/keyboard';

interface SpectrumScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  keyboard: KeyboardMatrix;
  scanlines: boolean;
  borderMode: BorderMode;
  screenScale: ScreenScaleMode;
  paused: boolean;
  modalOpen: boolean;
  showKeyboard: boolean;
  statusBanner: string | null;
  onUnlockAudio: () => void;
}

export const SpectrumScreen: React.FC<SpectrumScreenProps> = React.memo(({
  canvasRef,
  keyboard,
  scanlines,
  borderMode,
  screenScale,
  paused,
  modalOpen,
  showKeyboard,
  statusBanner,
  onUnlockAudio,
}) => {
  const vp = getBorderViewport(borderMode);
  const inputBlocked = paused || modalOpen;

  const cssSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const heldButtonsMaskRef = useRef(0);
  const isLockedRef = useRef(false);

  // Cache rendered canvas CSS size on mount & resize (zero layout reads during pointermove)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const syncSize = () => {
      cssSizeRef.current.w = canvas.clientWidth;
      cssSizeRef.current.h = canvas.clientHeight;
    };
    syncSize();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(syncSize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [canvasRef, borderMode, screenScale, showKeyboard]);

  const releaseHeldMouseButtons = useCallback(() => {
    if (heldButtonsMaskRef.current !== 0) {
      heldButtonsMaskRef.current = 0;
      keyboard.releasePhysicalMouseButtons();
    }
  }, [keyboard]);

  // Exit pointer lock and release held mouse buttons when blocked
  useEffect(() => {
    if (!inputBlocked) return;
    releaseHeldMouseButtons();
    const canvas = canvasRef.current;
    if (canvas && typeof document !== 'undefined' && document.pointerLockElement === canvas) {
      try {
        document.exitPointerLock?.();
      } catch {
        // Ignore if unsupported
      }
    }
  }, [inputBlocked, canvasRef, releaseHeldMouseButtons]);

  // Keep pointer lock & off-canvas button releases in sync with zero polling
  useEffect(() => {
    const onPointerLockChange = () => {
      const canvas = canvasRef.current;
      isLockedRef.current =
        Boolean(canvas) &&
        typeof document !== 'undefined' &&
        document.pointerLockElement === canvas;
      if (!isLockedRef.current) {
        releaseHeldMouseButtons();
      }
    };

    const onWindowPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || heldButtonsMaskRef.current === 0) return;
      const bit = mapMouseButtonToKempstonBit(e.button);
      if (bit !== null && (heldButtonsMaskRef.current & (1 << bit)) !== 0) {
        heldButtonsMaskRef.current &= ~(1 << bit);
        keyboard.setKempstonMouseButton(bit, false);
      }
    };

    const onWindowBlur = () => {
      releaseHeldMouseButtons();
    };

    document.addEventListener('pointerlockchange', onPointerLockChange);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [canvasRef, keyboard, releaseHeldMouseButtons]);

  const handleCanvasPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType !== 'mouse' || inputBlocked) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const locked = isLockedRef.current || document.pointerLockElement === canvas;
      if (!locked) return;

      const rawDx = e.movementX;
      const rawDy = e.movementY;
      if (rawDx === 0 && rawDy === 0) return;

      const cssW = cssSizeRef.current.w || canvas.clientWidth || canvas.width;
      const cssH = cssSizeRef.current.h || canvas.clientHeight || canvas.height;
      const dx = computeDesktopMouseAxisDelta(rawDx, canvas.width, cssW);
      const dy = computeDesktopMouseAxisDelta(rawDy, canvas.height, cssH);
      if (dx !== 0 || dy !== 0) {
        keyboard.moveKempstonMouse(dx, dy);
      }
    },
    [canvasRef, inputBlocked, keyboard]
  );

  const handleCanvasPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      onUnlockAudio();
      if (e.pointerType !== 'mouse' || inputBlocked) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const locked = isLockedRef.current || document.pointerLockElement === canvas;
      if (!locked) {
        e.preventDefault();
        try {
          Promise.resolve(canvas.requestPointerLock?.()).catch(() => {});
        } catch {
          // Ignore unsupported Pointer Lock
        }
        return;
      }

      const bit = mapMouseButtonToKempstonBit(e.button);
      if (bit === null) return;
      e.preventDefault();
      heldButtonsMaskRef.current |= 1 << bit;
      keyboard.setKempstonMouseButton(bit, true);
    },
    [canvasRef, inputBlocked, keyboard, onUnlockAudio]
  );

  const handleCanvasPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType !== 'mouse') return;
      const bit = mapMouseButtonToKempstonBit(e.button);
      if (bit !== null && (heldButtonsMaskRef.current & (1 << bit)) !== 0) {
        heldButtonsMaskRef.current &= ~(1 << bit);
        keyboard.setKempstonMouseButton(bit, false);
      }
    },
    [keyboard]
  );

  const handleCanvasPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType !== 'mouse') return;
      releaseHeldMouseButtons();
    },
    [releaseHeldMouseButtons]
  );

  const handleCanvasContextMenu = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!inputBlocked) {
        e.preventDefault();
      }
    },
    [inputBlocked]
  );

  const handleCanvasWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      if (inputBlocked) return;
      if (!isLockedRef.current && document.pointerLockElement !== canvasRef.current) return;
      keyboard.scrollKempstonMouse(e.deltaY);
    },
    [canvasRef, inputBlocked, keyboard]
  );

  const outerClassName =
    screenScale === 'stretch'
      ? `relative flex items-stretch justify-center min-h-0 w-full p-0 ${
          showKeyboard ? 'flex-none sm:flex-1' : 'flex-1'
        }`
      : `relative flex items-center justify-center min-h-0 w-full ${
          showKeyboard ? 'flex-none sm:flex-1 px-0 sm:px-3 pt-0 sm:pt-2' : 'flex-1 p-2 sm:p-4'
        }`;

  const sizeBoxClassName =
    screenScale === 'stretch'
      ? 'w-full h-full flex items-stretch justify-center'
      : screenScale === 'aspect'
      ? showKeyboard
        ? 'w-full sm:h-full sm:[container-type:size] flex items-center justify-center'
        : 'w-full h-full [container-type:size] flex items-center justify-center'
      : 'w-full h-full flex items-center justify-center';

  const wrapperClassName =
    screenScale === 'stretch'
      ? `relative bg-black overflow-hidden w-full ${showKeyboard ? 'h-[38dvh] sm:h-full' : 'h-full'}`
      : screenScale === 'aspect'
      ? showKeyboard
        ? 'relative bg-black overflow-hidden shadow-2xl w-full aspect-[4/3] sm:aspect-auto sm:w-[min(100cqw,calc(100cqh*4/3))] sm:h-[min(100cqh,calc(100cqw*3/4))] sm:rounded-xl sm:border sm:border-white/10'
        : 'relative bg-black overflow-hidden shadow-2xl w-[min(100cqw,calc(100cqh*4/3))] h-[min(100cqh,calc(100cqw*3/4))] rounded-xl border border-white/10'
      : `relative bg-black overflow-hidden shadow-2xl ${
          showKeyboard
            ? 'w-full max-h-full aspect-[4/3] sm:w-auto sm:h-full sm:max-w-full sm:rounded-xl sm:border sm:border-white/10'
            : 'h-full max-w-full aspect-[4/3] rounded-xl border border-white/10'
        }`;

  const autoWrapperStyle =
    screenScale === 'auto' && !showKeyboard
      ? {
          maxHeight: '100%',
          width: 'min(100%, calc((100dvh - 48px - 32px) * 4 / 3))',
        }
      : undefined;

  return (
    <div className={outerClassName} onPointerDown={onUnlockAudio}>
      <div className={sizeBoxClassName}>
        <div className={wrapperClassName} style={autoWrapperStyle}>
          <canvas
            ref={canvasRef}
            width={vp.width}
            height={vp.height}
            data-testid="spectrum-screen"
            data-border-mode={borderMode}
            data-scale-mode={screenScale}
            onPointerMove={handleCanvasPointerMove}
            onPointerDown={handleCanvasPointerDown}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerCancel}
            onContextMenu={handleCanvasContextMenu}
            onWheel={handleCanvasWheel}
            className="w-full h-full block pixelated [contain:layout_paint] cursor-crosshair"
          />

          {scanlines && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 crt-scanlines opacity-50"
            />
          )}

          {paused && (
            <div className="pointer-events-none absolute inset-0 bg-black/55 flex items-center justify-center">
              <span className="px-4 py-1.5 rounded-lg bg-zinc-900/95 border border-white/15 text-xs font-mono tracking-wider text-zinc-100">
                ПАУЗА
              </span>
            </div>
          )}

          {statusBanner && (
            <div
              role="status"
              className="pointer-events-none absolute bottom-2.5 left-1/2 -translate-x-1/2 px-3 py-1 rounded-md bg-zinc-950/90 border border-white/15 text-[11px] font-medium text-zinc-200 whitespace-nowrap shadow-lg"
            >
              {statusBanner}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
