import React, { useEffect, useMemo, useState } from 'react';
import { X, Play, Download, Trash2 } from 'lucide-react';
import {
  SAVE_STATE_SLOTS,
  SaveStateMeta,
  SaveStateSlot,
  mapSaveStatesBySlot,
} from '../emulator/saveStateStorage';
import { getMachineProfile } from '../emulator/machines';

interface SaveStatesModalProps {
  open: boolean;
  saveStates: readonly SaveStateMeta[];
  allSaveStates: readonly SaveStateMeta[];
  selectedSlot: SaveStateSlot;
  activeGameLabel?: string | null;
  isVersionScoped?: boolean;
  onSelectSlot: (slot: SaveStateSlot) => void;
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
  selectedSlot,
  activeGameLabel = null,
  isVersionScoped = false,
  onSelectSlot,
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

  const { slots: slotMap, legacy: legacyCurrentSaves } = useMemo(
    () => mapSaveStatesBySlot(saveStates),
    [saveStates]
  );

  if (!open) return null;

  const currentSlotItem = slotMap[selectedSlot];

  const renderCompactCardBody = (item: SaveStateMeta) => {
    const profile = getMachineProfile(item.machineId);
    return (
      <>
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
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
            <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-white/10 font-mono text-[10px] text-zinc-300">
              {profile.shortName}
            </span>
            {item.slot !== undefined && (
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-400/30 font-mono text-[10px] text-emerald-300">
                Слот {item.slot}
              </span>
            )}
            <span className="truncate">{formatSaveTimestamp(item.createdAt)}</span>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => onLoadSaveState(item.id)}
            aria-label={
              item.slot !== undefined
                ? `Загрузить слот ${item.slot}: ${item.title}`
                : `Загрузить ${item.title}`
            }
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
      </>
    );
  };

  const renderActiveSlotCard = (item: SaveStateMeta) => {
    const profile = getMachineProfile(item.machineId);
    return (
      <div
        data-testid={`savestate-slot-card-${selectedSlot}`}
        className="rounded-xl bg-zinc-900/80 border border-white/10 p-3.5 sm:p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3.5 sm:gap-4"
      >
        <div className="w-full sm:w-44 aspect-[4/3] rounded-xl border border-white/15 bg-black overflow-hidden shrink-0 flex items-center justify-center">
          {item.screenshotDataUrl ? (
            <img
              src={item.screenshotDataUrl}
              alt={item.title}
              className="w-full h-full object-cover pixelated"
            />
          ) : (
            <span className="text-xs font-mono text-zinc-500">—</span>
          )}
        </div>

        <div className="min-w-0 flex-1 flex flex-col justify-between gap-3 self-stretch py-0.5">
          <div className="space-y-1.5">
            <div className="text-sm sm:text-base font-semibold text-zinc-100 truncate">
              {item.title}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span className="px-2 py-0.5 rounded bg-zinc-800 border border-white/10 font-mono text-[11px] text-zinc-200">
                {profile.shortName}
              </span>
              <span className="truncate">{formatSaveTimestamp(item.createdAt)}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onLoadSaveState(item.id)}
              aria-label={`Загрузить: ${item.title}`}
              title="Загрузить"
              className="flex-1 sm:flex-initial h-9 px-3.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-semibold text-zinc-100 inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Загрузить</span>
            </button>
            <button
              type="button"
              onClick={() => onDownloadSaveState(item.id)}
              aria-label={`Скачать ${item.title}`}
              title="Скачать"
              className="w-9 h-9 rounded-lg bg-zinc-800/70 hover:bg-zinc-700 border border-white/10 text-zinc-300 hover:text-white flex items-center justify-center cursor-pointer shrink-0"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onDeleteSaveState(item.id)}
              aria-label={`Удалить ${item.title}`}
              title="Удалить"
              className="w-9 h-9 rounded-lg bg-zinc-800/70 hover:bg-red-500/20 border border-white/10 text-zinc-400 hover:text-red-300 flex items-center justify-center cursor-pointer shrink-0"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    );
  };

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

        {/* Active Save Slot selector (slots 1..5, default 1) */}
        <div
          data-testid="savestate-slot-selector"
          className="px-4 py-3 bg-[#14161b] border-b border-white/10 flex items-center justify-between gap-3 shrink-0"
        >
          <span className="text-xs font-medium text-zinc-300 shrink-0">
            Слот:
          </span>
          <div className="flex items-center gap-2 flex-1 justify-end" role="group" aria-label="Выбор слота сохранения">
            {SAVE_STATE_SLOTS.map((slot) => {
              const isSelected = selectedSlot === slot;
              const hasData = slotMap[slot] !== null;
              return (
                <button
                  key={slot}
                  type="button"
                  data-testid={`save-slot-btn-${slot}`}
                  aria-label={`Слот сохранения ${slot}`}
                  aria-pressed={isSelected}
                  onClick={() => onSelectSlot(slot)}
                  className={`relative h-10 flex-1 max-w-[56px] rounded-xl border text-sm font-mono font-bold flex items-center justify-center gap-1.5 cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-600/25 border-emerald-400/70 text-white'
                      : 'bg-zinc-900/90 hover:bg-zinc-800 border-white/10 text-zinc-300'
                  }`}
                >
                  <span>{slot}</span>
                  {hasData && (
                    <span
                      aria-hidden="true"
                      className={`w-1.5 h-1.5 rounded-full ${
                        isSelected ? 'bg-emerald-400' : 'bg-zinc-400'
                      }`}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-4 overflow-y-auto space-y-3">
          {scope === 'current' ? (
            <>
              {currentSlotItem ? (
                renderActiveSlotCard(currentSlotItem)
              ) : (
                <div
                  data-testid={`savestate-slot-empty-${selectedSlot}`}
                  className="rounded-xl border border-dashed border-white/15 bg-zinc-900/40 px-4 py-10 min-h-[144px] flex flex-col items-center justify-center text-center space-y-1.5"
                >
                  <p className="text-sm font-medium text-zinc-200">
                    Пусто
                  </p>
                  <p className="text-xs text-zinc-400">
                    Нажмите кнопку сохранения на верхней панели
                  </p>
                  {saveStates.length === 0 && allSaveStates.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setScope('all')}
                      className="mt-2 h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-xs font-medium text-zinc-200 cursor-pointer"
                    >
                      Показать все сохранения ({allSaveStates.length})
                    </button>
                  )}
                </div>
              )}

              {legacyCurrentSaves.length > 0 && (
                <div className="pt-2 border-t border-white/10 space-y-2">
                  <div className="text-[11px] font-semibold text-zinc-400 px-0.5">
                    Прочие сохранения ({legacyCurrentSaves.length})
                  </div>
                  <div className="space-y-2" data-testid="savestates-list">
                    {legacyCurrentSaves.map((item) => (
                      <div
                        key={item.id}
                        data-testid={`savestate-card-${item.id}`}
                        className="rounded-xl bg-zinc-900/80 border border-white/10 p-2.5 flex items-center gap-2.5 sm:gap-3"
                      >
                        {renderCompactCardBody(item)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : allSaveStates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/15 bg-zinc-900/40 px-4 py-10 text-center space-y-1.5">
              <p className="text-sm font-medium text-zinc-200">
                Сохранённых состояний пока нет
              </p>
              <p className="text-xs text-zinc-400">
                Используйте кнопку сохранения на верхней панели
              </p>
            </div>
          ) : (
            <div className="space-y-2" data-testid="savestates-list">
              {allSaveStates.map((item) => (
                <div
                  key={item.id}
                  data-testid={`savestate-card-${item.id}`}
                  className="rounded-xl bg-zinc-900/80 border border-white/10 p-2.5 flex items-center gap-2.5 sm:gap-3"
                >
                  {renderCompactCardBody(item)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
