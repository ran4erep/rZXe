import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibleTopBarActionCount } from './topBarLayout';

test('computeVisibleTopBarActionCount keeps all icons inline when total width fits', () => {
  // 8 icons * 32px + 7 gaps * 4px = 284px
  assert.equal(computeVisibleTopBarActionCount(284, 8, 32, 4, 32), 8);
  assert.equal(computeVisibleTopBarActionCount(500, 8, 32, 4, 32), 8);
  assert.equal(computeVisibleTopBarActionCount(330, 8, 36, 6, 36), 8);
});

test('computeVisibleTopBarActionCount overflows only icons that do not fit', () => {
  // 268px available (e.g. 390px screen with 128K): 6 icons (212px) + gap (4px) + toggle (32px) = 248px <= 268px
  assert.equal(computeVisibleTopBarActionCount(268, 8, 32, 4, 32), 6);

  // 248px available: still fits 6 icons + toggle
  assert.equal(computeVisibleTopBarActionCount(248, 8, 32, 4, 32), 6);

  // 247px available: drops one more icon -> 5 icons + toggle (212px)
  assert.equal(computeVisibleTopBarActionCount(247, 8, 32, 4, 32), 5);

  // 182px available (e.g. 390px screen with Pentagon A/B drives): 4 icons + toggle (176px)
  assert.equal(computeVisibleTopBarActionCount(182, 8, 32, 4, 32), 4);
});

test('computeVisibleTopBarActionCount always keeps at least one primary icon', () => {
  assert.equal(computeVisibleTopBarActionCount(40, 8, 32, 4, 32), 1);
  assert.equal(computeVisibleTopBarActionCount(0, 8, 32, 4, 32), 1);
});
