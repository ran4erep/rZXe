import {
  ZXART_ALL_CATEGORY_ID,
  ZXART_GAMES_CATEGORY_ID,
  decodeHtmlEntities,
  isAllowedZxArtDownloadUrl,
  isPlayableZxProd,
  normalizeZxProd,
  sanitizeZxArtSearch,
  selectPlayableReleases,
  sortZxArtGames,
  type RawZxProd,
  type RawZxRelease,
  type ZxArtCategory,
  type ZxArtGameSummary,
  type ZxArtPlayableRelease,
  type ZxArtSortOrder,
} from './zxartCatalog';

export const ZXART_DIRECT_API_BASE = 'https://zxart.ee/api';

const ALLOWED_ORDERS = new Set<ZxArtSortOrder>(['votes,desc', 'year,desc', 'title,asc']);

export interface ZxArtDirectGamesPage {
  totalAmount: number;
  start: number;
  limit: number;
  nextStart: number;
  hasMore: boolean;
  games: ZxArtGameSummary[];
}

export interface ExternalCorsProxySpec {
  id: string;
  label: string;
  buildUrl: (targetUrl: string) => string;
}

function encodeRawPathChars(url: string): string {
  return url
    .replace(/ /g, '%20')
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D')
    .replace(/\{/g, '%7B')
    .replace(/\}/g, '%7D');
}

/**
 * Normalizes ZX-Art file URLs (real API responses frequently contain raw spaces,
 * parentheses, and brackets) without double-encoding existing %XX sequences.
 */
export function normalizeZxArtDownloadUrl(fileUrl: string): string {
  const trimmed = fileUrl.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.href.replace(/ /g, '%20');
  } catch {
    return encodeRawPathChars(trimmed);
  }
}

/**
 * Extracts canonical ID-only URL (e.g. `https://zxart.ee/releasefile/id:598761/`)
 * as a clean fallback when filenames contain special characters that strict proxies choke on.
 */
export function buildCanonicalZxArtDownloadUrl(fileUrl: string): string | null {
  try {
    const parsed = new URL(fileUrl.trim());
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'zxart.ee') {
      return null;
    }
    const m = /^\/releasefile\/(id:\d+)\//.exec(parsed.pathname);
    if (!m) return null;
    const canonical = `https://zxart.ee/releasefile/${m[1]}/`;
    return canonical === fileUrl.trim() ? null : canonical;
  } catch {
    return null;
  }
}

/**
 * Free, keyless, binary-safe public CORS proxies used automatically
 * when the app is deployed as pure static files without server.ts.
 */
export const EXTERNAL_CORS_PROXIES: readonly ExternalCorsProxySpec[] = [
  {
    id: 'allorigins-hexlet',
    label: 'allorigins.hexlet.app',
    buildUrl: (targetUrl) =>
      `https://allorigins.hexlet.app/raw?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'corsfix-sdk',
    label: 'proxy.corsfix.com',
    buildUrl: (targetUrl) =>
      `https://proxy.corsfix.com/?sdk=1&url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'cors-lol',
    label: 'api.cors.lol',
    buildUrl: (targetUrl) => `https://api.cors.lol/?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'codetabs',
    label: 'api.codetabs.com',
    buildUrl: (targetUrl) =>
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'allorigins-raw',
    label: 'api.allorigins.win',
    buildUrl: (targetUrl) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'cors-eu-org',
    label: 'cors.eu.org',
    buildUrl: (targetUrl) => `https://cors.eu.org/${encodeRawPathChars(targetUrl)}`,
  },
];

export function buildZxArtDirectCategoriesUrl(): string {
  return `${ZXART_DIRECT_API_BASE}/action:filter/export:zxProdCategory/language:rus/start:0/limit:300/filter:zxProdCategoryAll/`;
}

export function parseZxArtCategoriesResponse(rawJson: unknown): ZxArtCategory[] {
  const data = rawJson as {
    responseData?: {
      zxProdCategory?: Array<{ id?: number; title?: string; categories?: number[] }>;
    };
  } | null;

  const all = Array.isArray(data?.responseData?.zxProdCategory)
    ? data.responseData.zxProdCategory
    : [];
  const root = all.find((c) => c.id === ZXART_GAMES_CATEGORY_ID);
  const childIds = Array.isArray(root?.categories) ? root.categories : [];
  const byId = new Map<number, string>();

  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (typeof c?.id === 'number' && typeof c?.title === 'string') {
      byId.set(c.id, decodeHtmlEntities(c.title).trim());
    }
  }

  const categories: ZxArtCategory[] = [];
  for (let i = 0; i < childIds.length; i++) {
    const title = byId.get(childIds[i]);
    if (title) categories.push({ id: childIds[i], title });
  }
  categories.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  return categories;
}

export function buildZxArtDirectReleasesUrl(prodId: number): string {
  return `${ZXART_DIRECT_API_BASE}/action:filter/export:zxRelease/language:rus/start:0/limit:200/filter:zxProdId=${prodId}/`;
}

export function parseZxArtReleasesResponse(rawJson: unknown): ZxArtPlayableRelease[] {
  const data = rawJson as {
    responseData?: { zxRelease?: RawZxRelease[] };
  } | null;
  const rawReleases = Array.isArray(data?.responseData?.zxRelease)
    ? data.responseData.zxRelease
    : [];
  return selectPlayableReleases(rawReleases);
}

export function buildZxArtDirectGamesQuery(params: {
  start: number;
  limit: number;
  categoryId: number;
  order: ZxArtSortOrder;
  search: string;
}): {
  start: number;
  limit: number;
  order: ZxArtSortOrder;
  rawSearch: string;
  effectiveCategoryId: number | null;
  prodsUrl: string;
  releaseSearchUrl: string | null;
} {
  const start = Number.isFinite(params.start) && params.start >= 0 ? Math.floor(params.start) : 0;
  const limit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(60, Math.floor(params.limit)))
    : 24;
  const categoryId =
    Number.isFinite(params.categoryId) && params.categoryId >= 0
      ? Math.floor(params.categoryId)
      : ZXART_GAMES_CATEGORY_ID;
  const order: ZxArtSortOrder = ALLOWED_ORDERS.has(params.order) ? params.order : 'votes,desc';
  const rawSearch = sanitizeZxArtSearch(params.search);

  const effectiveCategoryId =
    categoryId === ZXART_ALL_CATEGORY_ID ||
    (rawSearch.length > 0 && categoryId === ZXART_GAMES_CATEGORY_ID)
      ? null
      : categoryId;

  const filterParts: string[] = [];
  if (effectiveCategoryId !== null) {
    filterParts.push(`zxProdCategory=${effectiveCategoryId}`);
  }
  if (rawSearch.length > 0) {
    filterParts.push(`zxProdSearch=${encodeURIComponent(rawSearch)}`);
  }
  const filterExpr = filterParts.length > 0 ? filterParts.join(';') : 'zxProdAll';

  const prodsUrl = `${ZXART_DIRECT_API_BASE}/action:filter/export:zxProd/language:rus/start:${start}/limit:${limit}/filter:${filterExpr}/order:${order}/`;
  const shouldSearchReleases = rawSearch.length > 0 && start === 0 && effectiveCategoryId === null;
  const releaseSearchUrl = shouldSearchReleases
    ? `${ZXART_DIRECT_API_BASE}/action:filter/export:zxRelease/language:rus/start:0/limit:40/filter:zxReleaseSearch=${encodeURIComponent(rawSearch)}/`
    : null;

  return {
    start,
    limit,
    order,
    rawSearch,
    effectiveCategoryId,
    prodsUrl,
    releaseSearchUrl,
  };
}

export function isJsonContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes('application/json') || lower.includes('+json');
}

export function isHtmlOrJsonErrorPayload(
  bytes: Uint8Array,
  contentType?: string | null
): boolean {
  if (bytes.byteLength === 0) return true;

  if (contentType) {
    const lowerType = contentType.toLowerCase();
    if (
      lowerType.includes('text/html') ||
      lowerType.includes('application/xhtml') ||
      lowerType.includes('application/json')
    ) {
      return true;
    }
  }

  // Inspect leading ASCII prefix (skipping UTF-8 BOM or whitespace) without decoding huge binaries
  let pos = 0;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    pos = 3;
  }
  while (pos < bytes.byteLength && pos < 64) {
    const ch = bytes[pos];
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      pos++;
    } else {
      break;
    }
  }

  const sliceLen = Math.min(64, bytes.byteLength - pos);
  if (sliceLen <= 0) return true;

  let head = '';
  for (let i = 0; i < sliceLen; i++) {
    const c = bytes[pos + i];
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
      return false;
    }
    head += String.fromCharCode(c);
  }
  const lowerHead = head.toLowerCase();

  if (
    lowerHead.startsWith('<!doctype') ||
    lowerHead.startsWith('<html') ||
    lowerHead.startsWith('<head') ||
    lowerHead.startsWith('<?xml')
  ) {
    return true;
  }

  if (
    lowerHead.startsWith('{"error"') ||
    lowerHead.startsWith('{"corsfix_error"') ||
    lowerHead.startsWith('{"message"') ||
    lowerHead.startsWith('{"status"') ||
    lowerHead.startsWith('rate limit') ||
    lowerHead.startsWith('error code:')
  ) {
    return true;
  }

  return false;
}

export function buildExternalProxyDownloadCandidates(
  targetUrl: string,
  preferredIndex = 0
): Array<{ index: number; id: string; label: string; url: string }> {
  if (!isAllowedZxArtDownloadUrl(targetUrl)) {
    return [];
  }

  const normalizedUrl = normalizeZxArtDownloadUrl(targetUrl);
  const count = EXTERNAL_CORS_PROXIES.length;
  const start =
    Number.isInteger(preferredIndex) && preferredIndex >= 0 && preferredIndex < count
      ? preferredIndex
      : 0;

  const out: Array<{ index: number; id: string; label: string; url: string }> = [];
  for (let offset = 0; offset < count; offset++) {
    const index = (start + offset) % count;
    const spec = EXTERNAL_CORS_PROXIES[index];
    out.push({
      index,
      id: spec.id,
      label: spec.label,
      url: spec.buildUrl(normalizedUrl),
    });
  }
  return out;
}

// ============================================================================
// Runtime Browser Fetchers (Local Server Proxy -> Direct ZX-Art / Free CORS)
// ============================================================================

type LocalProxyStatus = 'unknown' | 'available' | 'unavailable';

const PROXY_PREF_STORAGE_KEY = 'zxart_proxy_pref_v1';
const STATIC_MODE_SESSION_KEY = 'zxart_static_mode_v1';
const STATIC_MODE_TTL_MS = 3 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const TRANSIENT_COOLDOWN_MS = 18_000;

let localProxyStatus: LocalProxyStatus = 'unknown';
let localProxyProbePromise: Promise<boolean> | null = null;
let preferredExternalProxyIndex = 0;
let stateHydrated = false;
const PROXY_COOLDOWN_UNTIL = new Map<string, number>();

const DOWNLOADED_FILE_CACHE = new Map<string, Uint8Array>();
const MAX_CACHED_DOWNLOAD_ENTRIES = 8;
const MAX_CACHED_DOWNLOAD_ITEM_BYTES = 2 * 1024 * 1024;

function getSafeStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    if (typeof window !== 'undefined' && window[kind]) {
      return window[kind];
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

function hydrateProxyStateOnce(): void {
  if (stateHydrated) return;
  stateHydrated = true;

  const ls = getSafeStorage('localStorage');
  if (ls) {
    try {
      const savedId = ls.getItem(PROXY_PREF_STORAGE_KEY);
      if (savedId) {
        const idx = EXTERNAL_CORS_PROXIES.findIndex((p) => p.id === savedId);
        if (idx >= 0) {
          preferredExternalProxyIndex = idx;
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }

  const ss = getSafeStorage('sessionStorage');
  if (ss && localProxyStatus === 'unknown') {
    try {
      const raw = ss.getItem(STATIC_MODE_SESSION_KEY);
      if (raw) {
        const ts = Number(raw);
        if (Number.isFinite(ts) && Date.now() - ts < STATIC_MODE_TTL_MS) {
          localProxyStatus = 'unavailable';
        } else {
          ss.removeItem(STATIC_MODE_SESSION_KEY);
        }
      }
    } catch {
      // Ignore storage read errors
    }
  }
}

function markLocalProxyUnavailable(): void {
  localProxyStatus = 'unavailable';
  const ss = getSafeStorage('sessionStorage');
  if (ss) {
    try {
      ss.setItem(STATIC_MODE_SESSION_KEY, String(Date.now()));
    } catch {
      // Ignore quota errors
    }
  }
}

function markLocalProxyAvailable(): void {
  localProxyStatus = 'available';
  const ss = getSafeStorage('sessionStorage');
  if (ss) {
    try {
      ss.removeItem(STATIC_MODE_SESSION_KEY);
    } catch {
      // Ignore storage errors
    }
  }
}

function rememberPreferredProxy(index: number, id: string): void {
  preferredExternalProxyIndex = index;
  PROXY_COOLDOWN_UNTIL.delete(id);
  const ls = getSafeStorage('localStorage');
  if (ls) {
    try {
      ls.setItem(PROXY_PREF_STORAGE_KEY, id);
    } catch {
      // Ignore quota errors
    }
  }
}

function markProxyCooldown(id: string, status: number): void {
  const duration =
    status === 429 || status === 401 || status === 403
      ? RATE_LIMIT_COOLDOWN_MS
      : TRANSIENT_COOLDOWN_MS;
  PROXY_COOLDOWN_UNTIL.set(id, Date.now() + duration);
}

export function getLocalProxyStatus(): LocalProxyStatus {
  hydrateProxyStateOnce();
  return localProxyStatus;
}

export function resetProxyDiscoveryForTests(): void {
  localProxyStatus = 'unknown';
  localProxyProbePromise = null;
  preferredExternalProxyIndex = 0;
  stateHydrated = false;
  PROXY_COOLDOWN_UNTIL.clear();
  DOWNLOADED_FILE_CACHE.clear();

  const ls = getSafeStorage('localStorage');
  if (ls) {
    try {
      ls.removeItem(PROXY_PREF_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }
  const ss = getSafeStorage('sessionStorage');
  if (ss) {
    try {
      ss.removeItem(STATIC_MODE_SESSION_KEY);
    } catch {
      // Ignore
    }
  }
}

function combineAbortSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const timer = globalThis.setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);

  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) {
      ctrl.abort(parent.reason);
    } else {
      parent.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  return {
    signal: ctrl.signal,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      if (parent) {
        parent.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const DIRECT_API_TIMEOUT_MS = 9_500;
const LOCAL_PROXY_TIMEOUT_MS = 3_000;

async function fetchJsonViaSingleAttempt(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const { signal: attemptSignal, cleanup } = combineAbortSignals(signal, timeoutMs);
  try {
    const res = await fetch(url, {
      signal: attemptSignal,
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    if (!res.ok) {
      throw new Error(`ZX-Art API HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    cleanup();
  }
}

async function fetchJsonDirect(url: string, signal?: AbortSignal): Promise<unknown> {
  let lastErr: unknown;

  // Try direct CORS-enabled ZX-Art API (plus 1 quick retry on transient blips)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fetchJsonViaSingleAttempt(url, DIRECT_API_TIMEOUT_MS, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      if (attempt === 0) {
        await sleepAbortable(250, signal);
      }
    }
  }

  // Last-resort JSON fallback through healthy external CORS proxies if direct zxart.ee fails
  const now = Date.now();
  const proxySpecs = selectOrderedProxyCandidates(
    EXTERNAL_CORS_PROXIES.map((spec, index) => ({
      index,
      id: spec.id,
      label: spec.label,
      url: spec.buildUrl(url),
    })),
    now
  );

  for (let i = 0; i < Math.min(3, proxySpecs.length); i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const spec = proxySpecs[i];
    try {
      const json = await fetchJsonViaSingleAttempt(spec.url, 6_500, signal);
      if (json && typeof json === 'object' && 'responseData' in (json as Record<string, unknown>)) {
        rememberPreferredProxy(spec.index, spec.id);
        return json;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Не удалось загрузить данные с zxart.ee');
}

async function fetchLocalProxyJson<T>(localUrl: string, signal?: AbortSignal): Promise<T | null> {
  hydrateProxyStateOnce();
  if (localProxyStatus === 'unavailable') return null;

  // Avoid firing redundant simultaneous /api/zxart/* probes on initial page load
  if (localProxyStatus === 'unknown' && localProxyProbePromise) {
    const hasBackend = await localProxyProbePromise;
    if (!hasBackend) return null;
  }

  const runProbe = async (): Promise<{ ok: boolean; value: T | null }> => {
    const { signal: attemptSignal, cleanup } = combineAbortSignals(signal, LOCAL_PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(localUrl, { signal: attemptSignal });
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        markLocalProxyUnavailable();
        return { ok: false, value: null };
      }

      const ct = res.headers.get('content-type');
      if (!isJsonContentType(ct)) {
        // Static hosts with SPA fallback often return 200 text/html for /api/* paths
        markLocalProxyUnavailable();
        return { ok: false, value: null };
      }

      markLocalProxyAvailable();
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Ошибка сервера (${res.status})`);
      }
      return { ok: true, value: (await res.json()) as T };
    } catch (err) {
      if (signal?.aborted) throw err;
      if (localProxyStatus === 'available') throw err;
      markLocalProxyUnavailable();
      return { ok: false, value: null };
    } finally {
      cleanup();
    }
  };

  if (localProxyStatus === 'unknown') {
    let settleProbe!: (available: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      settleProbe = resolve;
    });
    localProxyProbePromise = gate;
    try {
      const result = await runProbe();
      settleProbe(result.ok);
      return result.value;
    } catch (err) {
      settleProbe(getLocalProxyStatus() === 'available');
      throw err;
    } finally {
      if (localProxyProbePromise === gate) {
        localProxyProbePromise = null;
      }
    }
  }

  const result = await runProbe();
  return result.value;
}

export async function fetchZxArtCategoriesSmart(signal?: AbortSignal): Promise<ZxArtCategory[]> {
  const localData = await fetchLocalProxyJson<{ categories?: ZxArtCategory[] }>(
    'api/zxart/categories',
    signal
  );
  if (localData && Array.isArray(localData.categories)) {
    return localData.categories;
  }

  const rawJson = await fetchJsonDirect(buildZxArtDirectCategoriesUrl(), signal);
  return parseZxArtCategoriesResponse(rawJson);
}

export async function fetchZxArtGamesSmart(
  params: {
    start: number;
    limit: number;
    categoryId: number;
    order: ZxArtSortOrder;
    search: string;
  },
  signal?: AbortSignal
): Promise<ZxArtDirectGamesPage> {
  const qs = new URLSearchParams({
    start: String(params.start),
    limit: String(params.limit),
    categoryId: String(params.categoryId),
    order: params.order,
  });
  if (params.search) qs.set('search', params.search);

  const localData = await fetchLocalProxyJson<ZxArtDirectGamesPage>(
    `api/zxart/games?${qs.toString()}`,
    signal
  );
  if (localData) {
    return localData;
  }

  // Direct CORS-enabled ZX-Art API fallback (works on static hosting with no backend)
  const q = buildZxArtDirectGamesQuery(params);

  const [prodSettled, relSearchSettled] = await Promise.allSettled([
    fetchJsonDirect(q.prodsUrl, signal) as Promise<{
      totalAmount?: number;
      responseData?: { zxProd?: RawZxProd[] };
    }>,
    q.releaseSearchUrl
      ? (fetchJsonDirect(q.releaseSearchUrl, signal) as Promise<{
          responseData?: { zxRelease?: RawZxRelease[] };
        }>)
      : Promise.resolve(null),
  ]);

  if (prodSettled.status === 'rejected') {
    throw prodSettled.reason;
  }

  const data = prodSettled.value;
  const rawList = Array.isArray(data.responseData?.zxProd) ? data.responseData.zxProd : [];
  const mergedRaw: RawZxProd[] = [...rawList];
  const seenProdIds = new Set<number>();
  for (let i = 0; i < rawList.length; i++) {
    const id = rawList[i].id;
    if (typeof id === 'number') seenProdIds.add(id);
  }

  let mergedFromReleases = false;
  if (relSearchSettled.status === 'fulfilled' && relSearchSettled.value) {
    const rawRelHits = Array.isArray(relSearchSettled.value.responseData?.zxRelease)
      ? relSearchSettled.value.responseData.zxRelease
      : [];
    const playableRelHits = selectPlayableReleases(rawRelHits);
    const playableIds = new Set(playableRelHits.map((r) => r.id));
    const missingProdIds: number[] = [];

    for (let i = 0; i < rawRelHits.length; i++) {
      const rel = rawRelHits[i];
      if (
        typeof rel.id === 'number' &&
        playableIds.has(rel.id) &&
        typeof rel.prodId === 'number' &&
        rel.prodId > 0 &&
        !seenProdIds.has(rel.prodId)
      ) {
        seenProdIds.add(rel.prodId);
        missingProdIds.push(rel.prodId);
        if (missingProdIds.length >= 30) break;
      }
    }

    if (missingProdIds.length > 0) {
      try {
        const extraUrl = `${ZXART_DIRECT_API_BASE}/action:filter/export:zxProd/language:rus/start:0/limit:30/filter:zxProdId=${missingProdIds.join(',')}/`;
        const extraData = (await fetchJsonDirect(extraUrl, signal)) as {
          responseData?: { zxProd?: RawZxProd[] };
        };
        const extraProds = Array.isArray(extraData.responseData?.zxProd)
          ? extraData.responseData.zxProd
          : [];
        if (extraProds.length > 0) {
          mergedRaw.push(...extraProds);
          mergedFromReleases = true;
        }
      } catch {
        // Non-fatal: keep primary search results
      }
    }
  }

  const playableCandidates = mergedRaw.filter(isPlayableZxProd);
  const deadProdIds = new Set<number>();

  if (q.rawSearch.length > 0 && playableCandidates.length > 0) {
    const smallReleaseIds: number[] = [];
    const checkedProds: Array<{ prodId: number; releaseIds: number[] }> = [];
    for (let i = 0; i < playableCandidates.length; i++) {
      const item = playableCandidates[i];
      if (
        typeof item.id === 'number' &&
        Array.isArray(item.releasesIds) &&
        item.releasesIds.length > 0 &&
        item.releasesIds.length <= 2
      ) {
        if (smallReleaseIds.length + item.releasesIds.length > 40) break;
        checkedProds.push({ prodId: item.id, releaseIds: item.releasesIds });
        smallReleaseIds.push(...item.releasesIds);
      }
    }

    if (smallReleaseIds.length > 0) {
      try {
        const batchUrl = `${ZXART_DIRECT_API_BASE}/action:filter/export:zxRelease/language:rus/start:0/limit:50/filter:zxReleaseId=${smallReleaseIds.join(',')}/`;
        const relBatch = (await fetchJsonDirect(batchUrl, signal)) as {
          responseData?: { zxRelease?: RawZxRelease[] };
        };
        const fetchedRels = Array.isArray(relBatch.responseData?.zxRelease)
          ? relBatch.responseData.zxRelease
          : [];
        const byProd = new Map<number, RawZxRelease[]>();
        for (let i = 0; i < fetchedRels.length; i++) {
          const rel = fetchedRels[i];
          if (typeof rel.prodId === 'number') {
            const list = byProd.get(rel.prodId);
            if (list) list.push(rel);
            else byProd.set(rel.prodId, [rel]);
          }
        }
        for (let i = 0; i < checkedProds.length; i++) {
          const entry = checkedProds[i];
          const rels = byProd.get(entry.prodId) ?? [];
          if (selectPlayableReleases(rels).length === 0) {
            deadProdIds.add(entry.prodId);
          }
        }
      } catch {
        // Non-fatal: keep candidates
      }
    }
  }

  const games: ZxArtGameSummary[] = [];
  for (let i = 0; i < playableCandidates.length; i++) {
    const item = playableCandidates[i];
    if (typeof item.id === 'number' && deadProdIds.has(item.id)) continue;
    const normalized = normalizeZxProd(item);
    if (normalized) games.push(normalized);
  }

  const finalGames = mergedFromReleases ? sortZxArtGames(games, q.order) : games;
  const apiTotal = typeof data.totalAmount === 'number' ? data.totalAmount : rawList.length;
  const nextStart = q.start + rawList.length;
  const hasMore = rawList.length > 0 && nextStart < apiTotal;

  return {
    totalAmount: hasMore ? Math.max(apiTotal, finalGames.length) : finalGames.length,
    start: q.start,
    limit: q.limit,
    nextStart,
    hasMore,
    games: finalGames,
  };
}

export async function fetchZxArtReleasesSmart(
  prodId: number,
  signal?: AbortSignal
): Promise<ZxArtPlayableRelease[]> {
  const localData = await fetchLocalProxyJson<{ releases?: ZxArtPlayableRelease[] }>(
    `api/zxart/releases/${prodId}`,
    signal
  );
  if (localData && Array.isArray(localData.releases)) {
    return localData.releases;
  }

  const rawJson = await fetchJsonDirect(buildZxArtDirectReleasesUrl(prodId), signal);
  return parseZxArtReleasesResponse(rawJson);
}

const MAX_EXTERNAL_FILE_BYTES = 25 * 1024 * 1024;
const EXTERNAL_PROXY_TIMEOUT_MS = 7_500;
const HEDGE_STAGGER_MS = 1_400;
const MAX_CONCURRENT_HEDGES = 3;

class OversizeDownloadError extends Error {
  constructor() {
    super('Файл слишком большой для загрузки');
  }
}

function selectOrderedProxyCandidates<T extends { id: string }>(
  candidates: readonly T[],
  nowMs: number,
  ignoreCooldowns = false
): T[] {
  if (ignoreCooldowns || PROXY_COOLDOWN_UNTIL.size === 0) {
    return [...candidates];
  }
  const healthy: T[] = [];
  const cooling: T[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const until = PROXY_COOLDOWN_UNTIL.get(item.id) ?? 0;
    if (until > nowMs) {
      cooling.push(item);
    } else {
      if (until !== 0) PROXY_COOLDOWN_UNTIL.delete(item.id);
      healthy.push(item);
    }
  }
  return [...healthy, ...cooling];
}

function cacheDownloadedFile(fileUrl: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CACHED_DOWNLOAD_ITEM_BYTES) return;
  if (DOWNLOADED_FILE_CACHE.has(fileUrl)) {
    DOWNLOADED_FILE_CACHE.delete(fileUrl);
  } else if (DOWNLOADED_FILE_CACHE.size >= MAX_CACHED_DOWNLOAD_ENTRIES) {
    const oldest = DOWNLOADED_FILE_CACHE.keys().next().value;
    if (oldest !== undefined) DOWNLOADED_FILE_CACHE.delete(oldest);
  }
  DOWNLOADED_FILE_CACHE.set(fileUrl, bytes);
}

interface HedgeWaveResult {
  bytes: Uint8Array | null;
  lastStatus: number;
  oversize: boolean;
}

/**
 * Races external CORS proxies with staggered hedging:
 * starts the healthiest proxy first (zero redundant bandwidth if fast),
 * overlaps backups after HEDGE_STAGGER_MS or immediately on error,
 * and aborts losing in-flight requests as soon as valid binary bytes arrive.
 */
async function downloadViaHedgedProxyWave(
  targetUrl: string,
  ignoreCooldowns: boolean,
  signal?: AbortSignal
): Promise<HedgeWaveResult> {
  const rawCandidates = buildExternalProxyDownloadCandidates(targetUrl, preferredExternalProxyIndex);
  const queue = selectOrderedProxyCandidates(rawCandidates, Date.now(), ignoreCooldowns);
  if (queue.length === 0) {
    return { bytes: null, lastStatus: 0, oversize: false };
  }

  return new Promise<HedgeWaveResult>((resolve, reject) => {
    let nextQueueIdx = 0;
    let inFlight = 0;
    let settled = false;
    let lastStatus = 0;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
    const activeControllers = new Set<AbortController>();

    const cleanupAll = () => {
      if (hedgeTimer !== null) {
        globalThis.clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', onParentAbort);
      }
      for (const ctrl of activeControllers) {
        ctrl.abort();
      }
      activeControllers.clear();
    };

    const onParentAbort = () => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', onParentAbort, { once: true });
    }

    const scheduleHedge = () => {
      if (hedgeTimer !== null) {
        globalThis.clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
      if (settled || nextQueueIdx >= queue.length || inFlight >= MAX_CONCURRENT_HEDGES) {
        return;
      }
      hedgeTimer = globalThis.setTimeout(() => {
        hedgeTimer = null;
        if (!settled && nextQueueIdx < queue.length && inFlight < MAX_CONCURRENT_HEDGES) {
          launchNext();
        }
      }, HEDGE_STAGGER_MS);
    };

    const checkExhausted = () => {
      if (!settled && inFlight === 0 && nextQueueIdx >= queue.length) {
        settled = true;
        cleanupAll();
        resolve({ bytes: null, lastStatus, oversize: false });
      }
    };

    const launchNext = () => {
      if (settled || nextQueueIdx >= queue.length) return;
      const candidate = queue[nextQueueIdx++];
      inFlight++;

      const ctrl = new AbortController();
      activeControllers.add(ctrl);
      const timeoutId = globalThis.setTimeout(
        () => ctrl.abort(new Error('timeout')),
        EXTERNAL_PROXY_TIMEOUT_MS
      );

      scheduleHedge();

      (async () => {
        try {
          const res = await fetch(candidate.url, {
            signal: ctrl.signal,
            referrerPolicy: 'no-referrer',
            credentials: 'omit',
          });
          if (!res.ok) {
            lastStatus = res.status;
            markProxyCooldown(candidate.id, res.status);
            return;
          }

          const contentLen = Number(res.headers.get('content-length') ?? 0);
          if (contentLen > MAX_EXTERNAL_FILE_BYTES) {
            throw new OversizeDownloadError();
          }

          const ct = res.headers.get('content-type');
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.byteLength > MAX_EXTERNAL_FILE_BYTES) {
            throw new OversizeDownloadError();
          }
          if (isHtmlOrJsonErrorPayload(buf, ct)) {
            markProxyCooldown(candidate.id, 502);
            return;
          }

          if (!settled) {
            settled = true;
            rememberPreferredProxy(candidate.index, candidate.id);
            cleanupAll();
            resolve({ bytes: buf, lastStatus: 200, oversize: false });
          }
        } catch (err) {
          if (err instanceof OversizeDownloadError) {
            if (!settled) {
              settled = true;
              cleanupAll();
              resolve({ bytes: null, lastStatus, oversize: true });
            }
            return;
          }
          if (!settled && !signal?.aborted) {
            markProxyCooldown(candidate.id, 0);
          }
        } finally {
          globalThis.clearTimeout(timeoutId);
          activeControllers.delete(ctrl);
          inFlight--;
          if (!settled) {
            if (nextQueueIdx < queue.length && inFlight === 0) {
              launchNext();
            } else if (nextQueueIdx < queue.length) {
              scheduleHedge();
            } else {
              checkExhausted();
            }
          }
        }
      })();
    };

    launchNext();
  });
}

export async function downloadZxArtFileSmart(
  fileUrl: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!isAllowedZxArtDownloadUrl(fileUrl)) {
    throw new Error('Недопустимый URL файла ZX-Art');
  }

  hydrateProxyStateOnce();

  const cached = DOWNLOADED_FILE_CACHE.get(fileUrl);
  if (cached) {
    // Refresh LRU order
    DOWNLOADED_FILE_CACHE.delete(fileUrl);
    DOWNLOADED_FILE_CACHE.set(fileUrl, cached);
    return cached;
  }

  const normalizedUrl = normalizeZxArtDownloadUrl(fileUrl);

  // 1. Prefer same-origin backend proxy when available (fast, no rate limits)
  if (localProxyStatus !== 'unavailable') {
    try {
      const localRes = await fetch(
        `api/zxart/download?url=${encodeURIComponent(normalizedUrl)}`,
        { signal }
      );
      const ct = localRes.headers.get('content-type');
      const isStaticSpaHtml = ct !== null && ct.toLowerCase().includes('text/html');

      if (localRes.status === 404 || localRes.status === 405 || localRes.status === 501 || isStaticSpaHtml) {
        markLocalProxyUnavailable();
      } else if (!localRes.ok) {
        markLocalProxyAvailable();
        const errBody = (await localRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Ошибка загрузки файла (${localRes.status})`);
      } else {
        const buf = new Uint8Array(await localRes.arrayBuffer());
        if (!isHtmlOrJsonErrorPayload(buf, ct)) {
          markLocalProxyAvailable();
          cacheDownloadedFile(fileUrl, buf);
          return buf;
        }
        markLocalProxyUnavailable();
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (localProxyStatus === 'available') throw err;
      markLocalProxyUnavailable();
    }
  }

  // 2. Fallback for static sites: hedged proxy racing + canonical URL & retry wave
  const wave1 = await downloadViaHedgedProxyWave(normalizedUrl, false, signal);
  if (wave1.oversize) {
    throw new Error('Файл слишком большой для загрузки');
  }
  if (wave1.bytes) {
    cacheDownloadedFile(fileUrl, wave1.bytes);
    return wave1.bytes;
  }

  // Brief backoff before Wave 2 (tries canonical id:<id>/ URL if filename has special chars, or retries all proxies)
  await sleepAbortable(350, signal);
  const canonicalUrl = buildCanonicalZxArtDownloadUrl(normalizedUrl);
  const wave2 = await downloadViaHedgedProxyWave(canonicalUrl ?? normalizedUrl, true, signal);
  if (wave2.oversize) {
    throw new Error('Файл слишком большой для загрузки');
  }
  if (wave2.bytes) {
    cacheDownloadedFile(fileUrl, wave2.bytes);
    return wave2.bytes;
  }

  const finalStatus = wave2.lastStatus || wave1.lastStatus;
  if (finalStatus === 429) {
    throw new Error(
      'Бесплатные публичные CORS-прокси временно ограничили частоту запросов (HTTP 429). Нажмите «Скачать» или попробуйте через минуту.'
    );
  }
  throw new Error(
    'Не удалось скачать файл через внешние CORS-прокси. Вы можете нажать «Скачать» для прямой загрузки и открыть файл с диска.'
  );
}
