import React, { useEffect, useRef, useState } from 'react';
import { X, Check, ChevronDown } from 'lucide-react';
import {
  EmulatorSettings,
  KeyboardMode,
  JoystickMode,
  BorderMode,
  ScreenScaleMode,
} from '../emulator/settingsStorage';

export type { EmulatorSettings, KeyboardMode, JoystickMode, BorderMode, ScreenScaleMode };

interface SettingsModalProps {
  open: boolean;
  settings: EmulatorSettings;
  onChange: (patch: Partial<EmulatorSettings>) => void;
  onClose: () => void;
}

type CategoryKey = 'controls' | 'audio' | 'display' | 'system';

interface CustomCheckboxRowProps {
  label: string;
  checked: boolean;
  onToggle: (next: boolean) => void;
}

const CustomCheckboxRow: React.FC<CustomCheckboxRowProps> = ({ label, checked, onToggle }) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={checked}
    onClick={() => onToggle(!checked)}
    className="w-full flex items-center justify-between py-1.5 text-left cursor-pointer group focus-visible:outline-2 focus-visible:outline-red-400 rounded-md"
  >
    <span className="text-xs font-medium text-zinc-200 group-hover:text-white transition-colors">
      {label}
    </span>
    <span
      aria-hidden="true"
      className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors shrink-0 ${
        checked
          ? 'bg-red-600 border-red-500 text-white'
          : 'bg-zinc-900 border-white/20 text-transparent group-hover:border-white/35'
      }`}
    >
      <Check className="w-3.5 h-3.5 stroke-[3]" />
    </span>
  </button>
);

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

interface SettingSelectProps<T extends string> {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onSelect: (next: T) => void;
}

function SettingSelect<T extends string>({
  label,
  value,
  options,
  onSelect,
}: SettingSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollIntoView({ block: 'nearest' });

    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const currentLabel = options.find((opt) => opt.value === value)?.label ?? '';

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-zinc-200">{label}</span>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="h-8 min-w-[164px] px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800/90 border border-white/10 text-xs font-medium text-zinc-100 flex items-center justify-between gap-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400"
        >
          <span className="truncate">{currentLabel}</span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform duration-150 ${
              open ? 'rotate-180' : ''
            }`}
          />
        </button>

        {open && (
          <ul
            ref={listRef}
            role="listbox"
            aria-label={label}
            className="absolute right-0 top-full mt-1.5 min-w-full w-48 bg-[#1a1d24] border border-white/12 rounded-xl shadow-2xl py-1 z-30 overflow-hidden"
          >
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <li key={opt.value} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(opt.value);
                      setOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                      selected
                        ? 'bg-red-600/20 text-white font-semibold'
                        : 'text-zinc-300 hover:bg-white/5 hover:text-white'
                    }`}
                  >
                    <span>{opt.label}</span>
                    {selected && <Check className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

const BORDER_OPTIONS: readonly SelectOption<BorderMode>[] = [
  { value: 'none', label: 'Без бордюра' },
  { value: 'full', label: 'С бордюром' },
  { value: 'small', label: 'Небольшой бордюр' },
];

const SCALE_OPTIONS: readonly SelectOption<ScreenScaleMode>[] = [
  { value: 'auto', label: 'Авто' },
  { value: 'aspect', label: 'Пропорционально' },
  { value: 'stretch', label: 'Растянуть' },
];

interface CategorySectionProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

const CategorySection: React.FC<CategorySectionProps> = ({
  title,
  expanded,
  onToggle,
  children,
}) => (
  <div className="rounded-xl border border-white/10 bg-zinc-900/50">
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      className={`w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-white/[0.04] transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400 ${
        expanded ? 'rounded-t-xl' : 'rounded-xl'
      }`}
    >
      <span className="text-xs font-semibold tracking-wide text-zinc-100">{title}</span>
      <ChevronDown
        className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform duration-150 ${
          expanded ? 'rotate-180' : ''
        }`}
      />
    </button>
    {expanded && <div className="px-3.5 pb-3 pt-2 border-t border-white/8 space-y-3">{children}</div>}
  </div>
);

const INITIAL_EXPANDED_MAP: Record<CategoryKey, boolean> = {
  controls: false,
  audio: false,
  display: false,
  system: false,
};

interface SettingsModalContentProps {
  settings: EmulatorSettings;
  onChange: (patch: Partial<EmulatorSettings>) => void;
  onClose: () => void;
}

const SettingsModalContent: React.FC<SettingsModalContentProps> = ({
  settings,
  onChange,
  onClose,
}) => {
  const [expandedMap, setExpandedMap] = useState<Record<CategoryKey, boolean>>(INITIAL_EXPANDED_MAP);

  const toggleCategory = (key: CategoryKey) => {
    setExpandedMap((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md bg-[#181a20] border-t sm:border border-white/12 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88dvh]">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-white/10 shrink-0">
          <h2 id="settings-modal-title" className="text-base font-bold text-zinc-100">
            Настройки
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-9 h-9 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3.5 space-y-2.5 overflow-y-auto text-sm">
          <CategorySection
            title="Управление"
            expanded={expandedMap.controls}
            onToggle={() => toggleCategory('controls')}
          >
            {/* Joystick type */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-zinc-200">Тип джойстика</span>
              <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-lg border border-white/10">
                {(
                  [
                    ['kempston', 'Kempston'],
                    ['qaop', 'QAOP'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onChange({ joystickMode: mode })}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ${
                      settings.joystickMode === mode
                        ? 'bg-zinc-700 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* On-screen keyboard mode */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-zinc-200">Экранная клавиатура</span>
              <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-lg border border-white/10">
                {(
                  [
                    ['auto', 'Авто'],
                    ['show', 'Вкл'],
                    ['hide', 'Выкл'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onChange({ keyboardMode: mode })}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ${
                      settings.keyboardMode === mode
                        ? 'bg-zinc-700 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Desktop Kempston mouse mode */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-zinc-200">Kempston мышь</span>
              <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-lg border border-white/10">
                {(
                  [
                    ['cursor', 'Курсор'],
                    ['lock', 'Захват'],
                    ['off', 'Выкл'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onChange({ desktopMouseMode: mode })}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ${
                      settings.desktopMouseMode === mode
                        ? 'bg-zinc-700 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </CategorySection>

          <CategorySection
            title="Звук"
            expanded={expandedMap.audio}
            onToggle={() => toggleCategory('audio')}
          >
            {/* Volume */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="volume-slider" className="text-xs font-medium text-zinc-200">
                  Громкость
                </label>
                <span className="text-xs font-mono tabular-nums text-zinc-400">
                  {settings.soundEnabled ? `${Math.round(settings.volume * 100)}%` : 'Выкл'}
                </span>
              </div>
              <input
                id="volume-slider"
                type="range"
                min={0}
                max={100}
                value={Math.round(settings.volume * 100)}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  onChange({ volume: v, soundEnabled: v > 0 });
                }}
                className="w-full accent-red-500 cursor-pointer"
              />
            </div>

            {/* Stereo AY channel layout */}
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-zinc-200">Стерео (AY)</span>
              <div className="flex items-center gap-1 p-1 bg-zinc-900 rounded-lg border border-white/10">
                {(
                  [
                    ['abc', 'ABC'],
                    ['acb', 'ACB'],
                    ['mono', 'Моно'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onChange({ stereoMode: mode })}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer ${
                      settings.stereoMode === mode
                        ? 'bg-zinc-700 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </CategorySection>

          <CategorySection
            title="Экран"
            expanded={expandedMap.display}
            onToggle={() => toggleCategory('display')}
          >
            <SettingSelect
              label="Бордюр"
              value={settings.borderMode}
              options={BORDER_OPTIONS}
              onSelect={(borderMode) => onChange({ borderMode })}
            />
            <SettingSelect
              label="Масштабирование"
              value={settings.screenScale}
              options={SCALE_OPTIONS}
              onSelect={(screenScale) => onChange({ screenScale })}
            />
            <CustomCheckboxRow
              label="Эффект ЭЛТ (Scanlines)"
              checked={settings.scanlines}
              onToggle={(next) => onChange({ scanlines: next })}
            />
          </CategorySection>

          <CategorySection
            title="Система"
            expanded={expandedMap.system}
            onToggle={() => toggleCategory('system')}
          >
            {/* CPU Frequency */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="cpu-freq-slider" className="text-xs font-medium text-zinc-200">
                  Частота Z80
                </label>
                <div className="flex items-center gap-1.5">
                  {Math.abs(settings.cpuFreqMhz - 3.5) >= 0.01 && (
                    <button
                      type="button"
                      onClick={() => onChange({ cpuFreqMhz: 3.5 })}
                      className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[10px] font-mono text-zinc-300 cursor-pointer"
                    >
                      3.50
                    </button>
                  )}
                  <span className="text-xs font-mono tabular-nums text-zinc-400">
                    {settings.cpuFreqMhz.toFixed(2)} МГц
                  </span>
                </div>
              </div>
              <input
                id="cpu-freq-slider"
                type="range"
                min={0.5}
                max={14}
                step={0.25}
                value={settings.cpuFreqMhz}
                onChange={(e) => onChange({ cpuFreqMhz: Number(e.target.value) })}
                className="w-full accent-red-500 cursor-pointer"
              />
            </div>

            <CustomCheckboxRow
              label="Быстрая загрузка TAP"
              checked={settings.fastTapeLoad}
              onToggle={(next) => onChange({ fastTapeLoad: next })}
            />
          </CategorySection>
        </div>
      </div>
    </div>
  );
};

export const SettingsModal: React.FC<SettingsModalProps> = React.memo(({
  open,
  settings,
  onChange,
  onClose,
}) => {
  if (!open) return null;
  return <SettingsModalContent settings={settings} onChange={onChange} onClose={onClose} />;
});
