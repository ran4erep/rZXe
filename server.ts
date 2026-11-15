import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
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
  type ZxArtSortOrder,
} from './src/emulator/zxartCatalog.ts';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ZXART_BASE = 'https://zxart.ee/api';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class BoundedTtlCache<T> {
  private readonly maxEntries: number;
  private readonly map = new Map<string, CacheEntry<T>>();

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): T | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return null;
    }
    // Refresh LRU order
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

interface GamesPageResult {
  totalAmount: number;
  start: number;
  limit: number;
  nextStart: number;
  hasMore: boolean;
  games: ZxArtGameSummary[];
}

const gamesCache = new BoundedTtlCache<GamesPageResult>(100);
const categoriesCache = new BoundedTtlCache<ZxArtCategory[]>(4);
const releasesCache = new BoundedTtlCache<ReturnType<typeof selectPlayableReleases>>(120);

const ALLOWED_ORDERS = new Set<ZxArtSortOrder>(['votes,desc', 'year,desc', 'title,asc']);

async function fetchZxArtJson<T>(apiPath: string): Promise<T> {
  const res = await fetch(`${ZXART_BASE}/${apiPath}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ZXSpectrumEmulator/1.0',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`ZX-Art API HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function createApiRouter(): express.Router {
  const router = express.Router();

  router.get('/zxart/categories', async (_req, res) => {
    try {
      const cached = categoriesCache.get('games');
      if (cached) {
        res.json({ categories: cached });
        return;
      }

      const data = await fetchZxArtJson<{
        responseData?: {
          zxProdCategory?: Array<{ id?: number; title?: string; categories?: number[] }>;
        };
      }>('action:filter/export:zxProdCategory/language:rus/start:0/limit:300/filter:zxProdCategoryAll/');

      const all = data.responseData?.zxProdCategory ?? [];
      const root = all.find((c) => c.id === ZXART_GAMES_CATEGORY_ID);
      const childIds = Array.isArray(root?.categories) ? root.categories : [];
      const byId = new Map<number, string>();
      for (const c of all) {
        if (typeof c.id === 'number' && typeof c.title === 'string') {
          byId.set(c.id, decodeHtmlEntities(c.title).trim());
        }
      }

      const categories: ZxArtCategory[] = [];
      for (const id of childIds) {
        const title = byId.get(id);
        if (title) categories.push({ id, title });
      }
      categories.sort((a, b) => a.title.localeCompare(b.title, 'ru'));

      categoriesCache.set('games', categories, 60 * 60 * 1000);
      res.json({ categories });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Ошибка загрузки категорий ZX-Art';
      res.status(502).json({ error: message });
    }
  });

  router.get('/zxart/games', async (req, res) => {
    try {
      const rawStart = Number(req.query.start ?? 0);
      const rawLimit = Number(req.query.limit ?? 24);
      const rawCat = Number(req.query.categoryId ?? ZXART_GAMES_CATEGORY_ID);
      const rawOrder = String(req.query.order ?? 'votes,desc') as ZxArtSortOrder;
      const rawSearch = typeof req.query.search === 'string' ? sanitizeZxArtSearch(req.query.search) : '';

      const start = Number.isFinite(rawStart) && rawStart >= 0 ? Math.floor(rawStart) : 0;
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(60, Math.floor(rawLimit)))
        : 24;
      const categoryId =
        Number.isFinite(rawCat) && rawCat >= 0 ? Math.floor(rawCat) : ZXART_GAMES_CATEGORY_ID;
      const order: ZxArtSortOrder = ALLOWED_ORDERS.has(rawOrder) ? rawOrder : 'votes,desc';

      // When searching without picking a specific subgenre (All / Games root), search the entire ZX-Art catalog
      // so games categorized under Demoscene/Music/etc. are not missed (e.g. Castlevania -> 4 instead of 2).
      const effectiveCategoryId =
        categoryId === ZXART_ALL_CATEGORY_ID ||
        (rawSearch.length > 0 && categoryId === ZXART_GAMES_CATEGORY_ID)
          ? null
          : categoryId;

      const cacheKey = `${effectiveCategoryId ?? 'all'}|${order}|${start}|${limit}|${rawSearch.toLowerCase()}`;
      const cached = gamesCache.get(cacheKey);
      if (cached) {
        res.json(cached);
        return;
      }

      const filterParts: string[] = [];
      if (effectiveCategoryId !== null) {
        filterParts.push(`zxProdCategory=${effectiveCategoryId}`);
      }
      if (rawSearch.length > 0) {
        filterParts.push(`zxProdSearch=${encodeURIComponent(rawSearch)}`);
      }
      const filterExpr = filterParts.length > 0 ? filterParts.join(';') : 'zxProdAll';
      const apiPath = `action:filter/export:zxProd/language:rus/start:${start}/limit:${limit}/filter:${filterExpr}/order:${order}/`;

      const shouldSearchReleases =
        rawSearch.length > 0 && start === 0 && effectiveCategoryId === null;

      const [prodSettled, relSearchSettled] = await Promise.allSettled([
        fetchZxArtJson<{
          totalAmount?: number;
          start?: number;
          limit?: number;
          responseData?: { zxProd?: RawZxProd[] };
        }>(apiPath),
        shouldSearchReleases
          ? fetchZxArtJson<{
              responseData?: { zxRelease?: RawZxRelease[] };
            }>(
              `action:filter/export:zxRelease/language:rus/start:0/limit:40/filter:zxReleaseSearch=${encodeURIComponent(rawSearch)}/`
            )
          : Promise.resolve(null),
      ]);

      if (prodSettled.status === 'rejected') {
        throw prodSettled.reason;
      }

      const data = prodSettled.value;
      const rawList = Array.isArray(data.responseData?.zxProd) ? data.responseData.zxProd : [];
      const mergedRaw: RawZxProd[] = [...rawList];
      const seenProdIds = new Set<number>();
      for (const item of rawList) {
        if (typeof item.id === 'number') seenProdIds.add(item.id);
      }

      let mergedFromReleases = false;
      if (relSearchSettled.status === 'fulfilled' && relSearchSettled.value) {
        const rawRelHits = Array.isArray(relSearchSettled.value.responseData?.zxRelease)
          ? relSearchSettled.value.responseData.zxRelease
          : [];
        const playableRelHits = selectPlayableReleases(rawRelHits);
        const playableIds = new Set(playableRelHits.map((r) => r.id));
        const missingProdIds: number[] = [];
        for (const rel of rawRelHits) {
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
            const extraData = await fetchZxArtJson<{
              responseData?: { zxProd?: RawZxProd[] };
            }>(
              `action:filter/export:zxProd/language:rus/start:0/limit:30/filter:zxProdId=${missingProdIds.join(',')}/`
            );
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

      // When searching, verify low-release-count entries (1–2 releases) in one batch so broken ghost stubs
      // without downloadable files (e.g. missing release files on zxart.ee) don't masquerade as playable games.
      const deadProdIds = new Set<number>();
      if (rawSearch.length > 0 && playableCandidates.length > 0) {
        const smallReleaseIds: number[] = [];
        const checkedProds: Array<{ prodId: number; releaseIds: number[] }> = [];
        for (const item of playableCandidates) {
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
            const relBatch = await fetchZxArtJson<{
              responseData?: { zxRelease?: RawZxRelease[] };
            }>(
              `action:filter/export:zxRelease/language:rus/start:0/limit:50/filter:zxReleaseId=${smallReleaseIds.join(',')}/`
            );
            const fetchedRels = Array.isArray(relBatch.responseData?.zxRelease)
              ? relBatch.responseData.zxRelease
              : [];
            const byProd = new Map<number, RawZxRelease[]>();
            for (const rel of fetchedRels) {
              if (typeof rel.prodId === 'number') {
                const list = byProd.get(rel.prodId);
                if (list) list.push(rel);
                else byProd.set(rel.prodId, [rel]);
              }
            }
            for (const entry of checkedProds) {
              const rels = byProd.get(entry.prodId) ?? [];
              const playable = selectPlayableReleases(rels);
              if (playable.length === 0) {
                deadProdIds.add(entry.prodId);
              } else if (rels.length >= entry.releaseIds.length) {
                releasesCache.set(String(entry.prodId), playable, 15 * 60 * 1000);
              }
            }
          } catch {
            // Non-fatal: keep candidates if verification check fails
          }
        }
      }

      const games: ZxArtGameSummary[] = [];
      for (const item of playableCandidates) {
        if (typeof item.id === 'number' && deadProdIds.has(item.id)) continue;
        const normalized = normalizeZxProd(item);
        if (normalized) games.push(normalized);
      }

      const finalGames = mergedFromReleases ? sortZxArtGames(games, order) : games;
      const apiTotal = typeof data.totalAmount === 'number' ? data.totalAmount : rawList.length;
      const nextStart = start + rawList.length;
      const hasMore = rawList.length > 0 && nextStart < apiTotal;

      const result: GamesPageResult = {
        totalAmount: hasMore ? Math.max(apiTotal, finalGames.length) : finalGames.length,
        start,
        limit,
        nextStart,
        hasMore,
        games: finalGames,
      };
      gamesCache.set(cacheKey, result, 10 * 60 * 1000);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось получить каталог ZX-Art';
      res.status(502).json({ error: message });
    }
  });

  router.get('/zxart/releases/:prodId', async (req, res) => {
    try {
      const prodId = Number(req.params.prodId);
      if (!Number.isInteger(prodId) || prodId <= 0) {
        res.status(400).json({ error: 'Некорректный ID игры' });
        return;
      }

      const cacheKey = String(prodId);
      const cached = releasesCache.get(cacheKey);
      if (cached) {
        res.json({ releases: cached });
        return;
      }

      const data = await fetchZxArtJson<{
        responseData?: { zxRelease?: RawZxRelease[] };
      }>(`action:filter/export:zxRelease/language:rus/start:0/limit:200/filter:zxProdId=${prodId}/`);

      const rawReleases = Array.isArray(data.responseData?.zxRelease)
        ? data.responseData.zxRelease
        : [];
      const releases = selectPlayableReleases(rawReleases);
      releasesCache.set(cacheKey, releases, 15 * 60 * 1000);
      res.json({ releases });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось получить релизы игры';
      res.status(502).json({ error: message });
    }
  });

  router.get('/zxart/download', async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!rawUrl || !isAllowedZxArtDownloadUrl(rawUrl)) {
        res.status(400).json({ error: 'Недопустимый URL файла ZX-Art' });
        return;
      }

      const upstream = await fetch(rawUrl, {
        headers: {
          'User-Agent': 'ZXSpectrumEmulator/1.0',
        },
        signal: AbortSignal.timeout(20_000),
      });

      if (!upstream.ok) {
        res.status(upstream.status).json({ error: `Ошибка скачивания файла: HTTP ${upstream.status}` });
        return;
      }

      const contentLen = Number(upstream.headers.get('content-length') ?? 0);
      if (contentLen > MAX_DOWNLOAD_BYTES) {
        res.status(413).json({ error: 'Файл слишком большой для загрузки' });
        return;
      }

      const buf = new Uint8Array(await upstream.arrayBuffer());
      if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
        res.status(413).json({ error: 'Файл слишком большой для загрузки' });
        return;
      }

      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(buf));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось скачать файл с ZX-Art';
      res.status(502).json({ error: message });
    }
  });

  return router;
}

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', createApiRouter());

  const isProd =
    process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'start';

  if (isProd) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Ensure dist directory check doesn't fail silently in misconfigured start
  if (isProd && !fs.existsSync(path.resolve(process.cwd(), 'dist', 'index.html'))) {
    console.warn('Warning: dist/index.html not found; run npm run build first.');
  }

  app.listen(PORT, HOST, () => {
    console.log(`ZX Spectrum server listening on http://${HOST}:${PORT}`);
  });
}

void startServer();
