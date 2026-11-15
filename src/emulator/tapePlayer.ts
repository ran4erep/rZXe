// Real-time O(1) ZX Spectrum Cassette Tape Pulse Generator (.TAP/.TZX/.CDT/.PZX/.CSW/.WAV/.VOC -> EAR bit 6)

import { TapeBlock } from './formats';
import { TapeSegment, tapBlocksToTapeImage } from './tapeFormats';

const SYNCED_PAUSE_T = 2_800_000; // ~800ms natural cassette pause once ROM reaches 0x0556

type ActiveMode = 'idle' | 'tone' | 'pulses' | 'data' | 'pause';

export class TapePlayer {
  public active = false;
  public earLevel = 0; // 0 or 1 (maps to port 0xFE bit 6)
  public blockIdx = 0;
  public segmentIdx = 0;
  public is48kMachine = false;

  private segments: TapeSegment[] = [];
  private mode: ActiveMode = 'idle';
  private remT = 0;

  // Tone / Pulse sequence state
  private tonePulseT = 0;
  private toneRem = 0;
  private activePulses: Uint32Array | null = null;
  private pulseCursor = 0;

  // Data segment state
  private dataBuf: Uint8Array | null = null;
  private dataZeroT = 855;
  private dataOneT = 1710;
  private dataPulsesPerBit: 1 | 2 = 2;
  private dataUsedBitsLast = 8;
  private dataPauseT = 0;
  private byteIdx = 0;
  private bitPos = 0;
  private bitHalf = 0;
  private currentByte = 0;

  // Loop stack for TZX 0x24/0x25
  private loopStartSeg = -1;
  private loopRemaining = 0;

  public start(blocks: TapeBlock[], startBlockIdx = 0): void {
    if (blocks.length === 0) {
      this.stop();
      return;
    }
    const img = tapBlocksToTapeImage(blocks);
    const clampedBlock = Math.max(0, Math.min(startBlockIdx, blocks.length - 1));
    const segIdx = img.blockToSegmentIdx[clampedBlock] ?? 0;
    this.startSegments(img.segments, segIdx, clampedBlock);
  }

  public startSegments(segments: TapeSegment[], startSegIdx = 0, initialBlockIdx = 0): void {
    this.segments = segments;
    if (segments.length === 0 || startSegIdx >= segments.length) {
      this.stop();
      return;
    }
    this.active = true;
    this.earLevel = 0;
    this.blockIdx = initialBlockIdx;
    this.loopStartSeg = -1;
    this.loopRemaining = 0;
    this.beginSegment(Math.max(0, startSegIdx));
  }

  public stop(): void {
    this.active = false;
    this.mode = 'idle';
    this.remT = 0;
    this.earLevel = 0;
    this.activePulses = null;
    this.dataBuf = null;
  }

  public isAudioActive(): boolean {
    return this.active && this.mode !== 'pause';
  }

  /**
   * Called when ROM enters LD-BYTES (0x0556): if the tape is waiting in inter-block
   * pause, trim remaining silence so the next block begins cleanly without dead wait.
   */
  public syncOnLoaderReady(): void {
    if (this.active && this.mode === 'pause' && this.remT > SYNCED_PAUSE_T) {
      this.remT = SYNCED_PAUSE_T;
    }
  }

  private beginSegment(idx: number): void {
    let cur = idx;
    let safety = 0;

    while (cur < this.segments.length && safety++ < 256) {
      this.segmentIdx = cur;
      const seg = this.segments[cur];

      switch (seg.kind) {
        case 'setLevel': {
          this.earLevel = seg.level;
          cur++;
          continue;
        }
        case 'loopStart': {
          this.loopStartSeg = cur + 1;
          this.loopRemaining = Math.max(0, seg.count);
          cur++;
          continue;
        }
        case 'loopEnd': {
          if (this.loopStartSeg >= 0 && this.loopRemaining > 1) {
            this.loopRemaining--;
            cur = this.loopStartSeg;
          } else {
            this.loopStartSeg = -1;
            this.loopRemaining = 0;
            cur++;
          }
          continue;
        }
        case 'jump': {
          cur = seg.targetSeg;
          continue;
        }
        case 'stop': {
          this.stop();
          return;
        }
        case 'stop48k': {
          if (this.is48kMachine) {
            this.stop();
            return;
          }
          cur++;
          continue;
        }
        case 'tone': {
          if (seg.count <= 0 || seg.pulseT <= 0) {
            cur++;
            continue;
          }
          this.mode = 'tone';
          this.tonePulseT = seg.pulseT;
          this.toneRem = seg.count;
          this.remT = seg.pulseT;
          return;
        }
        case 'pulses': {
          if (seg.pulses.length === 0) {
            cur++;
            continue;
          }
          this.mode = 'pulses';
          this.activePulses = seg.pulses;
          this.pulseCursor = 0;
          this.remT = Math.max(1, seg.pulses[0]);
          return;
        }
        case 'data': {
          if (seg.data.length === 0) {
            if (seg.pauseT > 0) {
              this.mode = 'pause';
              this.remT = seg.pauseT;
              return;
            }
            cur++;
            continue;
          }
          this.mode = 'data';
          this.dataBuf = seg.data;
          this.dataZeroT = seg.zeroT;
          this.dataOneT = seg.oneT;
          this.dataPulsesPerBit = seg.pulsesPerBit;
          this.dataUsedBitsLast = seg.usedBitsLastByte;
          this.dataPauseT = seg.pauseT;
          this.byteIdx = 0;
          this.bitPos = 0;
          this.bitHalf = 0;
          this.currentByte = seg.data[0];
          const bit = (this.currentByte >> 7) & 1;
          this.remT = bit ? this.dataOneT : this.dataZeroT;
          return;
        }
        case 'pause': {
          if (seg.pauseT <= 0) {
            cur++;
            continue;
          }
          if (seg.level !== undefined) {
            this.earLevel = seg.level;
          }
          this.mode = 'pause';
          this.remT = seg.pauseT;
          return;
        }
      }
    }

    this.segmentIdx = this.segments.length;
    this.stop();
  }

  /**
   * Advances cassette playback by `deltaT` T-states from `baseT`,
   * invoking `onEdge(tstates, earLevel)` whenever the EAR signal flips.
   */
  public advance(
    deltaT: number,
    baseT: number,
    onEdge?: (tstates: number, earLevel: number) => void
  ): void {
    if (!this.active || deltaT <= 0) return;

    let left = deltaT;
    let curT = baseT;

    while (left > 0 && this.active) {
      if (left < this.remT) {
        this.remT -= left;
        return;
      }

      left -= this.remT;
      curT += this.remT;

      if (this.mode !== 'pause') {
        this.earLevel ^= 1;
        onEdge?.(curT, this.earLevel);
      }

      switch (this.mode) {
        case 'tone': {
          this.toneRem--;
          if (this.toneRem > 0) {
            this.remT = this.tonePulseT;
          } else {
            this.beginSegment(this.segmentIdx + 1);
          }
          break;
        }

        case 'pulses': {
          this.pulseCursor++;
          const arr = this.activePulses;
          if (arr && this.pulseCursor < arr.length) {
            this.remT = Math.max(1, arr[this.pulseCursor]);
          } else {
            this.activePulses = null;
            this.beginSegment(this.segmentIdx + 1);
          }
          break;
        }

        case 'data': {
          const buf = this.dataBuf;
          if (!buf) {
            this.beginSegment(this.segmentIdx + 1);
            break;
          }
          if (this.dataPulsesPerBit === 2 && this.bitHalf === 0) {
            this.bitHalf = 1;
            const bit = (this.currentByte >> (7 - this.bitPos)) & 1;
            this.remT = bit ? this.dataOneT : this.dataZeroT;
          } else {
            this.bitHalf = 0;
            this.bitPos++;
            const maxBits = this.byteIdx === buf.length - 1 ? this.dataUsedBitsLast : 8;
            if (this.bitPos >= maxBits) {
              this.byteIdx++;
              if (this.byteIdx >= buf.length) {
                this.dataBuf = null;
                if (this.dataPauseT > 0) {
                  this.mode = 'pause';
                  this.remT = this.dataPauseT;
                } else {
                  this.beginSegment(this.segmentIdx + 1);
                }
                break;
              }
              this.currentByte = buf[this.byteIdx];
              this.bitPos = 0;
            }
            const bit = (this.currentByte >> (7 - this.bitPos)) & 1;
            this.remT = bit ? this.dataOneT : this.dataZeroT;
          }
          break;
        }

        case 'pause': {
          this.beginSegment(this.segmentIdx + 1);
          break;
        }

        default:
          this.stop();
          break;
      }
    }
  }
}
