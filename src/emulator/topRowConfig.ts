import { SPECTRUM_KEYS, SpectrumKeySpec } from './keyboard';

export const DEFAULT_TOP_ROW_IDS: readonly string[] = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '0',
];

const GLOBAL_STORAGE_KEY = 'zx_top_row_global_v1';
const PER_GAME_STORAGE_KEY = 'zx_top_row_games_v1';

export const KEY_SPEC_BY_ID = new Map<string, SpectrumKeySpec>();
for (const row of SPECTRUM_KEYS) {
  for (const spec of row) {
    KEY_SPEC_BY_ID.set(spec.id, spec);
  }
}

export function normalizeTopRowIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length !== DEFAULT_TOP_ROW_IDS.length) {
    return null;
  }
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (typeof id !== 'string' || !KEY_SPEC_BY_ID.has(id)) {
      return null;
    }
    out.push(id);
  }
  return out;
}

export function normalizeGameMappingKey(gameTitle: string | null | undefined): string | null {
  if (!gameTitle) return null;
  const trimmed = gameTitle.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function getSafeStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
  return null;
}

export function loadGlobalTopRowIds(): string[] {
  const storage = getSafeStorage();
  if (!storage) return [...DEFAULT_TOP_ROW_IDS];
  try {
    const raw = storage.getItem(GLOBAL_STORAGE_KEY);
    if (!raw) return [...DEFAULT_TOP_ROW_IDS];
    const parsed = normalizeTopRowIds(JSON.parse(raw));
    return parsed ?? [...DEFAULT_TOP_ROW_IDS];
  } catch {
    return [...DEFAULT_TOP_ROW_IDS];
  }
}

export function saveGlobalTopRowIds(ids: readonly string[]): void {
  const normalized = normalizeTopRowIds(ids);
  if (!normalized) return;
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    storage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore quota errors
  }
}

function readPerGameMap(storage: Storage): Record<string, string[]> {
  try {
    const raw = storage.getItem(PER_GAME_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const clean: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const normalized = normalizeTopRowIds(v);
      if (normalized) {
        clean[k] = normalized;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function loadGameTopRowIds(gameKey: string): string[] | null {
  const key = normalizeGameMappingKey(gameKey);
  if (!key) return null;
  const storage = getSafeStorage();
  if (!storage) return null;
  const map = readPerGameMap(storage);
  return map[key] ? [...map[key]] : null;
}

export function saveGameTopRowIds(
  gameKey: string,
  ids: readonly string[],
  fallbackGameKey?: string | null
): void {
  const key = normalizeGameMappingKey(gameKey);
  const normalized = normalizeTopRowIds(ids);
  if (!key || !normalized) return;
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    const map = readPerGameMap(storage);
    map[key] = normalized;
    const fallback = normalizeGameMappingKey(fallbackGameKey);
    if (fallback && fallback !== key && fallback in map) {
      delete map[fallback];
    }
    storage.setItem(PER_GAME_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota errors
  }
}

export function clearGameTopRowIds(
  gameKey: string,
  fallbackGameKey?: string | null
): void {
  const key = normalizeGameMappingKey(gameKey);
  const fallback = normalizeGameMappingKey(fallbackGameKey);
  if (!key && !fallback) return;
  const storage = getSafeStorage();
  if (!storage) return;
  try {
    const map = readPerGameMap(storage);
    let changed = false;
    if (key && key in map) {
      delete map[key];
      changed = true;
    }
    if (fallback && fallback in map) {
      delete map[fallback];
      changed = true;
    }
    if (changed) {
      storage.setItem(PER_GAME_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // Ignore quota errors
  }
}

export function resolveTopRowIds(
  gameKey: string | null | undefined,
  sessionOverride: readonly string[] | null,
  fallbackGameKey?: string | null
): string[] {
  const key = normalizeGameMappingKey(gameKey);
  const fallback = normalizeGameMappingKey(fallbackGameKey);
  if (key || fallback) {
    if (key) {
      const perGame = loadGameTopRowIds(key);
      if (perGame) return perGame;
    }
    if (fallback && fallback !== key) {
      const perFallback = loadGameTopRowIds(fallback);
      if (perFallback) return perFallback;
    }
  } else if (sessionOverride) {
    const valid = normalizeTopRowIds(sessionOverride);
    if (valid) return valid;
  }
  return loadGlobalTopRowIds();
}
