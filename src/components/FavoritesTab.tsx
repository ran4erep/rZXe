import React, { memo, useMemo, useState } from 'react';
import { Heart, Search, X } from 'lucide-react';
import { ZxArtGameSummary } from '../emulator/zxartCatalog';
import { filterFavoriteGames } from '../emulator/favoritesStorage';
import {
  SaveStateMeta,
  extractZxArtProdIdFromKey,
  getSaveStateGameKey,
} from '../emulator/saveStateStorage';
import { ZxArtGameCard } from './ZxArtCatalog';

interface FavoritesTabProps {
  favorites: readonly ZxArtGameSummary[];
  saveStates: readonly SaveStateMeta[];
  onSelectGame: (game: ZxArtGameSummary) => void;
  onToggleFavorite: (game: ZxArtGameSummary) => void;
  onGoToCatalog: () => void;
}

export const FavoritesTab: React.FC<FavoritesTabProps> = memo(({
  favorites,
  saveStates,
  onSelectGame,
  onToggleFavorite,
  onGoToCatalog,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const saveStats = useMemo(() => {
    const byProdId = new Map<number, number>();
    const byLegacyTitle = new Map<string, number>();
    for (let i = 0; i < saveStates.length; i++) {
      const key = getSaveStateGameKey(saveStates[i]);
      const prodId = extractZxArtProdIdFromKey(key);
      if (prodId !== null) {
        byProdId.set(prodId, (byProdId.get(prodId) ?? 0) + 1);
      } else if (key.startsWith('game:')) {
        byLegacyTitle.set(key, (byLegacyTitle.get(key) ?? 0) + 1);
      }
    }
    return { byProdId, byLegacyTitle };
  }, [saveStates]);

  const filteredFavorites = useMemo(
    () => filterFavoriteGames(favorites, searchQuery),
    [favorites, searchQuery]
  );

  if (favorites.length === 0) {
    return (
      <div
        data-testid="favorites-empty-state"
        className="flex-1 min-h-0 flex flex-col items-center justify-center text-center p-6 gap-3"
      >
        <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-white/10 flex items-center justify-center text-zinc-500">
          <Heart className="w-6 h-6" />
        </div>
        <div className="space-y-1 max-w-sm">
          <h3 className="text-sm font-semibold text-zinc-100">В избранном пока пусто</h3>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Нажмите на иконку сердечка на любой игре в каталоге ZX-Art, чтобы добавить её в этот список.
          </p>
        </div>
        <button
          type="button"
          onClick={onGoToCatalog}
          className="h-9 px-4 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold cursor-pointer transition-colors"
        >
          Открыть каталог ZX-Art
        </button>
      </div>
    );
  }

  return (
    <div data-testid="favorites-tab-panel" className="flex-1 min-h-0 flex flex-col">
      <div className="px-4 py-2.5 border-b border-white/10 bg-[#15171d] flex items-center gap-2 shrink-0">
        <div className="relative flex-1 min-w-0">
          <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            role="searchbox"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Фильтр в избранном..."
            aria-label="Фильтр избранных игр"
            className="w-full h-9 pl-8 pr-8 rounded-lg bg-zinc-900 border border-white/12 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-white/35"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Очистить фильтр избранного"
              className="w-6 h-6 rounded text-zinc-400 hover:text-zinc-100 flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <span className="text-xs text-zinc-400 tabular-nums shrink-0">
          Игр: {filteredFavorites.length}
        </span>
      </div>

      <div className="flex-1 min-h-0 p-3 sm:p-4 overflow-y-auto overscroll-contain">
        {filteredFavorites.length === 0 ? (
          <div className="min-h-[200px] flex flex-col items-center justify-center text-center gap-2.5">
            <p className="text-sm text-zinc-400">
              Ничего не найдено по запросу «{searchQuery.trim()}»
            </p>
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-semibold text-zinc-100 cursor-pointer"
            >
              Сбросить фильтр
            </button>
          </div>
        ) : (
          <div
            data-testid="favorites-grid"
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3"
          >
            {filteredFavorites.map((game) => {
              const count =
                (saveStats.byProdId.get(game.id) ?? 0) +
                (saveStats.byLegacyTitle.get(`game:${game.title.trim().toLowerCase()}`) ?? 0);
              return (
                <ZxArtGameCard
                  key={game.id}
                  game={game}
                  className="w-full h-[225px] sm:h-[245px]"
                  saveCount={count}
                  isFavorite={true}
                  onSelect={onSelectGame}
                  onToggleFavorite={onToggleFavorite}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});

FavoritesTab.displayName = 'FavoritesTab';
