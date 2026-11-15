import test from 'node:test';
import assert from 'node:assert/strict';
import type { ZxArtGameSummary } from './zxartCatalog';
import {
  buildFavoriteIdSet,
  filterFavoriteGames,
  sanitizeFavoriteGames,
  toggleFavoriteGame,
} from './favoritesStorage';

function makeGame(id: number, title: string, genre: string | null = 'Arcade', year: number | null = 1987): ZxArtGameSummary {
  return {
    id,
    title,
    year,
    votes: 4.5,
    votesAmount: 20,
    coverUrl: `https://zxart.ee/cover/${id}.png`,
    fallbackImageUrl: null,
    genre,
    hardware: ['zx128'],
  };
}

test('toggleFavoriteGame adds newest game first and removes existing game cleanly', () => {
  const g1 = makeGame(101, 'Exolon');
  const g2 = makeGame(202, 'Saboteur!');

  const step1 = toggleFavoriteGame([], g1);
  assert.equal(step1.added, true);
  assert.deepEqual(step1.favorites.map((g) => g.id), [101]);

  const step2 = toggleFavoriteGame(step1.favorites, g2);
  assert.equal(step2.added, true);
  assert.deepEqual(step2.favorites.map((g) => g.id), [202, 101]);

  const ids = buildFavoriteIdSet(step2.favorites);
  assert.equal(ids.has(101), true);
  assert.equal(ids.has(202), true);
  assert.equal(ids.has(999), false);

  const step3 = toggleFavoriteGame(step2.favorites, g1);
  assert.equal(step3.added, false);
  assert.deepEqual(step3.favorites.map((g) => g.id), [202]);
});

test('sanitizeFavoriteGames filters invalid entries and deduplicates by id', () => {
  const sanitized = sanitizeFavoriteGames([
    null,
    { id: 'bad', title: 'Nope' },
    { id: 1, title: '' },
    { id: 10, title: '  Seraphima ', year: 2023, genre: 'Action', hardware: ['pentagon128', 42] },
    { id: 10, title: 'Duplicate' },
  ]);

  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].id, 10);
  assert.equal(sanitized[0].title, 'Seraphima');
  assert.equal(sanitized[0].year, 2023);
  assert.deepEqual(sanitized[0].hardware, ['pentagon128']);
});

test('filterFavoriteGames matches by title, genre, or year', () => {
  const list = [
    makeGame(1, 'Exolon', 'Shoot-em-up', 1987),
    makeGame(2, 'Seraphima', 'Action', 2023),
    makeGame(3, 'Elite', 'Simulation', 1985),
  ];

  assert.deepEqual(filterFavoriteGames(list, '').map((g) => g.id), [1, 2, 3]);
  assert.deepEqual(filterFavoriteGames(list, 'seraph').map((g) => g.id), [2]);
  assert.deepEqual(filterFavoriteGames(list, 'simul').map((g) => g.id), [3]);
  assert.deepEqual(filterFavoriteGames(list, '1987').map((g) => g.id), [1]);
});
