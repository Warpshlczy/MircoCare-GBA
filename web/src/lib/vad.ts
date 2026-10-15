// Browser glue: AnalyserNode -> energy VAD (signal.ts) on a timer.
//
// ponytail: energy-threshold VAD is the cheap ceiling — it misses soft/low-pitched
// speech and trips on background noise (fans, TV). The reference implementation in
// research (browser-vad / vad-recorder) runs Silero VAD via ONNX (@ricky0123/vad-web
// or @huggingface/transformers + onnxruntime-web). Upgrade path: swap createVad's
// internals for a Silero worker and keep the exact same {isSpeech, ratio} contract.

import { energyVad, trimSilence } from "./signal";
import type { ScreeningSession } from "./types";

function audioCtxCtor(): typeof AudioContext {
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) throw new Error("AudioContext unsupported");
  return Ctx;
}

function dbFromSamples(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  return 20 * Math.log10(rms + 1e-8);
}

export interface VadCfg {
  thresholdDb?: number;
  hangoverFrames?: number;
  intervalMs?: number;
}

export interface VadHandle {
  isSpeech(): boolean;
  ratio(): number;
  stop(): void;
}

export function createVad(stream: MediaStream, cfg: VadCfg = {}): VadHandle {
  const intervalMs = cfg.intervalMs ?? 100;
  const Ctx = audioCtxCtor();
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const frames: Float32Array[] = [];
  let state = { speech: false, ratio: 0 };
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    frames.push(new Float32Array(buf));
    if (frames.length > 50) frames.shift(); // ~5s rolling window
    state = energyVad(frames, { thresholdDb: cfg.thresholdDb, hangoverFrames: cfg.hangoverFrames });
  }, intervalMs);
  return {
    isSpeech: () => state.speech,
    ratio: () => state.ratio,
    stop: () => {
      clearInterval(timer);
      src.disconnect();
      void ctx.close();
    },
  };
}

/** Records a screening session and returns DERIVED FEATURES ONLY. No raw audio leaves the device. */
export async function recordScreening(
  durationMs: number,
  onFrame?: (frame: { rmsDb: number }) => void
): Promise<ScreeningSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const Ctx = audioCtxCtor();
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const frames: { rmsDb: number }[] = [];
  const startedAt = Date.now();

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      const frame = { rmsDb: dbFromSamples(buf) };
      frames.push(frame);
      onFrame?.(frame);
      if (Date.now() - startedAt >= durationMs) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });

  src.disconnect();
  void ctx.close();
  stream.getTracks().forEach((tr) => tr.stop());

  const { start, end } = trimSilence(frames);
  const kept = frames.slice(start, end + 1);
  const vad = energyVad(kept.map((f) => f.rmsDb));
  const dbs = kept.map((f) => f.rmsDb);
  return {
    id: `scr-${startedAt}`,
    startedAt,
    durationMs: Date.now() - startedAt,
    speechRatio: vad.ratio,
    trimmedStartMs: start * 100,
    trimmedEndMs: end * 100,
    features: {
      frameCount: kept.length,
      meanRmsDb: dbs.reduce((a, b) => a + b, 0) / (dbs.length || 1),
      maxRmsDb: dbs.reduce((a, b) => Math.max(a, b), -160),
    },
  };
}