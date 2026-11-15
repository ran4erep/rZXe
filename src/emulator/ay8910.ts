// Zero-allocation AY-3-8910 / YM2149 PSG chip with T-state register timing & ABC/ACB/Mono stereo

export type StereoMode = 'abc' | 'acb' | 'mono';

// Standard logarithmic AY-3-8912 DAC curve (normalized 0..1)
const AY_DAC = new Float32Array([
  0.0, 0.0073, 0.0114, 0.0178, 0.0268, 0.0398, 0.0566, 0.0885,
  0.1112, 0.1753, 0.2512, 0.3401, 0.4648, 0.6256, 0.8087, 1.0,
]);

const MAX_AY_EVENTS = 4096;

export class AY8910 {
  public readonly regs = new Uint8Array(16);
  private readonly renderRegs = new Uint8Array(16);
  public selectedReg = 0;
  public active = false;

  // Timed register writes within the current video frame (zero-allocation fixed arrays)
  private readonly evT = new Int32Array(MAX_AY_EVENTS);
  private readonly evReg = new Uint8Array(MAX_AY_EVENTS);
  private readonly evVal = new Uint8Array(MAX_AY_EVENTS);
  private evCount = 0;
  private hadActivity = false;

  private toneCntA = 0;
  private toneCntB = 0;
  private toneCntC = 0;
  private toneOutA = 1;
  private toneOutB = 1;
  private toneOutC = 1;

  private noiseCnt = 0;
  private noiseLfsr = 1;
  private noiseOut = 1;

  private envCnt = 0;
  private envPos = 0;
  private envHolding = false;
  private envAlt = false;
  private envAttack = false;
  private envVol = 0;
  private tickAcc = 0;

  public reset(): void {
    this.regs.fill(0);
    this.regs[7] = 0xff; // All channels muted initially
    this.renderRegs.fill(0);
    this.renderRegs[7] = 0xff;
    this.selectedReg = 0;
    this.active = false;
    this.evCount = 0;
    this.hadActivity = false;

    this.toneCntA = 0;
    this.toneCntB = 0;
    this.toneCntC = 0;
    this.toneOutA = 1;
    this.toneOutB = 1;
    this.toneOutC = 1;
    this.noiseCnt = 0;
    this.noiseLfsr = 1;
    this.noiseOut = 1;
    this.envCnt = 0;
    this.envPos = 0;
    this.envHolding = false;
    this.envAlt = false;
    this.envAttack = false;
    this.envVol = 0;
    this.tickAcc = 0;
  }

  public beginFrame(): void {
    if (this.evCount > 0) {
      for (let e = 0; e < this.evCount; e++) {
        this.applyRenderReg(this.evReg[e], this.evVal[e]);
      }
      this.evCount = 0;
    }
    this.hadActivity = this.active;
  }

  public hasFrameAudio(): boolean {
    return this.active || this.hadActivity || this.evCount > 0;
  }

  public selectRegister(reg: number): void {
    this.selectedReg = reg & 0x0f;
  }

  public readRegister(): number {
    return this.regs[this.selectedReg];
  }

  private applyRenderReg(r: number, v: number): void {
    this.renderRegs[r] = v;
    if (r === 13) {
      this.envPos = 0;
      this.envHolding = false;
      this.envAttack = (v & 0x04) !== 0;
      this.envAlt = (v & 0x02) !== 0;
      this.envVol = this.envAttack ? 0 : 15;
    }
  }

  public writeRegister(val: number, tstates = -1): void {
    const r = this.selectedReg;
    const v = val & 0xff;
    this.regs[r] = v;

    if (tstates < 0) {
      // Untimed direct write (e.g. unit tests / snapshots)
      this.applyRenderReg(r, v);
      this.hadActivity = true;
    } else if (this.evCount < MAX_AY_EVENTS) {
      this.evT[this.evCount] = tstates;
      this.evReg[this.evCount] = r;
      this.evVal[this.evCount] = v;
      this.evCount++;
      if ((r >= 8 && r <= 10 && (v & 0x1f) !== 0) || r === 13) {
        this.hadActivity = true;
      }
    }

    // Track if any channel currently has non-zero volume or envelope enabled
    const vA = this.regs[8] & 0x1f;
    const vB = this.regs[9] & 0x1f;
    const vC = this.regs[10] & 0x1f;
    this.active = (vA | vB | vC) !== 0;
    if (this.active) this.hadActivity = true;
  }

  /**
   * Generates `sampleCount` stereo samples and adds them into `outL` / `outR` buffers.
   * Replays all mid-frame register writes at exact T-state timing (supporting AY digi-drums/samples)
   * and supports ABC, ACB, and Mono stereo channel routing.
   */
  public mixIntoStereo(
    outL: Float32Array,
    outR: Float32Array,
    offset: number,
    sampleCount: number,
    sampleRate: number,
    stereoMode: StereoMode = 'acb',
    ayClockHz = 1_773_400,
    tstatesPerFrame = 70908
  ): void {
    if (!this.hasFrameAudio()) {
      // Still flush any harmless register events (e.g., frequency pre-loads while muted)
      for (let e = 0; e < this.evCount; e++) {
        this.applyRenderReg(this.evReg[e], this.evVal[e]);
      }
      this.evCount = 0;
      return;
    }

    // Stereo panning gains per channel (sum of L+R = 1.0 per channel)
    let aL = 0.5, aR = 0.5;
    let bL = 0.5, bR = 0.5;
    let cL = 0.5, cR = 0.5;
    if (stereoMode === 'abc') {
      aL = 0.85; aR = 0.15;
      bL = 0.50; bR = 0.50;
      cL = 0.15; cR = 0.85;
    } else if (stereoMode === 'acb') {
      aL = 0.85; aR = 0.15;
      bL = 0.15; bR = 0.85;
      cL = 0.50; cR = 0.50;
    }

    const regs = this.renderRegs;
    let perA = Math.max(1, regs[0] | ((regs[1] & 0x0f) << 8));
    let perB = Math.max(1, regs[2] | ((regs[3] & 0x0f) << 8));
    let perC = Math.max(1, regs[4] | ((regs[5] & 0x0f) << 8));
    let perN = Math.max(1, regs[6] & 0x1f);
    let mixer = regs[7];
    let perEnv = Math.max(1, regs[11] | (regs[12] << 8));
    let shape = regs[13];
    let vA = regs[8];
    let vB = regs[9];
    let vC = regs[10];

    let toneDisableA = (mixer & 0x01) !== 0;
    let toneDisableB = (mixer & 0x02) !== 0;
    let toneDisableC = (mixer & 0x04) !== 0;
    let noiseDisableA = (mixer & 0x08) !== 0;
    let noiseDisableB = (mixer & 0x10) !== 0;
    let noiseDisableC = (mixer & 0x20) !== 0;

    let toneCntA = this.toneCntA;
    let toneCntB = this.toneCntB;
    let toneCntC = this.toneCntC;
    let toneOutA = this.toneOutA;
    let toneOutB = this.toneOutB;
    let toneOutC = this.toneOutC;
    let noiseCnt = this.noiseCnt;
    let noiseLfsr = this.noiseLfsr;
    let noiseOut = this.noiseOut;
    let envCnt = this.envCnt;
    let envPos = this.envPos;
    let envHolding = this.envHolding;
    let envAlt = this.envAlt;
    let envAttack = this.envAttack;
    let envVol = this.envVol;
    let tickAcc = this.tickAcc;

    const ticksPerSample = (ayClockHz * 0.125) / sampleRate;
    const tPerSample = tstatesPerFrame / sampleCount;
    const evCount = this.evCount;
    const evT = this.evT;
    const evReg = this.evReg;
    const evVal = this.evVal;
    let evIdx = 0;

    for (let i = 0; i < sampleCount; i++) {
      // Apply any AY register writes occurring up to this sample's T-state boundary
      if (evIdx < evCount) {
        const boundaryT = (i + 1) * tPerSample;
        let regsChanged = false;
        while (evIdx < evCount && evT[evIdx] <= boundaryT) {
          const r = evReg[evIdx];
          const v = evVal[evIdx];
          regs[r] = v;
          if (r === 13) {
            envPos = 0;
            envHolding = false;
            envAttack = (v & 0x04) !== 0;
            envAlt = (v & 0x02) !== 0;
            envVol = envAttack ? 0 : 15;
          }
          evIdx++;
          regsChanged = true;
        }
        if (regsChanged) {
          perA = Math.max(1, regs[0] | ((regs[1] & 0x0f) << 8));
          perB = Math.max(1, regs[2] | ((regs[3] & 0x0f) << 8));
          perC = Math.max(1, regs[4] | ((regs[5] & 0x0f) << 8));
          perN = Math.max(1, regs[6] & 0x1f);
          mixer = regs[7];
          toneDisableA = (mixer & 0x01) !== 0;
          toneDisableB = (mixer & 0x02) !== 0;
          toneDisableC = (mixer & 0x04) !== 0;
          noiseDisableA = (mixer & 0x08) !== 0;
          noiseDisableB = (mixer & 0x10) !== 0;
          noiseDisableC = (mixer & 0x20) !== 0;
          perEnv = Math.max(1, regs[11] | (regs[12] << 8));
          shape = regs[13];
          vA = regs[8];
          vB = regs[9];
          vC = regs[10];
        }
      }

      tickAcc += ticksPerSample;
      const stepsPerSample = tickAcc | 0;
      tickAcc -= stepsPerSample;

      const gainA = AY_DAC[(vA & 0x10) ? envVol : (vA & 0x0f)];
      const gainB = AY_DAC[(vB & 0x10) ? envVol : (vB & 0x0f)];
      const gainC = AY_DAC[(vC & 0x10) ? envVol : (vC & 0x0f)];

      let accA = 0;
      let accB = 0;
      let accC = 0;

      if (stepsPerSample > 0) {
        const noisePeriod = perN << 1;
        const envPeriod = perEnv << 1;

        for (let s = 0; s < stepsPerSample; s++) {
          if (++toneCntA >= perA) { toneCntA = 0; toneOutA ^= 1; }
          if (++toneCntB >= perB) { toneCntB = 0; toneOutB ^= 1; }
          if (++toneCntC >= perC) { toneCntC = 0; toneOutC ^= 1; }

          if (++noiseCnt >= noisePeriod) {
            noiseCnt = 0;
            const bit = (noiseLfsr ^ (noiseLfsr >> 3)) & 1;
            noiseLfsr = (noiseLfsr >> 1) | (bit << 16);
            noiseOut = noiseLfsr & 1;
          }

          if (!envHolding && ++envCnt >= envPeriod) {
            envCnt = 0;
            envPos++;
            if (envPos >= 16) {
              if ((shape & 0x08) === 0) {
                envVol = 0;
                envHolding = true;
              } else if (shape & 0x01) {
                envVol = envAlt ? (envAttack ? 0 : 15) : (envAttack ? 15 : 0);
                envHolding = true;
              } else {
                envPos = 0;
                if (envAlt) envAttack = !envAttack;
                envVol = envAttack ? 0 : 15;
              }
            } else {
              envVol = envAttack ? envPos : 15 - envPos;
            }
          }

          // Box-average sub-sample transitions to suppress aliasing on high tones/buzzers
          if ((toneDisableA || toneOutA) && (noiseDisableA || noiseOut)) accA++;
          if ((toneDisableB || toneOutB) && (noiseDisableB || noiseOut)) accB++;
          if ((toneDisableC || toneOutC) && (noiseDisableC || noiseOut)) accC++;
        }

        const invSteps = 1 / stepsPerSample;
        accA *= gainA * invSteps;
        accB *= gainB * invSteps;
        accC *= gainC * invSteps;
      } else {
        if ((toneDisableA || toneOutA) && (noiseDisableA || noiseOut)) accA = gainA;
        if ((toneDisableB || toneOutB) && (noiseDisableB || noiseOut)) accB = gainB;
        if ((toneDisableC || toneOutC) && (noiseDisableC || noiseOut)) accC = gainC;
      }

      outL[offset + i] += (accA * aL + accB * bL + accC * cL) * 0.45;
      outR[offset + i] += (accA * aR + accB * bR + accC * cR) * 0.45;
    }

    this.toneCntA = toneCntA;
    this.toneCntB = toneCntB;
    this.toneCntC = toneCntC;
    this.toneOutA = toneOutA;
    this.toneOutB = toneOutB;
    this.toneOutC = toneOutC;
    this.noiseCnt = noiseCnt;
    this.noiseLfsr = noiseLfsr;
    this.noiseOut = noiseOut;
    this.envCnt = envCnt;
    this.envPos = envPos;
    this.envHolding = envHolding;
    this.envAlt = envAlt;
    this.envAttack = envAttack;
    this.envVol = envVol;
    this.tickAcc = tickAcc;

    // Flush any tail events >= frame end
    while (evIdx < evCount) {
      this.applyRenderReg(evReg[evIdx], evVal[evIdx]);
      evIdx++;
    }
    this.evCount = 0;
  }

  /**
   * Mono compatibility helper for unit tests and mono callers.
   */
  public mixInto(out: Float32Array, offset: number, sampleCount: number, sampleRate: number): void {
    const tmp = new Float32Array(sampleCount);
    this.mixIntoStereo(out, tmp, offset, sampleCount, sampleRate, 'mono', 1_773_400, 70908);
  }
}
