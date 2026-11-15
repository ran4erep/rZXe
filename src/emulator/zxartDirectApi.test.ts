import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_CORS_PROXIES,
  buildExternalProxyDownloadCandidates,
  buildZxArtDirectCategoriesUrl,
  buildZxArtDirectGamesQuery,
  buildZxArtDirectReleasesUrl,
  downloadZxArtFileSmart,
  fetchZxArtCategoriesSmart,
  fetchZxArtReleasesSmart,
  getLocalProxyStatus,
  isHtmlOrJsonErrorPayload,
  isJsonContentType,
  parseZxArtCategoriesResponse,
  parseZxArtReleasesResponse,
  resetProxyDiscoveryForTests,
} from './zxartDirectApi';
import { ZXART_ALL_CATEGORY_ID, ZXART_GAMES_CATEGORY_ID } from './zxartCatalog';

test('direct ZX-Art URL builders construct valid CORS-enabled endpoints', () => {
  assert.equal(
    buildZxArtDirectCategoriesUrl(),
    'https://zxart.ee/api/action:filter/export:zxProdCategory/language:rus/start:0/limit:300/filter:zxProdCategoryAll/'
  );
  assert.equal(
    buildZxArtDirectReleasesUrl(98871),
    'https://zxart.ee/api/action:filter/export:zxRelease/language:rus/start:0/limit:200/filter:zxProdId=98871/'
  );

  const qSearch = buildZxArtDirectGamesQuery({
    start: 0,
    limit: 24,
    categoryId: ZXART_GAMES_CATEGORY_ID,
    order: 'votes,desc',
    search: 'Exolon',
  });
  assert.equal(qSearch.effectiveCategoryId, null);
  assert.ok(qSearch.prodsUrl.includes('zxProdSearch=Exolon'));
  assert.ok(qSearch.releaseSearchUrl?.includes('zxReleaseSearch=Exolon'));

  const qCat = buildZxArtDirectGamesQuery({
    start: 24,
    limit: 12,
    categoryId: ZXART_ALL_CATEGORY_ID,
    order: 'year,desc',
    search: '',
  });
  assert.equal(qCat.effectiveCategoryId, null);
  assert.equal(qCat.releaseSearchUrl, null);
  assert.ok(qCat.prodsUrl.includes('filter:zxProdAll/order:year,desc/'));
});

test('parseZxArtCategoriesResponse extracts and sorts games subcategories', () => {
  const parsed = parseZxArtCategoriesResponse({
    responseData: {
      zxProdCategory: [
        { id: ZXART_GAMES_CATEGORY_ID, title: 'Игры', categories: [10, 20, 99] },
        { id: 10, title: 'Аркады &amp; Экшн' },
        { id: 20, title: 'Адвенчуры' },
      ],
    },
  });
  assert.deepEqual(parsed, [
    { id: 20, title: 'Адвенчуры' },
    { id: 10, title: 'Аркады & Экшн' },
  ]);
});

test('parseZxArtReleasesResponse parses direct zxRelease payload', () => {
  const list = parseZxArtReleasesResponse({
    responseData: {
      zxRelease: [
        {
          id: 98874,
          fileName: 'Exolon.tzx.zip',
          file: 'https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip',
          releaseType: 'original',
          releaseFormat: ['tzx'],
          hardwareRequired: ['ay'],
        },
      ],
    },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 98874);
});

test('isJsonContentType and isHtmlOrJsonErrorPayload distinguish real binaries from proxy errors', () => {
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  assert.equal(isJsonContentType('text/html; charset=utf-8'), false);
  assert.equal(isJsonContentType(null), false);

  const enc = new TextEncoder();
  assert.equal(isHtmlOrJsonErrorPayload(new Uint8Array(0)), true);
  assert.equal(isHtmlOrJsonErrorPayload(enc.encode('<!DOCTYPE html><html></html>')), true);
  assert.equal(isHtmlOrJsonErrorPayload(enc.encode('  {"error":"rate limit"}')), true);
  assert.equal(isHtmlOrJsonErrorPayload(enc.encode('Rate limit exceeded'), 'text/plain'), true);
  assert.equal(
    isHtmlOrJsonErrorPayload(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'text/html'),
    true
  );

  // Real binary headers: ZIP (PK), TAP, SINCLAIR (.scl)
  assert.equal(
    isHtmlOrJsonErrorPayload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), 'application/zip'),
    false
  );
  assert.equal(
    isHtmlOrJsonErrorPayload(new Uint8Array([0x13, 0x00, 0x00, 0x53, 0x45]), 'application/octet-stream'),
    false
  );
  assert.equal(
    isHtmlOrJsonErrorPayload(enc.encode('SINCLAIR\x05...'), 'application/octet-stream'),
    false
  );
});

test('buildExternalProxyDownloadCandidates validates zxart URLs and rotates from preferred index', () => {
  assert.deepEqual(buildExternalProxyDownloadCandidates('https://evil.example.com/file.zip'), []);

  const target = 'https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip';
  const rotated = buildExternalProxyDownloadCandidates(target, 2);
  assert.equal(rotated.length, EXTERNAL_CORS_PROXIES.length);
  assert.equal(rotated[0].index, 2);
  assert.equal(rotated[0].id, EXTERNAL_CORS_PROXIES[2].id);
  assert.ok(rotated[0].url.startsWith('https://'));
});

test('smart fetchers fall back cleanly from static-host HTML/404 to direct zxart.ee and external CORS proxies', async () => {
  const prevFetch = globalThis.fetch;
  const calls: string[] = [];
  resetProxyDiscoveryForTests();

  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);

      // Static hosting SPA fallback returns 200 text/html for api/zxart/*
      if (url.startsWith('api/zxart/')) {
        return new Response('<!doctype html><html><body>SPA</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (url.startsWith('https://zxart.ee/api/action:filter/export:zxProdCategory/')) {
        return new Response(
          JSON.stringify({
            responseData: {
              zxProdCategory: [
                { id: ZXART_GAMES_CATEGORY_ID, title: 'Игры', categories: [501] },
                { id: 501, title: 'Платформеры' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.startsWith('https://zxart.ee/api/action:filter/export:zxRelease/')) {
        return new Response(
          JSON.stringify({
            responseData: {
              zxRelease: [
                {
                  id: 98874,
                  fileName: 'Exolon.tzx.zip',
                  file: 'https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip',
                  releaseType: 'original',
                  releaseFormat: ['tzx'],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      // First two external proxies fail (403 limit / 429), third returns valid ZIP binary
      if (url.startsWith('https://proxy.corsfix.com/')) {
        return new Response('{"corsfix_error":"free_tier_transfer_limit"}', {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.cors.lol/')) {
        return new Response('Rate limit exceeded', { status: 429 });
      }
      if (url.startsWith('https://api.codetabs.com/')) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb]), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }

      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    const cats = await fetchZxArtCategoriesSmart();
    assert.deepEqual(cats, [{ id: 501, title: 'Платформеры' }]);
    assert.equal(getLocalProxyStatus(), 'unavailable');

    // Subsequent call should skip api/zxart/* completely once static mode is detected
    const releases = await fetchZxArtReleasesSmart(98871);
    assert.equal(releases.length, 1);
    assert.equal(
      calls.filter((u) => u.startsWith('api/zxart/')).length,
      1,
      'must not keep hitting unavailable local proxy'
    );

    const bytes = await downloadZxArtFileSmart('https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip');
    assert.deepEqual(bytes, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb]));

    // Repeated download of the same URL is served from memory with zero network calls
    const callsBeforeCached = calls.length;
    const cachedBytes = await downloadZxArtFileSmart('https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip');
    assert.deepEqual(cachedBytes, bytes);
    assert.equal(calls.length, callsBeforeCached);

    // Different URL should immediately start with the remembered working proxy (codetabs)
    const callsBeforeSecondDownload = calls.length;
    await downloadZxArtFileSmart('https://zxart.ee/releasefile/id:98875/Exolon.tap.zip');
    assert.ok(calls[callsBeforeSecondDownload].startsWith('https://api.codetabs.com/'));
  } finally {
    globalThis.fetch = prevFetch;
    resetProxyDiscoveryForTests();
  }
});

test('smart fetchers stay on local same-origin proxy when server.ts responds with JSON', async () => {
  const prevFetch = globalThis.fetch;
  const calls: string[] = [];
  resetProxyDiscoveryForTests();

  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url === 'api/zxart/categories') {
        return new Response(JSON.stringify({ categories: [{ id: 1, title: 'Логические' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('api/zxart/download?')) {
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      throw new Error(`Unexpected external fetch: ${url}`);
    }) as typeof fetch;

    const cats = await fetchZxArtCategoriesSmart();
    assert.deepEqual(cats, [{ id: 1, title: 'Логические' }]);
    assert.equal(getLocalProxyStatus(), 'available');

    const bytes = await downloadZxArtFileSmart('https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip');
    assert.deepEqual(bytes, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = prevFetch;
    resetProxyDiscoveryForTests();
  }
});
