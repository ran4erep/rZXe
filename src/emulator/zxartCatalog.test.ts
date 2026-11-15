import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCatalogGrid } from './catalogGrid';
import {
  ZXART_SEARCH_HISTORY_LIMIT,
  ZXART_SERIES_CATEGORY_ID,
  addZxArtSearchHistory,
  buildZxArtReleaseGameKey,
  clearZxArtSearchHistory,
  decodeHtmlEntities,
  extractAvailableReleaseFormats,
  extractFallbackReleaseFileName,
  filterReleasesByFormat,
  formatReleaseTypeLabel,
  formatZxArtReleaseDisplayTitle,
  getDiskReleaseTier,
  inferRecommendedMachine,
  isAllowedZxArtDownloadUrl,
  isPlayableZxProd,
  loadZxArtSearchHistory,
  normalizeZxProd,
  removeZxArtSearchHistoryItem,
  resolveCatalogOpenSelection,
  resolveTargetMachine,
  selectPlayableReleases,
  sortReleasesForCatalogMode,
  sortZxArtGames,
} from './zxartCatalog';

test('computeCatalogGrid adapts columns, rows, and card sizes to arbitrary viewports within bounds', () => {
  const viewports = [
    { w: 358, h: 560 },
    { w: 720, h: 650 },
    { w: 1168, h: 640 },
    { w: 1680, h: 920 },
  ];

  for (const vp of viewports) {
    const layout = computeCatalogGrid(vp.w, vp.h);
    assert.ok(layout.cols >= 1);
    assert.ok(layout.rows >= 1);
    assert.ok(layout.cardWidth >= 134 && layout.cardWidth <= 228, `cardWidth=${layout.cardWidth} out of bounds for ${vp.w}x${vp.h}`);
    assert.ok(layout.cardHeight >= 172 && layout.cardHeight <= 276, `cardHeight=${layout.cardHeight} out of bounds for ${vp.w}x${vp.h}`);
    assert.ok(
      layout.cols * layout.cardWidth + layout.gap * (layout.cols - 1) <= vp.w,
      `grid width overflows ${vp.w}`
    );
    assert.equal(layout.pageSize, layout.cols * layout.rows);
  }

  const mobile = computeCatalogGrid(358, 560);
  const desktop = computeCatalogGrid(1168, 640);
  assert.ok(desktop.cols > mobile.cols, 'desktop should automatically have more columns than mobile');
  assert.ok(desktop.pageSize > mobile.pageSize, 'desktop should fit more cards per page than mobile');
});

test('decodeHtmlEntities decodes common ZX-Art HTML entities cleanly', () => {
  assert.equal(
    decodeHtmlEntities('Shoot &#039;em up &amp; &quot;Run&quot;'),
    'Shoot \'em up & "Run"'
  );
});

test('normalizeZxProd prefers inlaysUrls over listImagesUrls and keeps fallback', () => {
  const normalized = normalizeZxProd({
    id: 98871,
    title: 'Exolon&#039;s Quest',
    year: 1987,
    votes: '4.48',
    votesAmount: 13,
    inlaysUrls: ['https://zxart.ee/image/type:prodListInlay/id:209467'],
    listImagesUrls: ['https://zxart.ee/screenshot/id:548187/exolon.gif'],
    categoriesInfo: [{ id: 523396, title: 'Run &#039;n&#039; Gun' }],
    hardwareInfo: [{ id: 'zx48', name: 'ZX Spectrum 48K' }],
  });

  assert.ok(normalized);
  assert.equal(normalized.title, "Exolon's Quest");
  assert.equal(normalized.coverUrl, 'https://zxart.ee/image/type:prodListInlay/id:209467');
  assert.equal(normalized.fallbackImageUrl, 'https://zxart.ee/screenshot/id:548187/exolon.gif');
  assert.equal(normalized.genre, "Run 'n' Gun");
  assert.deepEqual(normalized.hardware, ['zx48']);

  const fromCatString = normalizeZxProd({
    id: 248481,
    title: 'Черный Ворон',
    year: 1997,
    categoriesString: 'Игры/Стратегии/Стратегии в реальном времени',
  });
  assert.ok(fromCatString);
  assert.equal(fromCatString.genre, 'Стратегии в реальном времени');
});

test('selectPlayableReleases preserves release metadata, flags unsupported hardware, and sorts by compatibility', () => {
  const selected = selectPlayableReleases([
    {
      id: 1,
      fileName: undefined,
      file: 'https://zxart.ee/releasefile/id:1/',
      releaseType: 'original',
    },
    {
      id: 2,
      fileName: 'Game.rom.zip',
      file: 'https://zxart.ee/releasefile/id:2/Game.rom.zip',
      releaseType: 'original',
      year: 2015,
      language: ['en', 'es'],
      version: 'Cartridge &amp; Tap',
      hardwareRequired: ['zx128', 'dandanator'],
      releaseFormat: ['rom'],
    },
    {
      id: 3,
      fileName: 'Game.dsk',
      file: 'https://zxart.ee/releasefile/id:3/Game.dsk',
      releaseType: 'adaptation',
      hardwareRequired: ['zx+3', '3dos'],
      releaseFormat: ['dsk'],
    },
    {
      id: 4,
      fileName: 'Game(RU).tap.zip',
      file: 'https://zxart.ee/releasefile/id:4/Game(RU).tap.zip',
      releaseType: 'original',
      year: '2015',
      language: ['ru'],
      hardwareRequired: ['zx128', 'ay'],
      releaseFormat: ['tap'],
    },
    {
      id: 5,
      fileName: 'Game.trd.zip',
      file: 'https://zxart.ee/releasefile/id:5/Game.trd.zip',
      releaseType: 'original',
      hardwareRequired: ['trdos'],
      releaseFormat: ['trd'],
    },
  ]);

  assert.equal(selected.length, 4);
  assert.equal(selected[0].id, 4);
  assert.equal(selected[0].recommendedMachine, '128k');
  assert.deepEqual(selected[0].languages, ['RU']);
  assert.equal(selected[0].year, 2015);
  assert.equal(selected[0].hasUnsupportedHardware, false);

  assert.equal(selected[1].id, 5);
  assert.equal(selected[1].recommendedMachine, 'pentagon128');

  assert.equal(selected[2].id, 3);
  assert.equal(selected[2].recommendedMachine, '128k');

  assert.equal(selected[3].id, 2);
  assert.equal(selected[3].hasUnsupportedHardware, true);
  assert.deepEqual(selected[3].languages, ['EN', 'ES']);
  assert.equal(selected[3].version, 'Cartridge & Tap');
});

test('machine recommendation and target resolution honor explicit user choice and auto fallback', () => {
  assert.equal(inferRecommendedMachine(['tap'], ['zx+2']), 'plus2');
  assert.equal(inferRecommendedMachine(['tap'], ['zx48']), '48k');
  assert.equal(inferRecommendedMachine(['tap'], ['scorpion']), 'scorpion256');
  assert.equal(inferRecommendedMachine(['tap'], []), null);

  assert.equal(resolveTargetMachine('auto', 'pentagon128', '48k'), 'pentagon128');
  assert.equal(resolveTargetMachine('auto', null, 'plus2'), 'plus2');
  assert.equal(resolveTargetMachine('scorpion256', 'pentagon128', '48k'), 'scorpion256');

  assert.equal(formatReleaseTypeLabel('localization'), 'Локализация');
  assert.equal(formatReleaseTypeLabel('demoversion'), 'Демоверсия');
});

test('isAllowedZxArtDownloadUrl prevents SSRF to non-zxart hosts or paths', () => {
  assert.equal(isAllowedZxArtDownloadUrl('https://zxart.ee/releasefile/id:98874/Exolon.tzx.zip'), true);
  assert.equal(isAllowedZxArtDownloadUrl('https://zxart.ee/release/id:123/mode:download/foo.zip'), true);
  assert.equal(isAllowedZxArtDownloadUrl('http://zxart.ee/releasefile/id:1/foo.zip'), false);
  assert.equal(isAllowedZxArtDownloadUrl('https://evil.example.com/releasefile/id:1/foo.zip'), false);
  assert.equal(isAllowedZxArtDownloadUrl('https://zxart.ee/api/something'), false);
});

test('ZX-Art search history stores at least 5 recent unique queries, supports remove and clear', () => {
  const store = new Map<string, string>();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    },
  };

  try {
    assert.ok(ZXART_SEARCH_HISTORY_LIMIT >= 5);
    let history = loadZxArtSearchHistory();
    assert.deepEqual(history, []);

    for (const q of ['exolon', 'dizzy', 'saboteur', 'target renegade', 'castlevania', 'elite']) {
      history = addZxArtSearchHistory(history, q);
    }
    assert.equal(history.length, 6);
    assert.equal(history[0], 'elite');

    // Case-insensitive dedup moves existing entry to top
    history = addZxArtSearchHistory(history, '  Castlevania ');
    assert.equal(history.length, 6);
    assert.equal(history[0], 'Castlevania');
    assert.deepEqual(loadZxArtSearchHistory(), history);

    history = removeZxArtSearchHistoryItem(history, 'dizzy');
    assert.equal(history.length, 5);
    assert.equal(history.includes('dizzy'), false);

    history = clearZxArtSearchHistory();
    assert.deepEqual(history, []);
    assert.deepEqual(loadZxArtSearchHistory(), []);
  } finally {
    (globalThis as { window?: unknown }).window = prevWindow;
  }
});

test('buildZxArtReleaseGameKey and formatZxArtReleaseDisplayTitle uniquely identify each version', () => {
  assert.equal(buildZxArtReleaseGameKey(189835, 210455), 'zxart:189835:rel:210455');
  assert.equal(
    formatZxArtReleaseDisplayTitle('Castlevania', {
      title: 'Castlevania',
      fileName: 'Castlevania(RU).tap.zip',
    }),
    'Castlevania — Castlevania(RU).tap.zip'
  );
  assert.equal(
    formatZxArtReleaseDisplayTitle('Castlevania', {
      title: 'Pentagon Disk Edition',
      fileName: 'Castlevania.trd.zip',
    }),
    'Castlevania — Pentagon Disk Edition (Castlevania.trd.zip)'
  );
});

test('sortReleasesForCatalogMode prioritizes floppy images and archives in disk mode without mutating', () => {
  const releases = selectPlayableReleases([
    {
      id: 10,
      fileName: 'Dizzy.sna',
      file: 'https://zxart.ee/releasefile/id:10/Dizzy.sna',
      releaseType: 'original',
      releaseFormat: ['sna'],
    },
    {
      id: 11,
      fileName: 'Dizzy.tap.zip',
      file: 'https://zxart.ee/releasefile/id:11/Dizzy.tap.zip',
      releaseType: 'original',
      releaseFormat: ['tap'],
    },
    {
      id: 12,
      fileName: 'DizzyBundle.zip',
      file: 'https://zxart.ee/releasefile/id:12/DizzyBundle.zip',
      releaseType: 'rerelease',
      releaseFormat: ['zip'],
    },
    {
      id: 13,
      fileName: 'Dizzy.trd.zip',
      file: 'https://zxart.ee/releasefile/id:13/Dizzy.trd.zip',
      releaseType: 'adaptation',
      releaseFormat: ['trd'],
      hardwareRequired: ['trdos'],
    },
  ]);

  // Game mode prefers SNA/TAP first
  assert.deepEqual(
    sortReleasesForCatalogMode(releases, 'game').map((r) => r.id),
    [10, 11, 13, 12]
  );

  // Disk mode prioritizes TRD (tier 0), then generic ZIP archive (tier 1), then SNA/TAP (tier 2)
  const diskSorted = sortReleasesForCatalogMode(releases, 'disk');
  assert.deepEqual(
    diskSorted.map((r) => r.id),
    [13, 12, 10, 11]
  );
  assert.equal(getDiskReleaseTier(diskSorted[0]), 0);
  assert.equal(getDiskReleaseTier(diskSorted[1]), 1);
  assert.equal(getDiskReleaseTier(diskSorted[2]), 2);
});

test('resolveCatalogOpenSelection opens launched game page in disk mode or main grid otherwise', () => {
  const launchedGame = {
    id: 98871,
    title: 'Exolon',
    year: 1987,
    votes: 4.5,
    votesAmount: 20,
    coverUrl: null,
    fallbackImageUrl: null,
    genre: 'Action',
    hardware: ['zx48'],
  };
  const browsedOtherGame = { ...launchedGame, id: 12345, title: 'Saboteur' };

  assert.equal(resolveCatalogOpenSelection('disk', browsedOtherGame, launchedGame), launchedGame);
  assert.equal(resolveCatalogOpenSelection('disk', browsedOtherGame, null), null);
  assert.equal(resolveCatalogOpenSelection('game', browsedOtherGame, launchedGame), browsedOtherGame);
  assert.equal(resolveCatalogOpenSelection('game', null, launchedGame), null);
});
test('isPlayableZxProd filters out Series containers and zero-release entries', () => {
  assert.equal(
    isPlayableZxProd({
      id: 508966,
      title: 'Черный Ворон',
      categoriesInfo: [{ id: ZXART_SERIES_CATEGORY_ID, title: 'Серии' }],
    }),
    false
  );
  assert.equal(
    isPlayableZxProd({
      id: 999,
      title: 'Empty Game',
      categoriesInfo: [{ id: 523431, title: 'Стратегии в реальном времени' }],
      releasesIds: [],
    }),
    false
  );
  assert.equal(
    isPlayableZxProd({
      id: 248481,
      title: 'Черный Ворон',
      categoriesInfo: [{ id: 523431, title: 'Стратегии в реальном времени' }],
      releasesIds: [248482, 134550],
    }),
    true
  );
});

test('extractFallbackReleaseFileName recovers filenames from URLs while rejecting empty stubs', () => {
  assert.equal(
    extractFallbackReleaseFileName('https://zxart.ee/releasefile/id:362690/'),
    null
  );
  assert.equal(
    extractFallbackReleaseFileName('https://zxart.ee/releasefile/id:248482/B_RAVEN.ZIP'),
    'B_RAVEN.ZIP'
  );
  assert.equal(
    extractFallbackReleaseFileName('https://zxart.ee/release/id:123/mode:download/filename:Raven.trd.zip'),
    'Raven.trd.zip'
  );

  const parsed = selectPlayableReleases([
    {
      id: 362690,
      file: 'https://zxart.ee/releasefile/id:362690/',
      releaseType: 'original',
    },
    {
      id: 777,
      file: 'https://zxart.ee/releasefile/id:777/Raven.trd.zip',
      releaseType: 'original',
    },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 777);
  assert.equal(parsed[0].fileName, 'Raven.trd.zip');
});

test('sortZxArtGames orders merged search results cleanly by votes, year, or title', () => {
  const base = {
    votesAmount: 5,
    coverUrl: null,
    fallbackImageUrl: null,
    genre: null,
    hardware: [],
  };
  const list = [
    { ...base, id: 2, title: 'Бета', year: 2020, votes: 4.0 },
    { ...base, id: 1, title: 'Альфа', year: 1997, votes: 4.52 },
  ];
  assert.deepEqual(sortZxArtGames(list, 'votes,desc').map((g) => g.id), [1, 2]);
  assert.deepEqual(sortZxArtGames(list, 'year,desc').map((g) => g.id), [2, 1]);
  assert.deepEqual(sortZxArtGames(list, 'title,asc').map((g) => g.id), [1, 2]);
});

test('extractAvailableReleaseFormats and filterReleasesByFormat collect unique formats and filter cleanly', () => {
  const releases = selectPlayableReleases([
    {
      id: 1,
      fileName: 'Game1.tap.zip',
      file: 'https://zxart.ee/releasefile/id:1/Game1.tap.zip',
      releaseFormat: ['tap'],
      releaseType: 'original',
    },
    {
      id: 2,
      fileName: 'Game2.trd.zip',
      file: 'https://zxart.ee/releasefile/id:2/Game2.trd.zip',
      releaseFormat: ['trd'],
      releaseType: 'adaptation',
    },
    {
      id: 3,
      fileName: 'Game3.trd.zip',
      file: 'https://zxart.ee/releasefile/id:3/Game3.trd.zip',
      releaseFormat: ['trd', 'TRD'],
      releaseType: 'rerelease',
    },
    {
      id: 4,
      fileName: 'Game4.d80.zip',
      file: 'https://zxart.ee/releasefile/id:4/Game4.d80.zip',
      releaseFormat: ['d80', 'p'],
      releaseType: 'adaptation',
    },
  ]);

  const formats = extractAvailableReleaseFormats(releases);
  assert.deepEqual(formats, [
    { format: 'tap', count: 1 },
    { format: 'trd', count: 2 },
    { format: 'd80', count: 1 },
    { format: 'p', count: 1 },
  ]);

  assert.equal(filterReleasesByFormat(releases, null), releases);
  assert.deepEqual(
    filterReleasesByFormat(releases, 'trd').map((r) => r.id),
    [3, 2]
  );
  assert.deepEqual(
    filterReleasesByFormat(releases, 'D80').map((r) => r.id),
    [4]
  );
});

