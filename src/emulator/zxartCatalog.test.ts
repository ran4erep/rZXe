import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addZxArtSearchHistory,
  createTouchKeyboardViewportState,
  evaluateTouchKeyboardResize,
  shouldCommitHistoryOnSearchBlur,
} from './zxartCatalog';

test('addZxArtSearchHistory deduplicates case-insensitively and returns same reference when already first', () => {
  const first = addZxArtSearchHistory([], 'Dizzy');
  assert.deepEqual(first, ['Dizzy']);

  // Exact match already at index 0 returns identical reference (avoids React state churn & storage writes)
  const unchanged = addZxArtSearchHistory(first, '  Dizzy  ');
  assert.equal(unchanged, first);

  const second = addZxArtSearchHistory(first, 'Saboteur');
  assert.deepEqual(second, ['Saboteur', 'Dizzy']);

  const promoted = addZxArtSearchHistory(second, 'dizzy');
  assert.deepEqual(promoted, ['dizzy', 'Saboteur']);
});

test('evaluateTouchKeyboardResize detects docked touch keyboard open and close transitions accurately', () => {
  const state = createTouchKeyboardViewportState(390, 844);

  // Minor browser address bar shift (< 100px) must not mark keyboard open
  assert.equal(evaluateTouchKeyboardResize(state, 390, 790), false);
  assert.equal(state.keyboardOpen, false);

  // Virtual keyboard slides up (height drops by 324px)
  assert.equal(evaluateTouchKeyboardResize(state, 390, 520), false);
  assert.equal(state.keyboardOpen, true);
  assert.equal(state.minKeyboardHeight, 520);

  // Extra suggestion/emoji strip shrinks viewport slightly more -> still open
  assert.equal(evaluateTouchKeyboardResize(state, 390, 480), false);
  assert.equal(state.keyboardOpen, true);
  assert.equal(state.minKeyboardHeight, 480);

  // User presses Android Hide Keyboard / Back -> height returns to 844 -> signals keyboard closed!
  assert.equal(evaluateTouchKeyboardResize(state, 390, 844), true);
  assert.equal(state.keyboardOpen, false);

  // Further resize without re-opening keyboard must not fire close again
  assert.equal(evaluateTouchKeyboardResize(state, 390, 844), false);
});

test('evaluateTouchKeyboardResize ignores screen orientation changes', () => {
  const state = createTouchKeyboardViewportState(390, 844);
  assert.equal(evaluateTouchKeyboardResize(state, 390, 500), false);
  assert.equal(state.keyboardOpen, true);

  // Rotating portrait -> landscape changes width by > 80px -> resets baseline without false close
  assert.equal(evaluateTouchKeyboardResize(state, 844, 390), false);
  assert.equal(state.keyboardOpen, false);
  assert.equal(state.baselineWidth, 844);
  assert.equal(state.baselineHeight, 390);
});

test('shouldCommitHistoryOnSearchBlur commits ONLY for real touch keyboard dismissal, never desktop blur', () => {
  // Desktop blur (clicking away, tabbing out, etc.) must NEVER commit
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: 'dizzy',
      focusedViaTouch: false,
      keyboardOpen: false,
      suppressed: false,
      alreadyCommitted: false,
      windowLostFocus: false,
    }),
    false
  );

  // Mobile docked keyboard dismissal via blur -> MUST commit
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: 'dizzy',
      focusedViaTouch: true,
      keyboardOpen: true,
      suppressed: false,
      alreadyCommitted: false,
      windowLostFocus: false,
    }),
    true
  );

  // Mobile floating keyboard dismissal (no viewport shrink, focused via touch) -> MUST commit
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: 'dizzy',
      focusedViaTouch: true,
      keyboardOpen: false,
      suppressed: false,
      alreadyCommitted: false,
      windowLostFocus: false,
    }),
    true
  );

  // Suppressed controls (Clear button, History item, Select dropdown, Modal close) -> NEVER commit
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: 'diz',
      focusedViaTouch: true,
      keyboardOpen: true,
      suppressed: true,
      alreadyCommitted: false,
      windowLostFocus: false,
    }),
    false
  );

  // Already committed (Enter or visualViewport resize) -> NEVER duplicate commit
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: 'dizzy',
      focusedViaTouch: true,
      keyboardOpen: true,
      suppressed: false,
      alreadyCommitted: true,
      windowLostFocus: false,
    }),
    false
  );

  // App backgrounded / tab switched -> NEVER commit unfinished text
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: 'diz',
      focusedViaTouch: true,
      keyboardOpen: true,
      suppressed: false,
      alreadyCommitted: false,
      windowLostFocus: true,
    }),
    false
  );

  // Blank/whitespace query -> NEVER commit
  assert.equal(
    shouldCommitHistoryOnSearchBlur({
      query: '   ',
      focusedViaTouch: true,
      keyboardOpen: true,
      suppressed: false,
      alreadyCommitted: false,
      windowLostFocus: false,
    }),
    false
  );
});
