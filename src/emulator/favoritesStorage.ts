import type { ZxArtGameSummary } from './zxartCatalog';

const FAVORITES_STORAGE_KEY = 'zx_favorites_v1';

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors
  }
  return null;
}

function cloneFavoriteSummary(game: ZxArtGameSummary): ZxArtGameSummary {
  return {
    id: game.id,
    title: game.title,
    year: game.year ?? null,
    votes: game.votes ?? null,
    votesAmount: game.votesAmount ?? null,
    coverUrl: game.coverUrl ?? null,
    fallbackImageUrl: game.fallbackImageUrl ?? null,
    genre: game.genre ?? null,
    hardware: Array.isArray(game.hardware) ? [...game.hardware] : [],
  };
}

export function sanitizeFavoriteGames(raw: unknown): ZxArtGameSummary[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const result: ZxArtGameSummary[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.id !== 'number' || !Number.isFinite(obj.id) || seen.has(obj.id)) continue;
    if (typeof obj.title !== 'string' || obj.title.trim().length === 0) continue;

    seen.add(obj.id);
    result.push({
      id: obj.id,
      title: obj.title.trim(),
      year: typeof obj.year === 'number' && Number.isFinite(obj.year) ? obj.year : null,
      votes: typeof obj.votes === 'number' && Number.isFinite(obj.votes) ? obj.votes : null,
      votesAmount:
        typeof obj.votesAmount === 'number' && Number.isFinite(obj.votesAmount)
          ? obj.votesAmount
          : null,
      coverUrl: typeof obj.coverUrl === 'string' && obj.coverUrl ? obj.coverUrl : null,
      fallbackImageUrl:
        typeof obj.fallbackImageUrl === 'string' && obj.fallbackImageUrl
          ? obj.fallbackImageUrl
          : null,
      genre: typeof obj.genre === 'string' && obj.genre ? obj.genre : null,
      hardware: Array.isArray(obj.hardware)
        ? obj.hardware.filter((h): h is string => typeof h === 'string')
        : [],
    });
  }

  return result;
}

export function toggleFavoriteGame(
  list: readonly ZxArtGameSummary[],
  game: ZxArtGameSummary
): { favorites: ZxArtGameSummary[]; added: boolean } {
  const existingIdx = list.findIndex((item) => item.id === game.id);
  if (existingIdx >= 0) {
    return {
      favorites: list.filter((item) => item.id !== game.id),
      added: false,
    };
  }
  return {
    favorites: [cloneFavoriteSummary(game), ...list],
    added: true,
  };
}

export function buildFavoriteIdSet(list: readonly ZxArtGameSummary[]): Set<number> {
  const ids = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    ids.add(list[i].id);
  }
  return ids;
}

export function filterFavoriteGames(
  list: readonly ZxArtGameSummary[],
  query: string
): ZxArtGameSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return list as ZxArtGameSummary[];
  const out: ZxArtGameSummary[] = [];
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (
      g.title.toLowerCase().includes(q) ||
      (g.genre && g.genre.toLowerCase().includes(q)) ||
      (g.year !== null && String(g.year).includes(q))
    ) {
      out.push(g);
    }
  }
  return out;
}

export function loadFavorites(): ZxArtGameSummary[] {
  const storage = getSafeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeFavoriteGames(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveFavorites(favorites: readonly ZxArtGameSummary[]): void {
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Ignore quota errors
  }
}
