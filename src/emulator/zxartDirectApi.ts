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

/**
 * Free, keyless, binary-safe public CORS proxies used automatically
 * when the app is deployed as pure static files without server.ts.
 */
export const EXTERNAL_CORS_PROXIES: readonly ExternalCorsProxySpec[] = [
  {
    id: 'cors-lol',
    label: 'api.cors.lol',
    buildUrl: (targetUrl) => `https://api.cors.lol/?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'codetabs',
    label: 'api.codetabs.com',
    buildUrl: (targetUrl) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'allorigins-raw',
    label: 'api.allorigins.win',
    buildUrl: (targetUrl) => `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
  },
  {
    id: 'cors-eu-org',
    label: 'cors.eu.org',
    buildUrl: (targetUrl) => `https://cors.eu.org/${targetUrl}`,
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
      url: spec.buildUrl(targetUrl),
    });
  }
  return out;
}

// ============================================================================
// Runtime Browser Fetchers (Local Server Proxy -> Direct ZX-Art / Free CORS)
// ============================================================================

type LocalProxyStatus = 'unknown' | 'available' | 'unavailable';

let localProxyStatus: LocalProxyStatus = 'unknown';
let preferredExternalProxyIndex = 0;

export function getLocalProxyStatus(): LocalProxyStatus {
  return localProxyStatus;
}

export function resetProxyDiscoveryForTests(): void {
  localProxyStatus = 'unknown';
  preferredExternalProxyIndex = 0;
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

async function fetchJsonDirect(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`ZX-Art API HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchLocalProxyJson<T>(localUrl: string, signal?: AbortSignal): Promise<T | null> {
  if (localProxyStatus === 'unavailable') return null;

  try {
    const res = await fetch(localUrl, { signal });
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      localProxyStatus = 'unavailable';
      return null;
    }

    const ct = res.headers.get('content-type');
    if (!isJsonContentType(ct)) {
      // Static hosts with SPA fallback often return 200 text/html for /api/* paths
      localProxyStatus = 'unavailable';
      return null;
    }

    localProxyStatus = 'available';
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(errBody.error || `Ошибка сервера (${res.status})`);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (signal?.aborted) throw err;
    if (localProxyStatus === 'available') throw err;
    localProxyStatus = 'unavailable';
    return null;
  }
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
const EXTERNAL_PROXY_TIMEOUT_MS = 6_500;

export async function downloadZxArtFileSmart(
  fileUrl: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (!isAllowedZxArtDownloadUrl(fileUrl)) {
    throw new Error('Недопустимый URL файла ZX-Art');
  }

  // 1. Prefer same-origin backend proxy when available (fast, no rate limits)
  if (localProxyStatus !== 'unavailable') {
    try {
      const localRes = await fetch(
        `api/zxart/download?url=${encodeURIComponent(fileUrl)}`,
        { signal }
      );
      const ct = localRes.headers.get('content-type');
      const isStaticSpaHtml = ct !== null && ct.toLowerCase().includes('text/html');

      if (localRes.status === 404 || localRes.status === 405 || localRes.status === 501 || isStaticSpaHtml) {
        localProxyStatus = 'unavailable';
      } else if (!localRes.ok) {
        localProxyStatus = 'available';
        const errBody = (await localRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error || `Ошибка загрузки файла (${localRes.status})`);
      } else {
        const buf = new Uint8Array(await localRes.arrayBuffer());
        if (!isHtmlOrJsonErrorPayload(buf, ct)) {
          localProxyStatus = 'available';
          return buf;
        }
        localProxyStatus = 'unavailable';
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (localProxyStatus === 'available') throw err;
      localProxyStatus = 'unavailable';
    }
  }

  // 2. Fallback for static sites: try free keyless binary-safe external CORS proxies
  const candidates = buildExternalProxyDownloadCandidates(fileUrl, preferredExternalProxyIndex);
  let lastStatus = 0;

  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const candidate = candidates[i];
    const { signal: attemptSignal, cleanup } = combineAbortSignals(signal, EXTERNAL_PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(candidate.url, { signal: attemptSignal });
      if (!res.ok) {
        lastStatus = res.status;
        continue;
      }

      const contentLen = Number(res.headers.get('content-length') ?? 0);
      if (contentLen > MAX_EXTERNAL_FILE_BYTES) {
        throw new Error('Файл слишком большой для загрузки');
      }

      const ct = res.headers.get('content-type');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_EXTERNAL_FILE_BYTES) {
        throw new Error('Файл слишком большой для загрузки');
      }
      if (isHtmlOrJsonErrorPayload(buf, ct)) {
        continue;
      }

      preferredExternalProxyIndex = candidate.index;
      return buf;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof Error && err.message === 'Файл слишком большой для загрузки') {
        throw err;
      }
      // Try next proxy candidate
    } finally {
      cleanup();
    }
  }

  if (lastStatus === 429) {
    throw new Error(
      'Бесплатные публичные CORS-прокси временно ограничили частоту запросов (HTTP 429). Нажмите «Скачать» или попробуйте через минуту.'
    );
  }
  throw new Error(
    'Не удалось скачать файл через внешние CORS-прокси. Вы можете нажать «Скачать» для прямой загрузки и открыть файл с диска.'
  );
}
