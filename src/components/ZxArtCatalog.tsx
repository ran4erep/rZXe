import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  Bookmark,
  Check,
  Clock,
  Download,
  Heart,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { computeCatalogGrid, CatalogGridLayout } from '../emulator/catalogGrid';
import {
  ZXART_ALL_CATEGORY_ID,
  ZXART_GAMES_CATEGORY_ID,
  ZxArtCategory,
  ZxArtGameSummary,
  ZxArtPlayableRelease,
  ZxArtSortOrder,
  addZxArtSearchHistory,
  buildZxArtReleaseGameKey,
  clearZxArtSearchHistory,
  extractAvailableReleaseFormats,
  filterReleasesByFormat,
  formatReleaseTypeLabel,
  formatZxArtReleaseDisplayTitle,
  getDiskReleaseTier,
  loadZxArtSearchHistory,
  removeZxArtSearchHistoryItem,
  resolveCatalogOpenSelection,
  resolveTargetMachine,
  sortReleasesForCatalogMode,
} from '../emulator/zxartCatalog';
import {
  downloadZxArtFileSmart,
  fetchZxArtCategoriesSmart,
  fetchZxArtGamesSmart,
  fetchZxArtReleasesSmart,
  normalizeZxArtDownloadUrl,
} from '../emulator/zxartDirectApi';
import {
  ExtractedEntry,
  extractPlayableFiles,
  isMountableDriveExtension,
} from '../emulator/archiveExtractor';
import { MACHINE_PROFILES, MachineId, getMachineProfile } from '../emulator/machines';
import {
  SaveStateMeta,
  extractZxArtProdIdFromKey,
  getSaveStateGameKey,
} from '../emulator/saveStateStorage';

interface GamesApiResponse {
  totalAmount: number;
  start: number;
  limit: number;
  nextStart?: number;
  hasMore?: boolean;
  games: ZxArtGameSummary[];
}

export interface ZxArtArchiveResult {
  archiveName: string;
  files: ExtractedEntry[];
  gameTitle: string;
  gameKey?: string | null;
  selectedMachine: MachineId;
  zxArtGame?: ZxArtGameSummary | null;
  targetDrive?: 0 | 1 | null;
}

interface ZxArtCatalogProps {
  isOpen: boolean;
  targetDrive: 0 | 1 | null;
  openNonce: number;
  initialGame: ZxArtGameSummary | null;
  currentMachineId: MachineId;
  saveStates: readonly SaveStateMeta[];
  favoriteIds: ReadonlySet<number>;
  externalGameRequest?: { game: ZxArtGameSummary; nonce: number } | null;
  backLabel?: string;
  onBackFromDetails?: () => void;
  onToggleFavorite: (game: ZxArtGameSummary) => void;
  onPlayFile: (
    filename: string,
    bytes: Uint8Array,
    displayTitle?: string,
    selectedMachine?: MachineId | null,
    gameKey?: string | null,
    zxArtGame?: ZxArtGameSummary | null
  ) => void;
  onInsertDiskFile: (
    drive: 0 | 1,
    filename: string,
    bytes: Uint8Array
  ) => void;
  onOpenArchivePicker: (archive: ZxArtArchiveResult) => void;
  onLoadSaveState: (id: string, zxArtGame?: ZxArtGameSummary | null) => void;
  onDeleteSaveState: (id: string) => void;
  onError: (message: string | null) => void;
}

const CLIENT_BATCH_CACHE = new Map<string, GamesApiResponse>();
const CLIENT_CATEGORIES_CACHE: { list: ZxArtCategory[] | null } = { list: null };
const CLIENT_RELEASES_CACHE = new Map<number, ZxArtPlayableRelease[]>();

const TRDOS_DISK_FORMATS = new Set(['trd', 'scl', 'fdi', 'td0', 'udi']);

function formatSaveTimestamp(ts: number): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ts);
  } catch {
    return new Date(ts).toLocaleString();
  }
}

interface GameCardProps {
  game: ZxArtGameSummary;
  width?: number;
  height?: number;
  className?: string;
  saveCount: number;
  isFavorite: boolean;
  onSelect: (game: ZxArtGameSummary) => void;
  onToggleFavorite: (game: ZxArtGameSummary) => void;
}

export const ZxArtGameCard = memo<GameCardProps>(
  ({ game, width, height, className, saveCount, isFavorite, onSelect, onToggleFavorite }) => {
    const [imgStage, setImgStage] = useState<'primary' | 'fallback' | 'placeholder'>(() =>
      game.coverUrl ? 'primary' : game.fallbackImageUrl ? 'fallback' : 'placeholder'
    );

    useEffect(() => {
      setImgStage(game.coverUrl ? 'primary' : game.fallbackImageUrl ? 'fallback' : 'placeholder');
    }, [game.id, game.coverUrl, game.fallbackImageUrl]);

    const activeSrc =
      imgStage === 'primary'
        ? game.coverUrl
        : imgStage === 'fallback'
          ? game.fallbackImageUrl
          : null;

    const handleImageError = () => {
      if (imgStage === 'primary' && game.fallbackImageUrl) {
        setImgStage('fallback');
      } else {
        setImgStage('placeholder');
      }
    };

    const sizeStyle: React.CSSProperties | undefined =
      width !== undefined && height !== undefined
        ? {
            width: `${width}px`,
            height: `${height}px`,
            contentVisibility: 'auto',
            containIntrinsicSize: `${width}px ${height}px`,
          }
        : undefined;

    return (
      <div
        data-testid="zxart-game-card"
        style={sizeStyle}
        className={`group relative flex flex-col rounded-xl overflow-hidden bg-[#14161d] border border-white/10 hover:border-white/30 transition-colors shrink-0 ${
          className ?? ''
        }`}
      >
        <button
          type="button"
          onClick={() => onSelect(game)}
          aria-label={`Выбрать версию для ${game.title}`}
          className="flex-1 min-h-0 flex flex-col text-left cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400"
        >
          {/* Cover area */}
          <div className="relative flex-1 min-h-0 w-full overflow-hidden bg-[#0e1015]">
            {activeSrc ? (
              <img
                src={activeSrc}
                alt={game.title}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={handleImageError}
                className="w-full h-full object-cover object-center transition-transform duration-200 group-hover:scale-[1.03]"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center p-3 bg-gradient-to-br from-zinc-800/80 via-zinc-900 to-black relative">
                <div
                  className="absolute top-0 right-3 w-7 h-2.5 sinclair-stripes opacity-80"
                  aria-hidden="true"
                />
                <span className="text-[11px] font-mono font-bold text-zinc-400 text-center line-clamp-3">
                  {game.title}
                </span>
              </div>
            )}

            {/* Saved states count badge */}
            {saveCount > 0 && (
              <span
                title={`Сохранений: ${saveCount}`}
                className="pointer-events-none absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-black/80 border border-emerald-400/40 text-emerald-300 text-[10px] font-mono font-semibold inline-flex items-center gap-1"
              >
                <Bookmark className="w-2.5 h-2.5 fill-current" />
                <span>{saveCount}</span>
              </span>
            )}

            {/* Hover / focus CTA */}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex items-end justify-end p-2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150">
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-600 text-white text-[11px] font-semibold shadow-lg">
                <Play className="w-3 h-3 fill-current" />
                <span>Версии</span>
              </span>
            </div>
          </div>

          {/* Title footer */}
          <div className="shrink-0 w-full px-2.5 py-2 border-t border-white/8 bg-[#161922]">
            <div className="text-xs font-semibold text-zinc-100 leading-snug line-clamp-2 break-words">
              {game.title}
            </div>
            {(game.year || game.genre) && (
              <div className="mt-0.5 text-[11px] text-zinc-400 truncate tabular-nums">
                {[game.year, game.genre].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        </button>

        {/* Favorite heart toggle button (sibling to card button, never nested) */}
        <button
          type="button"
          onClick={() => onToggleFavorite(game)}
          aria-label={
            isFavorite
              ? `Убрать «${game.title}» из избранного`
              : `Добавить «${game.title}» в избранное`
          }
          aria-pressed={isFavorite}
          title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
          data-testid={`zxart-favorite-btn-${game.id}`}
          className={`absolute top-1.5 left-1.5 z-10 w-7 h-7 rounded-lg border flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400 ${
            isFavorite
              ? 'bg-black/80 border-red-400/55 text-red-400 hover:bg-black/95 hover:text-red-300'
              : 'bg-black/65 border-white/15 text-zinc-300 hover:bg-black/90 hover:border-red-400/40 hover:text-red-300'
          }`}
        >
          <Heart className={`w-3.5 h-3.5 ${isFavorite ? 'fill-current' : ''}`} />
        </button>
      </div>
    );
  }
);

ZxArtGameCard.displayName = 'ZxArtGameCard';

export const ZxArtCatalog: React.FC<ZxArtCatalogProps> = ({
  isOpen,
  targetDrive,
  openNonce,
  initialGame,
  currentMachineId,
  saveStates,
  favoriteIds,
  externalGameRequest,
  backLabel,
  onBackFromDetails,
  onToggleFavorite,
  onPlayFile,
  onInsertDiskFile,
  onOpenArchivePicker,
  onLoadSaveState,
  onDeleteSaveState,
  onError,
}) => {
  const isDiskMode = targetDrive !== null;
  const driveLetter = targetDrive === 1 ? 'B' : 'A';
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const widthMeasureRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const searchBoxWrapRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [grid, setGrid] = useState<CatalogGridLayout | null>(null);
  const gridRef = useRef<CatalogGridLayout | null>(null);
  gridRef.current = grid;

  const [categories, setCategories] = useState<ZxArtCategory[]>(
    () => CLIENT_CATEGORIES_CACHE.list ?? []
  );
  const [categoryId, setCategoryId] = useState<number>(ZXART_GAMES_CATEGORY_ID);
  const [order, setOrder] = useState<ZxArtSortOrder>('votes,desc');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadZxArtSearchHistory());
  const [historyOpen, setHistoryOpen] = useState(false);

  const [games, setGames] = useState<ZxArtGameSummary[]>([]);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Selected game & release / model prompt state
  const [selectedGame, setSelectedGame] = useState<ZxArtGameSummary | null>(() =>
    targetDrive !== null ? initialGame : null
  );
  const selectedGameRef = useRef<ZxArtGameSummary | null>(selectedGame);
  selectedGameRef.current = selectedGame;
  const lastAppliedOpenNonceRef = useRef<number>(openNonce);
  const [releases, setReleases] = useState<ZxArtPlayableRelease[]>([]);
  const [releasesLoading, setReleasesLoading] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);
  const [releasesNonce, setReleasesNonce] = useState(0);
  const [selectedFormatFilter, setSelectedFormatFilter] = useState<string | null>(null);
  const [selectedReleaseId, setSelectedReleaseId] = useState<number | null>(null);
  const [machineByRelease, setMachineByRelease] = useState<Record<number, MachineId | 'auto'>>({});
  const [launchingRelease, setLaunchingRelease] = useState(false);
  const [downloadingReleaseId, setDownloadingReleaseId] = useState<number | null>(null);

  const nextStartRef = useRef(0);
  const queryEpochRef = useRef(0);
  const inFlightMoreRef = useRef(false);
  const moreAbortRef = useRef<AbortController | null>(null);
  const launchAbortRef = useRef<AbortController | null>(null);
  const skipHistoryCommitRef = useRef(false);

  // O(1) lookup maps: aggregate count per game card (prodId/title) AND strict per-release list
  const saveStats = useMemo(() => {
    const byProdId = new Map<number, number>();
    const byLegacyTitle = new Map<string, number>();
    const byReleaseKey = new Map<string, SaveStateMeta[]>();

    for (const s of saveStates) {
      const key = getSaveStateGameKey(s);
      const prodId = extractZxArtProdIdFromKey(key);
      if (prodId !== null) {
        byProdId.set(prodId, (byProdId.get(prodId) ?? 0) + 1);
      } else if (key.startsWith('game:')) {
        byLegacyTitle.set(key, (byLegacyTitle.get(key) ?? 0) + 1);
      }

      const list = byReleaseKey.get(key);
      if (list) {
        list.push(s);
      } else {
        byReleaseKey.set(key, [s]);
      }
    }

    return { byProdId, byLegacyTitle, byReleaseKey };
  }, [saveStates]);

  const recordSearchHistory = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSearchHistory((prev) => addZxArtSearchHistory(prev, trimmed));
  }, []);

  // Measure catalog content width & visible height once on mount and on resize (zero polling)
  useLayoutEffect(() => {
    const scrollEl = scrollContainerRef.current;
    const widthEl = widthMeasureRef.current;
    if (!scrollEl || !widthEl) return;

    const updateGrid = () => {
      const style = window.getComputedStyle(scrollEl);
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const w = widthEl.clientWidth;
      const clientH = scrollEl.clientHeight;
      if (w < 60 || clientH < 60) return;
      const h = Math.max(120, clientH - padY);

      const next = computeCatalogGrid(w, h);
      setGrid((prev) => {
        if (
          prev &&
          prev.cols === next.cols &&
          prev.rows === next.rows &&
          prev.cardWidth === next.cardWidth &&
          prev.cardHeight === next.cardHeight &&
          prev.gap === next.gap
        ) {
          return prev;
        }
        return next;
      });
    };

    updateGrid();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateGrid);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, []);

  // Close search history dropdown when modal closes or user clicks outside
  useEffect(() => {
    if (!isOpen && historyOpen) {
      setHistoryOpen(false);
    }
  }, [isOpen, historyOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (searchBoxWrapRef.current && !searchBoxWrapRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [historyOpen]);

  // Load genre subcategories once
  useEffect(() => {
    if (CLIENT_CATEGORIES_CACHE.list) return;
    const ctrl = new AbortController();
    fetchZxArtCategoriesSmart(ctrl.signal)
      .then((cats) => {
        if (!ctrl.signal.aborted) {
          CLIENT_CATEGORIES_CACHE.list = cats;
          setCategories(cats);
        }
      })
      .catch(() => {
        // Categories are optional; "Все игры" remains usable
      });
    return () => ctrl.abort();
  }, []);

  // Debounce search input smoothly and record settled queries (>= 2 chars) in search history
  useEffect(() => {
    const trimmed = searchInput.trim();
    const applyTimer = window.setTimeout(() => {
      setAppliedSearch((prev) => (prev === trimmed ? prev : trimmed));
    }, 320);

    let historyTimer: number | undefined;
    if (trimmed.length >= 2) {
      historyTimer = window.setTimeout(() => {
        if (skipHistoryCommitRef.current) {
          skipHistoryCommitRef.current = false;
          return;
        }
        recordSearchHistory(trimmed);
      }, 750);
    }

    return () => {
      window.clearTimeout(applyTimer);
      if (historyTimer !== undefined) {
        window.clearTimeout(historyTimer);
      }
    };
  }, [searchInput, recordSearchHistory]);

  const fetchBatch = useCallback(
    async (
      start: number,
      limit: number,
      signal?: AbortSignal
    ): Promise<GamesApiResponse> => {
      const cacheKey = `${categoryId}|${order}|${start}|${limit}|${appliedSearch.toLowerCase()}`;
      const cached = CLIENT_BATCH_CACHE.get(cacheKey);
      if (cached) return cached;

      const data = await fetchZxArtGamesSmart(
        {
          start,
          limit,
          categoryId,
          order,
          search: appliedSearch,
        },
        signal
      );
      if (CLIENT_BATCH_CACHE.size > 100) {
        const oldest = CLIENT_BATCH_CACHE.keys().next().value;
        if (oldest !== undefined) CLIENT_BATCH_CACHE.delete(oldest);
      }
      CLIENT_BATCH_CACHE.set(cacheKey, data);
      return data;
    },
    [categoryId, order, appliedSearch]
  );

  // Initial load whenever filters/search/reload change (never resets on mere window resize!)
  const gridReady = grid !== null;
  useEffect(() => {
    if (!gridReady || !gridRef.current) return;

    queryEpochRef.current += 1;
    const epoch = queryEpochRef.current;

    moreAbortRef.current?.abort();
    moreAbortRef.current = null;
    inFlightMoreRef.current = false;

    const ctrl = new AbortController();
    const g = gridRef.current;
    // Load at least 1 extra row below the visible fold so scrolling is immediately smooth
    const initialLimit = Math.min(60, Math.max(g.pageSize, g.cols * (g.rows + 1)));

    nextStartRef.current = 0;
    setLoadingInitial(true);
    setLoadingMore(false);
    setFetchError(null);
    setLoadMoreError(null);
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }

    fetchBatch(0, initialLimit, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted || queryEpochRef.current !== epoch) return;
        const nextOffset = typeof data.nextStart === 'number' ? data.nextStart : data.games.length;
        nextStartRef.current = nextOffset;
        setGames(data.games);
        setTotalAmount(data.totalAmount);
        setHasMore(
          typeof data.hasMore === 'boolean'
            ? data.hasMore
            : data.games.length > 0 && nextOffset < data.totalAmount
        );
        setLoadingInitial(false);
      })
      .catch((err) => {
        if (ctrl.signal.aborted || queryEpochRef.current !== epoch) return;
        setFetchError(err instanceof Error ? err.message : 'Не удалось загрузить каталог ZX-Art');
        setLoadingInitial(false);
      });

    return () => ctrl.abort();
  }, [gridReady, fetchBatch, reloadNonce]);

  const loadMore = useCallback(() => {
    if (
      inFlightMoreRef.current ||
      loadingInitial ||
      !hasMore ||
      !gridRef.current ||
      selectedGame !== null
    ) {
      return;
    }

    const epoch = queryEpochRef.current;
    const g = gridRef.current;
    const batchLimit = Math.min(60, Math.max(g.cols * 2, g.pageSize));
    const start = nextStartRef.current;

    inFlightMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);

    const ctrl = new AbortController();
    moreAbortRef.current = ctrl;

    fetchBatch(start, batchLimit, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted || queryEpochRef.current !== epoch) return;
        const nextOffset =
          typeof data.nextStart === 'number' ? data.nextStart : start + data.games.length;
        nextStartRef.current = nextOffset;
        setGames((prev) => {
          if (data.games.length === 0) return prev;
          const seen = new Set(prev.map((item) => item.id));
          const merged = [...prev];
          for (const item of data.games) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              merged.push(item);
            }
          }
          return merged;
        });
        setTotalAmount(data.totalAmount);
        setHasMore(
          typeof data.hasMore === 'boolean'
            ? data.hasMore
            : data.games.length > 0 && nextOffset < data.totalAmount
        );
      })
      .catch((err) => {
        if (ctrl.signal.aborted || queryEpochRef.current !== epoch) return;
        setLoadMoreError(err instanceof Error ? err.message : 'Ошибка догрузки списка');
      })
      .finally(() => {
        if (queryEpochRef.current === epoch) {
          inFlightMoreRef.current = false;
          setLoadingMore(false);
        }
      });
  }, [fetchBatch, hasMore, loadingInitial, selectedGame]);

  // Zero-CPU-overhead IntersectionObserver to append next rows as user scrolls
  useEffect(() => {
    const root = scrollContainerRef.current;
    const target = sentinelRef.current;
    if (
      !root ||
      !target ||
      loadingInitial ||
      !hasMore ||
      fetchError ||
      loadMoreError ||
      selectedGame !== null
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      {
        root,
        rootMargin: '280px 0px',
        threshold: 0,
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [loadMore, loadingInitial, hasMore, fetchError, loadMoreError, games.length, selectedGame]);

  // Load releases list whenever a game is selected
  useEffect(() => {
    if (!selectedGame) return;

    const cached = CLIENT_RELEASES_CACHE.get(selectedGame.id);
    if (cached) {
      setReleases(cached);
      setReleasesLoading(false);
      setReleasesError(null);
      setSelectedFormatFilter(null);
      setSelectedReleaseId(null);
      return;
    }

    const ctrl = new AbortController();
    setReleasesLoading(true);
    setReleasesError(null);
    setReleases([]);
    setSelectedFormatFilter(null);
    setSelectedReleaseId(null);

    fetchZxArtReleasesSmart(selectedGame.id, ctrl.signal)
      .then((list) => {
        if (ctrl.signal.aborted) return;
        if (CLIENT_RELEASES_CACHE.size > 100) {
          const oldest = CLIENT_RELEASES_CACHE.keys().next().value;
          if (oldest !== undefined) CLIENT_RELEASES_CACHE.delete(oldest);
        }
        CLIENT_RELEASES_CACHE.set(selectedGame.id, list);
        setReleases(list);
        setSelectedReleaseId(null);
        setReleasesLoading(false);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setReleasesError(
          err instanceof Error ? err.message : 'Не удалось загрузить версии игры с zxart.ee'
        );
        setReleasesLoading(false);
      });

    return () => ctrl.abort();
  }, [selectedGame, releasesNonce]);

  useEffect(() => {
    if (!isOpen || lastAppliedOpenNonceRef.current === openNonce) return;
    lastAppliedOpenNonceRef.current = openNonce;
    if (targetDrive !== null) {
      launchAbortRef.current?.abort();
      launchAbortRef.current = null;
      setLaunchingRelease(false);
      setDownloadingReleaseId(null);
      setHistoryOpen(false);
      setMachineByRelease({});
      setSelectedFormatFilter(null);
      setSelectedReleaseId(null);
      setSelectedGame(
        resolveCatalogOpenSelection('disk', selectedGameRef.current, initialGame)
      );
      onError(null);
    }
  }, [isOpen, openNonce, targetDrive, initialGame, onError]);

  const lastExternalNonceRef = useRef<number>(externalGameRequest?.nonce ?? 0);
  useEffect(() => {
    if (!externalGameRequest || externalGameRequest.nonce === lastExternalNonceRef.current) return;
    lastExternalNonceRef.current = externalGameRequest.nonce;
    launchAbortRef.current?.abort();
    launchAbortRef.current = null;
    setLaunchingRelease(false);
    setDownloadingReleaseId(null);
    setHistoryOpen(false);
    setMachineByRelease({});
    setSelectedFormatFilter(null);
    setSelectedReleaseId(null);
    setSelectedGame(externalGameRequest.game);
    onError(null);
  }, [externalGameRequest, onError]);

  useEffect(() => {
    return () => {
      launchAbortRef.current?.abort();
    };
  }, []);

  const handleOpenGame = useCallback(
    (game: ZxArtGameSummary) => {
      const activeQuery = searchInput.trim() || appliedSearch.trim();
      if (activeQuery.length >= 2) {
        recordSearchHistory(activeQuery);
      }
      setHistoryOpen(false);
      onError(null);
      setMachineByRelease({});
      setSelectedFormatFilter(null);
      setSelectedReleaseId(null);
      setSelectedGame(game);
    },
    [onError, searchInput, appliedSearch, recordSearchHistory]
  );

  const handleBackToCatalog = useCallback(() => {
    launchAbortRef.current?.abort();
    launchAbortRef.current = null;
    setLaunchingRelease(false);
    setDownloadingReleaseId(null);
    setSelectedFormatFilter(null);
    setSelectedGame(null);
    onError(null);
    onBackFromDetails?.();
  }, [onError, onBackFromDetails]);

  const displayedReleases = useMemo(
    () => sortReleasesForCatalogMode(releases, isDiskMode ? 'disk' : 'game'),
    [releases, isDiskMode]
  );

  const availableFormats = useMemo(
    () => extractAvailableReleaseFormats(displayedReleases),
    [displayedReleases]
  );

  const activeFormatFilter = useMemo(() => {
    if (!selectedFormatFilter) return null;
    for (let i = 0; i < availableFormats.length; i++) {
      if (availableFormats[i].format === selectedFormatFilter) {
        return selectedFormatFilter;
      }
    }
    return null;
  }, [availableFormats, selectedFormatFilter]);

  const filteredReleases = useMemo(
    () => filterReleasesByFormat(displayedReleases, activeFormatFilter),
    [displayedReleases, activeFormatFilter]
  );

  const selectedRelease = useMemo(
    () => filteredReleases.find((r) => r.id === selectedReleaseId) ?? filteredReleases[0] ?? null,
    [filteredReleases, selectedReleaseId]
  );

  const machineChoice: MachineId | 'auto' =
    selectedRelease !== null ? (machineByRelease[selectedRelease.id] ?? 'auto') : 'auto';
  const autoMachineId = selectedRelease?.recommendedMachine ?? currentMachineId;
  const resolvedMachineId = resolveTargetMachine(
    machineChoice,
    selectedRelease?.recommendedMachine ?? null,
    currentMachineId
  );
  const resolvedProfile = getMachineProfile(resolvedMachineId);
  const autoProfile = getMachineProfile(autoMachineId);
  const selectedNeedsTrdosNote =
    !isDiskMode &&
    selectedRelease !== null &&
    !resolvedProfile.hasTrdos &&
    (selectedRelease.formats.some((f) => TRDOS_DISK_FORMATS.has(f)) ||
      selectedRelease.hardwareRequired.some((h) => h.toLowerCase() === 'trdos'));

  const handleLaunchSelected = useCallback(async () => {
    if (!selectedGame || !selectedRelease || launchingRelease) return;

    onError(null);
    setLaunchingRelease(true);
    const ctrl = new AbortController();
    launchAbortRef.current = ctrl;

    try {
      const buf = await downloadZxArtFileSmart(selectedRelease.fileUrl, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const extractMode = targetDrive !== null ? 'disk' : 'game';
      const extracted = await extractPlayableFiles(selectedRelease.fileName, buf, extractMode);
      if (ctrl.signal.aborted) return;

      const gameKey = buildZxArtReleaseGameKey(selectedGame.id, selectedRelease.id);
      const releaseDisplayTitle = formatZxArtReleaseDisplayTitle(
        selectedGame.title,
        selectedRelease
      );

      if (targetDrive !== null) {
        if (extracted.kind === 'single') {
          if (!isMountableDriveExtension(extracted.file.ext)) {
            throw new Error(`Файл «${extracted.file.name}» не является образом дискеты ZX Spectrum`);
          }
          onInsertDiskFile(targetDrive, extracted.file.name, extracted.file.bytes);
          return;
        }

        onOpenArchivePicker({
          archiveName: `${selectedGame.title} (${extracted.archiveName})`,
          files: extracted.files,
          gameTitle: releaseDisplayTitle,
          gameKey,
          selectedMachine: currentMachineId,
          zxArtGame: selectedGame,
          targetDrive,
        });
        return;
      }

      if (extracted.kind === 'single') {
        onPlayFile(
          extracted.file.name,
          extracted.file.bytes,
          releaseDisplayTitle,
          resolvedMachineId,
          gameKey,
          selectedGame
        );
        return;
      }

      onOpenArchivePicker({
        archiveName: `${selectedGame.title} (${extracted.archiveName})`,
        files: extracted.files,
        gameTitle: releaseDisplayTitle,
        gameKey,
        selectedMachine: resolvedMachineId,
        zxArtGame: selectedGame,
        targetDrive: null,
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      onError(
        err instanceof Error
          ? err.message
          : targetDrive !== null
            ? 'Не удалось вставить образ дискеты'
            : 'Не удалось запустить выбранную версию'
      );
    } finally {
      if (launchAbortRef.current === ctrl) {
        launchAbortRef.current = null;
      }
      setLaunchingRelease(false);
    }
  }, [
    selectedGame,
    selectedRelease,
    launchingRelease,
    targetDrive,
    currentMachineId,
    resolvedMachineId,
    onError,
    onOpenArchivePicker,
    onInsertDiskFile,
    onPlayFile,
  ]);

  const handleDownloadRelease = useCallback(
    (rel: ZxArtPlayableRelease) => {
      if (downloadingReleaseId !== null) return;
      onError(null);
      setDownloadingReleaseId(rel.id);

      try {
        const link = document.createElement('a');
        link.href = normalizeZxArtDownloadUrl(rel.fileUrl);
        link.download = rel.fileName;
        link.rel = 'noopener noreferrer';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Не удалось скачать файл');
      } finally {
        setDownloadingReleaseId(null);
      }
    },
    [downloadingReleaseId, onError]
  );

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchInput.trim();
    if (trimmed) {
      recordSearchHistory(trimmed);
    }
    if (trimmed !== appliedSearch) {
      setAppliedSearch(trimmed);
    }
    setHistoryOpen(false);
    searchInputRef.current?.blur();
  };

  const handleSelectHistoryQuery = (query: string) => {
    skipHistoryCommitRef.current = true;
    setSearchInput(query);
    setAppliedSearch(query);
    recordSearchHistory(query);
    setHistoryOpen(false);
    searchInputRef.current?.blur();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="zxart-catalog">
      {/* Keep catalog grid mounted & hidden while viewing a game's releases so scroll & cache survive Back cleanly at 0 CPU cost */}
      <div className={selectedGame ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}>
        {/* Filter & search toolbar */}
        <form
          onSubmit={handleSearchSubmit}
          className="px-4 py-2.5 border-b border-white/10 bg-[#15171d] flex flex-wrap items-center gap-2 shrink-0"
        >
          <div
            ref={searchBoxWrapRef}
            className="relative basis-full sm:basis-auto sm:flex-1 min-w-[180px]"
          >
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              role="searchbox"
              inputMode="search"
              enterKeyHint="search"
              autoComplete="off"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onFocus={() => setHistoryOpen(true)}
              onClick={() => setHistoryOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && historyOpen) {
                  e.preventDefault();
                  e.stopPropagation();
                  setHistoryOpen(false);
                }
              }}
              placeholder="Поиск на zxart.ee..."
              aria-label="Поиск игр на zxart.ee"
              aria-expanded={historyOpen && searchHistory.length > 0}
              className="w-full h-9 pl-8 pr-8 rounded-lg bg-zinc-900 border border-white/12 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-white/35"
            />
            {searchInput && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const isFocused = document.activeElement === searchInputRef.current;
                  setSearchInput('');
                  setAppliedSearch('');
                  setHistoryOpen(isFocused);
                }}
                aria-label="Очистить поиск"
                className="w-6 h-6 rounded text-zinc-400 hover:text-zinc-100 flex items-center justify-center absolute right-1.5 top-1/2 -translate-y-1/2 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}

            {historyOpen && searchHistory.length > 0 && (
              <div
                data-testid="zxart-search-history"
                onMouseDown={(e) => e.preventDefault()}
                className="absolute left-0 right-0 top-full mt-1.5 z-40 rounded-xl bg-[#181b23] border border-white/15 shadow-2xl overflow-hidden"
              >
                <div className="px-3 py-1.5 border-b border-white/8 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                  <span className="font-medium">История поиска</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchHistory(clearZxArtSearchHistory());
                      setHistoryOpen(false);
                    }}
                    className="text-zinc-400 hover:text-zinc-200 cursor-pointer"
                  >
                    Очистить
                  </button>
                </div>
                <ul className="max-h-60 overflow-y-auto py-1" aria-label="Недавние запросы">
                  {searchHistory.map((item) => (
                    <li
                      key={item}
                      className="flex items-center gap-1 px-1.5 hover:bg-zinc-800/80 transition-colors"
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectHistoryQuery(item)}
                        className="flex-1 min-w-0 py-1.5 px-1.5 text-left text-xs text-zinc-200 flex items-center gap-2 cursor-pointer"
                      >
                        <Clock className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        <span className="truncate">{item}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchHistory((prev) => removeZxArtSearchHistoryItem(prev, item));
                        }}
                        aria-label={`Удалить «${item}» из истории`}
                        className="w-7 h-7 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-700/60 flex items-center justify-center shrink-0 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <select
            aria-label="Раздел и жанр"
            value={categoryId}
            onChange={(e) => setCategoryId(Number(e.target.value))}
            className="h-9 min-w-0 flex-1 sm:flex-initial px-2.5 rounded-lg bg-zinc-900 border border-white/12 text-xs text-zinc-200 focus:outline-none focus:border-white/35 cursor-pointer"
          >
            <option value={ZXART_GAMES_CATEGORY_ID}>Все игры (жанры)</option>
            <option value={ZXART_ALL_CATEGORY_ID}>Весь каталог ZX-Art</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.title}
              </option>
            ))}
          </select>

          <select
            aria-label="Сортировка"
            value={order}
            onChange={(e) => setOrder(e.target.value as ZxArtSortOrder)}
            className="h-9 min-w-0 flex-1 sm:flex-initial px-2.5 rounded-lg bg-zinc-900 border border-white/12 text-xs text-zinc-200 focus:outline-none focus:border-white/35 cursor-pointer"
          >
            <option value="votes,desc">По рейтингу</option>
            <option value="year,desc">Сначала новые</option>
            <option value="title,asc">По алфавиту</option>
          </select>
        </form>

        {/* Scrollable dynamic card catalog */}
        <div
          ref={scrollContainerRef}
          className="flex-1 min-h-0 p-3 sm:p-4 overflow-y-auto overscroll-contain"
          data-testid="zxart-scroll-container"
        >
          <div
            ref={widthMeasureRef}
            className="w-full"
            data-testid="zxart-grid-viewport"
            data-cols={grid?.cols ?? 0}
            data-rows={grid?.rows ?? 0}
          >
            {!grid || loadingInitial ? (
              <div
                style={
                  grid
                    ? {
                        display: 'grid',
                        gridTemplateColumns: `repeat(${grid.cols}, ${grid.cardWidth}px)`,
                        gridAutoRows: `${grid.cardHeight}px`,
                        gap: `${grid.gap}px`,
                        justifyContent: 'center',
                      }
                    : undefined
                }
                className={!grid ? 'grid grid-cols-2 sm:grid-cols-4 gap-3' : undefined}
                aria-busy="true"
                aria-label="Загрузка каталога ZX-Art"
              >
                {Array.from({ length: grid ? grid.pageSize : 8 }).map((_, idx) => (
                  <div
                    key={idx}
                    style={
                      grid
                        ? { width: `${grid.cardWidth}px`, height: `${grid.cardHeight}px` }
                        : { height: '210px' }
                    }
                    className="rounded-xl bg-zinc-900/70 border border-white/8 animate-pulse"
                  />
                ))}
              </div>
            ) : fetchError ? (
              <div className="min-h-[240px] flex flex-col items-center justify-center text-center gap-3 px-4">
                <p className="text-sm text-red-200 max-w-md">{fetchError}</p>
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                  className="h-9 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-semibold text-zinc-100 inline-flex items-center gap-2 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Повторить</span>
                </button>
              </div>
            ) : games.length === 0 ? (
              <div className="min-h-[240px] flex flex-col items-center justify-center text-center gap-3 px-4">
                <p className="text-sm text-zinc-400">
                  {appliedSearch
                    ? `Ничего не найдено по запросу «${appliedSearch}»`
                    : 'В этом разделе пока нет игр'}
                </p>
                {(appliedSearch || categoryId !== ZXART_GAMES_CATEGORY_ID) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setAppliedSearch('');
                      setCategoryId(ZXART_GAMES_CATEGORY_ID);
                    }}
                    className="h-9 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-semibold text-zinc-100 cursor-pointer"
                  >
                    Сбросить фильтры
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  data-testid="zxart-grid"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${grid.cols}, ${grid.cardWidth}px)`,
                    gridAutoRows: `${grid.cardHeight}px`,
                    gap: `${grid.gap}px`,
                    justifyContent: 'center',
                  }}
                >
                  {games.map((game) => {
                    const count =
                      (saveStats.byProdId.get(game.id) ?? 0) +
                      (saveStats.byLegacyTitle.get(`game:${game.title.trim().toLowerCase()}`) ?? 0);
                    return (
                      <ZxArtGameCard
                        key={game.id}
                        game={game}
                        width={grid.cardWidth}
                        height={grid.cardHeight}
                        saveCount={count}
                        isFavorite={favoriteIds.has(game.id)}
                        onSelect={handleOpenGame}
                        onToggleFavorite={onToggleFavorite}
                      />
                    );
                  })}
                </div>

                {/* Infinite scroll sentinel & status */}
                <div
                  ref={sentinelRef}
                  className="py-4 flex items-center justify-center text-xs text-zinc-400"
                >
                  {loadingMore ? (
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-zinc-400" />
                      <span>Загрузка игр…</span>
                    </span>
                  ) : loadMoreError ? (
                    <button
                      type="button"
                      onClick={loadMore}
                      className="h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-medium text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Повторить загрузку</span>
                    </button>
                  ) : !hasMore && games.length > 0 ? (
                    <span className="tabular-nums">
                      Показаны все записи ({games.length.toLocaleString('ru-RU')})
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Quiet status footer */}
        <div className="px-4 py-2 border-t border-white/10 bg-[#15171d] flex items-center justify-between gap-3 shrink-0 text-xs text-zinc-400 tabular-nums">
          <span className="truncate">
            {totalAmount > 0
              ? `Показано ${games.length.toLocaleString('ru-RU')} из ${totalAmount.toLocaleString('ru-RU')} · zxart.ee`
              : 'zxart.ee'}
          </span>
        </div>
      </div>

      {/* Game Releases / Versions & Model Selector View */}
      {selectedGame && (
        <div className="flex-1 min-h-0 flex flex-col" data-testid="zxart-game-details">
          {/* Selected Game Header */}
          <div className="px-4 py-3 border-b border-white/10 bg-[#15171d] flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleBackToCatalog}
              aria-label={`Назад к разделу «${backLabel ?? 'Каталог'}»`}
              className="h-9 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-xs font-semibold text-zinc-200 inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>{backLabel ?? 'Каталог'}</span>
            </button>

            <div className="w-10 h-12 rounded-md overflow-hidden bg-zinc-900 border border-white/10 shrink-0 hidden sm:flex items-center justify-center">
              {selectedGame.coverUrl || selectedGame.fallbackImageUrl ? (
                <img
                  src={selectedGame.coverUrl ?? selectedGame.fallbackImageUrl ?? ''}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-zinc-900 relative">
                  <div className="absolute top-0 right-1.5 w-4 h-1.5 sinclair-stripes opacity-75" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-zinc-100 truncate">{selectedGame.title}</h3>
              <div className="text-xs text-zinc-400 truncate mt-0.5 tabular-nums">
                {[
                  selectedGame.year,
                  selectedGame.genre,
                  !releasesLoading && !releasesError
                    ? activeFormatFilter
                      ? `Версий: ${filteredReleases.length} из ${releases.length}`
                      : `Версий: ${releases.length}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>

            <button
              type="button"
              onClick={() => onToggleFavorite(selectedGame)}
              aria-label={
                favoriteIds.has(selectedGame.id)
                  ? `Убрать «${selectedGame.title}» из избранного`
                  : `Добавить «${selectedGame.title}» в избранное`
              }
              aria-pressed={favoriteIds.has(selectedGame.id)}
              title={
                favoriteIds.has(selectedGame.id)
                  ? 'Убрать из избранного'
                  : 'Добавить в избранное'
              }
              data-testid="zxart-detail-favorite-btn"
              className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-red-400 ${
                favoriteIds.has(selectedGame.id)
                  ? 'bg-red-500/15 border-red-400/50 text-red-400 hover:bg-red-500/25'
                  : 'bg-zinc-800/80 border-white/10 text-zinc-300 hover:bg-zinc-700 hover:text-red-300'
              }`}
            >
              <Heart className={`w-4 h-4 ${favoriteIds.has(selectedGame.id) ? 'fill-current' : ''}`} />
            </button>
          </div>

          {/* Available format filter bar */}
          {!releasesLoading && !releasesError && availableFormats.length > 1 && (
            <div
              data-testid="zxart-format-filter"
              role="group"
              aria-label="Фильтр по формату файла"
              className="px-4 py-2 border-b border-white/10 bg-[#14161c] flex flex-wrap items-center gap-1.5 shrink-0"
            >
              <button
                type="button"
                aria-pressed={activeFormatFilter === null}
                data-testid="zxart-format-btn-all"
                onClick={() => setSelectedFormatFilter(null)}
                className={`h-7 px-2.5 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                  activeFormatFilter === null
                    ? 'bg-red-600 border-red-500 text-white'
                    : 'bg-zinc-900 hover:bg-zinc-800 border-white/10 text-zinc-300'
                }`}
              >
                <span>Все</span>
                <span className="opacity-75 tabular-nums">{displayedReleases.length}</span>
              </button>
              {availableFormats.map(({ format, count }) => {
                const isActive = activeFormatFilter === format;
                return (
                  <button
                    key={format}
                    type="button"
                    aria-pressed={isActive}
                    data-testid={`zxart-format-btn-${format}`}
                    onClick={() =>
                      setSelectedFormatFilter((cur) => (cur === format ? null : format))
                    }
                    className={`h-7 px-2.5 rounded-lg border text-[11px] font-mono font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                      isActive
                        ? 'bg-red-600 border-red-500 text-white'
                        : 'bg-zinc-900 hover:bg-zinc-800 border-white/10 text-zinc-300'
                    }`}
                  >
                    <span>.{format.toUpperCase()}</span>
                    <span className="opacity-75 tabular-nums">{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Scrollable List of Versions / Releases & Per-Version Saved States */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 sm:p-4">
            {releasesLoading ? (
              <div className="min-h-[200px] flex flex-col items-center justify-center gap-2.5 text-xs text-zinc-400">
                <Loader2 className="w-5 h-5 animate-spin text-zinc-300" />
                <span>Загрузка версий и релизов с zxart.ee…</span>
              </div>
            ) : releasesError ? (
              <div className="min-h-[200px] flex flex-col items-center justify-center text-center gap-3 px-4">
                <p className="text-sm text-red-200 max-w-md">{releasesError}</p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      CLIENT_RELEASES_CACHE.delete(selectedGame.id);
                      setReleasesNonce((n) => n + 1);
                    }}
                    className="h-9 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-semibold text-zinc-100 inline-flex items-center gap-2 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Повторить</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleBackToCatalog}
                    className="h-9 px-4 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-xs font-semibold text-zinc-300 cursor-pointer"
                  >
                    К каталогу
                  </button>
                </div>
              </div>
            ) : releases.length === 0 ? (
              <div className="min-h-[200px] flex flex-col items-center justify-center text-center gap-3 px-4">
                <p className="text-sm text-zinc-400 max-w-md">
                  Для «{selectedGame.title}» на zxart.ee нет доступных для скачивания файлов.
                </p>
                <button
                  type="button"
                  onClick={handleBackToCatalog}
                  className="h-9 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/12 text-xs font-semibold text-zinc-100 cursor-pointer"
                >
                  Назад к каталогу
                </button>
              </div>
            ) : (
              <div className="space-y-2" role="radiogroup" aria-label="Доступные версии игры">
                {filteredReleases.map((rel) => {
                  const isSelected = selectedRelease?.id === rel.id;
                  const isDownloading = downloadingReleaseId === rel.id;
                  const isNonDiskInDiskMode = isDiskMode && getDiskReleaseTier(rel) === 2;
                  const releaseKey = buildZxArtReleaseGameKey(selectedGame.id, rel.id);
                  const relSaves = saveStats.byReleaseKey.get(releaseKey) ?? [];
                  const showDistinctTitle =
                    rel.title.length > 0 &&
                    rel.title.toLowerCase() !== selectedGame.title.toLowerCase();
                  const primaryName = showDistinctTitle ? rel.title : rel.fileName;
                  const secondaryParts = [
                    showDistinctTitle ? rel.fileName : null,
                    rel.version,
                  ].filter(Boolean);
                  const formatLabel =
                    rel.formats.length > 0
                      ? rel.formats.map((f) => `.${f.toUpperCase()}`).join(' ')
                      : 'FILE';
                  const typeLabel = formatReleaseTypeLabel(rel.releaseType);

                  return (
                    <div
                      key={rel.id}
                      data-testid={`zxart-release-card-${rel.id}`}
                      className={`rounded-xl border transition-colors ${
                        isSelected
                          ? 'bg-red-500/12 border-red-500/60'
                          : 'bg-zinc-900/75 hover:bg-zinc-800/80 border-white/10'
                      } ${isNonDiskInDiskMode && !isSelected ? 'opacity-65' : ''}`}
                    >
                      <div className="flex items-stretch gap-2">
                        <button
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          data-testid="zxart-release-item"
                          onClick={() => setSelectedReleaseId(rel.id)}
                          className="min-w-0 flex-1 pl-3.5 py-2.5 text-left flex items-start gap-3 cursor-pointer"
                        >
                          <span
                            aria-hidden="true"
                            className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                              isSelected
                                ? 'bg-red-600 border-red-500 text-white'
                                : 'border-zinc-600 bg-zinc-950'
                            }`}
                          >
                            {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                          </span>

                          <div className="min-w-0 flex-1">
                            <div className="text-xs sm:text-sm font-semibold text-zinc-100 break-all">
                              {primaryName}
                            </div>

                            {secondaryParts.length > 0 && (
                              <div className="text-[11px] text-zinc-400 truncate mt-0.5">
                                {secondaryParts.join(' · ')}
                              </div>
                            )}

                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                              <span className="px-1.5 py-0.5 rounded font-mono font-semibold text-[10px] bg-zinc-800 text-zinc-200 border border-white/10">
                                {formatLabel}
                              </span>
                              {rel.languages.length > 0 && (
                                <span className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-zinc-800/80 text-zinc-300 border border-white/10">
                                  {rel.languages.join('/')}
                                </span>
                              )}
                              {relSaves.length > 0 && (
                                <span
                                  data-testid={`zxart-release-savebadge-${rel.id}`}
                                  className="px-1.5 py-0.5 rounded font-mono font-semibold text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/35 inline-flex items-center gap-1"
                                >
                                  <Bookmark className="w-2.5 h-2.5 fill-current" />
                                  <span>{relSaves.length} сохр.</span>
                                </span>
                              )}
                              <span className="text-zinc-300">{typeLabel}</span>
                              {rel.year && <span className="tabular-nums">· {rel.year}</span>}
                              {rel.hardwareRequired.length > 0 && (
                                <span className="text-zinc-500 truncate">
                                  · {rel.hardwareRequired.join(', ')}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>

                        <div className="shrink-0 flex items-center pr-2.5 py-2">
                          <button
                            type="button"
                            disabled={downloadingReleaseId !== null}
                            onClick={() => {
                              void handleDownloadRelease(rel);
                            }}
                            aria-label={`Скачать ${rel.fileName}`}
                            title={`Скачать ${rel.fileName}`}
                            data-testid="zxart-release-download"
                            className="h-8 px-2.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 disabled:opacity-55 disabled:cursor-wait border border-white/10 text-xs font-medium text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            {isDownloading ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                            ) : (
                              <Download className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <span className="hidden sm:inline">Скачать</span>
                          </button>
                        </div>
                      </div>

                      {!isDiskMode && isSelected && relSaves.length > 0 && (
                        <div
                          data-testid="zxart-release-savestates"
                          className="mx-3 mb-2.5 pt-2 border-t border-white/10 space-y-1.5"
                        >
                          <div className="text-[11px] font-semibold text-emerald-300 inline-flex items-center gap-1.5">
                            <Bookmark className="w-3 h-3 fill-current" />
                            <span>Сохранения этой версии ({relSaves.length})</span>
                          </div>
                          <div className="space-y-1.5">
                            {relSaves.map((item) => {
                              const profile = getMachineProfile(item.machineId);
                              return (
                                <div
                                  key={item.id}
                                  data-testid={`zxart-savestate-${item.id}`}
                                  className="rounded-lg bg-[#141720] border border-white/10 p-1.5 flex items-center gap-2"
                                >
                                  <div className="w-14 aspect-[4/3] rounded border border-white/10 bg-black overflow-hidden shrink-0 flex items-center justify-center">
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
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 text-[11px] text-zinc-300">
                                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-white/10 font-mono text-[10px] text-zinc-200">
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
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="button"
                                      onClick={() => onLoadSaveState(item.id, selectedGame)}
                                      aria-label={`Загрузить сохранение от ${formatSaveTimestamp(item.createdAt)}`}
                                      className="h-7 px-2.5 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-[11px] font-medium text-zinc-100 inline-flex items-center gap-1 cursor-pointer"
                                    >
                                      <Play className="w-3 h-3 text-emerald-400 shrink-0" />
                                      <span>Загрузить</span>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => onDeleteSaveState(item.id)}
                                      aria-label={`Удалить сохранение от ${formatSaveTimestamp(item.createdAt)}`}
                                      title="Удалить сохранение"
                                      className="w-7 h-7 rounded-md bg-zinc-800/70 hover:bg-red-500/20 border border-white/10 text-zinc-400 hover:text-red-300 flex items-center justify-center cursor-pointer"
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pre-Launch Computer Model Selector & Launch / Insert Action */}
          {selectedRelease && !releasesLoading && !releasesError && (
            <div
              className="px-4 py-3 border-t border-white/10 bg-[#15171d] shrink-0 space-y-2"
              data-testid="zxart-launch-panel"
            >
              {isDiskMode ? (
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-zinc-200">
                      Вставить дискету в дисковод {driveLetter}:
                    </div>
                    <div className="text-[11px] text-zinc-400 truncate mt-0.5">
                      {selectedRelease.fileName}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={launchingRelease}
                    onClick={() => {
                      void handleLaunchSelected();
                    }}
                    data-testid="zxart-insert-disk-btn"
                    className="h-9 px-5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 disabled:cursor-wait text-white text-xs font-semibold inline-flex items-center justify-center gap-2 shrink-0 cursor-pointer"
                  >
                    {launchingRelease ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Загрузка…</span>
                      </>
                    ) : (
                      <>
                        <Save className="w-3.5 h-3.5" />
                        <span>Вставить в {driveLetter}:</span>
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex flex-col sm:flex-row sm:items-end gap-2.5">
                    <label className="flex-1 min-w-0 flex flex-col gap-1">
                      <span className="text-xs font-semibold text-zinc-200">
                        Какую модель компьютера использовать для запуска?
                      </span>
                      <select
                        aria-label="Модель компьютера перед запуском"
                        value={machineChoice}
                        onChange={(e) => {
                          const nextMachine = e.target.value as MachineId | 'auto';
                          const relId = selectedRelease.id;
                          setMachineByRelease((prev) => ({
                            ...prev,
                            [relId]: nextMachine,
                          }));
                        }}
                        className="h-9 w-full px-2.5 rounded-lg bg-zinc-900 border border-white/12 text-xs text-zinc-100 focus:outline-none focus:border-white/35 cursor-pointer"
                      >
                        <option value="auto">
                          Авто — {autoProfile.name}
                        </option>
                        {MACHINE_PROFILES.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="button"
                      disabled={launchingRelease}
                      onClick={() => {
                        void handleLaunchSelected();
                      }}
                      data-testid="zxart-launch-btn"
                      className="h-9 px-5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-60 disabled:cursor-wait text-white text-xs font-semibold inline-flex items-center justify-center gap-2 shrink-0 cursor-pointer"
                    >
                      {launchingRelease ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Загрузка…</span>
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Запустить</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="text-[11px] text-zinc-400 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                    <span>{resolvedProfile.description}</span>
                    {selectedNeedsTrdosNote && (
                      <span className="text-amber-300">
                        Для TR-DOS диска автоматически активируется Beta Disk (Pentagon 128K)
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

