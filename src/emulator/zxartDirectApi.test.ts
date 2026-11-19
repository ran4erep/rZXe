import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ZXART_PROXY_URL,
  buildCanonicalZxArtDownloadUrl,
  buildZxArtProxyApiUrl,
  buildZxArtProxyDownloadUrl,
  clearZxArtDownloadCacheForTests,
  downloadZxArtFileSmart,
  fetchZxArtCategoriesSmart,
  getConfiguredZxArtProxyUrl,
  isHtmlOrJsonErrorPayload,
  normalizeZxArtProxyBaseUrl,
  setZxArtProxyUrlForTests,
} from './zxartDirectApi';

function makeStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const local = new Uint8Array(30 + nameBytes.byteLength + entry.data.byteLength);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(8, 0, true); // stored
    ldv.setUint32(18, entry.data.byteLength, true);
    ldv.setUint32(22, entry.data.byteLength, true);
    ldv.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.byteLength);
    localParts.push(local);

    const cd = new Uint8Array(46 + nameBytes.byteLength);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint32(20, entry.data.byteLength, true);
    cdv.setUint32(24, entry.data.byteLength, true);
    cdv.setUint16(28, nameBytes.byteLength, true);
    cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    cdParts.push(cd);

    offset += local.byteLength;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const part of cdParts) cdSize += part.byteLength;

  const out = new Uint8Array(cdStart + cdSize + 22);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  for (const part of cdParts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  const eocd = new DataView(out.buffer, pos, 22);
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  return out;
}

test('normalizeZxArtProxyBaseUrl normalizes trailing slashes and rejects invalid protocols', () => {
  assert.equal(
    normalizeZxArtProxyBaseUrl(' https://rzxe-proxy.vercel.app/// '),
    'https://rzxe-proxy.vercel.app'
  );
  assert.equal(
    normalizeZxArtProxyBaseUrl('https://example.com/zxart-proxy/?foo=1#bar'),
    'https://example.com/zxart-proxy'
  );
  assert.equal(normalizeZxArtProxyBaseUrl('ftp://example.com'), null);
  assert.equal(normalizeZxArtProxyBaseUrl(''), null);
  assert.equal(normalizeZxArtProxyBaseUrl('not-a-url'), null);
});

test('buildZxArtProxyDownloadUrl and buildZxArtProxyApiUrl strictly whitelist zxart.ee paths', () => {
  const proxyBase = 'https://rzxe-proxy.vercel.app/';
  const dl = buildZxArtProxyDownloadUrl(
    'https://zxart.ee/releasefile/id:598761/filename:Dizzy (1987).tap',
    proxyBase
  );
  assert.equal(
    dl,
    'https://rzxe-proxy.vercel.app/?url=https%3A%2F%2Fzxart.ee%2Freleasefile%2Fid%3A598761%2Ffilename%3ADizzy%2520%281987%29.tap'
  );

  // Subpath route works cleanly too
  const subpathDl = buildZxArtProxyDownloadUrl(
    'https://zxart.ee/releasefile/id:123/',
    'https://mysite.com/api/proxy/'
  );
  assert.equal(
    subpathDl,
    'https://mysite.com/api/proxy?url=https%3A%2F%2Fzxart.ee%2Freleasefile%2Fid%3A123%2F'
  );

  // Rejects foreign domains and disallowed paths
  assert.equal(buildZxArtProxyDownloadUrl('https://evil.com/releasefile/id:1/', proxyBase), null);
  assert.equal(buildZxArtProxyDownloadUrl('https://zxart.ee/api/test', proxyBase), null);
  assert.equal(buildZxArtProxyApiUrl('https://zxart.ee/releasefile/id:1/', proxyBase), null);
  assert.equal(
    buildZxArtProxyApiUrl('https://zxart.ee/api/action:filter/export:zxProd/', proxyBase),
    'https://rzxe-proxy.vercel.app/?url=https%3A%2F%2Fzxart.ee%2Fapi%2Faction%3Afilter%2Fexport%3AzxProd%2F'
  );
});

test('buildCanonicalZxArtDownloadUrl extracts canonical ID URL', () => {
  assert.equal(
    buildCanonicalZxArtDownloadUrl('https://zxart.ee/releasefile/id:598761/filename:foo%20bar.zip'),
    'https://zxart.ee/releasefile/id:598761/'
  );
  assert.equal(
    buildCanonicalZxArtDownloadUrl('https://zxart.ee/releasefile/id:598761/'),
    null
  );
});

test('default configured proxy points to https://rzxe-proxy.vercel.app', () => {
  setZxArtProxyUrlForTests(undefined);
  assert.equal(DEFAULT_ZXART_PROXY_URL, 'https://rzxe-proxy.vercel.app');
  assert.equal(getConfiguredZxArtProxyUrl(), 'https://rzxe-proxy.vercel.app');
});

test('downloadZxArtFileSmart fails fast when proxy URL is explicitly unset', async () => {
  clearZxArtDownloadCacheForTests();
  setZxArtProxyUrlForTests(null);

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => downloadZxArtFileSmart('https://zxart.ee/releasefile/id:100/game.tap'),
      /Прокси-сервер для скачивания не настроен/
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    setZxArtProxyUrlForTests(undefined);
  }
});

test('downloadZxArtFileSmart downloads via Vercel proxy, falls back to canonical URL on 404, and caches result', async () => {
  clearZxArtDownloadCacheForTests();
  setZxArtProxyUrlForTests('https://rzxe-proxy.vercel.app');

  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];
  const payload = new Uint8Array([0x13, 0x00, 0x00, 0x03, 0x44, 0x49, 0x5a, 0x5a, 0x59]);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calledUrls.push(url);
    if (calledUrls.length === 1) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    return new Response(payload, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(payload.byteLength),
      },
    });
  }) as typeof fetch;

  try {
    const target = 'https://zxart.ee/releasefile/id:777/filename:Game [v1].tap';
    const first = await downloadZxArtFileSmart(target);
    assert.deepEqual(first, payload);
    assert.equal(calledUrls.length, 2);
    assert.ok(calledUrls[0].startsWith('https://rzxe-proxy.vercel.app/?url='));
    assert.equal(
      calledUrls[1],
      'https://rzxe-proxy.vercel.app/?url=https%3A%2F%2Fzxart.ee%2Freleasefile%2Fid%3A777%2F'
    );

    // Second call hits LRU cache without any network call
    const second = await downloadZxArtFileSmart(target);
    assert.deepEqual(second, payload);
    assert.equal(calledUrls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    setZxArtProxyUrlForTests(undefined);
  }
});

test('downloadZxArtFileSmart switches large >4MB ZIP to selective HTTP Range fetch via Vercel proxy', async () => {
  clearZxArtDownloadCacheForTests();
  setZxArtProxyUrlForTests('https://rzxe-proxy.vercel.app');

  const dummyManual = new Uint8Array(4 * 1024 * 1024 + 8192);
  dummyManual.fill(0x41);
  const gameTap = new Uint8Array([0x13, 0x00, 0x00, 0x00, 0x47, 0x41, 0x4d, 0x45]);
  const bigZip = makeStoredZip([
    { name: 'manual.pdf', data: dummyManual },
    { name: 'game.tap', data: gameTap },
  ]);

  const originalFetch = globalThis.fetch;
  let rangeRequests = 0;

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get('Range');
    if (range) {
      rangeRequests++;
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(m, `Unexpected Range header: ${range}`);
      const start = Number(m[1]);
      const end = Number(m[2]);
      const slice = bigZip.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          'content-type': 'application/zip',
          'content-length': String(slice.byteLength),
          'content-range': `bytes ${start}-${end}/${bigZip.byteLength}`,
        },
      });
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bigZip.subarray(0, 64));
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(bigZip.byteLength),
      },
    });
  }) as typeof fetch;

  try {
    const compactZip = await downloadZxArtFileSmart('https://zxart.ee/releasefile/id:900/big.zip');
    assert.ok(rangeRequests >= 2, 'Expected HTTP Range requests for tail + kept entry');
    assert.ok(
      compactZip.byteLength < 1024,
      `Expected compact reassembled ZIP without 4MB PDF, got ${compactZip.byteLength} bytes`
    );
    assert.equal(compactZip[0], 0x50);
    assert.equal(compactZip[1], 0x4b);
    assert.equal(compactZip[2], 0x03);
    assert.equal(compactZip[3], 0x04);
  } finally {
    globalThis.fetch = originalFetch;
    setZxArtProxyUrlForTests(undefined);
  }
});

test('fetchZxArtCategoriesSmart tries direct zxart.ee API first and falls back to Vercel proxy only on failure', async () => {
  setZxArtProxyUrlForTests('https://rzxe-proxy.vercel.app');

  const originalFetch = globalThis.fetch;
  const calledUrls: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calledUrls.push(url);
    if (url.startsWith('https://zxart.ee/api/')) {
      throw new TypeError('Failed to fetch');
    }
    return new Response(
      JSON.stringify({
        responseData: {
          zxProdCategory: [
            { id: 92177, title: 'Games', categories: [101] },
            { id: 101, title: 'Аркады' },
          ],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;

  try {
    const cats = await fetchZxArtCategoriesSmart();
    assert.deepEqual(cats, [{ id: 101, title: 'Аркады' }]);
    assert.equal(calledUrls.length, 3);
    assert.ok(calledUrls[0].startsWith('https://zxart.ee/api/'));
    assert.ok(calledUrls[1].startsWith('https://zxart.ee/api/'));
    assert.ok(calledUrls[2].startsWith('https://rzxe-proxy.vercel.app/?url='));
  } finally {
    globalThis.fetch = originalFetch;
    setZxArtProxyUrlForTests(undefined);
  }
});

test('isHtmlOrJsonErrorPayload distinguishes binary data from error payloads', () => {
  assert.equal(isHtmlOrJsonErrorPayload(new TextEncoder().encode('<!DOCTYPE html><html>')), true);
  assert.equal(isHtmlOrJsonErrorPayload(new TextEncoder().encode('{"error":"blocked"}')), true);
  assert.equal(isHtmlOrJsonErrorPayload(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), false);
});
