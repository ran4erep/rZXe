import React, { useEffect, useState } from 'react';
import { X, Play, Download, Trash2 } from 'lucide-react';
import { SaveStateMeta } from '../emulator/saveStateStorage';
import { getMachineProfile } from '../emulator/machines';

interface SaveStatesModalProps {
  open: boolean;
  saveStates: readonly SaveStateMeta[];
  allSaveStates: readonly SaveStateMeta[];
  activeGameLabel?: string | null;
  isVersionScoped?: boolean;
  onClose: () => void;
  onLoadSaveState: (id: string) => void;
  onDownloadSaveState: (id: string) => void;
  onDeleteSaveState: (id: string) => void;
}

type SaveScopeTab = 'current' | 'all';

function formatSaveTimestamp(ts: number): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(ts);
  } catch {
    return new Date(ts).toLocaleString();
  }
}

export const SaveStatesModal: React.FC<SaveStatesModalProps> = React.memo(({
  open,
  saveStates,
  allSaveStates,
  activeGameLabel = null,
  isVersionScoped = false,
  onClose,
  onLoadSaveState,
  onDownloadSaveState,
  onDeleteSaveState,
}) => {
  const [scope, setScope] = useState<SaveScopeTab>('current');

  useEffect(() => {
    if (!open) return;
    if (saveStates.length > 0 || activeGameLabel) {
      setScope('current');
    } else if (allSaveStates.length > 0) {
      setScope('all');
    } else {
      setScope('current');
    }
  }, [open, activeGameLabel, saveStates.length, allSaveStates.length]);

  if (!open) return null;

  const displayedStates = scope === 'current' ? saveStates : allSaveStates;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="savestates-modal-title"
      className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-lg bg-[#181a20] border-t sm:border border-white/12 rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88dvh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0 gap-2">
          <div className="min-w-0 flex items-center gap-2.5">
            <h2 id="savestates-modal-title" className="text-base font-bold text-zinc-100 truncate">
              Сохранения
            </h2>
            <div
              role="tablist"
              aria-label="Фильтр сохранений"
              className="flex items-center gap-1 p-0.5 rounded-lg bg-zinc-900 border border-white/10 shrink-0"
            >
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'current'}
                onClick={() => setScope('current')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  scope === 'current'
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                {isVersionScoped ? 'Эта версия' : activeGameLabel ? 'Эта игра' : 'Текущее'} ({saveStates.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={scope === 'all'}
                onClick={() => setScope('all')}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                  scope === 'all'
                    ? 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-zinc-100'
                }`}
              >
                Все ({allSaveStates.length})
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="w-9 h-9 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 flex items-center justify-center cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3.5 overflow-y-auto space-y-2.5">
          {displayedStates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/15 bg-zinc-900/40 px-4 py-8 text-center space-y-1.5">
              <p className="text-xs font-medium text-zinc-200">
                {scope === 'current'
                  ? isVersionScoped
                    ? 'Сохранённых состояний для этой версии пока нет'
                    : 'Сохранённых состояний для этой игры пока нет'
                  : 'Сохранённых состояний пока нет'}
              </p>
              <p className="text-[11px] text-zinc-400">
                Используйте кнопку сохранения на верхней панели
              </p>
              {scope === 'current' && allSaveStates.length > 0 && (
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className="mt-2 h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-xs font-medium text-zinc-200 cursor-pointer"
                >
                  Показать все сохранения ({allSaveStates.length})
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2" data-testid="savestates-list">
              {displayedStates.map((item) => {
                const profile = getMachineProfile(item.machineId);
                return (
                  <div
                    key={item.id}
                    data-testid={`savestate-card-${item.id}`}
                    className="rounded-xl bg-zinc-900/80 border border-white/10 p-2.5 flex items-center gap-2.5 sm:gap-3"
                  >
                    <div className="w-20 sm:w-24 aspect-[4/3] rounded-lg border border-white/15 bg-black overflow-hidden shrink-0 flex items-center justify-center">
                      {item.screenshotDataUrl ? (
                        <img
                          src={item.screenshotDataUrl}
                          alt={item.title}
                          className="w-full h-full object-cover pixelated"
                        />
                      ) : (
                        <span className="text-[10px] font-mono text-zinc-500">—</span>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="text-xs font-semibold text-zinc-100 truncate">
                        {item.title}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                        <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-white/10 font-mono text-[10px] text-zinc-300">
                          {profile.shortName}
                        </span>
                        <span className="truncate">{formatSaveTimestamp(item.createdAt)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => onLoadSaveState(item.id)}
                        aria-label={`Загрузить ${item.title}`}
                        title="Загрузить"
                        className="h-8 px-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-xs font-medium text-zinc-100 inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="hidden sm:inline">Загрузить</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDownloadSaveState(item.id)}
                        aria-label={`Скачать ${item.title}`}
                        title="Скачать"
                        className="w-8 h-8 rounded-lg bg-zinc-800/70 hover:bg-zinc-700 border border-white/10 text-zinc-300 hover:text-white flex items-center justify-center cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteSaveState(item.id)}
                        aria-label={`Удалить ${item.title}`}
                        title="Удалить"
                        className="w-8 h-8 rounded-lg bg-zinc-800/70 hover:bg-red-500/20 border border-white/10 text-zinc-400 hover:text-red-300 flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
