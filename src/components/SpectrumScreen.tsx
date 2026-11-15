import React from 'react';
import { BorderMode, getBorderViewport } from '../emulator/spectrum';
import { ScreenScaleMode } from '../emulator/settingsStorage';

interface SpectrumScreenProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  scanlines: boolean;
  borderMode: BorderMode;
  screenScale: ScreenScaleMode;
  paused: boolean;
  showKeyboard: boolean;
  statusBanner: string | null;
  onUnlockAudio: () => void;
}

export const SpectrumScreen: React.FC<SpectrumScreenProps> = React.memo(({
  canvasRef,
  scanlines,
  borderMode,
  screenScale,
  paused,
  showKeyboard,
  statusBanner,
  onUnlockAudio,
}) => {
  const vp = getBorderViewport(borderMode);

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
            className="w-full h-full block pixelated [contain:layout_paint]"
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
