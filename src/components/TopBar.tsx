import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  FolderOpen,
  RotateCcw,
  Volume2,
  VolumeX,
  Settings,
  Pause,
  Play,
  ChevronDown,
  Check,
  Save,
  Trash2,
  Pencil,
  Download,
  X,
  Upload,
  Camera,
} from 'lucide-react';
import { MACHINE_PROFILES, MachineId, getMachineProfile } from '../emulator/machines';
import { SavedDiskMeta, SessionDiskHistoryItem } from '../emulator/diskStorage';
import { SaveStateSlot } from '../emulator/saveStateStorage';
import { DISK_ACCEPT_ATTR } from '../emulator/archiveExtractor';
import { computeVisibleTopBarActionCount } from '../emulator/topBarLayout';

interface TopBarProps {
  paused: boolean;
  soundEnabled: boolean;
  machineId: MachineId;
  activeGameTitle: string | null;
  diskNames: [string | null, string | null];
  driveReading: [boolean, boolean];
  savedDisks: readonly SavedDiskMeta[];
  sessionDiskHistory: readonly SessionDiskHistoryItem[];
  onSelectMachine: (id: MachineId) => void;
  onInsertDisk: (drive: 0 | 1, filename: string, bytes: Uint8Array) => void | Promise<void>;
  onInsertBlankDisk: (drive: 0 | 1) => void;
  onSelectHistoryDisk: (drive: 0 | 1, item: SessionDiskHistoryItem) => void;
  onMountSavedDisk: (drive: 0 | 1, id: string) => void;
  onRenameSavedDisk: (id: string, newName: string) => void;
  onDownloadSavedDisk: (id: string) => void;
  onDeleteSavedDisk: (id: string) => void;
  onEjectDisk: (drive: 0 | 1) => void;
  onTogglePause: () => void;
  onToggleSound: () => void;
  onReset: () => void;
  onOpenGames: () => void;
  onOpenCatalogForDrive: (drive: 0 | 1) => void;
  selectedSaveSlot: SaveStateSlot;
  onSaveState: () => void;
  onCaptureScreenshot: () => void;
  onOpenSaveStates: () => void;
  onOpenSettings: () => void;
}

export const TopBar: React.FC<TopBarProps> = React.memo(({
  paused,
  soundEnabled,
  machineId,
  activeGameTitle,
  diskNames,
  driveReading,
  savedDisks,
  sessionDiskHistory,
  onSelectMachine,
  onInsertDisk,
  onInsertBlankDisk,
  onSelectHistoryDisk,
  onMountSavedDisk,
  onRenameSavedDisk,
  onDownloadSavedDisk,
  onDeleteSavedDisk,
  onEjectDisk,
  onTogglePause,
  onToggleSound,
  onReset,
  onOpenGames,
  onOpenCatalogForDrive,
  selectedSaveSlot,
  onSaveState,
  onCaptureScreenshot,
  onOpenSaveStates,
  onOpenSettings,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openDriveMenu, setOpenDriveMenu] = useState<0 | 1 | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [visibleActionCount, setVisibleActionCount] = useState(8);
  const [subBarOpen, setSubBarOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const leftMandatoryRef = useRef<HTMLDivElement | null>(null);
  const firstActionBtnRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const drivesRef = useRef<HTMLDivElement | null>(null);
  const fileInputARef = useRef<HTMLInputElement | null>(null);
  const fileInputBRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const currentProfile = getMachineProfile(machineId);

  // Measure once on mount, on machine change, and on container resize — zero polling overhead
  useLayoutEffect(() => {
    const checkOverflow = () => {
      const header = headerRef.current;
      const left = leftMandatoryRef.current;
      if (!header || !left) return;
      const headerW = header.clientWidth;
      const isSm = headerW >= 640;
      const padX = isSm ? 32 : 16;
      const gap = isSm ? 6 : 4;
      const itemW = firstActionBtnRef.current?.offsetWidth || (isSm ? 36 : 32);
      const availableForRight = headerW - padX - left.offsetWidth - gap;
      const nextCount = computeVisibleTopBarActionCount(availableForRight, 8, itemW, gap, itemW);
      setVisibleActionCount((prev) => (prev === nextCount ? prev : nextCount));
      if (nextCount >= 8) {
        setSubBarOpen(false);
      }
    };

    checkOverflow();

    if (typeof ResizeObserver === 'undefined' || !headerRef.current) return;
    const ro = new ResizeObserver(checkOverflow);
    ro.observe(headerRef.current);
    if (leftMandatoryRef.current) {
      ro.observe(leftMandatoryRef.current);
    }
    return () => ro.disconnect();
  }, [machineId]);

  useEffect(() => {
    if (openDriveMenu === null) {
      setRenamingId(null);
    }
  }, [openDriveMenu]);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (!menuOpen && openDriveMenu === null && !subBarOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuOpen && dropdownRef.current && !dropdownRef.current.contains(target)) {
        setMenuOpen(false);
      }
      if (openDriveMenu !== null && drivesRef.current && !drivesRef.current.contains(target)) {
        setOpenDriveMenu(null);
      }
      if (subBarOpen && rootRef.current && !rootRef.current.contains(target)) {
        setSubBarOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (renamingId) {
          setRenamingId(null);
          return;
        }
        setMenuOpen(false);
        setOpenDriveMenu(null);
        setSubBarOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen, openDriveMenu, renamingId, subBarOpen]);

  const handleDiskFileChange = async (
    drive: 0 | 1,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const buf = await file.arrayBuffer();
    await onInsertDisk(drive, file.name, new Uint8Array(buf));
    setOpenDriveMenu(null);
  };

  const actionButtons = [
    <button
      key="games"
      ref={firstActionBtnRef}
      type="button"
      onClick={onOpenGames}
      aria-label="Игры и файлы"
      title="Игры и файлы"
      className="w-8 sm:w-9 h-8 rounded-lg bg-red-600 hover:bg-red-500 active:bg-red-700 text-white flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400"
    >
      <FolderOpen className="w-4 h-4 shrink-0" />
    </button>,

    <button
      key="pause"
      type="button"
      onClick={onTogglePause}
      aria-label={paused ? 'Старт' : 'Пауза'}
      title={paused ? 'Старт' : 'Пауза'}
      className="w-8 sm:w-9 h-8 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200 flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
    >
      {paused ? <Play className="w-4 h-4 shrink-0" /> : <Pause className="w-4 h-4 shrink-0" />}
    </button>,

    <button
      key="sound"
      type="button"
      onClick={onToggleSound}
      aria-label={soundEnabled ? 'Выключить звук' : 'Включить звук'}
      title={soundEnabled ? 'Выключить звук' : 'Включить звук'}
      className={`w-8 sm:w-9 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400 ${
        soundEnabled
          ? 'bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200'
          : 'bg-zinc-900/80 hover:bg-zinc-800 text-zinc-500'
      }`}
    >
      {soundEnabled ? (
        <Volume2 className="w-4 h-4 shrink-0" />
      ) : (
        <VolumeX className="w-4 h-4 shrink-0" />
      )}
    </button>,

    <button
      key="reset"
      type="button"
      onClick={onReset}
      aria-label="Сброс"
      title="Сброс"
      className="w-8 sm:w-9 h-8 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200 flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
    >
      <RotateCcw className="w-4 h-4 shrink-0" />
    </button>,

    <button
      key="screenshot"
      type="button"
      data-testid="screenshot-btn"
      onClick={() => {
        setSubBarOpen(false);
        onCaptureScreenshot();
      }}
      aria-label="Скриншот 720p без бордюра"
      title="Скриншот (720p без бордюра)"
      className="w-8 sm:w-9 h-8 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200 flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
    >
      <Camera className="w-4 h-4 shrink-0" />
    </button>,

    <button
      key="save"
      type="button"
      data-testid="save-state-btn"
      onClick={() => {
        setSubBarOpen(false);
        onSaveState();
      }}
      aria-label={`Сохранить состояние (слот ${selectedSaveSlot})`}
      title={`Сохранить состояние (Слот ${selectedSaveSlot})`}
      className="relative w-8 sm:w-9 h-8 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200 flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
    >
      <Save className="w-4 h-4 shrink-0" />
      <span
        aria-hidden="true"
        className="absolute bottom-0.5 right-0.5 text-[9px] font-mono font-bold leading-none text-emerald-400"
      >
        {selectedSaveSlot}
      </span>
    </button>,

    <button
      key="load"
      type="button"
      onClick={() => {
        setSubBarOpen(false);
        onOpenSaveStates();
      }}
      aria-label="Загрузить состояние"
      title="Загрузить состояние"
      className="w-8 sm:w-9 h-8 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200 flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
    >
      <Upload className="w-4 h-4 shrink-0" />
    </button>,

    <button
      key="settings"
      type="button"
      onClick={() => {
        setSubBarOpen(false);
        onOpenSettings();
      }}
      aria-label="Настройки"
      title="Настройки"
      className="w-8 sm:w-9 h-8 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 text-zinc-200 flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400"
    >
      <Settings className="w-4 h-4 shrink-0" />
    </button>,
  ];

  const hasOverflow = visibleActionCount < actionButtons.length;
  const inlineActions = hasOverflow ? actionButtons.slice(0, visibleActionCount) : actionButtons;
  const overflowActions = hasOverflow ? actionButtons.slice(visibleActionCount) : [];

  return (
    <div ref={rootRef} className="relative shrink-0 z-30">
      <header
        ref={headerRef}
        className="h-12 w-full bg-[#14161b] border-b border-white/10 px-2 sm:px-4 flex items-center justify-between gap-1.5 sm:gap-2"
      >
        {/* Brand, custom BIOS dropdown & TR-DOS Drive A/B buttons */}
        <div className="flex items-center gap-1 sm:gap-2 min-w-0">
          <div ref={leftMandatoryRef} className="flex items-center gap-1 sm:gap-2 shrink-0">
            <div className="w-5 h-3.5 rounded-[2px] sinclair-stripes shrink-0" aria-hidden="true" />
            <h1 className="hidden sm:block text-sm md:text-base font-bold tracking-tight text-zinc-100 whitespace-nowrap shrink-0">
              ZX Spectrum
            </h1>

            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                aria-label="Модель и BIOS"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                onClick={() => {
                  setOpenDriveMenu(null);
                  setSubBarOpen(false);
                  setMenuOpen((o) => !o);
                }}
                className={`h-8 ${
                  currentProfile.hasTrdos ? 'max-w-[88px] sm:max-w-[190px]' : 'max-w-[126px] sm:max-w-[200px]'
                } px-2 sm:px-2.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700/90 border border-white/10 text-xs font-semibold text-zinc-100 flex items-center justify-between gap-1 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400`}
              >
                <span className="truncate">{currentProfile.shortName}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform duration-150 ${
                    menuOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {menuOpen && (
                <ul
                  role="listbox"
                  aria-label="Выбор BIOS"
                  className="absolute left-0 top-full mt-1.5 w-60 bg-[#1a1d24] border border-white/12 rounded-xl shadow-2xl py-1 z-50 overflow-hidden"
                >
                  {MACHINE_PROFILES.map((m) => {
                    const selected = m.id === machineId;
                    return (
                      <li key={m.id} role="option" aria-selected={selected}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectMachine(m.id);
                            setMenuOpen(false);
                          }}
                          className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                            selected
                              ? 'bg-red-600/20 text-white font-semibold'
                              : 'text-zinc-300 hover:bg-zinc-800/90 hover:text-zinc-100'
                          }`}
                        >
                          <span className="truncate">{m.name}</span>
                          {selected && <Check className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {currentProfile.hasTrdos && (
              <div ref={drivesRef} className="relative flex items-center gap-1 shrink-0">
                <input
                  ref={fileInputARef}
                  type="file"
                  accept={DISK_ACCEPT_ATTR}
                  className="hidden"
                  onChange={(e) => void handleDiskFileChange(0, e)}
                />
                <input
                  ref={fileInputBRef}
                  type="file"
                  accept={DISK_ACCEPT_ATTR}
                  className="hidden"
                  onChange={(e) => void handleDiskFileChange(1, e)}
                />

                {([0, 1] as const).map((drive) => {
                  const letter = drive === 0 ? 'A' : 'B';
                  const insertedName = diskNames[drive];
                  const isReading = driveReading[drive];
                  const isOpen = openDriveMenu === drive;

                  return (
                    <div key={drive} className="relative">
                      <button
                        type="button"
                        aria-label={`Дисковод ${letter}`}
                        aria-haspopup="menu"
                        aria-expanded={isOpen}
                        data-testid={`drive-btn-${letter}`}
                        data-has-disk={insertedName ? 'true' : 'false'}
                        data-reading={isReading ? 'true' : 'false'}
                        title={insertedName ? `${letter}: ${insertedName}` : `Дисковод ${letter}: дискета не вставлена`}
                        onClick={() => {
                          setMenuOpen(false);
                          setSubBarOpen(false);
                          setOpenDriveMenu((cur) => (cur === drive ? null : drive));
                        }}
                        className={`relative w-8 sm:w-9 h-8 rounded-lg border text-xs font-mono font-bold flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400 ${
                          insertedName
                            ? 'bg-zinc-800 hover:bg-zinc-700 border-white/80 text-white shadow-[0_0_8px_rgba(255,255,255,0.2)]'
                            : 'bg-zinc-900/90 hover:bg-zinc-800 border-white/10 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${
                            isReading
                              ? 'animate-disk-led-blink bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.95)]'
                              : 'bg-zinc-600'
                          }`}
                        />
                        <span>{letter}</span>
                      </button>

                      {isOpen && (
                        <div
                          role="menu"
                          aria-label={`Меню дисковода ${letter}`}
                          className={`absolute ${
                            drive === 1 ? '-left-10 sm:left-0' : 'left-0'
                          } top-full mt-1.5 w-64 sm:w-72 max-w-[calc(100vw-1rem)] bg-[#1a1d24] border border-white/12 rounded-xl shadow-2xl p-1.5 z-50 space-y-1`}
                        >
                          <div className="px-2 py-1 text-[11px] text-zinc-400 border-b border-white/8 truncate">
                            {letter}: {insertedName ?? 'Дискета не вставлена'}
                          </div>
                          {sessionDiskHistory.length > 0 && (
                            <div className="border-b border-white/8 pb-1">
                              <div
                                data-testid="session-disk-history-list"
                                className="max-h-[168px] overflow-y-auto space-y-0.5 pr-0.5"
                              >
                                {sessionDiskHistory.map((item) => {
                                  const isCurrent = insertedName === item.name;
                                  return (
                                    <button
                                      key={item.id}
                                      type="button"
                                      role="menuitem"
                                      title={item.name}
                                      onClick={() => {
                                        onSelectHistoryDisk(drive, item);
                                        setOpenDriveMenu(null);
                                      }}
                                      className={`w-full h-8 px-2 rounded-lg text-left text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                                        isCurrent
                                          ? 'bg-white/10 text-white'
                                          : 'text-zinc-200 hover:bg-zinc-800/80'
                                      }`}
                                    >
                                      <Save className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                                      <span className="truncate">{item.name}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              const input = drive === 0 ? fileInputARef.current : fileInputBRef.current;
                              input?.click();
                            }}
                            className="w-full px-2 py-1.5 rounded-lg text-left text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                          >
                            <FolderOpen className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                            <span>Выбрать образ...</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            data-testid={`drive-${letter}-catalog-btn`}
                            onClick={() => {
                              setOpenDriveMenu(null);
                              onOpenCatalogForDrive(drive);
                            }}
                            className="w-full px-2 py-1.5 rounded-lg text-left text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                          >
                            <Save className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                            <span>Выбрать из каталога</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              onInsertBlankDisk(drive);
                              setOpenDriveMenu(null);
                            }}
                            className="w-full px-2 py-1.5 rounded-lg text-left text-xs text-zinc-200 hover:bg-zinc-800 flex items-center gap-2 cursor-pointer"
                          >
                            <Save className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                            <span>Чистая дискета</span>
                          </button>
                          {insertedName && (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                onEjectDisk(drive);
                                setOpenDriveMenu(null);
                              }}
                              className="w-full px-2 py-1.5 rounded-lg text-left text-xs text-red-300 hover:bg-red-500/15 flex items-center gap-2 cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5 shrink-0" />
                              <span>Извлечь</span>
                            </button>
                          )}

                          {savedDisks.length > 0 && (
                            <div className="pt-1 border-t border-white/8">
                              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                                Сохранённые дискеты
                              </div>
                              <div className="max-h-48 overflow-y-auto space-y-0.5 pr-0.5">
                                {savedDisks.map((disk) => {
                                  const isEditing = renamingId === disk.id;
                                  const isCurrent = insertedName === disk.name;
                                  if (isEditing) {
                                    return (
                                      <form
                                        key={disk.id}
                                        className="flex items-center gap-1 px-1.5 py-1"
                                        onSubmit={(e) => {
                                          e.preventDefault();
                                          onRenameSavedDisk(disk.id, renameValue);
                                          setRenamingId(null);
                                        }}
                                      >
                                        <input
                                          ref={renameInputRef}
                                          type="text"
                                          value={renameValue}
                                          onChange={(e) => setRenameValue(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === 'Escape') {
                                              e.stopPropagation();
                                              setRenamingId(null);
                                            }
                                          }}
                                          aria-label="Новое имя дискеты"
                                          className="flex-1 min-w-0 h-6 px-1.5 rounded bg-zinc-900 border border-white/15 text-xs text-zinc-100 focus:outline-none focus:border-white/40"
                                        />
                                        <button
                                          type="submit"
                                          aria-label="Сохранить имя"
                                          className="w-6 h-6 rounded bg-emerald-600/80 hover:bg-emerald-500 text-white flex items-center justify-center shrink-0 cursor-pointer"
                                        >
                                          <Check className="w-3.5 h-3.5" />
                                        </button>
                                      </form>
                                    );
                                  }

                                  return (
                                    <div
                                      key={disk.id}
                                      className={`group flex items-center gap-1 px-1.5 py-1 rounded-lg ${
                                        isCurrent ? 'bg-white/10' : 'hover:bg-zinc-800/80'
                                      }`}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => {
                                          onMountSavedDisk(drive, disk.id);
                                          setOpenDriveMenu(null);
                                        }}
                                        className="flex-1 min-w-0 text-left text-xs text-zinc-200 truncate cursor-pointer"
                                        title={`Вставить ${disk.name}`}
                                      >
                                        {disk.name}
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`Переименовать ${disk.name}`}
                                        title="Переименовать"
                                        onClick={() => {
                                          setRenamingId(disk.id);
                                          setRenameValue(disk.name);
                                        }}
                                        className="w-6 h-6 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 flex items-center justify-center shrink-0 cursor-pointer"
                                      >
                                        <Pencil className="w-3 h-3" />
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`Скачать ${disk.name}`}
                                        title="Скачать"
                                        onClick={() => onDownloadSavedDisk(disk.id)}
                                        className="w-6 h-6 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100 flex items-center justify-center shrink-0 cursor-pointer"
                                      >
                                        <Download className="w-3 h-3" />
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`Удалить ${disk.name}`}
                                        title="Удалить"
                                        onClick={() => onDeleteSavedDisk(disk.id)}
                                        className="w-6 h-6 rounded hover:bg-red-500/20 text-zinc-400 hover:text-red-300 flex items-center justify-center shrink-0 cursor-pointer"
                                      >
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {activeGameTitle && (
            <span className="hidden lg:inline text-xs text-zinc-400 truncate max-w-[160px] min-w-0">
              · {activeGameTitle}
            </span>
          )}
        </div>

        {/* Action controls */}
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          {inlineActions}
          {hasOverflow && (
            <button
              type="button"
              data-testid="topbar-more-toggle"
              aria-label={subBarOpen ? 'Скрыть дополнительные кнопки' : 'Дополнительные кнопки'}
              aria-expanded={subBarOpen}
              onClick={() => {
                setMenuOpen(false);
                setOpenDriveMenu(null);
                setSubBarOpen((o) => !o);
              }}
              className={`w-8 sm:w-9 h-8 rounded-lg border text-xs font-medium flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-zinc-400 ${
                subBarOpen
                  ? 'bg-zinc-700 border-white/25 text-white'
                  : 'bg-zinc-800/90 hover:bg-zinc-700/90 border-transparent text-zinc-200'
              }`}
            >
              <ChevronDown
                className={`w-4 h-4 shrink-0 transition-transform duration-150 ${
                  subBarOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
          )}
        </div>
      </header>

      {/* Secondary dropdown bar only for icons that genuinely did not fit */}
      {hasOverflow && subBarOpen && (
        <div
          data-testid="topbar-subbar"
          className="absolute top-full left-0 right-0 h-12 bg-[#14161b] border-b border-white/10 px-2 sm:px-4 flex items-center justify-end gap-1.5 shadow-xl z-20"
        >
          {overflowActions}
        </div>
      )}
    </div>
  );
});
