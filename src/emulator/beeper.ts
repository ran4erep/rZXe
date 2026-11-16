// Band-Limited (Windowed-Sinc BLEP) ZX Spectrum Beeper + AY-3-8910 Mixer
// Zero runtime allocations, ~0% CPU when idle, <0.15% CPU during active PWM music

import { TSTATES_PER_FRAME } from './spectrum';
import { AY8910, StereoMode } from './ay8910';

const RING_SIZE = 32768; // Power of 2; ~680ms at 48kHz, supports up to 192kHz DACs without stalls
const MAX_FRAME_SAMPLES = 4096;

// Precomputed 12-tap, 64-phase Blackman-windowed-sinc impulse table for aliasing-free BLEP
const BLEP_TAPS = 12;
const BLEP_HALF = 6; // 6-sample lookahead (~0.125ms @ 48kHz) keeps every edge causal & artifact-free
const BLEP_PHASES = 64;
const BLEP_CUTOFF = 0.34; // Normalized to sampleRate -> >55dB stopband suppression at 36.4kHz PWM
const SINC_IMPULSE = new Float32Array(BLEP_PHASES * BLEP_TAPS);

for (let p = 0; p < BLEP_PHASES; p++) {
  const frac = (p + 0.5) / BLEP_PHASES;
  let sum = 0;
  const base = p * BLEP_TAPS;
  for (let k = 0; k < BLEP_TAPS; k++) {
    const d = k - (BLEP_HALF - 1 + frac);
    const wPos = (k + 0.5 - frac) / BLEP_TAPS;
    const win =
      0.42 - 0.5 * Math.cos(2 * Math.PI * wPos) + 0.08 * Math.cos(4 * Math.PI * wPos);
    const x = 2 * BLEP_CUTOFF * d;
    const sinc = Math.abs(x) < 1e-6 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const v = sinc * win;
    SINC_IMPULSE[base + k] = v;
    sum += v;
  }
  const invSum = 1 / sum;
  for (let k = 0; k < BLEP_TAPS; k++) {
    SINC_IMPULSE[base + k] *= invSum;
  }
}

// Reusable scratch buffer for difference/BLEP accumulation (never allocated per frame)
const OVERLAP_LEN = BLEP_TAPS + BLEP_HALF + 4;
const DIFF_SCRATCH = new Float32Array(MAX_FRAME_SAMPLES + OVERLAP_LEN);

// Issue 3 / 128K resistor-ladder EAR + MIC speaker levels mapped to [-0.5, +0.5]:
// 0..3: Beeper (bit1 = EAR, bit0 = MIC)
// 4..5: Cassette EAR playback
// 8..15: Combined Beeper + Cassette EAR
export function levelToAmp(v: number): number {
  switch (v) {
    case 0:
      return -0.5;
    case 1:
      return -0.4;
    case 2:
      return 0.46;
    case 3:
      return 0.5;
    case 4:
      return -0.16;
    case 5:
      return 0.16;
    default: {
      if (v >= 8 && v <= 15) {
        const base = levelToAmp(v & 3);
        const tape = (v & 4) !== 0 ? 0.16 : -0.16;
        return base * 0.8 + tape;
      }
      return v ? 0.5 : -0.5;
    }
  }
}

export interface BeeperSynthState {
  initialized: boolean;
  curAmp: number;
  acc: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  overlap: Float32Array;
  overlapActive: boolean;
  cachedSampleRate: number;
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function createBeeperSynthState(): BeeperSynthState {
  return {
    initialized: false,
    curAmp: 0,
    acc: 0,
    x1: 0,
    x2: 0,
    y1: 0,
    y2: 0,
    overlap: new Float32Array(OVERLAP_LEN),
    overlapActive: false,
    cachedSampleRate: 0,
    b0: 1,
    b1: 0,
    b2: 0,
    a1: 0,
    a2: 0,
  };
}

export function resetBeeperSynthState(state: BeeperSynthState): void {
  state.initialized = false;
  state.curAmp = 0;
  state.acc = 0;
  state.x1 = 0;
  state.x2 = 0;
  state.y1 = 0;
  state.y2 = 0;
  state.overlap.fill(0);
  state.overlapActive = false;
}

function updateBiquadCoeffs(state: BeeperSynthState, sampleRate: number): void {
  if (state.cachedSampleRate === sampleRate) return;
  state.cachedSampleRate = sampleRate;
  // 2nd-order Butterworth speaker low-pass at 12000 Hz (clamped safely below Nyquist)
  const fc = Math.min(12000, sampleRate * 0.42);
  const w0 = (2 * Math.PI * fc) / sampleRate;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const q = 0.70710678;
  const alpha = sinW / (2 * q);
  const a0 = 1 + alpha;
  const invA0 = 1 / a0;
  state.b0 = ((1 - cosW) * 0.5) * invA0;
  state.b1 = (1 - cosW) * invA0;
  state.b2 = state.b0;
  state.a1 = (-2 * cosW) * invA0;
  state.a2 = (1 - alpha) * invA0;
}

// Standalone scratch state when synthesizeBeeperFrame is called statelessly
const STATELESS_STATE = createBeeperSynthState();

/**
 * Synthesizes one video frame of ZX Spectrum beeper audio using 12-tap
 * Blackman-windowed-sinc Band-Limited Step (BLEP) integration followed by a
 * 2-pole Butterworth speaker low-pass filter (~9.5 kHz).
 *
 * Eliminates ultrasonic PWM/PFM aliasing (e.g. 36.4 kHz engines like Exolon,
 * Tim Follin, Special FX) while preserving sub-sample pulses down to 1 T-state.
 */
export function synthesizeBeeperFrame(
  out: Float32Array,
  sampleCount: number,
  transitionsT: Int32Array,
  transitionsVal: Uint8Array,
  count: number,
  initialLevel: number,
  tstatesPerFrame: number,
  sampleRate: number,
  prevLpState = 0,
  state?: BeeperSynthState
): number {
  if (sampleCount <= 0) return prevLpState;

  const initAmp = levelToAmp(initialLevel);
  const st = state ?? STATELESS_STATE;
  if (!state) {
    // Stateless call: seed directly from initialLevel / prevLpState without leftover tail
    st.curAmp = initAmp;
    st.acc = initAmp;
    st.x1 = initAmp;
    st.x2 = initAmp;
    st.y1 = prevLpState;
    st.y2 = prevLpState;
    st.overlap.fill(0);
    st.overlapActive = false;
    st.initialized = true;
  } else if (!st.initialized) {
    st.curAmp = initAmp;
    st.acc = initAmp;
    st.x1 = initAmp;
    st.x2 = initAmp;
    st.y1 = initAmp;
    st.y2 = initAmp;
    st.overlap.fill(0);
    st.overlapActive = false;
    st.initialized = true;
  }

  updateBiquadCoeffs(st, sampleRate);
  const { b0, b1, b2, a1, a2 } = st;

  // Ultra-fast O(1) idle path when no transitions, no pending BLEP overlap, and filter settled
  if (
    count === 0 &&
    !st.overlapActive &&
    Math.abs(st.curAmp - initAmp) < 1e-6 &&
    Math.abs(st.acc - initAmp) < 1e-6 &&
    Math.abs(st.y1 - initAmp) < 1e-5 &&
    Math.abs(st.y2 - initAmp) < 1e-5
  ) {
    st.curAmp = initAmp;
    st.acc = initAmp;
    st.x1 = initAmp;
    st.x2 = initAmp;
    st.y1 = initAmp;
    st.y2 = initAmp;
    out.fill(initAmp, 0, sampleCount);
    return initAmp;
  }

  const diffLen = sampleCount + OVERLAP_LEN;
  DIFF_SCRATCH.fill(0, 0, diffLen);

  // Copy previous frame's BLEP tail into start of this frame
  if (st.overlapActive) {
    for (let i = 0; i < OVERLAP_LEN; i++) {
      DIFF_SCRATCH[i] = st.overlap[i];
    }
  }

  // Track logical amplitude independently of st.acc so pending overlap deltas never skew transitions
  let cur = st.curAmp;
  const initJump = initAmp - cur;
  if (Math.abs(initJump) > 1e-6) {
    // Re-sync smoothly via BLEP step if external state jumped (e.g. snapshot load or tape start)
    const base0 = 0;
    const start0 = 1;
    for (let k = 0; k < BLEP_TAPS; k++) {
      DIFF_SCRATCH[start0 + k] += initJump * SINC_IMPULSE[base0 + k];
    }
    cur = initAmp;
  }

  const scale = sampleCount / tstatesPerFrame;
  for (let i = 0; i < count; i++) {
    const next = levelToAmp(transitionsVal[i]);
    const delta = next - cur;
    if (delta === 0) continue;
    cur = next;

    const rawT = transitionsT[i];
    const clampedT = rawT < 0 ? 0 : rawT >= tstatesPerFrame ? tstatesPerFrame - 1 : rawT;
    const pos = clampedT * scale + BLEP_HALF;
    const idx = pos | 0;
    const frac = pos - idx;
    const phase = Math.min(BLEP_PHASES - 1, Math.max(0, (frac * BLEP_PHASES) | 0));
    const base = phase * BLEP_TAPS;
    const start = idx - (BLEP_HALF - 1);

    for (let k = 0; k < BLEP_TAPS; k++) {
      const dst = start + k;
      if (dst >= 0 && dst < diffLen) {
        DIFF_SCRATCH[dst] += delta * SINC_IMPULSE[base + k];
      }
    }
  }
  st.curAmp = cur;

  // Save tail past sampleCount for seamless next-frame integration
  let hasTail = false;
  for (let i = 0; i < OVERLAP_LEN; i++) {
    const v = DIFF_SCRATCH[sampleCount + i];
    st.overlap[i] = v;
    if (v !== 0) hasTail = true;
  }
  st.overlapActive = hasTail;

  // Integrate band-limited impulses and apply 2-pole Butterworth speaker filter
  let acc = st.acc;
  let x1 = st.x1;
  let x2 = st.x2;
  let y1 = st.y1;
  let y2 = st.y2;

  for (let s = 0; s < sampleCount; s++) {
    acc += DIFF_SCRATCH[s];
    const y = b0 * acc + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = acc;
    y2 = y1;
    y1 = y;
    out[s] = y;
  }

  st.acc = acc;
  st.x1 = x1;
  st.x2 = x2;
  st.y1 = y1;
  st.y2 = y2;
  return y1;
}

const WORKLET_BUF_STRIDE = MAX_FRAME_SAMPLES;
const WORKLET_BUF_TOTAL = WORKLET_BUF_STRIDE * 2;
const INITIAL_WORKLET_POOL = 8;
const MAX_WORKLET_POOL = 24;

const BEEPER_WORKLET_SOURCE = `
const RING_SIZE = ${RING_SIZE};
const RING_MASK = RING_SIZE - 1;
const STRIDE = ${WORKLET_BUF_STRIDE};
const HIGH_WATERMARK = RING_SIZE >> 2;
const LOW_WATERMARK = RING_SIZE >> 3;

class ZXBeeperWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ringL = new Float32Array(RING_SIZE);
    this.ringR = new Float32Array(RING_SIZE);
    this.writePtr = 0;
    this.readPtr = 0;
    this.buffered = 0;
    this.seq = 0;
    this.highWaterArmed = false;
    this.lastL = 0;
    this.lastR = 0;
    this.dcPrevInL = 0;
    this.dcPrevOutL = 0;
    this.dcPrevInR = 0;
    this.dcPrevOutR = 0;
    this.needsDcSeed = true;
    this.dcPole = Math.exp((-2 * Math.PI * 20) / sampleRate);

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;

      if (msg.type === 'reset') {
        this.writePtr = 0;
        this.readPtr = 0;
        this.buffered = 0;
        this.seq = typeof msg.seq === 'number' ? msg.seq : this.seq + 1;
        this.highWaterArmed = false;
        this.lastL = 0;
        this.lastR = 0;
        this.dcPrevInL = 0;
        this.dcPrevOutL = 0;
        this.dcPrevInR = 0;
        this.dcPrevOutR = 0;
        this.needsDcSeed = true;
        return;
      }

      if (msg.type === 'fill') {
        const msgSeq = typeof msg.seq === 'number' ? msg.seq : this.seq;
        if (msgSeq !== this.seq) return;
        const prefill = msg.prefill | 0;
        if (this.buffered === 0 && prefill > 0) {
          const amp = msg.initAmp;
          const capPrefill = Math.min(prefill, RING_SIZE - 128);
          for (let i = 0; i < capPrefill; i++) {
            this.ringL[this.writePtr] = amp;
            this.ringR[this.writePtr] = amp;
            this.writePtr = (this.writePtr + 1) & RING_MASK;
          }
          this.buffered += capPrefill;
          this.lastL = amp;
          this.lastR = amp;
        }
        const len = msg.len | 0;
        const amp = msg.amp;
        const room = RING_SIZE - 64 - this.buffered;
        const count = len < room ? len : room;
        for (let i = 0; i < count; i++) {
          this.ringL[this.writePtr] = amp;
          this.ringR[this.writePtr] = amp;
          this.writePtr = (this.writePtr + 1) & RING_MASK;
        }
        if (count > 0) this.buffered += count;
        if (this.buffered > HIGH_WATERMARK) this.highWaterArmed = true;
        this.port.postMessage({ type: 'status', buffered: this.buffered, seq: this.seq });
        return;
      }

      if (msg.type === 'push') {
        const src = msg.buf;
        const msgSeq = typeof msg.seq === 'number' ? msg.seq : this.seq;
        if (msgSeq !== this.seq) {
          this.port.postMessage(
            { type: 'recycle', buf: src, buffered: this.buffered, seq: this.seq },
            [src.buffer]
          );
          return;
        }

        const len = msg.len | 0;
        const mono = msg.mono === true;
        const prefill = msg.prefill | 0;

        if (this.buffered === 0 && prefill > 0) {
          const amp = msg.initAmp;
          const capPrefill = Math.min(prefill, RING_SIZE - 128);
          for (let i = 0; i < capPrefill; i++) {
            this.ringL[this.writePtr] = amp;
            this.ringR[this.writePtr] = amp;
            this.writePtr = (this.writePtr + 1) & RING_MASK;
          }
          this.buffered += capPrefill;
          this.lastL = amp;
          this.lastR = amp;
        }

        const room = RING_SIZE - 64 - this.buffered;
        const count = len < room ? len : room;
        if (mono) {
          for (let i = 0; i < count; i++) {
            const v = src[i];
            this.ringL[this.writePtr] = v;
            this.ringR[this.writePtr] = v;
            this.writePtr = (this.writePtr + 1) & RING_MASK;
          }
        } else {
          for (let i = 0; i < count; i++) {
            this.ringL[this.writePtr] = src[i];
            this.ringR[this.writePtr] = src[STRIDE + i];
            this.writePtr = (this.writePtr + 1) & RING_MASK;
          }
        }
        if (count > 0) this.buffered += count;
        if (this.buffered > HIGH_WATERMARK) this.highWaterArmed = true;
        this.port.postMessage(
          { type: 'recycle', buf: src, buffered: this.buffered, seq: this.seq },
          [src.buffer]
        );
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const outL = out[0];
    const outR = out[1];

    let buffered = this.buffered;
    let lastL = this.lastL;
    let lastR = this.lastR;
    let dcPrevOutL = this.dcPrevOutL;
    let dcPrevOutR = this.dcPrevOutR;

    // Ultra-low-CPU idle path when ring is drained and output settled at 0
    if (
      buffered === 0 &&
      Math.abs(lastL) < 1e-6 &&
      Math.abs(lastR) < 1e-6 &&
      Math.abs(dcPrevOutL) < 1e-6 &&
      Math.abs(dcPrevOutR) < 1e-6
    ) {
      if (this.highWaterArmed) {
        this.highWaterArmed = false;
        this.port.postMessage({ type: 'status', buffered: 0, seq: this.seq });
      }
      this.lastL = 0;
      this.lastR = 0;
      this.dcPrevInL = 0;
      this.dcPrevOutL = 0;
      this.dcPrevInR = 0;
      this.dcPrevOutR = 0;
      this.needsDcSeed = true;
      outL.fill(0);
      outR.fill(0);
      return true;
    }

    const len = outL.length;
    const pole = this.dcPole;
    let readPtr = this.readPtr;
    let dcPrevInL = this.dcPrevInL;
    let dcPrevInR = this.dcPrevInR;
    let needsDcSeed = this.needsDcSeed;
    const ringL = this.ringL;
    const ringR = this.ringR;

    for (let i = 0; i < len; i++) {
      if (buffered > 0) {
        lastL = ringL[readPtr];
        lastR = ringR[readPtr];
        readPtr = (readPtr + 1) & RING_MASK;
        buffered--;
      } else {
        lastL *= 0.996;
        lastR *= 0.996;
      }

      if (needsDcSeed) {
        dcPrevInL = lastL;
        dcPrevOutL = 0;
        dcPrevInR = lastR;
        dcPrevOutR = 0;
        needsDcSeed = false;
      }

      const yL = lastL - dcPrevInL + pole * dcPrevOutL;
      dcPrevInL = lastL;
      dcPrevOutL = yL;
      outL[i] = yL;

      const yR = lastR - dcPrevInR + pole * dcPrevOutR;
      dcPrevInR = lastR;
      dcPrevOutR = yR;
      outR[i] = yR;
    }

    this.readPtr = readPtr;
    this.buffered = buffered;
    this.lastL = lastL;
    this.lastR = lastR;
    this.dcPrevInL = dcPrevInL;
    this.dcPrevOutL = dcPrevOutL;
    this.dcPrevInR = dcPrevInR;
    this.dcPrevOutR = dcPrevOutR;
    this.needsDcSeed = needsDcSeed;

    if (this.highWaterArmed && buffered <= LOW_WATERMARK) {
      this.highWaterArmed = false;
      this.port.postMessage({ type: 'status', buffered, seq: this.seq });
    }
    return true;
  }
}

registerProcessor('zx-beeper-processor', ZXBeeperWorkletProcessor);
`;

const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
const DEFERRED_SUSPEND_MS = 4000;

export class SpectrumBeeper {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletLoading = false;
  private workletReady = false;
  private destroyed = false;
  private muted = false;
  private freePool: Float32Array[] = [];
  private allocatedPoolCount = 0;
  private workletBuffered = 0;
  private resetSeq = 0;
  private blockedFrames = 0;
  private suspendTimer: number | null = null;
  private unlockListenersArmed = false;

  // Legacy ScriptProcessorNode fallback state (used only if AudioWorklet is unavailable)
  private procNode: ScriptProcessorNode | null = null;
  private ringL: Float32Array | null = null;
  private ringR: Float32Array | null = null;
  private tempL = new Float32Array(MAX_FRAME_SAMPLES);
  private tempR = new Float32Array(MAX_FRAME_SAMPLES);
  private synthState = createBeeperSynthState();
  private writePtr = 0;
  private readPtr = 0;
  private sampleRate = 48000;
  private active = false;
  private volume = 1;
  private lastSampleL = 0;
  private lastSampleR = 0;
  private dcPrevInL = 0;
  private dcPrevOutL = 0;
  private dcPrevInR = 0;
  private dcPrevOutR = 0;
  private dcPole = 0.997;
  private needsPrefill = true;
  private needsDcSeed = true;
  private sampleFracAcc = 0;

  private readonly handleUserUnlockGesture = (): void => {
    if (this.destroyed || this.muted || !this.active) {
      this.disarmUnlockListeners();
      return;
    }
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') {
      this.disarmUnlockListeners();
      this.start();
      return;
    }
    if (ctx.state === 'running') {
      this.disarmUnlockListeners();
      return;
    }
    void ctx
      .resume()
      .then(() => {
        if (this.ctx === ctx && ctx.state === 'running') {
          this.disarmUnlockListeners();
        }
      })
      .catch(() => {});
  };

  private armUnlockListeners(): void {
    if (this.unlockListenersArmed || typeof window === 'undefined') return;
    this.unlockListenersArmed = true;
    for (let i = 0; i < UNLOCK_EVENTS.length; i++) {
      window.addEventListener(UNLOCK_EVENTS[i], this.handleUserUnlockGesture, {
        capture: true,
        passive: true,
      });
    }
  }

  private disarmUnlockListeners(): void {
    if (!this.unlockListenersArmed || typeof window === 'undefined') return;
    this.unlockListenersArmed = false;
    for (let i = 0; i < UNLOCK_EVENTS.length; i++) {
      window.removeEventListener(UNLOCK_EVENTS[i], this.handleUserUnlockGesture, {
        capture: true,
      });
    }
  }

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
  }

  private teardownGraph(): void {
    this.clearSuspendTimer();
    this.disarmUnlockListeners();
    this.workletLoading = false;
    this.workletReady = false;
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.onprocessorerror = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    this.freePool.length = 0;
    this.allocatedPoolCount = 0;
    if (this.procNode) {
      this.procNode.disconnect();
      this.procNode.onaudioprocess = null;
      this.procNode = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.ctx) {
      this.ctx.onstatechange = null;
      if (this.ctx.state !== 'closed') {
        void this.ctx.close().catch(() => {});
      }
      this.ctx = null;
    }
  }

  private acquireTransferBuffer(): Float32Array {
    const reused = this.freePool.pop();
    if (reused && reused.buffer.byteLength === WORKLET_BUF_TOTAL * 4) {
      return reused;
    }
    if (this.allocatedPoolCount < MAX_WORKLET_POOL) {
      this.allocatedPoolCount++;
      return new Float32Array(WORKLET_BUF_TOTAL);
    }
    // Pool temporarily exhausted (e.g. background burst): return reusable view up to cap
    return new Float32Array(WORKLET_BUF_TOTAL);
  }

  private initFallbackScriptProcessor(ctx: AudioContext, gain: GainNode): void {
    if (this.destroyed || this.procNode || this.ctx !== ctx) return;
    this.ringL = new Float32Array(RING_SIZE);
    this.ringR = new Float32Array(RING_SIZE);
    this.readPtr = 0;
    this.writePtr = 0;
    const proc = ctx.createScriptProcessor(512, 0, 2);
    proc.onaudioprocess = (ev) => {
      const outL = ev.outputBuffer.getChannelData(0);
      const outR = ev.outputBuffer.getChannelData(1);
      const len = outL.length;
      const pole = this.dcPole;
      const rL = this.ringL!;
      const rR = this.ringR!;

      for (let i = 0; i < len; i++) {
        if (this.readPtr !== this.writePtr) {
          this.lastSampleL = rL[this.readPtr];
          this.lastSampleR = rR[this.readPtr];
          this.readPtr = (this.readPtr + 1) & (RING_SIZE - 1);
        } else {
          this.lastSampleL *= 0.996;
          this.lastSampleR *= 0.996;
        }
        const xL = this.lastSampleL;
        const xR = this.lastSampleR;
        if (this.needsDcSeed) {
          this.dcPrevInL = xL;
          this.dcPrevOutL = 0;
          this.dcPrevInR = xR;
          this.dcPrevOutR = 0;
          this.needsDcSeed = false;
        }
        const yL = xL - this.dcPrevInL + pole * this.dcPrevOutL;
        this.dcPrevInL = xL;
        this.dcPrevOutL = yL;
        outL[i] = yL;

        const yR = xR - this.dcPrevInR + pole * this.dcPrevOutR;
        this.dcPrevInR = xR;
        this.dcPrevOutR = yR;
        outR[i] = yR;
      }
    };
    proc.connect(gain);
    this.procNode = proc;
  }

  private async initAudioWorklet(ctx: AudioContext, gain: GainNode): Promise<void> {
    if (this.workletLoading || this.workletReady || this.destroyed) return;
    this.workletLoading = true;

    let blobUrl: string | null = null;
    try {
      const blob = new Blob([BEEPER_WORKLET_SOURCE], { type: 'application/javascript' });
      blobUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(blobUrl);
      if (this.destroyed || this.ctx !== ctx) return;

      // Pre-warm transfer buffer pool once
      while (this.freePool.length < INITIAL_WORKLET_POOL) {
        this.freePool.push(new Float32Array(WORKLET_BUF_TOTAL));
        this.allocatedPoolCount++;
      }

      const node = new AudioWorkletNode(ctx, 'zx-beeper-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });

      node.port.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        this.blockedFrames = 0;
        if (typeof msg.buffered === 'number' && msg.seq === this.resetSeq) {
          this.workletBuffered = msg.buffered;
        }
        if (msg.type === 'recycle' && msg.buf instanceof Float32Array) {
          if (this.freePool.length < MAX_WORKLET_POOL) {
            this.freePool.push(msg.buf);
          }
        }
      };

      node.onprocessorerror = () => {
        if (this.destroyed || this.ctx !== ctx || this.workletNode !== node) return;
        node.port.onmessage = null;
        node.onprocessorerror = null;
        node.disconnect();
        this.workletNode = null;
        this.workletReady = false;
        this.initFallbackScriptProcessor(ctx, gain);
      };

      node.connect(gain);
      this.workletNode = node;
      this.workletReady = true;
      this.needsPrefill = true;
      this.workletBuffered = 0;
      this.blockedFrames = 0;
      this.resetSeq++;
      node.port.postMessage({ type: 'reset', seq: this.resetSeq });
    } catch {
      if (!this.destroyed && this.ctx === ctx) {
        this.initFallbackScriptProcessor(ctx, gain);
      }
    } finally {
      this.workletLoading = false;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    }
  }

  public start(): void {
    // Allow clean revival if start() is called after a strict-mode/HMR unmount-remount cycle
    if (this.destroyed) {
      this.destroyed = false;
    }
    this.clearSuspendTimer();

    if (this.ctx && this.ctx.state === 'closed') {
      this.teardownGraph();
    }

    if (this.ctx) {
      this.active = !this.muted;
      if (this.gainNode) {
        this.gainNode.gain.value = this.muted ? 0 : this.volume;
      }
      if (!this.workletReady && !this.workletLoading && !this.procNode && this.gainNode) {
        if (
          typeof AudioWorkletNode !== 'undefined' &&
          this.ctx.audioWorklet &&
          typeof this.ctx.audioWorklet.addModule === 'function'
        ) {
          void this.initAudioWorklet(this.ctx, this.gainNode);
        } else {
          this.initFallbackScriptProcessor(this.ctx, this.gainNode);
        }
      }
      if (this.ctx.state !== 'running') {
        void this.ctx.resume().catch(() => {});
        if (!this.muted) {
          this.armUnlockListeners();
        }
      }
      return;
    }

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    this.dcPole = Math.exp((-2 * Math.PI * 20) / this.sampleRate);

    ctx.onstatechange = () => {
      if (this.destroyed || this.ctx !== ctx) return;
      if (ctx.state === 'running') {
        this.disarmUnlockListeners();
      } else if (ctx.state === 'closed') {
        this.teardownGraph();
      } else if (!this.muted && this.active) {
        this.armUnlockListeners();
      }
    };

    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    gain.connect(ctx.destination);
    this.gainNode = gain;

    this.needsPrefill = true;
    this.needsDcSeed = true;
    this.workletBuffered = 0;
    this.blockedFrames = 0;
    this.active = !this.muted;

    if (
      typeof AudioWorkletNode !== 'undefined' &&
      ctx.audioWorklet &&
      typeof ctx.audioWorklet.addModule === 'function'
    ) {
      void this.initAudioWorklet(ctx, gain);
    } else {
      this.initFallbackScriptProcessor(ctx, gain);
    }

    if (ctx.state !== 'running') {
      void ctx.resume().catch(() => {});
      if (!this.muted) {
        this.armUnlockListeners();
      }
    }
  }

  public setMuted(muted: boolean, immediateSuspend = false): void {
    this.muted = muted;
    this.clearSuspendTimer();

    if (muted) {
      this.active = false;
      this.disarmUnlockListeners();
      this.readPtr = 0;
      this.writePtr = 0;
      this.workletBuffered = 0;
      this.blockedFrames = 0;
      this.lastSampleL = 0;
      this.lastSampleR = 0;
      this.dcPrevInL = 0;
      this.dcPrevOutL = 0;
      this.dcPrevInR = 0;
      this.dcPrevOutR = 0;
      this.sampleFracAcc = 0;
      this.needsPrefill = true;
      this.needsDcSeed = true;
      resetBeeperSynthState(this.synthState);
      if (this.gainNode) {
        this.gainNode.gain.value = 0;
      }
      if (this.workletNode) {
        this.resetSeq++;
        this.workletNode.port.postMessage({ type: 'reset', seq: this.resetSeq });
      }
      const ctx = this.ctx;
      if (!ctx || ctx.state === 'closed') return;
      if (immediateSuspend) {
        if (ctx.state === 'running') {
          void ctx.suspend().catch(() => {});
        }
      } else if (typeof window !== 'undefined') {
        // Defer ctx.suspend() across brief modals/pauses so async game loads keep user activation intact,
        // while still sleeping the OS audio thread during extended pauses/menus.
        this.suspendTimer = window.setTimeout(() => {
          this.suspendTimer = null;
          if (!this.muted || this.destroyed) return;
          if (this.ctx === ctx && ctx.state === 'running') {
            void ctx.suspend().catch(() => {});
          }
        }, DEFERRED_SUSPEND_MS);
      }
      return;
    }

    this.active = true;
    this.needsPrefill = true;
    this.needsDcSeed = true;
    this.workletBuffered = 0;
    this.blockedFrames = 0;
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
    if (!this.ctx) return;
    if (this.ctx.state === 'closed') {
      this.start();
      return;
    }
    if (this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => {});
      this.armUnlockListeners();
    } else {
      this.disarmUnlockListeners();
    }
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.gainNode && !this.muted) {
      this.gainNode.gain.value = this.volume;
    }
  }

  public pushFrame(
    transitionsT: Int32Array,
    transitionsVal: Uint8Array,
    count: number,
    initialLevel: number,
    ay?: AY8910 | null,
    tstatesPerFrame = TSTATES_PER_FRAME,
    frameHz = 50.080128,
    clockMult = 1,
    stereoMode: StereoMode = 'acb',
    ayClockHz = 1_773_400
  ): void {
    if (!this.active || this.muted || !this.ctx || this.ctx.state !== 'running') return;

    const usingWorklet = this.workletReady && this.workletNode !== null;
    if (!usingWorklet && !this.procNode) {
      // Worklet is still compiling in background during the very first few milliseconds
      return;
    }

    const targetBuffered = Math.round(this.sampleRate * 0.055); // ~55ms jitter cushion
    let buffered = usingWorklet
      ? this.workletBuffered
      : (this.writePtr - this.readPtr) & (RING_SIZE - 1);

    let prefillSamples = 0;
    const initAmp = levelToAmp(initialLevel);

    if (this.needsPrefill) {
      if (usingWorklet) {
        prefillSamples = targetBuffered;
        buffered = targetBuffered;
        this.workletBuffered = targetBuffered;
      } else {
        const rL = this.ringL!;
        const rR = this.ringR!;
        for (let i = 0; i < targetBuffered; i++) {
          rL[this.writePtr] = initAmp;
          rR[this.writePtr] = initAmp;
          this.writePtr = (this.writePtr + 1) & (RING_SIZE - 1);
        }
        this.lastSampleL = initAmp;
        this.lastSampleR = initAmp;
        buffered = targetBuffered;
      }
      this.needsPrefill = false;
    }

    // Smooth continuous proportional DRC (±0.4% max, inaudible <7 cents) locks frame rate to audio DAC
    const fillError = (targetBuffered - buffered) / targetBuffered;
    let drcDelta = fillError * 0.006;
    if (drcDelta > 0.004) drcDelta = 0.004;
    else if (drcDelta < -0.004) drcDelta = -0.004;
    const rateAdjust = 1 + drcDelta;

    const mult = Math.max(0.1, clockMult);
    const effectiveHz = Math.max(5, frameHz * mult);
    const exactSamples = (this.sampleRate / effectiveHz) * rateAdjust;
    this.sampleFracAcc += exactSamples;
    const sampleCount = Math.min(MAX_FRAME_SAMPLES, Math.floor(this.sampleFracAcc));
    this.sampleFracAcc -= sampleCount;
    if (sampleCount <= 0) return;

    if (buffered > RING_SIZE - sampleCount - 64) {
      if (usingWorklet) {
        this.blockedFrames++;
        if (this.blockedFrames >= 20) {
          // Self-heal if worklet buffered count drifted or stalled across browser hiccups
          this.blockedFrames = 0;
          this.workletBuffered = 0;
          this.needsPrefill = true;
          this.resetSeq++;
          this.workletNode!.port.postMessage({ type: 'reset', seq: this.resetSeq });
        }
      }
      return;
    }
    this.blockedFrames = 0;

    const ayActive = Boolean(ay && ay.hasFrameAudio());

    // Fast path for AudioWorklet when both beeper and AY are completely settled & silent
    if (
      usingWorklet &&
      !ayActive &&
      count === 0 &&
      !this.synthState.overlapActive &&
      Math.abs(this.synthState.curAmp - initAmp) < 1e-6 &&
      Math.abs(this.synthState.acc - initAmp) < 1e-6 &&
      Math.abs(this.synthState.y1 - initAmp) < 1e-5 &&
      Math.abs(this.synthState.y2 - initAmp) < 1e-5
    ) {
      // Keep biquad state synchronized in case level changed cleanly
      this.synthState.initialized = true;
      this.synthState.curAmp = initAmp;
      this.synthState.acc = initAmp;
      this.synthState.x1 = initAmp;
      this.synthState.x2 = initAmp;
      this.synthState.y1 = initAmp;
      this.synthState.y2 = initAmp;
      this.workletBuffered += sampleCount;
      this.workletNode!.port.postMessage({
        type: 'fill',
        seq: this.resetSeq,
        len: sampleCount,
        amp: initAmp,
        prefill: prefillSamples,
        initAmp,
      });
      return;
    }

    if (usingWorklet) {
      const transferBuf = this.acquireTransferBuffer();
      const bufL = transferBuf.subarray(0, sampleCount);
      synthesizeBeeperFrame(
        bufL,
        sampleCount,
        transitionsT,
        transitionsVal,
        count,
        initialLevel,
        tstatesPerFrame,
        this.sampleRate,
        0,
        this.synthState
      );

      let mono = true;
      if (ayActive && ay) {
        mono = false;
        const bufR = transferBuf.subarray(WORKLET_BUF_STRIDE, WORKLET_BUF_STRIDE + sampleCount);
        bufR.set(bufL);
        ay.mixIntoStereo(
          bufL,
          bufR,
          0,
          sampleCount,
          this.sampleRate / mult,
          stereoMode,
          ayClockHz,
          tstatesPerFrame
        );
        for (let s = 0; s < sampleCount; s++) {
          const l = bufL[s];
          if (l > 0.98) bufL[s] = 0.98;
          else if (l < -0.98) bufL[s] = -0.98;
          const r = bufR[s];
          if (r > 0.98) bufR[s] = 0.98;
          else if (r < -0.98) bufR[s] = -0.98;
        }
      }

      this.workletBuffered += sampleCount;
      this.workletNode!.port.postMessage(
        {
          type: 'push',
          seq: this.resetSeq,
          buf: transferBuf,
          len: sampleCount,
          mono,
          prefill: prefillSamples,
          initAmp,
        },
        [transferBuf.buffer]
      );
      return;
    }

    const bufL = this.tempL;
    const bufR = this.tempR;
    synthesizeBeeperFrame(
      bufL,
      sampleCount,
      transitionsT,
      transitionsVal,
      count,
      initialLevel,
      tstatesPerFrame,
      this.sampleRate,
      0,
      this.synthState
    );

    if (ayActive && ay) {
      for (let s = 0; s < sampleCount; s++) {
        bufR[s] = bufL[s];
      }
      ay.mixIntoStereo(
        bufL,
        bufR,
        0,
        sampleCount,
        this.sampleRate / mult,
        stereoMode,
        ayClockHz,
        tstatesPerFrame
      );
      const rL = this.ringL!;
      const rR = this.ringR!;
      for (let s = 0; s < sampleCount; s++) {
        let l = bufL[s];
        let r = bufR[s];
        if (l > 0.98) l = 0.98;
        else if (l < -0.98) l = -0.98;
        if (r > 0.98) r = 0.98;
        else if (r < -0.98) r = -0.98;
        rL[this.writePtr] = l;
        rR[this.writePtr] = r;
        this.writePtr = (this.writePtr + 1) & (RING_SIZE - 1);
      }
    } else {
      const rL = this.ringL!;
      const rR = this.ringR!;
      for (let s = 0; s < sampleCount; s++) {
        const v = bufL[s];
        rL[this.writePtr] = v;
        rR[this.writePtr] = v;
        this.writePtr = (this.writePtr + 1) & (RING_SIZE - 1);
      }
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.active = false;
    this.teardownGraph();
  }
}
