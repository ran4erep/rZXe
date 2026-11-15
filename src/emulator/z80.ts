// High-performance, zero-allocation Z80A CPU core with O(1) 16KB bank paging & TR-DOS trap

export interface Z80IO {
  readPort(port: number): number;
  writePort(port: number, value: number, tstates: number): void;
  onRomTrap?: (cpu: Z80) => boolean;
  onTrdosCheck?: (pc: number) => void;
}

// Z80 Flag bit masks
export const FLAG_C = 0x01;
export const FLAG_N = 0x02;
export const FLAG_P = 0x04;
export const FLAG_V = 0x04;
export const FLAG_3 = 0x08;
export const FLAG_H = 0x10;
export const FLAG_5 = 0x20;
export const FLAG_Z = 0x40;
export const FLAG_S = 0x80;

// Precomputed lookup tables (allocated once at module load)
const SZ53_TABLE = new Uint8Array(256);
const SZ53P_TABLE = new Uint8Array(256);
const PARITY_TABLE = new Uint8Array(256);

const HALF_CARRY_ADD = new Uint8Array([0, FLAG_H, FLAG_H, FLAG_H, 0, 0, 0, FLAG_H]);
const HALF_CARRY_SUB = new Uint8Array([0, 0, FLAG_H, 0, FLAG_H, 0, FLAG_H, FLAG_H]);
const OVERFLOW_ADD = new Uint8Array([0, 0, 0, FLAG_V, FLAG_V, 0, 0, 0]);
const OVERFLOW_SUB = new Uint8Array([0, FLAG_V, 0, 0, 0, 0, FLAG_V, 0]);

for (let i = 0; i < 256; i++) {
  let bits = i;
  let parity = 0;
  for (let b = 0; b < 8; b++) {
    parity ^= bits & 1;
    bits >>= 1;
  }
  PARITY_TABLE[i] = parity === 0 ? FLAG_P : 0;
  const sz53 = (i & (FLAG_S | FLAG_5 | FLAG_3)) | (i === 0 ? FLAG_Z : 0);
  SZ53_TABLE[i] = sz53;
  SZ53P_TABLE[i] = sz53 | PARITY_TABLE[i];
}

export class Z80 {
  // 8-bit registers
  public a = 0;
  public f = 0;
  public b = 0;
  public c = 0;
  public d = 0;
  public e = 0;
  public h = 0;
  public l = 0;

  // Shadow registers
  public a_ = 0;
  public f_ = 0;
  public b_ = 0;
  public c_ = 0;
  public d_ = 0;
  public e_ = 0;
  public h_ = 0;
  public l_ = 0;

  // Index & special registers
  public ixh = 0;
  public ixl = 0;
  public iyh = 0;
  public iyl = 0;
  public sp = 0xffff;
  public pc = 0x0000;
  public i = 0;
  public r = 0;
  public r7 = 0;

  // Interrupt state
  public iff1 = 0;
  public iff2 = 0;
  public im = 0;
  public halted = false;
  public eiDelay = false;

  // Cycle counter
  public tstates = 0;

  // 4 x 16KB memory bank pointers for O(1) 48K/128K/256K/TR-DOS paging
  public readBanks: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  public writeBanks: [Uint8Array | null, Uint8Array, Uint8Array, Uint8Array];
  public screenBank: Uint8Array;
  public vramDirty = true;

  // Fast inline flags for ROM traps & TR-DOS M1 paging
  public trdosEnabled = false;
  public trdosActive = false;
  public romTrapAddr = 0x0556;
  public romTrapActive = false;

  private io: Z80IO;

  constructor(
    readBanks: [Uint8Array, Uint8Array, Uint8Array, Uint8Array],
    writeBanks: [Uint8Array | null, Uint8Array, Uint8Array, Uint8Array],
    screenBank: Uint8Array,
    io: Z80IO
  ) {
    this.readBanks = readBanks;
    this.writeBanks = writeBanks;
    this.screenBank = screenBank;
    this.io = io;
  }

  public reset(): void {
    this.a = 0xff;
    this.f = 0xff;
    this.b = 0;
    this.c = 0;
    this.d = 0;
    this.e = 0;
    this.h = 0;
    this.l = 0;
    this.a_ = 0xff;
    this.f_ = 0xff;
    this.b_ = 0;
    this.c_ = 0;
    this.d_ = 0;
    this.e_ = 0;
    this.h_ = 0;
    this.l_ = 0;
    this.ixh = 0xff;
    this.ixl = 0xff;
    this.iyh = 0xff;
    this.iyl = 0xff;
    this.sp = 0xffff;
    this.pc = 0x0000;
    this.i = 0;
    this.r = 0;
    this.r7 = 0;
    this.iff1 = 0;
    this.iff2 = 0;
    this.im = 0;
    this.halted = false;
    this.eiDelay = false;
    this.tstates = 0;
    this.vramDirty = true;
  }

  public get af(): number { return (this.a << 8) | this.f; }
  public set af(v: number) { this.a = (v >> 8) & 0xff; this.f = v & 0xff; }
  public get bc(): number { return (this.b << 8) | this.c; }
  public set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  public get de(): number { return (this.d << 8) | this.e; }
  public set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  public get hl(): number { return (this.h << 8) | this.l; }
  public set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }
  public get ix(): number { return (this.ixh << 8) | this.ixl; }
  public set ix(v: number) { this.ixh = (v >> 8) & 0xff; this.ixl = v & 0xff; }
  public get iy(): number { return (this.iyh << 8) | this.iyl; }
  public set iy(v: number) { this.iyh = (v >> 8) & 0xff; this.iyl = v & 0xff; }

  public rb(addr: number): number {
    const a = addr & 0xffff;
    return this.readBanks[a >> 14][a & 0x3fff];
  }

  public wb(addr: number, val: number): void {
    const a = addr & 0xffff;
    const slot = a >> 14;
    const bank = this.writeBanks[slot];
    if (bank !== null) {
      const off = a & 0x3fff;
      bank[off] = val & 0xff;
      if (off < 0x1b00 && bank === this.screenBank) {
        this.vramDirty = true;
      }
    }
  }

  private rw(addr: number): number {
    return this.rb(addr) | (this.rb(addr + 1) << 8);
  }

  private ww(addr: number, val: number): void {
    this.wb(addr, val & 0xff);
    this.wb(addr + 1, (val >> 8) & 0xff);
  }

  private fetch(): number {
    const pc = this.pc;
    const b = this.readBanks[pc >> 14][pc & 0x3fff];
    this.pc = (pc + 1) & 0xffff;
    return b;
  }

  private fetchWord(): number {
    const lo = this.fetch();
    const hi = this.fetch();
    return lo | (hi << 8);
  }

  private fetchSigned(): number {
    const b = this.fetch();
    return b < 128 ? b : b - 256;
  }

  private push(val: number): void {
    this.sp = (this.sp - 1) & 0xffff;
    this.wb(this.sp, (val >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.wb(this.sp, val & 0xff);
  }

  private pop(): number {
    const lo = this.rb(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.rb(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return lo | (hi << 8);
  }

  private incR(): void {
    this.r = (this.r + 1) & 0x7f;
  }

  public interrupt(): boolean {
    if (!this.iff1 || this.eiDelay) {
      return false;
    }
    if (this.halted) {
      this.pc = (this.pc + 1) & 0xffff;
      this.halted = false;
    }
    this.iff1 = 0;
    this.iff2 = 0;
    this.incR();
    this.push(this.pc);
    if (this.im === 2) {
      const vec = (this.i << 8) | 0xff;
      this.pc = this.rw(vec);
      this.tstates += 19;
    } else {
      this.pc = 0x0038;
      this.tstates += 13;
    }
    return true;
  }

  public nmi(): void {
    if (this.halted) {
      this.pc = (this.pc + 1) & 0xffff;
      this.halted = false;
    }
    this.iff2 = this.iff1;
    this.iff1 = 0;
    this.incR();
    this.push(this.pc);
    this.pc = 0x0066;
    this.tstates += 11;
  }

  // Arithmetic / Logic helpers
  private add8(val: number): void {
    const a = this.a;
    const sum = a + val;
    const res = sum & 0xff;
    const lookup = ((a & 0x88) >> 3) | ((val & 0x88) >> 2) | ((res & 0x88) >> 1);
    this.a = res;
    this.f =
      (sum > 0xff ? FLAG_C : 0) |
      HALF_CARRY_ADD[lookup & 0x07] |
      OVERFLOW_ADD[lookup >> 4] |
      SZ53_TABLE[res];
  }

  private adc8(val: number): void {
    const a = this.a;
    const c = this.f & FLAG_C;
    const sum = a + val + c;
    const res = sum & 0xff;
    const lookup = ((a & 0x88) >> 3) | ((val & 0x88) >> 2) | ((res & 0x88) >> 1);
    this.a = res;
    this.f =
      (sum > 0xff ? FLAG_C : 0) |
      HALF_CARRY_ADD[lookup & 0x07] |
      OVERFLOW_ADD[lookup >> 4] |
      SZ53_TABLE[res];
  }

  private sub8(val: number): void {
    const a = this.a;
    const diff = a - val;
    const res = diff & 0xff;
    const lookup = ((a & 0x88) >> 3) | ((val & 0x88) >> 2) | ((res & 0x88) >> 1);
    this.a = res;
    this.f =
      FLAG_N |
      (diff < 0 ? FLAG_C : 0) |
      HALF_CARRY_SUB[lookup & 0x07] |
      OVERFLOW_SUB[lookup >> 4] |
      SZ53_TABLE[res];
  }

  private sbc8(val: number): void {
    const a = this.a;
    const c = this.f & FLAG_C;
    const diff = a - val - c;
    const res = diff & 0xff;
    const lookup = ((a & 0x88) >> 3) | ((val & 0x88) >> 2) | ((res & 0x88) >> 1);
    this.a = res;
    this.f =
      FLAG_N |
      (diff < 0 ? FLAG_C : 0) |
      HALF_CARRY_SUB[lookup & 0x07] |
      OVERFLOW_SUB[lookup >> 4] |
      SZ53_TABLE[res];
  }

  private cp8(val: number): void {
    const a = this.a;
    const diff = a - val;
    const res = diff & 0xff;
    const lookup = ((a & 0x88) >> 3) | ((val & 0x88) >> 2) | ((res & 0x88) >> 1);
    this.f =
      FLAG_N |
      (diff < 0 ? FLAG_C : 0) |
      HALF_CARRY_SUB[lookup & 0x07] |
      OVERFLOW_SUB[lookup >> 4] |
      (res === 0 ? FLAG_Z : 0) |
      (res & FLAG_S) |
      (val & (FLAG_5 | FLAG_3));
  }

  private and8(val: number): void {
    this.a &= val;
    this.f = FLAG_H | SZ53P_TABLE[this.a];
  }

  private xor8(val: number): void {
    this.a ^= val;
    this.f = SZ53P_TABLE[this.a];
  }

  private or8(val: number): void {
    this.a |= val;
    this.f = SZ53P_TABLE[this.a];
  }

  private inc8(val: number): number {
    const res = (val + 1) & 0xff;
    this.f =
      (this.f & FLAG_C) |
      (res === 0x80 ? FLAG_V : 0) |
      ((res & 0x0f) === 0 ? FLAG_H : 0) |
      SZ53_TABLE[res];
    return res;
  }

  private dec8(val: number): number {
    const res = (val - 1) & 0xff;
    this.f =
      (this.f & FLAG_C) |
      FLAG_N |
      (res === 0x7f ? FLAG_V : 0) |
      ((res & 0x0f) === 0x0f ? FLAG_H : 0) |
      SZ53_TABLE[res];
    return res;
  }

  private add16(a: number, b: number): number {
    const sum = a + b;
    const lookup = ((a & 0x0800) >> 11) | ((b & 0x0800) >> 10) | ((sum & 0x0800) >> 9);
    const res = sum & 0xffff;
    this.f =
      (this.f & (FLAG_S | FLAG_Z | FLAG_V)) |
      (sum > 0xffff ? FLAG_C : 0) |
      HALF_CARRY_ADD[lookup & 0x07] |
      ((res >> 8) & (FLAG_5 | FLAG_3));
    return res;
  }

  private adc16(val: number): void {
    const hl = this.hl;
    const c = this.f & FLAG_C;
    const sum = hl + val + c;
    const res = sum & 0xffff;
    const lookup = ((hl & 0x8800) >> 11) | ((val & 0x8800) >> 10) | ((res & 0x8800) >> 9);
    this.hl = res;
    this.f =
      (sum > 0xffff ? FLAG_C : 0) |
      HALF_CARRY_ADD[lookup & 0x07] |
      OVERFLOW_ADD[lookup >> 4] |
      (res === 0 ? FLAG_Z : 0) |
      ((res >> 8) & (FLAG_S | FLAG_5 | FLAG_3));
  }

  private sbc16(val: number): void {
    const hl = this.hl;
    const c = this.f & FLAG_C;
    const diff = hl - val - c;
    const res = diff & 0xffff;
    const lookup = ((hl & 0x8800) >> 11) | ((val & 0x8800) >> 10) | ((res & 0x8800) >> 9);
    this.hl = res;
    this.f =
      FLAG_N |
      (diff < 0 ? FLAG_C : 0) |
      HALF_CARRY_SUB[lookup & 0x07] |
      OVERFLOW_SUB[lookup >> 4] |
      (res === 0 ? FLAG_Z : 0) |
      ((res >> 8) & (FLAG_S | FLAG_5 | FLAG_3));
  }

  private daa(): void {
    let add = 0;
    let carry = this.f & FLAG_C;
    const a = this.a;
    if ((this.f & FLAG_H) || (a & 0x0f) > 9) add = 6;
    if (carry || a > 0x99) {
      add |= 0x60;
      carry = FLAG_C;
    }
    if (this.f & FLAG_N) {
      const res = (a - add) & 0xff;
      const h = (this.f & FLAG_H) && (a & 0x0f) < 6 ? FLAG_H : 0;
      this.a = res;
      this.f = carry | FLAG_N | h | SZ53P_TABLE[res];
    } else {
      const res = (a + add) & 0xff;
      const h = (a & 0x0f) > 9 ? FLAG_H : 0;
      this.a = res;
      this.f = carry | h | SZ53P_TABLE[res];
    }
  }

  private rlc(v: number): number {
    const c = (v >> 7) & 1;
    const res = ((v << 1) | c) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private rrc(v: number): number {
    const c = v & 1;
    const res = ((v >> 1) | (c << 7)) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private rl(v: number): number {
    const c = (v >> 7) & 1;
    const res = ((v << 1) | (this.f & FLAG_C)) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private rr(v: number): number {
    const c = v & 1;
    const res = ((v >> 1) | ((this.f & FLAG_C) << 7)) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private sla(v: number): number {
    const c = (v >> 7) & 1;
    const res = (v << 1) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private sra(v: number): number {
    const c = v & 1;
    const res = ((v >> 1) | (v & 0x80)) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private sll(v: number): number {
    const c = (v >> 7) & 1;
    const res = ((v << 1) | 1) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }
  private srl(v: number): number {
    const c = v & 1;
    const res = (v >> 1) & 0xff;
    this.f = SZ53P_TABLE[res] | c;
    return res;
  }

  private getReg(idx: number): number {
    switch (idx) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.rb(this.hl);
      default: return this.a;
    }
  }

  private setReg(idx: number, val: number): void {
    switch (idx) {
      case 0: this.b = val; break;
      case 1: this.c = val; break;
      case 2: this.d = val; break;
      case 3: this.e = val; break;
      case 4: this.h = val; break;
      case 5: this.l = val; break;
      case 6: this.wb(this.hl, val); break;
      default: this.a = val; break;
    }
  }

  public step(): number {
    if (this.trdosEnabled) {
      if ((this.pc & 0xff00) === 0x3d00 || (this.trdosActive && this.pc >= 0x4000)) {
        this.io.onTrdosCheck?.(this.pc);
      }
    }
    if (this.romTrapActive && this.pc >= 0x0556 && this.pc <= 0x056c) {
      if (this.io.onRomTrap?.(this)) {
        return 10;
      }
    }

    this.eiDelay = false;
    const startT = this.tstates;
    if (this.halted) {
      this.incR();
      this.tstates += 4;
      return 4;
    }

    const op = this.fetch();
    this.incR();
    this.execMain(op);
    return this.tstates - startT;
  }

  public runUntil(targetTstates: number): void {
    while (this.tstates < targetTstates) {
      if (this.trdosEnabled) {
        if ((this.pc & 0xff00) === 0x3d00 || (this.trdosActive && this.pc >= 0x4000)) {
          this.io.onTrdosCheck?.(this.pc);
        }
      }
      if (this.romTrapActive && this.pc >= 0x0556 && this.pc <= 0x056c) {
        if (this.io.onRomTrap?.(this)) {
          this.tstates += 10;
          continue;
        }
      }
      if (this.halted) {
        const rem = targetTstates - this.tstates;
        const steps = (rem + 3) >> 2;
        this.r = (this.r + steps) & 0x7f;
        this.tstates += steps * 4;
        this.eiDelay = false;
        break;
      }
      this.eiDelay = false;
      const op = this.fetch();
      this.incR();
      this.execMain(op);
    }
  }

  private execMain(op: number): void {
    switch (op) {
      case 0x00: this.tstates += 4; break;
      case 0x01: this.bc = this.fetchWord(); this.tstates += 10; break;
      case 0x02: this.wb(this.bc, this.a); this.tstates += 7; break;
      case 0x03: this.bc = (this.bc + 1) & 0xffff; this.tstates += 6; break;
      case 0x04: this.b = this.inc8(this.b); this.tstates += 4; break;
      case 0x05: this.b = this.dec8(this.b); this.tstates += 4; break;
      case 0x06: this.b = this.fetch(); this.tstates += 7; break;
      case 0x07: {
        const c = (this.a >> 7) & 1;
        this.a = ((this.a << 1) | c) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.a & (FLAG_5 | FLAG_3)) | c;
        this.tstates += 4;
        break;
      }
      case 0x08: {
        const ta = this.a; const tf = this.f;
        this.a = this.a_; this.f = this.f_;
        this.a_ = ta; this.f_ = tf;
        this.tstates += 4;
        break;
      }
      case 0x09: this.hl = this.add16(this.hl, this.bc); this.tstates += 11; break;
      case 0x0a: this.a = this.rb(this.bc); this.tstates += 7; break;
      case 0x0b: this.bc = (this.bc - 1) & 0xffff; this.tstates += 6; break;
      case 0x0c: this.c = this.inc8(this.c); this.tstates += 4; break;
      case 0x0d: this.c = this.dec8(this.c); this.tstates += 4; break;
      case 0x0e: this.c = this.fetch(); this.tstates += 7; break;
      case 0x0f: {
        const c = this.a & 1;
        this.a = ((this.a >> 1) | (c << 7)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.a & (FLAG_5 | FLAG_3)) | c;
        this.tstates += 4;
        break;
      }
      case 0x10: {
        const e = this.fetchSigned();
        this.b = (this.b - 1) & 0xff;
        if (this.b !== 0) {
          this.pc = (this.pc + e) & 0xffff;
          this.tstates += 13;
        } else {
          this.tstates += 8;
        }
        break;
      }
      case 0x11: this.de = this.fetchWord(); this.tstates += 10; break;
      case 0x12: this.wb(this.de, this.a); this.tstates += 7; break;
      case 0x13: this.de = (this.de + 1) & 0xffff; this.tstates += 6; break;
      case 0x14: this.d = this.inc8(this.d); this.tstates += 4; break;
      case 0x15: this.d = this.dec8(this.d); this.tstates += 4; break;
      case 0x16: this.d = this.fetch(); this.tstates += 7; break;
      case 0x17: {
        const c = (this.a >> 7) & 1;
        this.a = ((this.a << 1) | (this.f & FLAG_C)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.a & (FLAG_5 | FLAG_3)) | c;
        this.tstates += 4;
        break;
      }
      case 0x18: {
        const e = this.fetchSigned();
        this.pc = (this.pc + e) & 0xffff;
        this.tstates += 12;
        break;
      }
      case 0x19: this.hl = this.add16(this.hl, this.de); this.tstates += 11; break;
      case 0x1a: this.a = this.rb(this.de); this.tstates += 7; break;
      case 0x1b: this.de = (this.de - 1) & 0xffff; this.tstates += 6; break;
      case 0x1c: this.e = this.inc8(this.e); this.tstates += 4; break;
      case 0x1d: this.e = this.dec8(this.e); this.tstates += 4; break;
      case 0x1e: this.e = this.fetch(); this.tstates += 7; break;
      case 0x1f: {
        const c = this.a & 1;
        this.a = ((this.a >> 1) | ((this.f & FLAG_C) << 7)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.a & (FLAG_5 | FLAG_3)) | c;
        this.tstates += 4;
        break;
      }
      case 0x20: {
        const e = this.fetchSigned();
        if ((this.f & FLAG_Z) === 0) { this.pc = (this.pc + e) & 0xffff; this.tstates += 12; }
        else { this.tstates += 7; }
        break;
      }
      case 0x21: this.hl = this.fetchWord(); this.tstates += 10; break;
      case 0x22: this.ww(this.fetchWord(), this.hl); this.tstates += 16; break;
      case 0x23: this.hl = (this.hl + 1) & 0xffff; this.tstates += 6; break;
      case 0x24: this.h = this.inc8(this.h); this.tstates += 4; break;
      case 0x25: this.h = this.dec8(this.h); this.tstates += 4; break;
      case 0x26: this.h = this.fetch(); this.tstates += 7; break;
      case 0x27: this.daa(); this.tstates += 4; break;
      case 0x28: {
        const e = this.fetchSigned();
        if (this.f & FLAG_Z) { this.pc = (this.pc + e) & 0xffff; this.tstates += 12; }
        else { this.tstates += 7; }
        break;
      }
      case 0x29: this.hl = this.add16(this.hl, this.hl); this.tstates += 11; break;
      case 0x2a: this.hl = this.rw(this.fetchWord()); this.tstates += 16; break;
      case 0x2b: this.hl = (this.hl - 1) & 0xffff; this.tstates += 6; break;
      case 0x2c: this.l = this.inc8(this.l); this.tstates += 4; break;
      case 0x2d: this.l = this.dec8(this.l); this.tstates += 4; break;
      case 0x2e: this.l = this.fetch(); this.tstates += 7; break;
      case 0x2f:
        this.a ^= 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P | FLAG_C)) | FLAG_H | FLAG_N | (this.a & (FLAG_5 | FLAG_3));
        this.tstates += 4;
        break;
      case 0x30: {
        const e = this.fetchSigned();
        if ((this.f & FLAG_C) === 0) { this.pc = (this.pc + e) & 0xffff; this.tstates += 12; }
        else { this.tstates += 7; }
        break;
      }
      case 0x31: this.sp = this.fetchWord(); this.tstates += 10; break;
      case 0x32: this.wb(this.fetchWord(), this.a); this.tstates += 13; break;
      case 0x33: this.sp = (this.sp + 1) & 0xffff; this.tstates += 6; break;
      case 0x34: this.wb(this.hl, this.inc8(this.rb(this.hl))); this.tstates += 11; break;
      case 0x35: this.wb(this.hl, this.dec8(this.rb(this.hl))); this.tstates += 11; break;
      case 0x36: this.wb(this.hl, this.fetch()); this.tstates += 10; break;
      case 0x37:
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.a & (FLAG_5 | FLAG_3)) | FLAG_C;
        this.tstates += 4;
        break;
      case 0x38: {
        const e = this.fetchSigned();
        if (this.f & FLAG_C) { this.pc = (this.pc + e) & 0xffff; this.tstates += 12; }
        else { this.tstates += 7; }
        break;
      }
      case 0x39: this.hl = this.add16(this.hl, this.sp); this.tstates += 11; break;
      case 0x3a: this.a = this.rb(this.fetchWord()); this.tstates += 13; break;
      case 0x3b: this.sp = (this.sp - 1) & 0xffff; this.tstates += 6; break;
      case 0x3c: this.a = this.inc8(this.a); this.tstates += 4; break;
      case 0x3d: this.a = this.dec8(this.a); this.tstates += 4; break;
      case 0x3e: this.a = this.fetch(); this.tstates += 7; break;
      case 0x3f: {
        const c = this.f & FLAG_C;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.a & (FLAG_5 | FLAG_3)) | (c ? FLAG_H : FLAG_C);
        this.tstates += 4;
        break;
      }
      case 0x76:
        this.halted = true;
        this.pc = (this.pc - 1) & 0xffff;
        this.tstates += 4;
        break;

      default: {
        if (op >= 0x40 && op <= 0x7f) {
          const dst = (op >> 3) & 7;
          const src = op & 7;
          const val = this.getReg(src);
          this.setReg(dst, val);
          this.tstates += dst === 6 || src === 6 ? 7 : 4;
        } else if (op >= 0x80 && op <= 0xbf) {
          const src = op & 7;
          const val = this.getReg(src);
          const alu = (op >> 3) & 7;
          switch (alu) {
            case 0: this.add8(val); break;
            case 1: this.adc8(val); break;
            case 2: this.sub8(val); break;
            case 3: this.sbc8(val); break;
            case 4: this.and8(val); break;
            case 5: this.xor8(val); break;
            case 6: this.or8(val); break;
            case 7: this.cp8(val); break;
          }
          this.tstates += src === 6 ? 7 : 4;
        } else {
          this.execUpper(op);
        }
        break;
      }
    }
  }

  private execUpper(op: number): void {
    switch (op) {
      case 0xc0: if ((this.f & FLAG_Z) === 0) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xc1: this.bc = this.pop(); this.tstates += 10; break;
      case 0xc2: { const nn = this.fetchWord(); if ((this.f & FLAG_Z) === 0) this.pc = nn; this.tstates += 10; break; }
      case 0xc3: this.pc = this.fetchWord(); this.tstates += 10; break;
      case 0xc4: { const nn = this.fetchWord(); if ((this.f & FLAG_Z) === 0) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xc5: this.push(this.bc); this.tstates += 11; break;
      case 0xc6: this.add8(this.fetch()); this.tstates += 7; break;
      case 0xc7: this.push(this.pc); this.pc = 0x00; this.tstates += 11; break;
      case 0xc8: if (this.f & FLAG_Z) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xc9: this.pc = this.pop(); this.tstates += 10; break;
      case 0xca: { const nn = this.fetchWord(); if (this.f & FLAG_Z) this.pc = nn; this.tstates += 10; break; }
      case 0xcb: this.execCB(); break;
      case 0xcc: { const nn = this.fetchWord(); if (this.f & FLAG_Z) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xcd: { const nn = this.fetchWord(); this.push(this.pc); this.pc = nn; this.tstates += 17; break; }
      case 0xce: this.adc8(this.fetch()); this.tstates += 7; break;
      case 0xcf: this.push(this.pc); this.pc = 0x08; this.tstates += 11; break;

      case 0xd0: if ((this.f & FLAG_C) === 0) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xd1: this.de = this.pop(); this.tstates += 10; break;
      case 0xd2: { const nn = this.fetchWord(); if ((this.f & FLAG_C) === 0) this.pc = nn; this.tstates += 10; break; }
      case 0xd3: { const port = this.fetch() | (this.a << 8); this.tstates += 11; this.io.writePort(port, this.a, this.tstates); break; }
      case 0xd4: { const nn = this.fetchWord(); if ((this.f & FLAG_C) === 0) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xd5: this.push(this.de); this.tstates += 11; break;
      case 0xd6: this.sub8(this.fetch()); this.tstates += 7; break;
      case 0xd7: this.push(this.pc); this.pc = 0x10; this.tstates += 11; break;
      case 0xd8: if (this.f & FLAG_C) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xd9: {
        let t = this.b; this.b = this.b_; this.b_ = t;
        t = this.c; this.c = this.c_; this.c_ = t;
        t = this.d; this.d = this.d_; this.d_ = t;
        t = this.e; this.e = this.e_; this.e_ = t;
        t = this.h; this.h = this.h_; this.h_ = t;
        t = this.l; this.l = this.l_; this.l_ = t;
        this.tstates += 4;
        break;
      }
      case 0xda: { const nn = this.fetchWord(); if (this.f & FLAG_C) this.pc = nn; this.tstates += 10; break; }
      case 0xdb: { const port = this.fetch() | (this.a << 8); this.a = this.io.readPort(port); this.tstates += 11; break; }
      case 0xdc: { const nn = this.fetchWord(); if (this.f & FLAG_C) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xdd: this.execIndexed(true); break;
      case 0xde: this.sbc8(this.fetch()); this.tstates += 7; break;
      case 0xdf: this.push(this.pc); this.pc = 0x18; this.tstates += 11; break;

      case 0xe0: if ((this.f & FLAG_P) === 0) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xe1: this.hl = this.pop(); this.tstates += 10; break;
      case 0xe2: { const nn = this.fetchWord(); if ((this.f & FLAG_P) === 0) this.pc = nn; this.tstates += 10; break; }
      case 0xe3: {
        const lo = this.rb(this.sp);
        const hi = this.rb(this.sp + 1);
        this.wb(this.sp, this.l);
        this.wb(this.sp + 1, this.h);
        this.l = lo;
        this.h = hi;
        this.tstates += 19;
        break;
      }
      case 0xe4: { const nn = this.fetchWord(); if ((this.f & FLAG_P) === 0) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xe5: this.push(this.hl); this.tstates += 11; break;
      case 0xe6: this.and8(this.fetch()); this.tstates += 7; break;
      case 0xe7: this.push(this.pc); this.pc = 0x20; this.tstates += 11; break;
      case 0xe8: if (this.f & FLAG_P) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xe9: this.pc = this.hl; this.tstates += 4; break;
      case 0xea: { const nn = this.fetchWord(); if (this.f & FLAG_P) this.pc = nn; this.tstates += 10; break; }
      case 0xeb: {
        const td = this.d; const te = this.e;
        this.d = this.h; this.e = this.l;
        this.h = td; this.l = te;
        this.tstates += 4;
        break;
      }
      case 0xec: { const nn = this.fetchWord(); if (this.f & FLAG_P) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xed: this.execED(); break;
      case 0xee: this.xor8(this.fetch()); this.tstates += 7; break;
      case 0xef: this.push(this.pc); this.pc = 0x28; this.tstates += 11; break;

      case 0xf0: if ((this.f & FLAG_S) === 0) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xf1: this.af = this.pop(); this.tstates += 10; break;
      case 0xf2: { const nn = this.fetchWord(); if ((this.f & FLAG_S) === 0) this.pc = nn; this.tstates += 10; break; }
      case 0xf3: this.iff1 = 0; this.iff2 = 0; this.tstates += 4; break;
      case 0xf4: { const nn = this.fetchWord(); if ((this.f & FLAG_S) === 0) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xf5: this.push(this.af); this.tstates += 11; break;
      case 0xf6: this.or8(this.fetch()); this.tstates += 7; break;
      case 0xf7: this.push(this.pc); this.pc = 0x30; this.tstates += 11; break;
      case 0xf8: if (this.f & FLAG_S) { this.pc = this.pop(); this.tstates += 11; } else { this.tstates += 5; } break;
      case 0xf9: this.sp = this.hl; this.tstates += 6; break;
      case 0xfa: { const nn = this.fetchWord(); if (this.f & FLAG_S) this.pc = nn; this.tstates += 10; break; }
      case 0xfb: this.iff1 = 1; this.iff2 = 1; this.eiDelay = true; this.tstates += 4; break;
      case 0xfc: { const nn = this.fetchWord(); if (this.f & FLAG_S) { this.push(this.pc); this.pc = nn; this.tstates += 17; } else { this.tstates += 10; } break; }
      case 0xfd: this.execIndexed(false); break;
      case 0xfe: this.cp8(this.fetch()); this.tstates += 7; break;
      case 0xff: this.push(this.pc); this.pc = 0x38; this.tstates += 11; break;
    }
  }

  private execCB(): void {
    const op = this.fetch();
    this.incR();
    const reg = op & 7;
    const bit = (op >> 3) & 7;
    const grp = op >> 6;
    let val = this.getReg(reg);

    if (grp === 0) {
      switch (bit) {
        case 0: val = this.rlc(val); break;
        case 1: val = this.rrc(val); break;
        case 2: val = this.rl(val); break;
        case 3: val = this.rr(val); break;
        case 4: val = this.sla(val); break;
        case 5: val = this.sra(val); break;
        case 6: val = this.sll(val); break;
        case 7: val = this.srl(val); break;
      }
      this.setReg(reg, val);
      this.tstates += reg === 6 ? 15 : 8;
    } else if (grp === 1) {
      const masked = val & (1 << bit);
      this.f =
        (this.f & FLAG_C) |
        FLAG_H |
        (masked === 0 ? FLAG_Z | FLAG_P : 0) |
        (masked & FLAG_S) |
        (val & (FLAG_5 | FLAG_3));
      this.tstates += reg === 6 ? 12 : 8;
    } else if (grp === 2) {
      this.setReg(reg, val & ~(1 << bit));
      this.tstates += reg === 6 ? 15 : 8;
    } else {
      this.setReg(reg, val | (1 << bit));
      this.tstates += reg === 6 ? 15 : 8;
    }
  }

  private execED(): void {
    const op = this.fetch();
    this.incR();

    switch (op) {
      case 0x40: case 0x48: case 0x50: case 0x58:
      case 0x60: case 0x68: case 0x70: case 0x78: {
        const val = this.io.readPort(this.bc);
        const r = (op >> 3) & 7;
        if (r !== 6) this.setReg(r, val);
        this.f = (this.f & FLAG_C) | SZ53P_TABLE[val];
        this.tstates += 12;
        break;
      }
      case 0x41: case 0x49: case 0x51: case 0x59:
      case 0x61: case 0x69: case 0x71: case 0x79: {
        const r = (op >> 3) & 7;
        const val = r === 6 ? 0 : this.getReg(r);
        this.tstates += 12;
        this.io.writePort(this.bc, val, this.tstates);
        break;
      }
      case 0x42: this.sbc16(this.bc); this.tstates += 15; break;
      case 0x52: this.sbc16(this.de); this.tstates += 15; break;
      case 0x62: this.sbc16(this.hl); this.tstates += 15; break;
      case 0x72: this.sbc16(this.sp); this.tstates += 15; break;

      case 0x4a: this.adc16(this.bc); this.tstates += 15; break;
      case 0x5a: this.adc16(this.de); this.tstates += 15; break;
      case 0x6a: this.adc16(this.hl); this.tstates += 15; break;
      case 0x7a: this.adc16(this.sp); this.tstates += 15; break;

      case 0x43: this.ww(this.fetchWord(), this.bc); this.tstates += 20; break;
      case 0x53: this.ww(this.fetchWord(), this.de); this.tstates += 20; break;
      case 0x63: this.ww(this.fetchWord(), this.hl); this.tstates += 20; break;
      case 0x73: this.ww(this.fetchWord(), this.sp); this.tstates += 20; break;

      case 0x4b: this.bc = this.rw(this.fetchWord()); this.tstates += 20; break;
      case 0x5b: this.de = this.rw(this.fetchWord()); this.tstates += 20; break;
      case 0x6b: this.hl = this.rw(this.fetchWord()); this.tstates += 20; break;
      case 0x7b: this.sp = this.rw(this.fetchWord()); this.tstates += 20; break;

      case 0x44: case 0x4c: case 0x54: case 0x5c:
      case 0x64: case 0x6c: case 0x74: case 0x7c: {
        const val = this.a;
        this.a = 0;
        this.sub8(val);
        this.tstates += 8;
        break;
      }

      case 0x45: case 0x55: case 0x65: case 0x75:
      case 0x4d: case 0x5d: case 0x6d: case 0x7d:
        this.iff1 = this.iff2;
        this.pc = this.pop();
        this.tstates += 14;
        break;

      case 0x46: case 0x4e: case 0x66: case 0x6e: this.im = 0; this.tstates += 8; break;
      case 0x56: case 0x76: this.im = 1; this.tstates += 8; break;
      case 0x5e: case 0x7e: this.im = 2; this.tstates += 8; break;

      case 0x47: this.i = this.a; this.tstates += 9; break;
      case 0x4f: this.r = this.a & 0x7f; this.r7 = this.a & 0x80; this.tstates += 9; break;
      case 0x57:
        this.a = this.i;
        this.f = (this.f & FLAG_C) | SZ53_TABLE[this.a] | (this.iff2 ? FLAG_P : 0);
        this.tstates += 9;
        break;
      case 0x5f:
        this.a = (this.r & 0x7f) | (this.r7 & 0x80);
        this.f = (this.f & FLAG_C) | SZ53_TABLE[this.a] | (this.iff2 ? FLAG_P : 0);
        this.tstates += 9;
        break;

      case 0x67: {
        const hl = this.hl;
        const m = this.rb(hl);
        this.wb(hl, ((this.a & 0x0f) << 4) | (m >> 4));
        this.a = (this.a & 0xf0) | (m & 0x0f);
        this.f = (this.f & FLAG_C) | SZ53P_TABLE[this.a];
        this.tstates += 18;
        break;
      }
      case 0x6f: {
        const hl = this.hl;
        const m = this.rb(hl);
        this.wb(hl, ((m << 4) | (this.a & 0x0f)) & 0xff);
        this.a = (this.a & 0xf0) | (m >> 4);
        this.f = (this.f & FLAG_C) | SZ53P_TABLE[this.a];
        this.tstates += 18;
        break;
      }

      case 0xa0: case 0xb0: case 0xa8: case 0xb8: {
        const inc = (op & 0x08) === 0 ? 1 : -1;
        const val = this.rb(this.hl);
        this.wb(this.de, val);
        this.hl = (this.hl + inc) & 0xffff;
        this.de = (this.de + inc) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const n = (val + this.a) & 0xff;
        this.f =
          (this.f & (FLAG_S | FLAG_Z | FLAG_C)) |
          (this.bc !== 0 ? FLAG_P : 0) |
          (n & FLAG_3) |
          ((n & 0x02) ? FLAG_5 : 0);
        if ((op & 0x10) && this.bc !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          this.tstates += 21;
        } else {
          this.tstates += 16;
        }
        break;
      }

      case 0xa1: case 0xb1: case 0xa9: case 0xb9: {
        const inc = (op & 0x08) === 0 ? 1 : -1;
        const val = this.rb(this.hl);
        const diff = (this.a - val) & 0xff;
        const lookup = ((this.a & 0x08) >> 3) | ((val & 0x08) >> 2) | ((diff & 0x08) >> 1);
        const hf = HALF_CARRY_SUB[lookup & 0x07];
        this.hl = (this.hl + inc) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const n = (diff - (hf ? 1 : 0)) & 0xff;
        this.f =
          (this.f & FLAG_C) |
          FLAG_N |
          hf |
          (this.bc !== 0 ? FLAG_P : 0) |
          (diff === 0 ? FLAG_Z : 0) |
          (diff & FLAG_S) |
          (n & FLAG_3) |
          ((n & 0x02) ? FLAG_5 : 0);
        if ((op & 0x10) && this.bc !== 0 && diff !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          this.tstates += 21;
        } else {
          this.tstates += 16;
        }
        break;
      }

      case 0xa2: case 0xb2: case 0xaa: case 0xba: {
        const inc = (op & 0x08) === 0 ? 1 : -1;
        const val = this.io.readPort(this.bc);
        this.wb(this.hl, val);
        this.b = (this.b - 1) & 0xff;
        this.hl = (this.hl + inc) & 0xffff;
        this.f = (val & 0x80 ? FLAG_N : 0) | SZ53_TABLE[this.b];
        if ((op & 0x10) && this.b !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          this.tstates += 21;
        } else {
          this.tstates += 16;
        }
        break;
      }

      case 0xa3: case 0xb3: case 0xab: case 0xbb: {
        const inc = (op & 0x08) === 0 ? 1 : -1;
        const val = this.rb(this.hl);
        this.b = (this.b - 1) & 0xff;
        this.hl = (this.hl + inc) & 0xffff;
        this.f = (val & 0x80 ? FLAG_N : 0) | SZ53_TABLE[this.b];
        if ((op & 0x10) && this.b !== 0) {
          this.pc = (this.pc - 2) & 0xffff;
          this.tstates += 21;
        } else {
          this.tstates += 16;
        }
        this.io.writePort(this.bc, val, this.tstates);
        break;
      }

      default:
        this.tstates += 8;
        break;
    }
  }

  private getIdxReg(isIX: boolean, idx: number, addr: number): number {
    switch (idx) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return isIX ? this.ixh : this.iyh;
      case 5: return isIX ? this.ixl : this.iyl;
      case 6: return this.rb(addr);
      default: return this.a;
    }
  }

  private setIdxReg(isIX: boolean, idx: number, val: number, addr: number): void {
    switch (idx) {
      case 0: this.b = val; break;
      case 1: this.c = val; break;
      case 2: this.d = val; break;
      case 3: this.e = val; break;
      case 4: if (isIX) this.ixh = val; else this.iyh = val; break;
      case 5: if (isIX) this.ixl = val; else this.iyl = val; break;
      case 6: this.wb(addr, val); break;
      default: this.a = val; break;
    }
  }

  private execIndexed(isIX: boolean): void {
    const op = this.fetch();
    this.incR();
    const xy = isIX ? this.ix : this.iy;

    switch (op) {
      case 0x09: { const v = this.add16(xy, this.bc); if (isIX) this.ix = v; else this.iy = v; this.tstates += 15; break; }
      case 0x19: { const v = this.add16(xy, this.de); if (isIX) this.ix = v; else this.iy = v; this.tstates += 15; break; }
      case 0x21: { const nn = this.fetchWord(); if (isIX) this.ix = nn; else this.iy = nn; this.tstates += 14; break; }
      case 0x22: this.ww(this.fetchWord(), xy); this.tstates += 20; break;
      case 0x23: { const v = (xy + 1) & 0xffff; if (isIX) this.ix = v; else this.iy = v; this.tstates += 10; break; }
      case 0x24: {
        if (isIX) this.ixh = this.inc8(this.ixh); else this.iyh = this.inc8(this.iyh);
        this.tstates += 8;
        break;
      }
      case 0x25: {
        if (isIX) this.ixh = this.dec8(this.ixh); else this.iyh = this.dec8(this.iyh);
        this.tstates += 8;
        break;
      }
      case 0x26: {
        const n = this.fetch();
        if (isIX) this.ixh = n; else this.iyh = n;
        this.tstates += 11;
        break;
      }
      case 0x29: { const v = this.add16(xy, xy); if (isIX) this.ix = v; else this.iy = v; this.tstates += 15; break; }
      case 0x2a: { const v = this.rw(this.fetchWord()); if (isIX) this.ix = v; else this.iy = v; this.tstates += 20; break; }
      case 0x2b: { const v = (xy - 1) & 0xffff; if (isIX) this.ix = v; else this.iy = v; this.tstates += 10; break; }
      case 0x2c: {
        if (isIX) this.ixl = this.inc8(this.ixl); else this.iyl = this.inc8(this.iyl);
        this.tstates += 8;
        break;
      }
      case 0x2d: {
        if (isIX) this.ixl = this.dec8(this.ixl); else this.iyl = this.dec8(this.iyl);
        this.tstates += 8;
        break;
      }
      case 0x2e: {
        const n = this.fetch();
        if (isIX) this.ixl = n; else this.iyl = n;
        this.tstates += 11;
        break;
      }
      case 0x34: {
        const addr = (xy + this.fetchSigned()) & 0xffff;
        this.wb(addr, this.inc8(this.rb(addr)));
        this.tstates += 23;
        break;
      }
      case 0x35: {
        const addr = (xy + this.fetchSigned()) & 0xffff;
        this.wb(addr, this.dec8(this.rb(addr)));
        this.tstates += 23;
        break;
      }
      case 0x36: {
        const addr = (xy + this.fetchSigned()) & 0xffff;
        this.wb(addr, this.fetch());
        this.tstates += 19;
        break;
      }
      case 0x39: { const v = this.add16(xy, this.sp); if (isIX) this.ix = v; else this.iy = v; this.tstates += 15; break; }

      case 0xcb: {
        const d = this.fetchSigned();
        const cbOp = this.fetch();
        const addr = (xy + d) & 0xffff;
        const grp = cbOp >> 6;
        const bit = (cbOp >> 3) & 7;
        const reg = cbOp & 7;
        let val = this.rb(addr);

        if (grp === 0) {
          switch (bit) {
            case 0: val = this.rlc(val); break;
            case 1: val = this.rrc(val); break;
            case 2: val = this.rl(val); break;
            case 3: val = this.rr(val); break;
            case 4: val = this.sla(val); break;
            case 5: val = this.sra(val); break;
            case 6: val = this.sll(val); break;
            case 7: val = this.srl(val); break;
          }
          this.wb(addr, val);
          if (reg !== 6) this.setReg(reg, val);
          this.tstates += 23;
        } else if (grp === 1) {
          const masked = val & (1 << bit);
          this.f =
            (this.f & FLAG_C) |
            FLAG_H |
            (masked === 0 ? FLAG_Z | FLAG_P : 0) |
            (masked & FLAG_S) |
            ((addr >> 8) & (FLAG_5 | FLAG_3));
          this.tstates += 20;
        } else if (grp === 2) {
          val &= ~(1 << bit);
          this.wb(addr, val);
          if (reg !== 6) this.setReg(reg, val);
          this.tstates += 23;
        } else {
          val |= 1 << bit;
          this.wb(addr, val);
          if (reg !== 6) this.setReg(reg, val);
          this.tstates += 23;
        }
        break;
      }

      case 0xe1: { const v = this.pop(); if (isIX) this.ix = v; else this.iy = v; this.tstates += 14; break; }
      case 0xe3: {
        const lo = this.rb(this.sp);
        const hi = this.rb(this.sp + 1);
        this.wb(this.sp, xy & 0xff);
        this.wb(this.sp + 1, (xy >> 8) & 0xff);
        const v = lo | (hi << 8);
        if (isIX) this.ix = v; else this.iy = v;
        this.tstates += 23;
        break;
      }
      case 0xe5: this.push(xy); this.tstates += 15; break;
      case 0xe9: this.pc = xy; this.tstates += 8; break;
      case 0xf9: this.sp = xy; this.tstates += 10; break;

      case 0xdd:
      case 0xfd:
        this.pc = (this.pc - 1) & 0xffff;
        this.tstates += 4;
        break;

      default: {
        if (op >= 0x40 && op <= 0x7f && op !== 0x76) {
          const dst = (op >> 3) & 7;
          const src = op & 7;
          if (dst === 6 || src === 6) {
            const addr = (xy + this.fetchSigned()) & 0xffff;
            const val = src === 6 ? this.rb(addr) : this.getReg(src);
            if (dst === 6) this.wb(addr, val); else this.setReg(dst, val);
            this.tstates += 19;
          } else {
            const val = this.getIdxReg(isIX, src, 0);
            this.setIdxReg(isIX, dst, val, 0);
            this.tstates += 8;
          }
        } else if (op >= 0x80 && op <= 0xbf) {
          const src = op & 7;
          let val: number;
          if (src === 6) {
            const addr = (xy + this.fetchSigned()) & 0xffff;
            val = this.rb(addr);
            this.tstates += 19;
          } else {
            val = this.getIdxReg(isIX, src, 0);
            this.tstates += 8;
          }
          const alu = (op >> 3) & 7;
          switch (alu) {
            case 0: this.add8(val); break;
            case 1: this.adc8(val); break;
            case 2: this.sub8(val); break;
            case 3: this.sbc8(val); break;
            case 4: this.and8(val); break;
            case 5: this.xor8(val); break;
            case 6: this.or8(val); break;
            case 7: this.cp8(val); break;
          }
        } else {
          this.execMain(op);
          this.tstates += 4;
        }
        break;
      }
    }
  }
}
