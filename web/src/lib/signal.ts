// signal.ts — PURE math. No window/document/navigator at module scope.
// This is the tested core (see src/selfcheck.ts). Units:
//   - accelerometer samples are in m/s² (DeviceMotionEvent native), gravity G ≈ 9.80665
//   - gyroscope samples are in rad/s (magnitudes, orientation-independent)

export const G = 9.80665;

/** Euclidean magnitude of a 3-vector. */
export function magnitude(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// ---------------------------------------------------------------------------
// Fall detection
// Reference: CareBridge FallDetectionService (Kotlin) — accel/gyro magnitude
// deltas over accThreshold=10 / gyroThreshold=10. We extend it with the
// free-fall phase + post-impact stillness the spec requires, which the naive
// delta-only reference lacks (it false-fires on any sharp knock).
// ---------------------------------------------------------------------------

export interface FallSample {
  t: number;
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}

export interface FallDetectorCfg {
  accThreshold?: number; // m/s² jump in |a| that counts as impact
  gyroThreshold?: number; // rad/s magnitude that counts as a violent rotation
  freeFallG?: number; // |a| below this many g starts a free-fall phase
  windowMs?: number; // free-fall -> impact must happen within this
  restBandG?: number; // |a|-G within this counts as "still"
  stillnessMs?: number; // sustained stillness after impact before we confirm
}

export interface FallResult {
  fall: boolean;
  reason?: "impact" | "free-fall+impact";
}

export function createFallDetector(cfg: FallDetectorCfg = {}) {
  const accThreshold = cfg.accThreshold ?? 10;
  const gyroThreshold = cfg.gyroThreshold ?? 10;
  const freeFallMag = (cfg.freeFallG ?? 0.5) * G;
  const windowMs = cfg.windowMs ?? 2000;
  const restBand = cfg.restBandG ?? 2.5;
  const stillnessMs = cfg.stillnessMs ?? 300;

  let phase: "idle" | "freefall" | "impact" = "idle";
  let freeFallAt: number | null = null;
  let impactAt: number | null = null;
  let fromFreeFall = false;
  let stillSince: number | null = null;
  let lastMag: number | null = null;

  const reset = () => {
    phase = "idle";
    freeFallAt = null;
    impactAt = null;
    fromFreeFall = false;
    stillSince = null;
  };

  return {
    push(s: FallSample): FallResult {
      const mag = magnitude(s.ax, s.ay, s.az);
      const gyro = magnitude(s.gx, s.gy, s.gz);
      const prev = lastMag;
      lastMag = mag;

      // 1. free-fall entry
      if (phase === "idle" && mag < freeFallMag) {
        phase = "freefall";
        freeFallAt = s.t;
      } else if (phase === "freefall" && freeFallAt !== null && s.t - freeFallAt > windowMs) {
        phase = "idle";
        freeFallAt = null;
      }

      // 2. impact spike (needs a big |a| jump; free-fall OR violent rotation)
      if (prev !== null && (phase === "freefall" || phase === "idle")) {
        const jump = mag - prev;
        const violent = jump > accThreshold;
        if (violent && (phase === "freefall" || gyro > gyroThreshold)) {
          phase = "impact";
          impactAt = s.t;
          fromFreeFall = freeFallAt !== null && s.t - freeFallAt <= windowMs;
        }
      }

      // 3. post-impact stillness confirms the fall (a stumble recovers, a fall doesn't)
      if (phase === "impact" && impactAt !== null) {
        if (Math.abs(mag - G) < restBand && gyro < gyroThreshold / 2) {
          if (stillSince === null) stillSince = s.t;
        } else {
          stillSince = null;
        }
        if (stillSince !== null && s.t - stillSince >= stillnessMs) {
          const reason: FallResult["reason"] = fromFreeFall ? "free-fall+impact" : "impact";
          reset();
          return { fall: true, reason };
        }
        if (s.t - impactAt > windowMs) reset(); // gave up: motion resumed
      }

      return { fall: false };
    },
  };
}

// ---------------------------------------------------------------------------
// Gait: step detection + variability
// ---------------------------------------------------------------------------

export interface StepSample {
  t: number;
  ax: number;
  ay: number;
  az: number;
}

/** Vertical-acceleration proxy = |a| deviation from gravity. */
function verticalAccel(s: StepSample): number {
  return magnitude(s.ax, s.ay, s.az) - G;
}

export function detectSteps(
  samples: StepSample[],
  cfg: { minPeak?: number; minIntervalMs?: number } = {}
): number[] {
  const minPeak = cfg.minPeak ?? 2;
  const minIntervalMs = cfg.minIntervalMs ?? 250;
  const steps: number[] = [];
  let lastStepT = -Infinity;
  for (let i = 1; i < samples.length - 1; i++) {
    const sig = verticalAccel(samples[i]);
    if (sig < minPeak) continue;
    if (sig <= verticalAccel(samples[i - 1])) continue; // not a local max
    if (sig <= verticalAccel(samples[i + 1])) continue;
    if (samples[i].t - lastStepT < minIntervalMs) continue; // refractory
    steps.push(samples[i].t);
    lastStepT = samples[i].t;
  }
  return steps;
}

export function gaitVariability(stepTimestampsMs: number[]): {
  steps: number;
  cadence: number;
  cv: number;
} {
  const steps = stepTimestampsMs.length;
  if (steps < 2) return { steps, cadence: 0, cv: 0 };
  const intervals: number[] = [];
  for (let i = 1; i < steps; i++) intervals.push(stepTimestampsMs[i] - stepTimestampsMs[i - 1]);
  const m = mean(intervals);
  if (m <= 0) return { steps, cadence: 0, cv: 0 };
  const variance = mean(intervals.map((x) => (x - m) * (x - m)));
  const cv = Math.sqrt(variance) / m;
  return { steps, cadence: 60000 / m, cv };
}

// ---------------------------------------------------------------------------
// Audio: energy VAD + silence trim (feeds the 1-minute screening)
// ---------------------------------------------------------------------------

function rmsDb(frame: Float32Array | number[]): number {
  if (frame.length === 0) return -160;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  const rms = Math.sqrt(sum / frame.length);
  return 20 * Math.log10(rms + 1e-8);
}

export function energyVad(
  frames: Float32Array[] | number[],
  cfg: { thresholdDb?: number; hangoverFrames?: number } = {}
): { speech: boolean; ratio: number } {
  const thresholdDb = cfg.thresholdDb ?? -40;
  const hangoverFrames = cfg.hangoverFrames ?? 5;
  let active = 0;
  let lastLoud = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const db = typeof f === "number" ? f : rmsDb(f);
    if (db > thresholdDb) lastLoud = i;
    if (i - lastLoud <= hangoverFrames) active++;
  }
  return { speech: active > 0, ratio: frames.length === 0 ? 0 : active / frames.length };
}

export function trimSilence(
  frames: { rmsDb: number }[],
  cfg: { thresholdDb?: number; padFrames?: number } = {}
): { start: number; end: number } {
  const thresholdDb = cfg.thresholdDb ?? -40;
  const padFrames = cfg.padFrames ?? 2;
  let first = -1;
  let last = -1;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].rmsDb > thresholdDb) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return { start: 0, end: 0 };
  return {
    start: Math.max(0, first - padFrames),
    end: Math.min(frames.length - 1, last + padFrames),
  };
}

// ---------------------------------------------------------------------------
// Reminder escalation state machine
// Spec: gentle retry at 10 min, auto-push to community carer/family at 30 min.
// ---------------------------------------------------------------------------

export function escalationFor(
  elapsedMs: number,
  cfg: { retryMs?: number; escalateMs?: number } = {}
): "retry" | "notify-caregiver" | "none" {
  const retryMs = cfg.retryMs ?? 10 * 60 * 1000;
  const escalateMs = cfg.escalateMs ?? 30 * 60 * 1000;
  if (elapsedMs >= escalateMs) return "notify-caregiver";
  if (elapsedMs >= retryMs) return "retry";
  return "none";
}
// ---------------------------------------------------------------------------
// Capture quality gate (docs/dev.md §2.4 A4). The sample is still uploaded with
// its label — the backend decides what enters the baseline, so the denominator
// ("how many were captured, how many were unusable") is never lost.
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return -160;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/**
 * Frame-energy dynamic range: P90 (speech peaks) − P10 (noise floor), in dB.
 * Must be computed BEFORE silence trimming, which deletes the noise floor.
 * ponytail: a steady fan/air-con and loudness-compressed TV both have a narrow
 * range, so they score low — that is the case energy VAD alone cannot reject.
 * Ceiling: dynamic TV dialogue close to the mic can still pass. Upgrade path:
 * multiply by a Silero "is this a human voice" probability.
 */
export function snrDb(frameDbs: number[]): number {
  const s = [...frameDbs].sort((a, b) => a - b);
  return percentile(s, 0.9) - percentile(s, 0.1);
}

export type CaptureQuality = "good" | "fair" | "reject";

export const QUALITY_MIN = { speechRatio: 0.25, snrDb: 15 } as const;
export const QUALITY_GOOD = { speechRatio: 0.4, snrDb: 20 } as const;
/** Free-speech screening needs 8s; a single interview answer needs 3s. */
export const QUALITY_MIN_MS = { screening: 8000, answer: 3000 } as const;

export function qualityOf(
  s: { speechRatio: number; snrDb: number; durationMs: number },
  minMs: number = QUALITY_MIN_MS.screening
): CaptureQuality {
  if (s.speechRatio < QUALITY_MIN.speechRatio || s.snrDb < QUALITY_MIN.snrDb || s.durationMs < minMs) return "reject";
  if (s.speechRatio >= QUALITY_GOOD.speechRatio && s.snrDb >= QUALITY_GOOD.snrDb) return "good";
  return "fair";
}
