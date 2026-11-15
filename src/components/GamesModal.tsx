import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Upload, Play, Archive, ArrowLeft, Save } from 'lucide-react';
import { BUILTIN_GAMES, BuiltinGame } from '../emulator/builtinGames';
import {
  DISK_ACCEPT_ATTR,
  GAME_ACCEPT_ATTR,
  ExtractedEntry,
  extractPlayableFiles,
  getFormatBadge,
  isMountableDriveExtension,
} from '../emulator/archiveExtractor';
import { MACHINE_PROFILES, MachineId } from '../emulator/machines';
import { SaveStateMeta } from '../emulator/saveStateStorage';
import { ZxArtGameSummary } from '../emulator/zxartCatalog';
import { buildFavoriteIdSet } from '../emulator/favoritesStorage';
import { ZxArtCatalog } from './ZxArtCatalog';
import { FavoritesTab } from './FavoritesTab';

interface GamesModalProps {
  open: boolean;
  targetDrive: 0 | 1 | null;
  openNonce: number;
  initialZxArtGame: ZxArtGameSummary | null;
  currentMachineId: MachineId;
  saveStates: readonly SaveStateMeta[];
  favorites: readonly ZxArtGameSummary[];
  onToggleFavorite: (game: ZxArtGameSummary) => void;
  onClose: () => void;
  onSelectBuiltin: (game: BuiltinGame) => void;
  onLoadFile: (
    filename: string,
    bytes: Uint8Array,
    displayTitle?: string,
    recommendedMachine?: MachineId | null,
    gameKey?: string | null,
    zxArtGame?: ZxArtGameSummary | null
  ) => void;
  onInsertDiskFile: (drive: 0 | 1, filename: string, bytes: Uint8Array) => void;
  onLoadSaveState: (id: string, zxArtGame?: ZxArtGameSummary | null) => void;
  onDeleteSaveState: (id: string) => void;
}

type ModalTab = 'zxart' | 'favorites' | 'local';

function formatSizeKb(len: number): string {
  if (len < 1024) return `${len} Б`;
  const kb = len / 1024;
  return kb >= 100 ? `${Math.round(kb)} КБ` : `${kb.toFixed(1)} КБ`;
}

export const GamesModal: React.FC<GamesModalProps> = React.memo(({
  open,
  targetDrive,
  openNonce,
  initialZxArtGame,
  currentMachineId,
  saveStates,
  favorites,
  onToggleFavorite,
  onClose,
  onSelectBuiltin,
  onLoadFile,
  onInsertDiskFile,
  onLoadSaveState,
  onDeleteSaveState,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [hasOpened, setHasOpened] = useState(open);
  const [activeTab, setActiveTab] = useState<ModalTab>('zxart');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [favoriteOpenReq, setFavoriteOpenReq] = useState<{
    game: ZxArtGameSummary;
    nonce: number;
  } | null>(null);
  const [detailReturnTab, setDetailReturnTab] = useState<ModalTab | null>(null);
  const [archivePicker, setArchivePicker] = useState<{
    archiveName: string;
    files: ExtractedEntry[];
    gameTitle?: string;
    gameKey?: string | null;
    selectedMachine: MachineId;
    zxArtGame?: ZxArtGameSummary | null;
    targetDrive?: 0 | 1 | null;
  } | null>(null);

  const isDiskMode = targetDrive !== null;
  const driveLetter = targetDrive === 1 ? 'B' : 'A';
  const favoriteIds = useMemo(() => buildFavoriteIdSet(favorites), [favorites]);

  const handleOpenFavoriteGame = useCallback((game: ZxArtGameSummary) => {
    setErrorMsg(null);
    setFavoriteOpenReq((prev) => ({ game, nonce: (prev?.nonce ?? 0) + 1 }));
    setDetailReturnTab('favorites');
    setActiveTab('zxart');
  }, []);

  const handleBackFromDetails = useCallback(() => {
    setDetailReturnTab((prev) => {
      if (prev === 'favorites') {
        setActiveTab('favorites');
      }
      return null;
    });
  }, []);

  const handleGoToCatalog = useCallback(() => {
    setErrorMsg(null);
    setDetailReturnTab(null);
    setActiveTab('zxart');
  }, []);

  useEffect(() => {
    if (open && !hasOpened) {
      setHasOpened(true);
    }
  }, [open, hasOpened]);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setArchivePicker(null);
    if (targetDrive !== null) {
      setDetailReturnTab(null);
      setActiveTab('zxart');
    }
  }, [open, openNonce, targetDrive]);

  if (!hasOpened && !open) return null;

  const handleClose = () => {
    setErrorMsg(null);
    setArchivePicker(null);
    setDetailReturnTab(null);
    onClose();
  };

  const processFile = async (file: File) => {
    setErrorMsg(null);
    setExtracting(true);
    try {
      const buf = await file.arrayBuffer();
      const extractMode = targetDrive !== null ? 'disk' : 'game';
      const extracted = await extractPlayableFiles(file.name, new Uint8Array(buf), extractMode);
      if (targetDrive !== null) {
        if (extracted.kind === 'single') {
          if (!isMountableDriveExtension(extracted.file.ext)) {
            throw new Error(`Файл «${extracted.file.name}» не является образом дискеты ZX Spectrum`);
          }
          onInsertDiskFile(targetDrive, extracted.file.name, extracted.file.bytes);
          setArchivePicker(null);
          onClose();
        } else {
          setArchivePicker({
            archiveName: extracted.archiveName,
            files: extracted.files,
            selectedMachine: currentMachineId,
            targetDrive,
          });
        }
        return;
      }

      if (extracted.kind === 'single') {
        onLoadFile(extracted.file.name, extracted.file.bytes);
        setArchivePicker(null);
        onClose();
      } else {
        setArchivePicker({
          archiveName: extracted.archiveName,
          files: extracted.files,
          selectedMachine: currentMachineId,
          targetDrive: null,
        });
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Не удалось загрузить файл');
    } finally {
      setExtracting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void processFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-labelledby="games-modal-title"
      className={
        open
          ? 'fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-4'
          : 'hidden'
      }
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={handleDrop}
        className={`relative w-full sm:w-[min(94vw,1220px)] h-[92dvh] sm:h-[min(90dvh,860px)] bg-[#181a20] border-t sm:border rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col transition-colors ${
          dragging ? 'border-red-400' : 'border-white/12'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={isDiskMode ? DISK_ACCEPT_ATTR : GAME_ACCEPT_ATTR}
          onChange={handleFileChange}
          className="hidden"
        />

        {/* Header */}
        <div className="px-4 py-3 border-b border-white/10 shrink-0 space-y-2.5 sm:space-y-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              {archivePicker && (
                <button
                  type="button"
                  onClick={() => setArchivePicker(null)}
                  aria-label="Назад к списку"
                  className="w-8 h-8 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center shrink-0 cursor-pointer"
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
              )}
              <h2 id="games-modal-title" className="text-base font-bold text-zinc-100 truncate">
                {archivePicker
                  ? archivePicker.targetDrive !== null && archivePicker.targetDrive !== undefined
                    ? `Дисковод ${archivePicker.targetDrive === 0 ? 'A' : 'B'}: ${archivePicker.archiveName}`
                    : archivePicker.archiveName
                  : isDiskMode
                    ? `Дисковод ${driveLetter}: каталог zxart.ee`
                    : 'Игры и файлы'}
              </h2>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {!archivePicker && !isDiskMode && (
                <div
                  role="tablist"
                  aria-label="Источник игр"
                  className="hidden sm:flex items-center gap-1 p-1 rounded-lg bg-zinc-900 border border-white/10"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'zxart'}
                    onClick={() => {
                      setErrorMsg(null);
                      setDetailReturnTab(null);
                      setActiveTab('zxart');
                    }}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      activeTab === 'zxart'
                        ? 'bg-red-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-100'
                    }`}
                  >
                    Каталог ZX-Art
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'favorites'}
                    data-testid="tab-favorites"
                    onClick={() => {
                      setErrorMsg(null);
                      setDetailReturnTab(null);
                      setActiveTab('favorites');
                    }}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer inline-flex items-center gap-1.5 ${
                      activeTab === 'favorites'
                        ? 'bg-red-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-100'
                    }`}
                  >
                    <span>Избранное</span>
                    {favorites.length > 0 && (
                      <span
                        className={`px-1.5 py-0.2 rounded-full text-[10px] tabular-nums ${
                          activeTab === 'favorites'
                            ? 'bg-white/20 text-white'
                            : 'bg-zinc-800 text-zinc-300'
                        }`}
                      >
                        {favorites.length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTab === 'local'}
                    onClick={() => {
                      setErrorMsg(null);
                      setDetailReturnTab(null);
                      setActiveTab('local');
                    }}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                      activeTab === 'local'
                        ? 'bg-zinc-700 text-white'
                        : 'text-zinc-400 hover:text-zinc-100'
                    }`}
                  >
                    Встроенные и файлы
                  </button>
                </div>
              )}

              <button
                type="button"
                disabled={extracting}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Выбрать свой файл"
                className="h-8 px-2.5 sm:px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 border border-white/10 text-xs font-semibold text-zinc-100 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">
                  {extracting ? 'Распаковка…' : 'Свой файл'}
                </span>
              </button>

              <button
                type="button"
                onClick={handleClose}
                aria-label="Закрыть"
                className="w-8 h-8 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center shrink-0 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {!archivePicker && !isDiskMode && (
            <div
              role="tablist"
              aria-label="Источник игр"
              className="grid grid-cols-3 sm:hidden gap-1 p-1 rounded-lg bg-zinc-900 border border-white/10"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'zxart'}
                onClick={() => {
                  setErrorMsg(null);
                  setDetailReturnTab(null);
                  setActiveTab('zxart');
                }}
                className={`py-1.5 px-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap truncate cursor-pointer ${
                  activeTab === 'zxart'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                ZX-Art
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'favorites'}
                onClick={() => {
                  setErrorMsg(null);
                  setDetailReturnTab(null);
                  setActiveTab('favorites');
                }}
                className={`py-1.5 px-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap truncate cursor-pointer ${
                  activeTab === 'favorites'
                    ? 'bg-red-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {favorites.length > 0 ? `Избранное (${favorites.length})` : 'Избранное'}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'local'}
                onClick={() => {
                  setErrorMsg(null);
                  setDetailReturnTab(null);
                  setActiveTab('local');
                }}
                className={`py-1.5 px-1 rounded-md text-xs font-semibold transition-colors whitespace-nowrap truncate cursor-pointer ${
                  activeTab === 'local'
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                Файлы
              </button>
            </div>
          )}
        </div>

        {errorMsg && (
          <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-950/70 border border-red-500/40 text-xs text-red-200 flex items-center justify-between gap-2 shrink-0">
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              aria-label="Скрыть ошибку"
              className="text-red-300 hover:text-white shrink-0 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {archivePicker && (
          <div className="flex-1 min-h-0 flex flex-col" data-testid="archive-file-picker">
            <div className="px-4 py-2.5 border-b border-white/10 bg-[#15171d] flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <Archive className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                <span>Файлов в архиве: {archivePicker.files.length}</span>
              </div>
              {archivePicker.targetDrive !== null && archivePicker.targetDrive !== undefined ? (
                <div className="text-xs font-medium text-zinc-300">
                  Вставка в дисковод {archivePicker.targetDrive === 0 ? 'A:' : 'B:'}
                </div>
              ) : (
                <label className="flex items-center gap-2 text-xs text-zinc-300">
                  <span className="text-zinc-400">Модель:</span>
                  <select
                    aria-label="Модель компьютера для файла из архива"
                    value={archivePicker.selectedMachine}
                    onChange={(e) =>
                      setArchivePicker((prev) =>
                        prev ? { ...prev, selectedMachine: e.target.value as MachineId } : prev
                      )
                    }
                    className="h-8 px-2.5 rounded-lg bg-zinc-900 border border-white/12 text-xs text-zinc-100 focus:outline-none focus:border-white/35 cursor-pointer"
                  >
                    {MACHINE_PROFILES.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="p-4 space-y-1.5 overflow-y-auto flex-1 min-h-0">
              {archivePicker.files.map((entry) => {
                const pickerDrive = archivePicker.targetDrive ?? null;
                const pickerDriveLetter = pickerDrive === 1 ? 'B' : 'A';
                return (
                  <div
                    key={entry.path}
                    className="rounded-xl bg-zinc-900/80 border border-white/10 px-3 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-zinc-100 truncate" title={entry.path}>
                          {entry.name}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold shrink-0 bg-zinc-800 text-zinc-300 border border-white/10">
                          {getFormatBadge(entry.name)}
                        </span>
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate mt-0.5">
                        {entry.path !== entry.name ? `${entry.path} · ` : ''}
                        {formatSizeKb(entry.bytes.length)}
                      </div>
                    </div>
                    {pickerDrive !== null ? (
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            onInsertDiskFile(pickerDrive, entry.name, entry.bytes);
                            setArchivePicker(null);
                            onClose();
                          } catch (err) {
                            setErrorMsg(
                              err instanceof Error ? err.message : 'Не удалось вставить образ дискеты'
                            );
                          }
                        }}
                        aria-label={`Вставить ${entry.name} в дисковод ${pickerDriveLetter}`}
                        className="h-8 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>Вставить в {pickerDriveLetter}:</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          try {
                            onLoadFile(
                              entry.name,
                              entry.bytes,
                              archivePicker.gameTitle,
                              archivePicker.selectedMachine,
                              archivePicker.gameKey,
                              archivePicker.zxArtGame
                            );
                            setArchivePicker(null);
                            onClose();
                          } catch (err) {
                            setErrorMsg(err instanceof Error ? err.message : 'Не удалось запустить файл');
                          }
                        }}
                        aria-label={`Запустить ${entry.name}`}
                        className="h-8 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Запуск</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div
          className={
            !archivePicker && (activeTab === 'zxart' || isDiskMode)
              ? 'flex-1 min-h-0 flex flex-col'
              : 'hidden'
          }
        >
          <ZxArtCatalog
            isOpen={open && !archivePicker}
            targetDrive={targetDrive}
            openNonce={openNonce}
            initialGame={initialZxArtGame}
            currentMachineId={currentMachineId}
            saveStates={saveStates}
            favoriteIds={favoriteIds}
            externalGameRequest={favoriteOpenReq}
            backLabel={detailReturnTab === 'favorites' ? 'Избранное' : 'Каталог'}
            onBackFromDetails={handleBackFromDetails}
            onToggleFavorite={onToggleFavorite}
            onPlayFile={(filename, bytes, displayTitle, selectedMachine, gameKey, zxArtGame) => {
              onLoadFile(filename, bytes, displayTitle, selectedMachine, gameKey, zxArtGame);
              handleClose();
            }}
            onInsertDiskFile={(drive, filename, bytes) => {
              onInsertDiskFile(drive, filename, bytes);
              handleClose();
            }}
            onOpenArchivePicker={(archive) => setArchivePicker(archive)}
            onLoadSaveState={(id, zxArtGame) => {
              onLoadSaveState(id, zxArtGame);
              handleClose();
            }}
            onDeleteSaveState={onDeleteSaveState}
            onError={setErrorMsg}
          />
        </div>

        {!archivePicker && activeTab === 'favorites' && !isDiskMode && (
          <FavoritesTab
            favorites={favorites}
            saveStates={saveStates}
            onSelectGame={handleOpenFavoriteGame}
            onToggleFavorite={onToggleFavorite}
            onGoToCatalog={handleGoToCatalog}
          />
        )}

        {!archivePicker && activeTab === 'local' && !isDiskMode && (
          <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
            {/* File upload area */}
            <div
              className={`rounded-xl border border-dashed p-3.5 flex items-center justify-between gap-3 transition-colors ${
                dragging
                  ? 'border-red-400 bg-red-500/10'
                  : 'border-white/15 bg-zinc-900/60'
              }`}
            >
              <div className="min-w-0 space-y-0.5">
                <div className="text-xs font-medium text-zinc-200">
                  Все форматы ZX Spectrum и архивы
                </div>
                <div className="text-[11px] font-mono text-zinc-400 leading-relaxed">
                  TAP TZX PZX CSW WAV · SNA Z80 SZX SP SLT · TRD SCL FDI TD0 UDI DSK MDR Hobeta · ROM SCR · ZIP RAR 7Z TAR GZ BZ2 ARJ LHA
                </div>
              </div>
              <button
                type="button"
                disabled={extracting}
                onClick={() => fileInputRef.current?.click()}
                className="h-9 px-3.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 border border-white/10 text-xs font-semibold text-zinc-100 inline-flex items-center gap-2 shrink-0 cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                <span>{extracting ? 'Распаковка…' : 'Выбрать файл'}</span>
              </button>
            </div>

            {/* Built-in ZX Spectrum programs */}
            <div className="space-y-1.5">
              {BUILTIN_GAMES.map((game) => (
                <div
                  key={game.id}
                  className="rounded-xl bg-zinc-900/80 border border-white/10 px-3 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-zinc-100 truncate">
                      {game.title}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold shrink-0 ${
                        game.format === 'TRD'
                          ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                          : 'bg-zinc-800 text-zinc-300 border border-white/10'
                      }`}
                    >
                      .{game.format}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectBuiltin(game);
                      handleClose();
                    }}
                    aria-label={`Запустить ${game.title}`}
                    className="h-8 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    <span>Запуск</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
