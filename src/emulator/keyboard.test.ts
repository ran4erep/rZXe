import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECTRUM_KEYS,
  SPECTRUM_RU_JCUKEN_MAP,
  KeyboardMatrix,
  getSpectrumKeyDisplayLabel,
} from './keyboard';
import { sanitizeEmulatorSettings } from './settingsStorage';

test('SPECTRUM_RU_JCUKEN_MAP maps all 26 English keys to unique Soviet JCUKEN Cyrillic letters', () => {
  const row2 = SPECTRUM_KEYS[1].map((spec) => getSpectrumKeyDisplayLabel(spec, 'ru')).join('');
  const row3 = SPECTRUM_KEYS[2]
    .slice(0, 9)
    .map((spec) => getSpectrumKeyDisplayLabel(spec, 'ru'))
    .join('');
  const row4 = SPECTRUM_KEYS[3]
    .slice(1, 8)
    .map((spec) => getSpectrumKeyDisplayLabel(spec, 'ru'))
    .join('');

  assert.equal(row2, 'ЙЦУКЕНГШЩЗ');
  assert.equal(row3, 'ФЫВАПРОЛД');
  assert.equal(row4, 'ЯЧСМИТЬ');

  const uniqueRu = new Set(Object.values(SPECTRUM_RU_JCUKEN_MAP));
  assert.equal(Object.keys(SPECTRUM_RU_JCUKEN_MAP).length, 26);
  assert.equal(uniqueRu.size, 26);
});

test('getSpectrumKeyDisplayLabel preserves non-letter keys in RU mode and returns Latin in EN mode', () => {
  for (const row of SPECTRUM_KEYS) {
    for (const spec of row) {
      assert.equal(getSpectrumKeyDisplayLabel(spec, 'en'), spec.label);
      const isLetter = spec.id.length === 1 && spec.id >= 'A' && spec.id <= 'Z';
      if (!isLetter) {
        assert.equal(getSpectrumKeyDisplayLabel(spec, 'ru'), spec.label);
      }
    }
  }
});

test('KeyboardMatrix port #FE bit positions remain identical for physical and virtual keys', () => {
  const matrix = new KeyboardMatrix();
  // Q (Й) is row 2 (0xFBFE), bit 0
  matrix.setVirtualKey('Q', true);
  assert.equal(matrix.readRows(0xfb) & 0x01, 0);
  matrix.setVirtualKey('Q', false);
  for (let i = 0; i < 4; i++) matrix.endVirtualFrame();
  assert.equal(matrix.readRows(0xfb) & 0x01, 1);

  // Physical Russian Й on Windows/Linux/macOS sends code KeyQ
  assert.equal(matrix.handlePhysicalKeyDown('KeyQ', 'й', false), true);
  assert.equal(matrix.readRows(0xfb) & 0x01, 0);
  matrix.handlePhysicalKeyUp('KeyQ');
  assert.equal(matrix.readRows(0xfb) & 0x01, 1);
});

test('sanitizeEmulatorSettings validates keyboardLayout safely', () => {
  assert.equal(sanitizeEmulatorSettings({}).keyboardLayout, 'en');
  assert.equal(sanitizeEmulatorSettings({ keyboardLayout: 'ru' }).keyboardLayout, 'ru');
  assert.equal(sanitizeEmulatorSettings({ keyboardLayout: 'en' }).keyboardLayout, 'en');
  assert.equal(sanitizeEmulatorSettings({ keyboardLayout: 'jcuken' }).keyboardLayout, 'en');
});

test('Physical Shift+Digit1..0 sends pure CAPS+Digit (EDIT/CAPS LOCK/GRAPHICS/DELETE) in EN and RU OS layouts', () => {
  const matrix = new KeyboardMatrix();

  // Shift + 1 (EN sends '!', RU sends '!') -> must press CAPS (row 0 bit 0) + 1 (row 3 bit 0), NEVER SYMBOL (row 7 bit 1)
  matrix.handlePhysicalKeyDown('ShiftLeft', 'Shift', true);
  matrix.handlePhysicalKeyDown('Digit1', '!', true);
  assert.equal(matrix.readRows(0xfe) & 0x01, 0, 'CAPS should be active');
  assert.equal(matrix.readRows(0xf7) & 0x01, 0, 'Digit 1 should be active');
  assert.equal(matrix.readRows(0x7f) & 0x02, 0x02, 'SYMBOL must NOT be active on Shift+1');
  matrix.handlePhysicalKeyUp('Digit1');

  // Shift + 2 in Russian OS layout sends '"' -> must still press CAPS + 2 (CAPS LOCK), not SYMBOL + P
  matrix.handlePhysicalKeyDown('Digit2', '"', true);
  assert.equal(matrix.readRows(0xfe) & 0x01, 0, 'CAPS should be active');
  assert.equal(matrix.readRows(0xf7) & 0x02, 0, 'Digit 2 should be active');
  assert.equal(matrix.readRows(0xdf) & 0x01, 0x01, 'P must NOT be pressed on RU Shift+2');
  assert.equal(matrix.readRows(0x7f) & 0x02, 0x02, 'SYMBOL must NOT be active on RU Shift+2');
  matrix.handlePhysicalKeyUp('Digit2');

  // Shift + 9 -> CAPS + 9 (GRAPHICS)
  matrix.handlePhysicalKeyDown('Digit9', '(', true);
  assert.equal(matrix.readRows(0xfe) & 0x01, 0, 'CAPS should be active');
  assert.equal(matrix.readRows(0xef) & 0x02, 0, 'Digit 9 should be active');
  assert.equal(matrix.readRows(0x7f) & 0x02, 0x02, 'SYMBOL must NOT be active on Shift+9');
  matrix.handlePhysicalKeyUp('Digit9');
  matrix.handlePhysicalKeyUp('ShiftLeft');

  for (let i = 0; i < 8; i++) {
    assert.equal(matrix.rows[i], 0x1f);
  }
});

test('Physical Alt/Ctrl+Digit produces SYMBOL+Digit and Shift+Control produces CAPS+SYMBOL (EXTEND)', () => {
  const matrix = new KeyboardMatrix();

  // AltLeft + Digit1 -> SYMBOL + 1 ('!')
  matrix.handlePhysicalKeyDown('AltLeft', 'Alt', false);
  matrix.handlePhysicalKeyDown('Digit1', '¡', false);
  assert.equal(matrix.readRows(0x7f) & 0x02, 0, 'SYMBOL active');
  assert.equal(matrix.readRows(0xf7) & 0x01, 0, '1 active');
  assert.equal(matrix.readRows(0xfe) & 0x01, 0x01, 'CAPS inactive');
  matrix.handlePhysicalKeyUp('Digit1');
  matrix.handlePhysicalKeyUp('AltLeft');

  // ShiftLeft + ControlLeft -> CAPS + SYMBOL (EXTEND mode)
  matrix.handlePhysicalKeyDown('ShiftLeft', 'Shift', true);
  matrix.handlePhysicalKeyDown('ControlLeft', 'Control', true);
  assert.equal(matrix.readRows(0xfe) & 0x01, 0, 'CAPS active for EXTEND');
  assert.equal(matrix.readRows(0x7f) & 0x02, 0, 'SYMBOL active for EXTEND');
  matrix.handlePhysicalKeyUp('ControlLeft');
  matrix.handlePhysicalKeyUp('ShiftLeft');

  for (let i = 0; i < 8; i++) {
    assert.equal(matrix.rows[i], 0x1f);
  }
});

test('Shifted punctuation suppresses held PC Shift CAPS leakage and restores cleanly', () => {
  const matrix = new KeyboardMatrix();

  // Hold ShiftLeft -> CAPS is active
  matrix.handlePhysicalKeyDown('ShiftLeft', 'Shift', true);
  assert.equal(matrix.readRows(0xfe) & 0x01, 0);

  // Press Quote ('"') -> SYMBOL + P without CAPS!
  matrix.handlePhysicalKeyDown('Quote', '"', true);
  assert.equal(matrix.readRows(0x7f) & 0x02, 0, 'SYMBOL must be active');
  assert.equal(matrix.readRows(0xdf) & 0x01, 0, 'P must be active');
  assert.equal(matrix.readRows(0xfe) & 0x01, 0x01, 'CAPS must be suppressed while typing "');

  // Release Quote while ShiftLeft stays held -> CAPS resumes cleanly
  matrix.handlePhysicalKeyUp('Quote');
  assert.equal(matrix.readRows(0xfe) & 0x01, 0, 'CAPS resumes when ShiftLeft still held');
  assert.equal(matrix.readRows(0x7f) & 0x02, 0x02, 'SYMBOL released');
  assert.equal(matrix.readRows(0xdf) & 0x01, 0x01, 'P released');

  // Reverse release order: ShiftLeft released BEFORE Quote
  matrix.handlePhysicalKeyDown('Slash', '?', true);
  assert.equal(matrix.readRows(0xfe) & 0x01, 0x01, 'CAPS suppressed during ?');
  matrix.handlePhysicalKeyUp('ShiftLeft');
  assert.equal(matrix.readRows(0xfe) & 0x01, 0x01, 'CAPS stays off');
  matrix.handlePhysicalKeyUp('Slash');

  // releaseAllPhysical safety check
  matrix.handlePhysicalKeyDown('ShiftRight', 'Shift', true);
  matrix.handlePhysicalKeyDown('Digit1', '!', true);
  matrix.releaseAllPhysical();
  for (let i = 0; i < 8; i++) {
    assert.equal(matrix.rows[i], 0x1f);
  }
});
