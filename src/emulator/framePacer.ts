// Zero-allocation Phase-Locked Loop (PLL) frame pacer for jitter-free 50Hz emulation on 50/60/120/144Hz displays

export interface FramePacerState {
  initialized: boolean;
  lastNowMs: number;
  virtualClockMs: number;
  estVsyncMs: number;
  accMs: number;
}

export function createFramePacerState(): FramePacerState {
  return {
    initialized: false,
    lastNowMs: 0,
    virtualClockMs: 0,
    estVsyncMs: 1000 / 60,
    accMs: 0,
  };
}

export function resetFramePacerState(state: FramePacerState, nowMs = 0): void {
  state.initialized = nowMs > 0;
  state.lastNowMs = nowMs;
  state.virtualClockMs = nowMs;
  state.accMs = 0;
}

/**
 * Computes how many whole emulated frames (0..maxSteps) to advance on this rAF tick.
 * Filters OS/browser rAF delivery jitter via an adaptive PLL so minor ±1.5ms wake-up
 * variance never causes erratic frame skips or 2-frame catch-up bursts.
 */
export function advanceFramePacer(
  state: FramePacerState,
  nowMs: number,
  targetHz: number,
  maxSteps = 2
): number {
  const frameMs = 1000 / Math.max(5, targetHz);

  if (!state.initialized) {
    state.initialized = true;
    state.lastNowMs = nowMs;
    state.virtualClockMs = nowMs;
    state.accMs = frameMs; // Step 1st frame immediately on start/resume
  } else {
    let rawDt = nowMs - state.lastNowMs;
    state.lastNowMs = nowMs;

    if (rawDt <= 0) {
      rawDt = 0;
    } else if (rawDt > 60) {
      // Tab switch or debugger pause: clamp spiral-of-death and re-sync virtual clock
      rawDt = frameMs;
      state.virtualClockMs = nowMs - rawDt;
      state.accMs = 0;
    }

    // Track true display refresh interval only from steady frames (ignore single hiccups)
    if (rawDt >= 3.5 && rawDt <= 26) {
      const diff = rawDt - state.estVsyncMs;
      if (Math.abs(diff) <= 2.4) {
        state.estVsyncMs += diff * 0.08;
      } else if (Math.abs(diff) > 3.5) {
        // Refresh rate switched (e.g. ProMotion 60Hz <-> 120Hz or external monitor move)
        state.estVsyncMs += diff * 0.35;
      }
    }

    // Use smoothed vsync period when frame arrived smoothly; keep rawDt on genuine multi-vsync drops
    const baseDt =
      rawDt > 0 && Math.abs(rawDt - state.estVsyncMs) <= 2.4
        ? state.estVsyncMs
        : rawDt;

    state.virtualClockMs += baseDt;

    // Gentle bounded phase lock keeps virtualClockMs tied to wall time without passing raw jitter
    const phaseErr = nowMs - state.virtualClockMs;
    let nudge = phaseErr * 0.06;
    if (nudge > 0.6) nudge = 0.6;
    else if (nudge < -0.6) nudge = -0.6;
    state.virtualClockMs += nudge;

    const stepDt = baseDt + nudge;
    if (stepDt > 0) {
      state.accMs += stepDt;
    }
  }

  let steps = 0;
  while (state.accMs >= frameMs && steps < maxSteps) {
    state.accMs -= frameMs;
    steps++;
  }

  // Prevent stale backlog from accumulating across transient OS stalls
  const maxBacklog = frameMs * 1.5;
  if (state.accMs > maxBacklog) {
    state.accMs = maxBacklog;
  }

  return steps;
}
