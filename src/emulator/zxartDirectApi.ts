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
import { shouldUnzipEntry } from './archiveExtractor';

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
    id: 'corsmirror',
    label: 'corsmirror.com',
    buildUrl: (targetUrl) =>
      `https://corsmirror.com/v1?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'isteed',
    label: 'cors.isteed.cc',
    buildUrl: (targetUrl) => `https://cors.isteed.cc/${encodeRawPathChars(targetUrl)}`,
  },
  {
    id: 'allorigins-hexlet',
    label: 'allorigins.hexlet.app',
    buildUrl: (targetUrl) =>
      `https://allorigins.hexlet.app/raw?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'cors-eu-org',
    label: 'cors.eu.org',
    buildUrl: (targetUrl) => `https://cors.eu.org/${encodeRawPathChars(targetUrl)}`,
  },
  {
    id: 'allorigins-raw',
    label: 'api.allorigins.win',
    buildUrl: (targetUrl) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
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
// Runtime Browser Fetchers (Direct ZX-Art API + External CORS Proxies Only)
// ============================================================================

const PROXY_PREF_STORAGE_KEY = 'zxart_proxy_pref_v2';
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const TRANSIENT_COOLDOWN_MS = 18_000;

let preferredExternalProxyIndex = 0;
let stateHydrated = false;
const PROXY_COOLDOWN_UNTIL = new Map<string, number>();

const DOWNLOADED_FILE_CACHE = new Map<string, Uint8Array>();
const MAX_CACHED_DOWNLOAD_ENTRIES = 8;
const MAX_CACHED_DOWNLOAD_ITEM_BYTES = 2 * 1024 * 1024;

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

function hydrateProxyStateOnce(): void {
  if (stateHydrated) return;
  stateHydrated = true;

  const ls = getSafeLocalStorage();
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
}

function rememberPreferredProxy(index: number, id: string): void {
  preferredExternalProxyIndex = index;
  PROXY_COOLDOWN_UNTIL.delete(id);
  const ls = getSafeLocalStorage();
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

export function resetProxyDiscoveryForTests(): void {
  preferredExternalProxyIndex = 0;
  stateHydrated = false;
  PROXY_COOLDOWN_UNTIL.clear();
  DOWNLOADED_FILE_CACHE.clear();

  const ls = getSafeLocalStorage();
  if (ls) {
    try {
      ls.removeItem(PROXY_PREF_STORAGE_KEY);
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
  hydrateProxyStateOnce();
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

export async function fetchZxArtCategoriesSmart(signal?: AbortSignal): Promise<ZxArtCategory[]> {
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
  const rawJson = await fetchJsonDirect(buildZxArtDirectReleasesUrl(prodId), signal);
  return parseZxArtReleasesResponse(rawJson);
}

const EXTERNAL_PROXY_HEADER_TIMEOUT_MS = 12_000;
const STREAM_STALL_TIMEOUT_MS = 15_000;
const ZIP_SELECTIVE_RANGE_MIN_BYTES = 4 * 1024 * 1024;
const ZIP_RANGE_COALESCE_GAP_BYTES = 64 * 1024;
const ZIP_RANGE_MAX_SPAN_BYTES = 8 * 1024 * 1024;
const HEDGE_STAGGER_MS = 700;
const MAX_CONCURRENT_HEDGES = 3;

const ZIP_UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

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

function concatUint8Chunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1 && chunks[0].byteLength === totalBytes) {
    return chunks[0];
  }
  const out = new Uint8Array(totalBytes);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

class HtmlOrJsonProxyError extends Error {
  constructor() {
    super('Proxy returned HTML/JSON error payload');
  }
}

class LargeZipRangeSwitchSignal extends Error {
  constructor(
    public readonly totalBytes: number,
    public readonly firstChunk: Uint8Array
  ) {
    super('Large ZIP detected for selective range fetch');
  }
}

async function readResponseStreamWithWatchdog(
  res: Response,
  ctrl: AbortController,
  contentType: string | null,
  options: {
    stallTimeoutMs: number;
    detectLargeZip: boolean;
    onValidFirstChunk?: () => void;
  }
): Promise<Uint8Array> {
  const hasContentEncoding = Boolean(res.headers.get('content-encoding'));
  const rawContentLen = Number(res.headers.get('content-length') ?? 0);
  const expectedLen =
    !hasContentEncoding && Number.isFinite(rawContentLen) && rawContentLen > 0
      ? Math.floor(rawContentLen)
      : 0;

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (isHtmlOrJsonErrorPayload(buf, contentType)) {
      throw new HtmlOrJsonProxyError();
    }
    options.onValidFirstChunk?.();
    return buf;
  }

  const reader = res.body.getReader();
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const armStallTimer = () => {
    if (stallTimer !== null) globalThis.clearTimeout(stallTimer);
    stallTimer = globalThis.setTimeout(
      () => ctrl.abort(new Error('stream stall timeout')),
      options.stallTimeoutMs
    );
  };

  let prealloc: Uint8Array | null = null;
  if (expectedLen > 0) {
    try {
      prealloc = new Uint8Array(expectedLen);
    } catch {
      prealloc = null;
    }
  }
  const chunks: Uint8Array[] = [];
  let totalRead = 0;
  let validatedFirstChunk = false;

  try {
    armStallTimer();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armStallTimer();
      if (!value || value.byteLength === 0) continue;

      if (!validatedFirstChunk) {
        validatedFirstChunk = true;
        if (isHtmlOrJsonErrorPayload(value, contentType)) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          throw new HtmlOrJsonProxyError();
        }
        if (
          options.detectLargeZip &&
          expectedLen > ZIP_SELECTIVE_RANGE_MIN_BYTES &&
          value.byteLength >= 4 &&
          value[0] === 0x50 &&
          value[1] === 0x4b &&
          value[2] === 0x03 &&
          value[3] === 0x04
        ) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          throw new LargeZipRangeSwitchSignal(expectedLen, value);
        }
        options.onValidFirstChunk?.();
      }

      if (prealloc !== null) {
        if (totalRead + value.byteLength <= prealloc.byteLength) {
          prealloc.set(value, totalRead);
          totalRead += value.byteLength;
          continue;
        }
        // Fallback if actual decompressed bytes exceed compressed Content-Length
        if (totalRead > 0) {
          chunks.push(prealloc.slice(0, totalRead));
        }
        prealloc = null;
      }

      chunks.push(value);
      totalRead += value.byteLength;
    }

    if (!validatedFirstChunk) {
      throw new HtmlOrJsonProxyError();
    }

    if (prealloc !== null) {
      return totalRead === prealloc.byteLength ? prealloc : prealloc.subarray(0, totalRead);
    }
    return concatUint8Chunks(chunks, totalRead);
  } finally {
    if (stallTimer !== null) {
      globalThis.clearTimeout(stallTimer);
      stallTimer = null;
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors
    }
  }
}

interface ParsedZipEocd {
  cdSize: number;
  cdOffset: number;
  totalEntries: number;
}

function parseZipEocdFromTail(tail: Uint8Array): ParsedZipEocd | null {
  if (tail.byteLength < 22) return null;
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const minOffset = Math.max(0, tail.byteLength - 65558);
  for (let i = tail.byteLength - 22; i >= minOffset; i--) {
    if (dv.getUint32(i, true) !== 0x06054b50) continue;
    const commentLen = dv.getUint16(i + 20, true);
    if (i + 22 + commentLen > tail.byteLength) continue;
    const diskNum = dv.getUint16(i + 4, true);
    const cdStartDisk = dv.getUint16(i + 6, true);
    const diskEntries = dv.getUint16(i + 8, true);
    const totalEntries = dv.getUint16(i + 10, true);
    const cdSize = dv.getUint32(i + 12, true);
    const cdOffset = dv.getUint32(i + 16, true);
    if (
      diskNum !== 0 ||
      cdStartDisk !== 0 ||
      diskEntries !== totalEntries ||
      totalEntries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      return null;
    }
    return { cdSize, cdOffset, totalEntries };
  }
  return null;
}

interface ZipCdEntry {
  name: string;
  flags: number;
  crc32: number;
  compSize: number;
  uncompSize: number;
  lfhOffset: number;
  lfhEndExclusive: number;
  cdRaw: Uint8Array;
}

function parseZipCentralDirectory(
  cd: Uint8Array,
  cdOffset: number
): ZipCdEntry[] | null {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const entries: ZipCdEntry[] = [];
  let pos = 0;

  while (pos + 46 <= cd.byteLength) {
    if (dv.getUint32(pos, true) !== 0x02014b50) {
      return null;
    }
    const flags = dv.getUint16(pos + 8, true);
    const crc32 = dv.getUint32(pos + 16, true);
    const compSize = dv.getUint32(pos + 20, true);
    const uncompSize = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const diskStart = dv.getUint16(pos + 34, true);
    const lfhOffset = dv.getUint32(pos + 42, true);

    const recordLen = 46 + nameLen + extraLen + commentLen;
    if (pos + recordLen > cd.byteLength) return null;
    if (
      diskStart !== 0 ||
      compSize === 0xffffffff ||
      uncompSize === 0xffffffff ||
      lfhOffset === 0xffffffff
    ) {
      return null;
    }

    const name = ZIP_UTF8_DECODER.decode(cd.subarray(pos + 46, pos + 46 + nameLen));
    entries.push({
      name,
      flags,
      crc32,
      compSize,
      uncompSize,
      lfhOffset,
      lfhEndExclusive: cdOffset,
      cdRaw: cd.subarray(pos, pos + recordLen),
    });

    pos += recordLen;
  }

  if (pos !== cd.byteLength) return null;

  // Sort a copy by lfhOffset so each entry gets its tight byte upper bound in the archive
  const byOffset = [...entries].sort((a, b) => a.lfhOffset - b.lfhOffset);
  for (let i = 0; i < byOffset.length; i++) {
    const cur = byOffset[i];
    const nextOff = i + 1 < byOffset.length ? byOffset[i + 1].lfhOffset : cdOffset;
    if (nextOff < cur.lfhOffset) return null;
    cur.lfhEndExclusive = nextOff;
  }

  return entries;
}

interface ByteSpanRequest {
  start: number;
  end: number; // inclusive
  entries: ZipCdEntry[];
}

function coalesceZipEntrySpans(kept: readonly ZipCdEntry[]): ByteSpanRequest[] {
  if (kept.length === 0) return [];
  const sorted = [...kept].sort((a, b) => a.lfhOffset - b.lfhOffset);
  const spans: ByteSpanRequest[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const entryStart = entry.lfhOffset;
    const entryEnd = Math.max(entryStart, entry.lfhEndExclusive - 1);
    const prev = spans.length > 0 ? spans[spans.length - 1] : null;
    if (
      prev &&
      entryStart - (prev.end + 1) <= ZIP_RANGE_COALESCE_GAP_BYTES &&
      entryEnd - prev.start + 1 <= ZIP_RANGE_MAX_SPAN_BYTES
    ) {
      prev.end = Math.max(prev.end, entryEnd);
      prev.entries.push(entry);
    } else {
      spans.push({ start: entryStart, end: entryEnd, entries: [entry] });
    }
  }

  return spans;
}

async function fetchProxyByteRange(
  candidate: { index: number; id: string; url: string },
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<{ status: number; bytes: Uint8Array | null }> {
  const expectedLen = end - start + 1;
  if (expectedLen <= 0) return { status: 0, bytes: null };

  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const headerTimer = globalThis.setTimeout(
    () => ctrl.abort(new Error('range header timeout')),
    EXTERNAL_PROXY_HEADER_TIMEOUT_MS
  );

  try {
    const res = await fetch(candidate.url, {
      signal: ctrl.signal,
      headers: { Range: `bytes=${start}-${end}` },
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
    });
    globalThis.clearTimeout(headerTimer);

    if (res.status !== 206) {
      try {
        await res.body?.cancel();
      } catch {
        // Ignore cancel errors
      }
      if (!res.ok) {
        markProxyCooldown(candidate.id, res.status);
      }
      return { status: res.status, bytes: null };
    }

    const bytes = await readResponseStreamWithWatchdog(
      res,
      ctrl,
      res.headers.get('content-type'),
      {
        stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
        detectLargeZip: false,
      }
    );
    if (bytes.byteLength !== expectedLen) {
      return { status: 206, bytes: null };
    }
    return { status: 206, bytes };
  } catch (err) {
    if (signal?.aborted) throw err;
    markProxyCooldown(candidate.id, 0);
    return { status: 0, bytes: null };
  } finally {
    globalThis.clearTimeout(headerTimer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

async function tryDownloadSelectiveZipViaRange(
  totalBytes: number,
  candidates: readonly { index: number; id: string; label: string; url: string }[],
  signal?: AbortSignal
): Promise<Uint8Array | null> {
  if (totalBytes < 22 || candidates.length === 0) return null;

  // 1) Fetch tail 64KB to locate ZIP End-Of-Central-Directory (EOCD)
  const tailStart = Math.max(0, totalBytes - 65536);
  const tailEnd = totalBytes - 1;
  let workingCandidate: { index: number; id: string; label: string; url: string } | null = null;
  let tailBytes: Uint8Array | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const probe = await fetchProxyByteRange(cand, tailStart, tailEnd, signal);
    if (probe.status === 206 && probe.bytes) {
      workingCandidate = cand;
      tailBytes = probe.bytes;
      break;
    }
  }

  if (!workingCandidate || !tailBytes) return null;

  const eocd = parseZipEocdFromTail(tailBytes);
  if (
    !eocd ||
    eocd.cdSize === 0 ||
    eocd.cdOffset + eocd.cdSize > totalBytes ||
    eocd.cdSize > 16 * 1024 * 1024
  ) {
    return null;
  }

  // Helper that fetches a range preferring the verified Range-capable proxy, with backup fallback
  const fetchRangeReliable = async (start: number, end: number): Promise<Uint8Array | null> => {
    const primary = await fetchProxyByteRange(workingCandidate!, start, end, signal);
    if (primary.status === 206 && primary.bytes) return primary.bytes;
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (cand.id === workingCandidate!.id) continue;
      const alt = await fetchProxyByteRange(cand, start, end, signal);
      if (alt.status === 206 && alt.bytes) {
        workingCandidate = cand;
        return alt.bytes;
      }
    }
    return null;
  };

  // 2) Slice Central Directory from tailBytes if already covered, else fetch via Range
  let cdBytes: Uint8Array | null = null;
  if (eocd.cdOffset >= tailStart) {
    const rel = eocd.cdOffset - tailStart;
    if (rel + eocd.cdSize <= tailBytes.byteLength) {
      cdBytes = tailBytes.subarray(rel, rel + eocd.cdSize);
    }
  }
  if (!cdBytes) {
    cdBytes = await fetchRangeReliable(eocd.cdOffset, eocd.cdOffset + eocd.cdSize - 1);
  }
  if (!cdBytes) return null;

  // 3) Parse Central Directory & keep only playable ZX Spectrum / nested-archive entries
  const allEntries = parseZipCentralDirectory(cdBytes, eocd.cdOffset);
  if (!allEntries) return null;

  const keptEntries: ZipCdEntry[] = [];
  let keptTotalSpanBytes = 0;
  for (let i = 0; i < allEntries.length; i++) {
    const entry = allEntries[i];
    if (!shouldUnzipEntry(entry.name)) continue;
    keptEntries.push(entry);
    keptTotalSpanBytes += Math.max(0, entry.lfhEndExclusive - entry.lfhOffset);
  }

  // If ZIP contains zero playable entries, emit a 22-byte empty ZIP immediately
  // instead of wasting bandwidth on unrelated PC binaries/media.
  if (keptEntries.length === 0) {
    const emptyEocd = new Uint8Array(22);
    new DataView(emptyEocd.buffer).setUint32(0, 0x06054b50, true);
    rememberPreferredProxy(workingCandidate.index, workingCandidate.id);
    return emptyEocd;
  }

  // If kept entries already make up >80% of the archive, a full sequential stream is cheaper
  if (keptTotalSpanBytes > totalBytes * 0.8) {
    return null;
  }

  // 4) Download only the kept spans via coalesced Range requests
  const spans = coalesceZipEntrySpans(keptEntries);
  const localChunks: Uint8Array[] = [];
  const newOffsets: number[] = [];
  let totalLocalBytes = 0;
  let totalCdBytes = 0;

  for (let sIdx = 0; sIdx < spans.length; sIdx++) {
    const span = spans[sIdx];
    const spanBytes = await fetchRangeReliable(span.start, span.end);
    if (!spanBytes) return null;

    for (let eIdx = 0; eIdx < span.entries.length; eIdx++) {
      const entry = span.entries[eIdx];
      const rel = entry.lfhOffset - span.start;
      if (rel < 0 || rel + 30 > spanBytes.byteLength) return null;

      const lfhDv = new DataView(spanBytes.buffer, spanBytes.byteOffset + rel, 30);
      if (lfhDv.getUint32(0, true) !== 0x04034b50) return null;
      const lfhNameLen = lfhDv.getUint16(26, true);
      const lfhExtraLen = lfhDv.getUint16(28, true);
      const localRecordLen = 30 + lfhNameLen + lfhExtraLen + entry.compSize;
      if (rel + localRecordLen > spanBytes.byteLength) return null;

      // Copy local record so we can normalize Data Descriptor bits cleanly if needed
      const localRecord = spanBytes.slice(rel, rel + localRecordLen);
      if ((entry.flags & 0x0008) !== 0) {
        const recDv = new DataView(localRecord.buffer, localRecord.byteOffset, 30);
        recDv.setUint16(6, recDv.getUint16(6, true) & ~0x0008, true);
        recDv.setUint32(14, entry.crc32, true);
        recDv.setUint32(18, entry.compSize, true);
        recDv.setUint32(22, entry.uncompSize, true);
      }

      newOffsets.push(totalLocalBytes);
      localChunks.push(localRecord);
      totalLocalBytes += localRecordLen;
      totalCdBytes += entry.cdRaw.byteLength;
    }
  }

  // 5) Reassemble compact valid ZIP containing exclusively the kept Spectrum entries
  const out = new Uint8Array(totalLocalBytes + totalCdBytes + 22);
  let writePos = 0;
  for (let i = 0; i < localChunks.length; i++) {
    out.set(localChunks[i], writePos);
    writePos += localChunks[i].byteLength;
  }

  const cdOutStart = writePos;
  let flatIdx = 0;
  for (let sIdx = 0; sIdx < spans.length; sIdx++) {
    const entries = spans[sIdx].entries;
    for (let eIdx = 0; eIdx < entries.length; eIdx++) {
      const entry = entries[eIdx];
      out.set(entry.cdRaw, writePos);
      const cdDv = new DataView(out.buffer, writePos, entry.cdRaw.byteLength);
      if ((entry.flags & 0x0008) !== 0) {
        cdDv.setUint16(8, entry.flags & ~0x0008, true);
      }
      cdDv.setUint32(42, newOffsets[flatIdx++], true);
      writePos += entry.cdRaw.byteLength;
    }
  }

  const eocdDv = new DataView(out.buffer, writePos, 22);
  eocdDv.setUint32(0, 0x06054b50, true);
  eocdDv.setUint16(4, 0, true);
  eocdDv.setUint16(6, 0, true);
  eocdDv.setUint16(8, keptEntries.length, true);
  eocdDv.setUint16(10, keptEntries.length, true);
  eocdDv.setUint32(12, totalCdBytes, true);
  eocdDv.setUint32(16, cdOutStart, true);
  eocdDv.setUint16(20, 0, true);

  rememberPreferredProxy(workingCandidate.index, workingCandidate.id);
  return out;
}

interface HedgeWaveResult {
  bytes: Uint8Array | null;
  lastStatus: number;
  fallbackToFullStream?: boolean;
}

/**
 * Races external CORS proxies with staggered hedging:
 * - starts the healthiest proxy first (zero redundant bandwidth when responsive)
 * - aborts competing idle/slower full-GET streams once one proxy begins streaming valid bytes
 * - uses header + per-chunk stall watchdog so multi-megabyte files never fail mid-transfer
 * - switches large (>4MB) ZIP files to HTTP Range selective entry retrieval when supported
 */
async function downloadViaHedgedProxyWave(
  targetUrl: string,
  ignoreCooldowns: boolean,
  skipSelectiveZip: boolean,
  signal?: AbortSignal
): Promise<HedgeWaveResult> {
  const rawCandidates = buildExternalProxyDownloadCandidates(targetUrl, preferredExternalProxyIndex);
  const queue = selectOrderedProxyCandidates(rawCandidates, Date.now(), ignoreCooldowns);
  if (queue.length === 0) {
    return { bytes: null, lastStatus: 0 };
  }

  return new Promise<HedgeWaveResult>((resolve, reject) => {
    let nextQueueIdx = 0;
    let inFlight = 0;
    let settled = false;
    let lastStatus = 0;
    let selectiveZipAttempted = skipSelectiveZip;
    let activeStreamWinner: AbortController | null = null;
    let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
    const activeControllers = new Set<AbortController>();

    const clearHedgeTimer = () => {
      if (hedgeTimer !== null) {
        globalThis.clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
    };

    const cleanupAll = () => {
      clearHedgeTimer();
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
      clearHedgeTimer();
      if (
        settled ||
        activeStreamWinner !== null ||
        nextQueueIdx >= queue.length ||
        inFlight >= MAX_CONCURRENT_HEDGES
      ) {
        return;
      }
      hedgeTimer = globalThis.setTimeout(() => {
        hedgeTimer = null;
        if (
          !settled &&
          activeStreamWinner === null &&
          nextQueueIdx < queue.length &&
          inFlight < MAX_CONCURRENT_HEDGES
        ) {
          launchNext();
        }
      }, HEDGE_STAGGER_MS);
    };

    const checkExhausted = () => {
      if (!settled && inFlight === 0 && nextQueueIdx >= queue.length) {
        settled = true;
        cleanupAll();
        resolve({ bytes: null, lastStatus });
      }
    };

    const claimStreamWinner = (winnerCtrl: AbortController) => {
      if (settled || activeStreamWinner !== null) return;
      activeStreamWinner = winnerCtrl;
      clearHedgeTimer();
      for (const other of activeControllers) {
        if (other !== winnerCtrl) {
          other.abort();
        }
      }
    };

    const launchNext = () => {
      if (settled || nextQueueIdx >= queue.length) return;
      const candidate = queue[nextQueueIdx++];
      inFlight++;

      const ctrl = new AbortController();
      activeControllers.add(ctrl);
      let headerTimeoutId: ReturnType<typeof setTimeout> | null = globalThis.setTimeout(
        () => ctrl.abort(new Error('header timeout')),
        EXTERNAL_PROXY_HEADER_TIMEOUT_MS
      );

      scheduleHedge();

      (async () => {
        try {
          const res = await fetch(candidate.url, {
            signal: ctrl.signal,
            referrerPolicy: 'no-referrer',
            credentials: 'omit',
          });
          if (headerTimeoutId !== null) {
            globalThis.clearTimeout(headerTimeoutId);
            headerTimeoutId = null;
          }

          if (!res.ok) {
            lastStatus = res.status;
            markProxyCooldown(candidate.id, res.status);
            return;
          }

          const ct = res.headers.get('content-type');
          if (
            ct &&
            (ct.toLowerCase().includes('text/html') ||
              ct.toLowerCase().includes('application/xhtml') ||
              ct.toLowerCase().includes('application/json'))
          ) {
            try {
              await res.body?.cancel();
            } catch {
              // Ignore
            }
            markProxyCooldown(candidate.id, 502);
            return;
          }

          const buf = await readResponseStreamWithWatchdog(res, ctrl, ct, {
            stallTimeoutMs: STREAM_STALL_TIMEOUT_MS,
            detectLargeZip: !selectiveZipAttempted,
            onValidFirstChunk: () => claimStreamWinner(ctrl),
          });

          if (!settled) {
            settled = true;
            rememberPreferredProxy(candidate.index, candidate.id);
            cleanupAll();
            resolve({ bytes: buf, lastStatus: 200 });
          }
        } catch (err) {
          if (err instanceof LargeZipRangeSwitchSignal && !selectiveZipAttempted && !settled) {
            selectiveZipAttempted = true;
            settled = true;
            cleanupAll();
            try {
              const rangeCandidates = [
                candidate,
                ...queue.filter((item) => item.id !== candidate.id),
              ];
              const compactZip = await tryDownloadSelectiveZipViaRange(
                err.totalBytes,
                rangeCandidates,
                signal
              );
              if (compactZip) {
                resolve({ bytes: compactZip, lastStatus: 200 });
              } else {
                resolve({ bytes: null, lastStatus: 0, fallbackToFullStream: true });
              }
            } catch (rangeErr) {
              if (signal?.aborted) {
                reject(rangeErr);
              } else {
                resolve({ bytes: null, lastStatus: 0, fallbackToFullStream: true });
              }
            }
            return;
          }

          if (err instanceof HtmlOrJsonProxyError) {
            if (!settled && !signal?.aborted) {
              markProxyCooldown(candidate.id, 502);
            }
            return;
          }

          if (!settled && !signal?.aborted && !ctrl.signal.aborted) {
            markProxyCooldown(candidate.id, 0);
          } else if (
            !settled &&
            !signal?.aborted &&
            ctrl.signal.aborted &&
            activeStreamWinner === ctrl
          ) {
            // Stream stalled mid-transfer after winning -> cool down & let backup try
            markProxyCooldown(candidate.id, 0);
          }
        } finally {
          if (headerTimeoutId !== null) {
            globalThis.clearTimeout(headerTimeoutId);
            headerTimeoutId = null;
          }
          if (activeStreamWinner === ctrl) {
            activeStreamWinner = null;
          }
          activeControllers.delete(ctrl);
          inFlight--;
          if (!settled) {
            if (nextQueueIdx < queue.length && inFlight === 0) {
              launchNext();
            } else if (nextQueueIdx < queue.length && activeStreamWinner === null) {
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

  // Download strictly via external CORS proxies (identical on AI Studio and static sites)
  let wave1 = await downloadViaHedgedProxyWave(normalizedUrl, false, false, signal);
  if (wave1.fallbackToFullStream) {
    wave1 = await downloadViaHedgedProxyWave(normalizedUrl, false, true, signal);
  }
  if (wave1.bytes) {
    cacheDownloadedFile(fileUrl, wave1.bytes);
    return wave1.bytes;
  }

  // Brief backoff before Wave 2 (tries canonical id:<id>/ URL if filename has special chars, or retries all proxies)
  await sleepAbortable(350, signal);
  const canonicalUrl = buildCanonicalZxArtDownloadUrl(normalizedUrl);
  const targetWave2 = canonicalUrl ?? normalizedUrl;
  let wave2 = await downloadViaHedgedProxyWave(targetWave2, true, false, signal);
  if (wave2.fallbackToFullStream) {
    wave2 = await downloadViaHedgedProxyWave(targetWave2, true, true, signal);
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
