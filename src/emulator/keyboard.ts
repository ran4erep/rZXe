// ZX Spectrum 48K 8x5 Keyboard Matrix + Kempston Joystick + Authentic 40-key Layout

export interface SpectrumKeySpec {
  id: string;
  row: number; // 0..7 (A8..A15)
  bit: number; // 0..4 (D0..D4)
  label: string;
  subLabel?: string; // Secondary text printed on keycap (e.g. SHIFT, BREAK)
  keyword?: string; // White main Sinclair BASIC keyword on keycap
  symbol?: string; // Red Symbol Shift symbol on keycap
  colorName?: string; // Colour name printed above Row 1 keys (BLUE..WHITE, BLACK)
  colorNameHex?: string; // CSS colour for colorName
  topText?: string; // White (Row 1) or Green (Rows 2-4) caption printed above keycap
  topKind?: 'white' | 'green'; // Faceplate top legend colour
  bottomText?: string; // Red caption printed below keycap
  colorBar?: string; // ZX Spectrum 1..8 colour stripe
  widthClass?: string;
  isShift?: 'CAPS' | 'SYMBOL';
}

// Row indices matching A8..A15 address lines:
// Row 0 (0xFEFE): CAPS SHIFT, Z, X, C, V
// Row 1 (0xFDFE): A, S, D, F, G
// Row 2 (0xFBFE): Q, W, E, R, T
// Row 3 (0xF7FE): 1, 2, 3, 4, 5
// Row 4 (0xEFFE): 0, 9, 8, 7, 6
// Row 5 (0xDFFE): P, O, I, U, Y
// Row 6 (0xBFFE): ENTER, L, K, J, H
// Row 7 (0x7FFE): SPACE, SYMBOL SHIFT, M, N, B

export const SPECTRUM_KEYS: SpectrumKeySpec[][] = [
  // Row 1: 1..0
  [
    { id: '1', row: 3, bit: 0, label: '1', symbol: '!', colorName: 'BLUE', colorNameHex: '#60a5fa', topText: 'EDIT', topKind: 'white', bottomText: 'DEF FN', colorBar: '#0000d7' },
    { id: '2', row: 3, bit: 1, label: '2', symbol: '@', colorName: 'RED', colorNameHex: '#f87171', topText: 'CAPS LOCK', topKind: 'white', bottomText: 'FN', colorBar: '#d70000' },
    { id: '3', row: 3, bit: 2, label: '3', symbol: '#', colorName: 'MAGENTA', colorNameHex: '#e879f9', topText: 'TRUE VIDEO', topKind: 'white', bottomText: 'LINE', colorBar: '#d700d7' },
    { id: '4', row: 3, bit: 3, label: '4', symbol: '$', colorName: 'GREEN', colorNameHex: '#4ade80', topText: 'INV. VIDEO', topKind: 'white', bottomText: 'OPEN #', colorBar: '#00d700' },
    { id: '5', row: 3, bit: 4, label: '5', symbol: '%', colorName: 'CYAN', colorNameHex: '#22d3ee', topText: '←', topKind: 'white', bottomText: 'CLOSE #', colorBar: '#00d7d7' },
    { id: '6', row: 4, bit: 4, label: '6', symbol: '&', colorName: 'YELLOW', colorNameHex: '#facc15', topText: '↓', topKind: 'white', bottomText: 'MOVE', colorBar: '#d7d700' },
    { id: '7', row: 4, bit: 3, label: '7', symbol: "'", colorName: 'WHITE', colorNameHex: '#f4f4f5', topText: '↑', topKind: 'white', bottomText: 'ERASE', colorBar: '#d7d7d7' },
    { id: '8', row: 4, bit: 2, label: '8', symbol: '(', topText: '→', topKind: 'white', bottomText: 'POINT', colorBar: '#18181b' },
    { id: '9', row: 4, bit: 1, label: '9', symbol: ')', topText: 'GRAPHICS', topKind: 'white', bottomText: 'CAT' },
    { id: '0', row: 4, bit: 0, label: '0', symbol: '_', colorName: 'BLACK', colorNameHex: '#09090b', topText: 'DELETE', topKind: 'white', bottomText: 'FORMAT' },
  ],
  // Row 2: Q..P
  [
    { id: 'Q', row: 2, bit: 0, label: 'Q', keyword: 'PLOT', symbol: '<=', topText: 'SIN', topKind: 'green', bottomText: 'ASN' },
    { id: 'W', row: 2, bit: 1, label: 'W', keyword: 'DRAW', symbol: '<>', topText: 'COS', topKind: 'green', bottomText: 'ACS' },
    { id: 'E', row: 2, bit: 2, label: 'E', keyword: 'REM', symbol: '>=', topText: 'TAN', topKind: 'green', bottomText: 'ATN' },
    { id: 'R', row: 2, bit: 3, label: 'R', keyword: 'RUN', symbol: '<', topText: 'INT', topKind: 'green', bottomText: 'VERIFY' },
    { id: 'T', row: 2, bit: 4, label: 'T', keyword: 'RAND', symbol: '>', topText: 'RND', topKind: 'green', bottomText: 'MERGE' },
    { id: 'Y', row: 5, bit: 4, label: 'Y', keyword: 'RETURN', symbol: 'AND', topText: 'STR$', topKind: 'green', bottomText: '[' },
    { id: 'U', row: 5, bit: 3, label: 'U', keyword: 'IF', symbol: 'OR', topText: 'CHR$', topKind: 'green', bottomText: ']' },
    { id: 'I', row: 5, bit: 2, label: 'I', keyword: 'INPUT', symbol: 'AT', topText: 'CODE', topKind: 'green', bottomText: 'IN' },
    { id: 'O', row: 5, bit: 1, label: 'O', keyword: 'POKE', symbol: ';', topText: 'PEEK', topKind: 'green', bottomText: 'OUT' },
    { id: 'P', row: 5, bit: 0, label: 'P', keyword: 'PRINT', symbol: '"', topText: 'TAB', topKind: 'green', bottomText: '©' },
  ],
  // Row 3: A..L + ENTER
  [
    { id: 'A', row: 1, bit: 0, label: 'A', keyword: 'NEW', symbol: 'STOP', topText: 'READ', topKind: 'green', bottomText: '~' },
    { id: 'S', row: 1, bit: 1, label: 'S', keyword: 'SAVE', symbol: 'NOT', topText: 'RESTORE', topKind: 'green', bottomText: '|' },
    { id: 'D', row: 1, bit: 2, label: 'D', keyword: 'DIM', symbol: 'STEP', topText: 'DATA', topKind: 'green', bottomText: '\\' },
    { id: 'F', row: 1, bit: 3, label: 'F', keyword: 'FOR', symbol: 'TO', topText: 'SGN', topKind: 'green', bottomText: '{' },
    { id: 'G', row: 1, bit: 4, label: 'G', keyword: 'GOTO', symbol: 'THEN', topText: 'ABS', topKind: 'green', bottomText: '}' },
    { id: 'H', row: 6, bit: 4, label: 'H', keyword: 'GOSUB', symbol: '↑', topText: 'SQR', topKind: 'green', bottomText: 'CIRCLE' },
    { id: 'J', row: 6, bit: 3, label: 'J', keyword: 'LOAD', symbol: '-', topText: 'VAL', topKind: 'green', bottomText: 'VAL$' },
    { id: 'K', row: 6, bit: 2, label: 'K', keyword: 'LIST', symbol: '+', topText: 'LEN', topKind: 'green', bottomText: 'SCREEN$' },
    { id: 'L', row: 6, bit: 1, label: 'L', keyword: 'LET', symbol: '=', topText: 'USR', topKind: 'green', bottomText: 'ATTR' },
    { id: 'ENTER', row: 6, bit: 0, label: 'ENTER' },
  ],
  // Row 4: CAPS, Z..M, SYMBOL, SPACE
  [
    { id: 'CAPS', row: 0, bit: 0, label: 'CAPS', subLabel: 'SHIFT', isShift: 'CAPS', widthClass: 'flex-[1.3]' },
    { id: 'Z', row: 0, bit: 1, label: 'Z', keyword: 'COPY', symbol: ':', topText: 'LN', topKind: 'green', bottomText: 'BEEP' },
    { id: 'X', row: 0, bit: 2, label: 'X', keyword: 'CLEAR', symbol: '£', topText: 'EXP', topKind: 'green', bottomText: 'INK' },
    { id: 'C', row: 0, bit: 3, label: 'C', keyword: 'CONT', symbol: '?', topText: 'LPRINT', topKind: 'green', bottomText: 'PAPER' },
    { id: 'V', row: 0, bit: 4, label: 'V', keyword: 'CLS', symbol: '/', topText: 'LLIST', topKind: 'green', bottomText: 'FLASH' },
    { id: 'B', row: 7, bit: 4, label: 'B', keyword: 'BORDER', symbol: '*', topText: 'BIN', topKind: 'green', bottomText: 'BRIGHT' },
    { id: 'N', row: 7, bit: 3, label: 'N', keyword: 'NEXT', symbol: ',', topText: 'INKEY$', topKind: 'green', bottomText: 'OVER' },
    { id: 'M', row: 7, bit: 2, label: 'M', keyword: 'PAUSE', symbol: '.', topText: 'PI', topKind: 'green', bottomText: 'INVERSE' },
    { id: 'SYMBOL', row: 7, bit: 1, label: 'SYMBOL', subLabel: 'SHIFT', isShift: 'SYMBOL', widthClass: 'flex-[1.15]' },
    { id: 'SPACE', row: 7, bit: 0, label: 'SPACE', subLabel: 'BREAK', widthClass: 'flex-[1.55]' },
  ],
];

const KEY_LOOKUP = new Map<string, { row: number; bit: number }>();
for (const row of SPECTRUM_KEYS) {
  for (const k of row) {
    KEY_LOOKUP.set(k.id, { row: k.row, bit: k.bit });
  }
}

const MIN_VIRTUAL_HOLD_FRAMES = 3;
const QAOP_DIRECTION_KEYS = ['P', 'O', 'A', 'Q'] as const;

export type JoystickMode = 'kempston' | 'qaop';

interface VirtualPointerAction {
  keys: readonly string[];
  kempstonBit?: number;
  mouseButton?: 0 | 1 | 2;
}

export interface GamepadButtonLike {
  pressed?: boolean;
  value?: number;
}

export interface GamepadLike {
  connected?: boolean;
  axes?: ArrayLike<number>;
  buttons?: ArrayLike<GamepadButtonLike | null | undefined>;
}

const HARDWARE_STICK_DEADZONE = 0.35;

export class KeyboardMatrix {
  // 8 rows, bits 0..4 active low (0x1F = nothing pressed)
  public readonly rows = new Uint8Array(8);
  // Active sources per matrix position so multi-touch + physical keys never stomp each other
  private readonly counts = new Uint8Array(40);
  // Kempston joystick bits: 0=R, 1=L, 2=D, 3=U, 4=Fire (virtual | hardware gamepad)
  public kempston = 0;
  private virtualKempstonMask = 0;
  private hardwareGamepadMask = 0;
  private hardwareGamepadStickMask = 0;
  private readonly kempstonHoldFrames = new Uint8Array(5);
  private kempstonPendingMask = 0;
  private continuousPadMask = 0;
  private joystickMode: JoystickMode = 'kempston';

  // Kempston mouse state (ports 0xFBDF=X, 0xFFDF=Y, 0xFADF=buttons+wheel)
  public mouseX = 128;
  public mouseY = 96;
  public mouseButtons = 0x07; // active-low bits: 0=Left, 1=Right, 2=Middle (1=released)
  public mouseWheel = 0x0f;   // 4-bit scroll wheel counter (0..15)
  private mouseFracX = 0;
  private mouseFracY = 0;
  private readonly mouseBtnHoldFrames = new Uint8Array(3);
  private mouseBtnPendingMask = 0;

  // Physical KeyboardEvent.code -> static tuple of matrix IDs pressed by that physical key
  private readonly physicalPressed = new Map<string, readonly string[]>();
  // Touch / virtual pressed keys + minimum frame latch so fast taps never drop in 50Hz/25Hz loops
  private readonly virtualPressed = new Set<string>();
  private readonly virtualPendingRelease = new Set<string>();
  private readonly virtualHoldFrames = new Map<string, number>();
  private readonly virtualPointers = new Map<number, VirtualPointerAction>();
  private readonly virtualSlideTargets = new Map<number, string>();

  constructor() {
    this.rows.fill(0x1f);
  }

  private syncKempston(): void {
    this.kempston = (this.virtualKempstonMask | this.hardwareGamepadMask) & 0x1f;
  }

  public clearAll(): void {
    this.rows.fill(0x1f);
    this.counts.fill(0);
    this.physicalPressed.clear();
    this.virtualPressed.clear();
    this.virtualPendingRelease.clear();
    this.virtualHoldFrames.clear();
    this.virtualPointers.clear();
    this.virtualSlideTargets.clear();
    this.virtualKempstonMask = 0;
    this.hardwareGamepadMask = 0;
    this.hardwareGamepadStickMask = 0;
    this.kempston = 0;
    this.kempstonPendingMask = 0;
    this.kempstonHoldFrames.fill(0);
    this.continuousPadMask = 0;
    this.mouseX = 128;
    this.mouseY = 96;
    this.mouseButtons = 0x07;
    this.mouseWheel = 0x0f;
    this.mouseFracX = 0;
    this.mouseFracY = 0;
    this.mouseBtnPendingMask = 0;
    this.mouseBtnHoldFrames.fill(0);
  }

  private setKeyDelta(id: string, delta: number): void {
    const pos = KEY_LOOKUP.get(id);
    if (!pos) return;
    const idx = pos.row * 5 + pos.bit;
    const next = Math.max(0, this.counts[idx] + delta);
    this.counts[idx] = next;
    if (next > 0) {
      this.rows[pos.row] &= ~(1 << pos.bit);
    } else {
      this.rows[pos.row] |= 1 << pos.bit;
    }
  }

  public pressVirtualButton(
    pointerId: number,
    _buttonId: string,
    keys: readonly string[],
    kempstonBit?: number,
    mouseButton?: 0 | 1 | 2
  ): void {
    if (this.virtualPointers.has(pointerId)) {
      this.releaseVirtualButton(pointerId);
    }

    this.virtualPointers.set(pointerId, { keys, kempstonBit, mouseButton });
    for (let i = 0; i < keys.length; i++) {
      this.setVirtualKey(keys[i], true);
    }
    if (kempstonBit !== undefined) {
      this.setKempstonDirection(kempstonBit, true);
    }
    if (mouseButton !== undefined) {
      this.setKempstonMouseButton(mouseButton, true);
    }
  }

  public setVirtualShiftSlideTarget(pointerId: number, targetKeyId: string | null): void {
    const prevTarget = this.virtualSlideTargets.get(pointerId) ?? null;
    if (prevTarget === targetKeyId) return;
    if (prevTarget !== null) {
      this.virtualSlideTargets.delete(pointerId);
      this.setVirtualKey(prevTarget, false);
    }
    if (targetKeyId !== null) {
      this.virtualSlideTargets.set(pointerId, targetKeyId);
      this.setVirtualKey(targetKeyId, true);
    }
  }

  public releaseVirtualButton(pointerId: number): void {
    const slideTarget = this.virtualSlideTargets.get(pointerId);
    if (slideTarget !== undefined) {
      this.virtualSlideTargets.delete(pointerId);
      this.setVirtualKey(slideTarget, false);
    }

    const action = this.virtualPointers.get(pointerId);
    if (!action) return;
    this.virtualPointers.delete(pointerId);

    const keys = action.keys;
    for (let i = 0; i < keys.length; i++) {
      this.setVirtualKey(keys[i], false);
    }
    if (action.kempstonBit !== undefined) {
      this.setKempstonDirection(action.kempstonBit, false);
    }
    if (action.mouseButton !== undefined) {
      this.setKempstonMouseButton(action.mouseButton, false);
    }
  }

  public setVirtualKey(id: string, down: boolean): void {
    if (down) {
      // If a prior released non-shift tap already had >= 1 frame, release it now so fast typing never ghosts
      if (id !== 'CAPS' && id !== 'SYMBOL' && this.virtualPendingRelease.size > 0) {
        for (const prevId of this.virtualPendingRelease) {
          if (prevId !== id && prevId !== 'CAPS' && prevId !== 'SYMBOL') {
            const prevRem = this.virtualHoldFrames.get(prevId) ?? 0;
            if (prevRem < MIN_VIRTUAL_HOLD_FRAMES) {
              this.virtualPendingRelease.delete(prevId);
              this.virtualHoldFrames.delete(prevId);
              if (this.virtualPressed.delete(prevId)) {
                this.setKeyDelta(prevId, -1);
              }
            }
          }
        }
      }

      this.virtualPendingRelease.delete(id);
      this.virtualHoldFrames.set(id, MIN_VIRTUAL_HOLD_FRAMES);
      if (!this.virtualPressed.has(id)) {
        this.virtualPressed.add(id);
        this.setKeyDelta(id, 1);
      }
    } else {
      if (!this.virtualPressed.has(id)) return;
      const rem = this.virtualHoldFrames.get(id) ?? 0;
      if (rem <= 0) {
        this.virtualPressed.delete(id);
        this.virtualPendingRelease.delete(id);
        this.virtualHoldFrames.delete(id);
        this.setKeyDelta(id, -1);
      } else {
        // Hold until minimum emulated frame count finishes
        this.virtualPendingRelease.add(id);
      }
    }
  }

  public endVirtualFrame(): void {
    if (this.virtualPressed.size > 0) {
      for (const id of this.virtualPressed) {
        const rem = this.virtualHoldFrames.get(id) ?? 0;
        if (rem > 1) {
          this.virtualHoldFrames.set(id, rem - 1);
        } else {
          this.virtualHoldFrames.delete(id);
          if (this.virtualPendingRelease.delete(id)) {
            this.virtualPressed.delete(id);
            this.setKeyDelta(id, -1);
          }
        }
      }
    }

    if (this.virtualKempstonMask !== 0) {
      for (let bit = 0; bit < 5; bit++) {
        const mask = 1 << bit;
        if ((this.virtualKempstonMask & mask) === 0) continue;
        const rem = this.kempstonHoldFrames[bit];
        if (rem > 1) {
          this.kempstonHoldFrames[bit] = rem - 1;
        } else {
          this.kempstonHoldFrames[bit] = 0;
          if ((this.kempstonPendingMask & mask) !== 0) {
            this.kempstonPendingMask &= ~mask;
            this.virtualKempstonMask &= ~mask;
          }
        }
      }
      this.syncKempston();
    }
    if (this.mouseBtnPendingMask !== 0 || this.mouseButtons !== 0x07) {
      for (let bit = 0; bit < 3; bit++) {
        const mask = 1 << bit;
        if ((this.mouseButtons & mask) !== 0) continue; // bit=1 means released
        const rem = this.mouseBtnHoldFrames[bit];
        if (rem > 1) {
          this.mouseBtnHoldFrames[bit] = rem - 1;
        } else {
          this.mouseBtnHoldFrames[bit] = 0;
          if ((this.mouseBtnPendingMask & mask) !== 0) {
            this.mouseBtnPendingMask &= ~mask;
            this.mouseButtons |= mask;
          }
        }
      }
    }
  }

  public releaseAllVirtual(): void {
    this.setContinuousPadMask(0);
    this.virtualPointers.clear();
    this.virtualSlideTargets.clear();

    if (this.virtualPressed.size > 0) {
      for (const id of this.virtualPressed) {
        this.setKeyDelta(id, -1);
      }
      this.virtualPressed.clear();
    }
    this.virtualPendingRelease.clear();
    this.virtualHoldFrames.clear();
    this.virtualKempstonMask = 0;
    this.kempstonPendingMask = 0;
    this.kempstonHoldFrames.fill(0);
    this.syncKempston();
    this.mouseButtons = 0x07;
    this.mouseBtnPendingMask = 0;
    this.mouseBtnHoldFrames.fill(0);
    this.mouseFracX = 0;
    this.mouseFracY = 0;
  }

  public getJoystickMode(): JoystickMode {
    return this.joystickMode;
  }

  public setJoystickMode(mode: JoystickMode): void {
    if (this.joystickMode === mode) return;
    this.setContinuousPadMask(0);
    this.joystickMode = mode;
  }

  /**
   * Immediately updates continuous joystick/D-Pad 4-bit direction mask (0=R, 1=L, 2=D, 3=U)
   * using either pure Kempston port 0x1F or pure QAOP keyboard matrix according to joystickMode.
   */
  public setContinuousPadMask(nextMask: number): void {
    const masked = nextMask & 0x0f;
    const prevMask = this.continuousPadMask;
    if (prevMask === masked) return;
    this.continuousPadMask = masked;

    const diff = prevMask ^ masked;
    if (this.joystickMode === 'qaop') {
      // Release deactivated directions first, then engage new directions atomically
      for (let bit = 0; bit < 4; bit++) {
        const bitMask = 1 << bit;
        if ((diff & bitMask) !== 0 && (masked & bitMask) === 0) {
          this.setKeyDelta(QAOP_DIRECTION_KEYS[bit], -1);
        }
      }
      for (let bit = 0; bit < 4; bit++) {
        const bitMask = 1 << bit;
        if ((diff & bitMask) !== 0 && (masked & bitMask) !== 0) {
          this.setKeyDelta(QAOP_DIRECTION_KEYS[bit], 1);
        }
      }
      return;
    }

    this.virtualKempstonMask = (this.virtualKempstonMask & ~diff) | masked;
    this.kempstonPendingMask &= ~diff;
    if ((diff & 0x01) !== 0) this.kempstonHoldFrames[0] = 0;
    if ((diff & 0x02) !== 0) this.kempstonHoldFrames[1] = 0;
    if ((diff & 0x04) !== 0) this.kempstonHoldFrames[2] = 0;
    if ((diff & 0x08) !== 0) this.kempstonHoldFrames[3] = 0;
    this.syncKempston();
  }

  /**
   * Zero-allocation read of modern HTML5 Gamepad API controllers into Kempston port 0x1F (bits 0..4).
   * Combines D-pad (buttons 12..15), left analog stick (axes 0..1 with strict deadzone/sectors),
   * and primary face/shoulder/trigger buttons (0..7) as Fire (bit 4).
   */
  public pollHardwareGamepads(pads: ArrayLike<GamepadLike | null | undefined> | null | undefined): void {
    let nextFullMask = 0;
    let nextStickMask = 0;

    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const gp = pads[i];
        if (!gp || !gp.connected) continue;

        const axes = gp.axes;
        if (axes && axes.length >= 2) {
          const ax = axes[0];
          const ay = axes[1];
          const stickMask = computeDpadMask(
            Number.isFinite(ax) ? ax : 0,
            Number.isFinite(ay) ? ay : 0,
            HARDWARE_STICK_DEADZONE,
            this.hardwareGamepadStickMask
          );
          nextStickMask |= stickMask;
          nextFullMask |= stickMask;
        }

        const btns = gp.buttons;
        if (btns) {
          if (btns.length > 12 && (btns[12]?.pressed || (btns[12]?.value ?? 0) > 0.5)) nextFullMask |= 0x08;
          if (btns.length > 13 && (btns[13]?.pressed || (btns[13]?.value ?? 0) > 0.5)) nextFullMask |= 0x04;
          if (btns.length > 14 && (btns[14]?.pressed || (btns[14]?.value ?? 0) > 0.5)) nextFullMask |= 0x02;
          if (btns.length > 15 && (btns[15]?.pressed || (btns[15]?.value ?? 0) > 0.5)) nextFullMask |= 0x01;

          const fireEnd = btns.length < 8 ? btns.length : 8;
          for (let b = 0; b < fireEnd; b++) {
            const btn = btns[b];
            if (btn && (btn.pressed || (btn.value ?? 0) > 0.5)) {
              nextFullMask |= 0x10;
              break;
            }
          }
        }
      }
    }

    if ((nextFullMask & 0x03) === 0x03) nextFullMask &= ~0x03;
    if ((nextFullMask & 0x0c) === 0x0c) nextFullMask &= ~0x0c;

    this.hardwareGamepadStickMask = nextStickMask & 0x0f;
    const masked = nextFullMask & 0x1f;
    if (this.hardwareGamepadMask !== masked) {
      this.hardwareGamepadMask = masked;
      this.syncKempston();
    }
  }

  public setKempstonDirection(bit: number, down: boolean): void {
    if (bit < 0 || bit > 4) return;
    const mask = 1 << bit;
    if (down) {
      // Clear pending release on opposite axis direction (R<->L, D<->U) so flicks never oppose
      if (bit < 4) {
        const oppBit = bit ^ 1;
        const oppMask = 1 << oppBit;
        if ((this.kempstonPendingMask & oppMask) !== 0) {
          this.kempstonPendingMask &= ~oppMask;
          this.virtualKempstonMask &= ~oppMask;
          this.kempstonHoldFrames[oppBit] = 0;
        }
      }
      this.kempstonPendingMask &= ~mask;
      this.kempstonHoldFrames[bit] = MIN_VIRTUAL_HOLD_FRAMES;
      this.virtualKempstonMask |= mask;
      this.syncKempston();
    } else {
      if ((this.virtualKempstonMask & mask) === 0) return;
      if (this.kempstonHoldFrames[bit] === 0) {
        this.virtualKempstonMask &= ~mask;
        this.kempstonPendingMask &= ~mask;
        this.syncKempston();
      } else {
        this.kempstonPendingMask |= mask;
      }
    }
  }

  public moveKempstonMouse(dx: number, dy: number): void {
    this.mouseFracX += dx;
    this.mouseFracY -= dy; // Kempston Mouse Y axis increases upward (opposite of DOM clientY)
    const stepX = Math.trunc(this.mouseFracX);
    const stepY = Math.trunc(this.mouseFracY);
    if (stepX !== 0) {
      this.mouseFracX -= stepX;
      this.mouseX = (this.mouseX + stepX) & 0xff;
    }
    if (stepY !== 0) {
      this.mouseFracY -= stepY;
      this.mouseY = (this.mouseY + stepY) & 0xff;
    }
  }

  public setKempstonMouseButton(bit: 0 | 1 | 2, down: boolean): void {
    const mask = 1 << bit;
    if (down) {
      this.mouseBtnPendingMask &= ~mask;
      this.mouseBtnHoldFrames[bit] = MIN_VIRTUAL_HOLD_FRAMES;
      this.mouseButtons &= ~mask; // active low
    } else {
      if ((this.mouseButtons & mask) !== 0) return;
      if (this.mouseBtnHoldFrames[bit] === 0) {
        this.mouseButtons |= mask;
        this.mouseBtnPendingMask &= ~mask;
      } else {
        this.mouseBtnPendingMask |= mask;
      }
    }
  }

  public scrollKempstonMouse(deltaY: number): void {
    if (deltaY === 0) return;
    this.mouseWheel = (this.mouseWheel + (deltaY < 0 ? 1 : -1)) & 0x0f;
  }

  public readMouseButtons(): number {
    return ((this.mouseWheel & 0x0f) << 4) | 0x08 | (this.mouseButtons & 0x07);
  }

  public readRows(highByte: number): number {
    const r = this.rows;
    let result = 0x1f;
    if ((highByte & 0x01) === 0) result &= r[0];
    if ((highByte & 0x02) === 0) result &= r[1];
    if ((highByte & 0x04) === 0) result &= r[2];
    if ((highByte & 0x08) === 0) result &= r[3];
    if ((highByte & 0x10) === 0) result &= r[4];
    if ((highByte & 0x20) === 0) result &= r[5];
    if ((highByte & 0x40) === 0) result &= r[6];
    if ((highByte & 0x80) === 0) result &= r[7];
    return result;
  }

  public handlePhysicalKeyDown(
    code: string,
    key: string,
    shiftKey: boolean
  ): boolean {
    if (this.physicalPressed.has(code)) {
      return true;
    }

    const mapped = mapPhysicalKey(code, key, shiftKey);
    if (!mapped) return false;

    this.physicalPressed.set(code, mapped);
    for (let i = 0; i < mapped.length; i++) {
      this.setKeyDelta(mapped[i], 1);
    }
    return true;
  }

  public handlePhysicalKeyUp(code: string): void {
    const mapped = this.physicalPressed.get(code);
    if (!mapped) return;
    this.physicalPressed.delete(code);
    for (let i = 0; i < mapped.length; i++) {
      this.setKeyDelta(mapped[i], -1);
    }
  }

  public releasePhysicalMouseButtons(): void {
    this.mouseButtons = 0x07;
    this.mouseBtnPendingMask = 0;
    this.mouseBtnHoldFrames.fill(0);
    this.mouseFracX = 0;
    this.mouseFracY = 0;
  }

  public releaseAllPhysical(): void {
    for (const [, mapped] of this.physicalPressed) {
      for (let i = 0; i < mapped.length; i++) {
        this.setKeyDelta(mapped[i], -1);
      }
    }
    this.physicalPressed.clear();
    this.hardwareGamepadMask = 0;
    this.hardwareGamepadStickMask = 0;
    this.syncKempston();
    this.releasePhysicalMouseButtons();
  }

  // Helper for tests / programmatic macro key injection
  public tapKeys(ids: readonly string[]): void {
    for (let i = 0; i < ids.length; i++) this.setVirtualKey(ids[i], true);
  }

  public releaseKeys(ids: readonly string[]): void {
    for (let i = 0; i < ids.length; i++) this.setVirtualKey(ids[i], false);
  }
}

const CODE_SINGLE_TUPLES = new Map<string, readonly string[]>();
const CODE_CAPS_TUPLES = new Map<string, readonly string[]>();

for (let c = 65; c <= 90; c++) {
  const ch = String.fromCharCode(c);
  const code = `Key${ch}`;
  CODE_SINGLE_TUPLES.set(code, [ch]);
  CODE_CAPS_TUPLES.set(code, ['CAPS', ch]);
}
for (let d = 0; d <= 9; d++) {
  const ch = String(d);
  const code = `Digit${ch}`;
  CODE_SINGLE_TUPLES.set(code, [ch]);
  CODE_CAPS_TUPLES.set(code, ['CAPS', ch]);
}

const PUNCT_KEY_TUPLES = new Map<string, readonly string[]>([
  ['"', ['SYMBOL', 'P']],
  [';', ['SYMBOL', 'O']],
  [':', ['SYMBOL', 'Z']],
  [',', ['SYMBOL', 'N']],
  ['.', ['SYMBOL', 'M']],
  ['?', ['SYMBOL', 'C']],
  ['/', ['SYMBOL', 'V']],
  ['*', ['SYMBOL', 'B']],
  ['-', ['SYMBOL', 'J']],
  ['+', ['SYMBOL', 'K']],
  ['=', ['SYMBOL', 'L']],
  ['!', ['SYMBOL', '1']],
  ['@', ['SYMBOL', '2']],
  ['#', ['SYMBOL', '3']],
  ['$', ['SYMBOL', '4']],
  ['%', ['SYMBOL', '5']],
  ['&', ['SYMBOL', '6']],
  ["'", ['SYMBOL', '7']],
  ['(', ['SYMBOL', '8']],
  [')', ['SYMBOL', '9']],
  ['_', ['SYMBOL', '0']],
  ['<', ['SYMBOL', 'R']],
  ['>', ['SYMBOL', 'T']],
]);

const TUPLE_ENTER: readonly string[] = ['ENTER'];
const TUPLE_SPACE: readonly string[] = ['SPACE'];
const TUPLE_CAPS_SPACE: readonly string[] = ['CAPS', 'SPACE'];
const TUPLE_CAPS: readonly string[] = ['CAPS'];
const TUPLE_SYMBOL: readonly string[] = ['SYMBOL'];
const TUPLE_BACKSPACE: readonly string[] = ['CAPS', '0'];
const TUPLE_ARROW_L: readonly string[] = ['CAPS', '5'];
const TUPLE_ARROW_D: readonly string[] = ['CAPS', '6'];
const TUPLE_ARROW_U: readonly string[] = ['CAPS', '7'];
const TUPLE_ARROW_R: readonly string[] = ['CAPS', '8'];
const TUPLE_COMMA: readonly string[] = ['SYMBOL', 'N'];
const TUPLE_PERIOD: readonly string[] = ['SYMBOL', 'M'];
const TUPLE_SLASH: readonly string[] = ['SYMBOL', 'V'];
const TUPLE_SEMICOLON: readonly string[] = ['SYMBOL', 'O'];
const TUPLE_QUOTE: readonly string[] = ['SYMBOL', 'P'];
const TUPLE_MINUS: readonly string[] = ['SYMBOL', 'J'];
const TUPLE_EQUAL: readonly string[] = ['SYMBOL', 'L'];

function mapPhysicalKey(code: string, key: string, shiftKey: boolean): readonly string[] | null {
  // Handle shifted punctuation first if character matches
  const punct = PUNCT_KEY_TUPLES.get(key);
  if (punct) return punct;

  // Letter & digit keys by physical code (works even if OS layout is Russian!)
  const codeTuple = shiftKey ? CODE_CAPS_TUPLES.get(code) : CODE_SINGLE_TUPLES.get(code);
  if (codeTuple) return codeTuple;

  switch (code) {
    case 'Enter':
    case 'NumpadEnter':
      return TUPLE_ENTER;
    case 'Space':
      return shiftKey ? TUPLE_CAPS_SPACE : TUPLE_SPACE;
    case 'ShiftLeft':
    case 'ShiftRight':
      return TUPLE_CAPS;
    case 'ControlLeft':
    case 'ControlRight':
    case 'AltLeft':
    case 'AltRight':
      return TUPLE_SYMBOL;
    case 'Backspace':
      return TUPLE_BACKSPACE;
    case 'ArrowLeft':
      return TUPLE_ARROW_L;
    case 'ArrowDown':
      return TUPLE_ARROW_D;
    case 'ArrowUp':
      return TUPLE_ARROW_U;
    case 'ArrowRight':
      return TUPLE_ARROW_R;
    case 'Escape':
      return TUPLE_CAPS_SPACE; // BREAK
    case 'Comma':
      return TUPLE_COMMA;
    case 'Period':
      return TUPLE_PERIOD;
    case 'Slash':
      return TUPLE_SLASH;
    case 'Semicolon':
      return TUPLE_SEMICOLON;
    case 'Quote':
      return TUPLE_QUOTE;
    case 'Minus':
      return TUPLE_MINUS;
    case 'Equal':
      return TUPLE_EQUAL;
    default:
      return null;
  }
}

const DEG_TO_RAD = Math.PI / 180;

// Strict 8-way diagonal entry/exit slopes for minor/major axis ratio (tan of cardinal half-angle):
// ±37 deg cardinal sector (74 deg total) on entry prevents curved thumb arcs from misfiring diagonals;
// ±32 deg exit slope adds 5 deg angular hysteresis to eliminate chatter along sector edges.
const STRICT_ENTER_SLOPE = Math.tan(37 * DEG_TO_RAD); // ~0.7536
const STRICT_EXIT_SLOPE = Math.tan(32 * DEG_TO_RAD);  // ~0.6249

export const STICK_DEADZONE_PX = 20;
export const DPAD_DEADZONE_PX = 21;

/**
 * Compute 8-way direction bitmask matching Kempston bits:
 * bit 0 (1) = Right, bit 1 (2) = Left, bit 2 (4) = Down, bit 3 (8) = Up.
 * Zero-allocation with strict radial deadzone hysteresis and angular hysteresis
 * so curved thumb arcs do not trigger unwanted diagonals or sector jitter.
 */
export function computeDpadMask(
  dx: number,
  dy: number,
  deadzone = STICK_DEADZONE_PX,
  prevMask = 0
): number {
  const effectiveDeadzone = prevMask === 0 ? deadzone : deadzone * 0.75;
  if (dx * dx + dy * dy < effectiveDeadzone * effectiveDeadzone) {
    return 0;
  }

  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const horizBit = dx >= 0 ? 0x01 : 0x02;
  const vertBit = dy >= 0 ? 0x04 : 0x08;

  const isDiagPrev = (prevMask & 0x03) !== 0 && (prevMask & 0x0c) !== 0;
  const slope = isDiagPrev ? STRICT_EXIT_SLOPE : STRICT_ENTER_SLOPE;

  if (ax >= ay) {
    return ay > ax * slope ? horizBit | vertBit : horizBit;
  }
  return ax > ay * slope ? horizBit | vertBit : vertBit;
}

export interface StickTouchState {
  anchorX: number;
  anchorY: number;
  dx: number;
  dy: number;
  clampedDx: number;
  clampedDy: number;
}

export function createStickTouchState(): StickTouchState {
  return { anchorX: 0, anchorY: 0, dx: 0, dy: 0, clampedDx: 0, clampedDy: 0 };
}

/**
 * Anchors a touch inside the knob radius directly under the finger (eliminating touch-down drift)
 * while still allowing immediate directional taps when touching outside the center knob.
 */
export function initStickTouchState(
  out: StickTouchState,
  clientX: number,
  clientY: number,
  baseCenterX: number,
  baseCenterY: number,
  maxStartAnchorR = 30,
  maxStickR = 46
): void {
  const offX = clientX - baseCenterX;
  const offY = clientY - baseCenterY;
  const distSq = offX * offX + offY * offY;
  if (distSq <= maxStartAnchorR * maxStartAnchorR) {
    out.anchorX = clientX;
    out.anchorY = clientY;
    out.dx = 0;
    out.dy = 0;
    out.clampedDx = 0;
    out.clampedDy = 0;
    return;
  }

  const dist = Math.sqrt(distSq);
  const anchorScale = maxStartAnchorR / dist;
  out.anchorX = baseCenterX + offX * anchorScale;
  out.anchorY = baseCenterY + offY * anchorScale;

  const dx = clientX - out.anchorX;
  const dy = clientY - out.anchorY;
  out.dx = dx;
  out.dy = dy;

  const dSq = dx * dx + dy * dy;
  if (dSq > maxStickR * maxStickR) {
    const knobScale = maxStickR / Math.sqrt(dSq);
    out.clampedDx = dx * knobScale;
    out.clampedDy = dy * knobScale;
  } else {
    out.clampedDx = dx;
    out.clampedDy = dy;
  }
}

/**
 * Updates virtual stick delta and applies a bounded "leash" when dragged past maxStickR,
 * keeping instant reverse-direction turnaround regardless of how far the thumb traveled.
 */
export function stepStickTouchState(
  out: StickTouchState,
  clientX: number,
  clientY: number,
  baseCenterX: number,
  baseCenterY: number,
  maxStickR = 46,
  maxAnchorDriftR = 42
): void {
  let dx = clientX - out.anchorX;
  let dy = clientY - out.anchorY;
  const distSq = dx * dx + dy * dy;

  if (distSq > maxStickR * maxStickR) {
    const dist = Math.sqrt(distSq);
    const excess = dist - maxStickR;
    let nextAnchorX = out.anchorX + (dx / dist) * excess;
    let nextAnchorY = out.anchorY + (dy / dist) * excess;

    const driftX = nextAnchorX - baseCenterX;
    const driftY = nextAnchorY - baseCenterY;
    const driftSq = driftX * driftX + driftY * driftY;
    if (driftSq > maxAnchorDriftR * maxAnchorDriftR) {
      const driftScale = maxAnchorDriftR / Math.sqrt(driftSq);
      nextAnchorX = baseCenterX + driftX * driftScale;
      nextAnchorY = baseCenterY + driftY * driftScale;
    }

    out.anchorX = nextAnchorX;
    out.anchorY = nextAnchorY;
    dx = clientX - nextAnchorX;
    dy = clientY - nextAnchorY;
  }

  out.dx = dx;
  out.dy = dy;

  const finalSq = dx * dx + dy * dy;
  if (finalSq > maxStickR * maxStickR) {
    const knobScale = maxStickR / Math.sqrt(finalSq);
    out.clampedDx = dx * knobScale;
    out.clampedDy = dy * knobScale;
  } else {
    out.clampedDx = dx;
    out.clampedDy = dy;
  }
}

/**
 * Encodes a printable ASCII string into ZX Spectrum key-chord tuples suitable for
 * typing inside quotes ("...") at the 48K BASIC / TR-DOS prompt.
 * Returns null if any character cannot be typed via standard/CAPS/SYMBOL chords.
 */
export function encodeSpectrumStringKeys(text: string): ReadonlyArray<readonly string[]> | null {
  const result: Array<readonly string[]> = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') {
      result.push(TUPLE_SPACE);
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code >= 0x61 && code <= 0x7a) {
      // 'a'..'z' (lowercase is unshifted in L mode)
      const tuple = CODE_SINGLE_TUPLES.get(`Key${ch.toUpperCase()}`);
      if (!tuple) return null;
      result.push(tuple);
      continue;
    }
    if (code >= 0x41 && code <= 0x5a) {
      // 'A'..'Z' (uppercase requires CAPS SHIFT in L mode)
      const tuple = CODE_CAPS_TUPLES.get(`Key${ch}`);
      if (!tuple) return null;
      result.push(tuple);
      continue;
    }
    if (code >= 0x30 && code <= 0x39) {
      // '0'..'9'
      const tuple = CODE_SINGLE_TUPLES.get(`Digit${ch}`);
      if (!tuple) return null;
      result.push(tuple);
      continue;
    }
    if (ch !== '"') {
      const punct = PUNCT_KEY_TUPLES.get(ch);
      if (punct) {
        result.push(punct);
        continue;
      }
    }
    return null;
  }
  return result;
}

/**
 * Scales a DOM mouse pixel delta into ZX Spectrum pixel coordinates without object allocations.
 */
export function computeDesktopMouseAxisDelta(
  rawDelta: number,
  internalPixels: number,
  cssPixels: number,
  sensitivity = 1
): number {
  if (!Number.isFinite(rawDelta) || rawDelta === 0) return 0;
  if (!Number.isFinite(internalPixels) || internalPixels <= 0) return 0;
  if (!Number.isFinite(cssPixels) || cssPixels <= 0) return 0;
  return rawDelta * (internalPixels / cssPixels) * sensitivity;
}

/**
 * Maps standard DOM MouseEvent.button (0=Left, 1=Middle, 2=Right)
 * to Kempston Mouse button bit index (0=Left, 1=Right, 2=Middle).
 */
export function mapMouseButtonToKempstonBit(button: number): 0 | 1 | 2 | null {
  if (button === 0) return 0;
  if (button === 2) return 1;
  if (button === 1) return 2;
  return null;
}


