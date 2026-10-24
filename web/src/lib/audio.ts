// Web Speech (TTS + STT) and Web Audio (amplitude for lip-sync). No dependencies.

import { FRAMES_PER_CHAR, VISEME_FRAME_MS, visemeFromText } from "./viseme";

// --- minimal SpeechRecognition typings (not in TS DOM lib yet) ---
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  readonly length: number;
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternative;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEvent {
  results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorLike {
  error?: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function srCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function sttSupported(): boolean {
  return srCtor() !== null;
}

function pickVoice(locale: string): SpeechSynthesisVoice | undefined {
  if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
  const voices = window.speechSynthesis.getVoices();
  const exact = voices.find((v) => v.lang.replace("_", "-").toLowerCase() === locale.toLowerCase());
  if (exact) return exact;
  const prefix = locale.slice(0, 2).toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
}

/**
 * Slower rate (0.85) — seniors need it. Resolves when speech ends (or is
 * cancelled). `onViseme` gets 0..1 mouth openness every frame, re-synced to the
 * engine's `onboundary` char index when the engine emits it (see viseme.ts).
 */
export function speak(text: string, locale: string, onViseme?: (v: number) => void): Promise<void> {
  if (typeof window === "undefined" || !window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    u.rate = 0.85;
    u.pitch = 1.0;
    const v = pickVoice(locale);
    if (v) u.voice = v;
    const frames = visemeFromText(text);
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearInterval(timer);
      clearTimeout(guard);
      onViseme?.(0);
      resolve();
    };
    // Some Android engines never fire `onend` for long utterances; without this
    // guard the assistant would stay "speaking" and the senior would be locked out.
    const guard = setTimeout(finish, frames.length * VISEME_FRAME_MS * 2 + 4000);
    u.onstart = () => {
      if (!onViseme || !frames.length) return;
      timer = setInterval(() => onViseme(frames[frame++ % frames.length]), VISEME_FRAME_MS);
    };
    u.onboundary = (e) => {
      frame = e.charIndex * FRAMES_PER_CHAR;
    };
    u.onend = finish;
    u.onerror = finish;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

/** Stops whatever is being said. The pending `speak()` promise resolves. */
export function cancelSpeech(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
}

/** Wraps SpeechRecognition with graceful failure when unsupported. Returns null then. */
export function startListening(
  locale: string,
  onResult: (text: string, isFinal: boolean, confidence: number) => void,
  onEnd?: (error?: string) => void
): { stop: () => void } | null {
  const Ctor = srCtor();
  if (!Ctor) {
    onEnd?.();
    return null;
  }
  const rec = new Ctor();
  rec.lang = locale === "zh-CN" ? "zh-CN" : "zh-HK";
  rec.continuous = false;
  rec.interimResults = true;
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    onResult(r[0].transcript, r.isFinal, r[0].confidence ?? 0);
  };
  rec.onend = () => onEnd?.();
  rec.onerror = (e) => onEnd?.((e as SpeechRecognitionErrorLike)?.error ?? "error");
  rec.start();
  return { stop: () => rec.stop() };
}

export interface Heard {
  /** "" when the senior stayed silent. */
  text: string;
  confidence: number;
  /** From "start listening" to the final result — the response time. */
  durationMs: number;
}

/** Errors that mean "voice cannot work here", as opposed to "nobody spoke". */
const VOICE_UNAVAILABLE = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
const MAX_ANSWER_MS = 30_000;

/**
 * One question → one answer. Resolves `{text: ""}` after `silenceMs` without
 * any speech, and `null` when voice is unavailable (no STT / mic refused) so
 * the caller can fail open to buttons instead of re-asking forever.
 */
export function listenOnce(locale: string, silenceMs: number): Promise<Heard | null> {
  if (!sttSupported()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const t0 = Date.now();
    let best = { text: "", confidence: 0 };
    let settled = false;
    let handle: { stop: () => void } | null = null;
    const settle = (out: Heard | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(silence);
      clearTimeout(cap);
      try {
        handle?.stop();
      } catch {
        /* already ended */
      }
      resolve(out);
    };
    const finish = () => settle({ ...best, durationMs: Date.now() - t0 });
    const silence = setTimeout(finish, silenceMs);
    const cap = setTimeout(finish, MAX_ANSWER_MS);
    try {
      handle = startListening(
        locale,
        (text, isFinal, confidence) => {
          clearTimeout(silence); // they started talking: don't cut them off
          best = { text: text.trim(), confidence };
          if (isFinal) finish();
        },
        (error) => (error && VOICE_UNAVAILABLE.has(error) ? settle(null) : finish())
      );
    } catch {
      settle(null); // recognizer refused to start (e.g. already busy)
    }
  });
}

/**
 * Amplitude meter → smoothed 0..1 level driving the avatar mouth.
 * ponytail: this is loudness (amplitude -> mouth openness), NOT a phoneme viseme.
 * Ceiling: mouth only opens/closes, it never shapes lips. Upgrade path: Live2D +
 * a real viseme timeline (or a wav2lip-style mouth track) keyed off the same stream.
 */
export function createAmplitudeMeter(stream: MediaStream): { getLevel: () => number; stop: () => void } {
  const Ctx =
    (typeof window !== "undefined" &&
      ((window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) ||
    null;
  if (!Ctx) return { getLevel: () => 0, stop: () => {} };
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let level = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    const target = Math.min(1, rms * 6); // scale speech RMS into 0..1
    level = level * 0.7 + target * 0.3; // smoothing
  }, 50);
  return {
    getLevel: () => level,
    stop: () => {
      clearInterval(timer);
      src.disconnect();
      void ctx.close();
      // Release the microphone: disconnecting the analyser alone leaves the
      // capture track live and keeps the OS mic indicator on.
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}

export function canPlayAudio(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Some browsers block audio until a user gesture. Call this inside a click handler. */
export async function ensureAudioUnlocked(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    if (window.speechSynthesis) {
      window.speechSynthesis.getVoices();
      const u = new SpeechSynthesisUtterance("");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch {
    /* best effort */
  }
}

/**
 * Foreground-only wake-word listener: continuously recognizes speech and fires
 * `onWake` the first time one of `names` appears.
 *
 * ponytail: browsers SUSPEND JS + the microphone when the app is backgrounded or
 * the screen locks, so a wake name can only be heard while the app is in the
 * foreground. Always-on wake needs a native background audio service — the seam
 * is lib/native.ts. This auto-restarts on end (browsers stop after silence) but
 * gives up on error (e.g. permission denied) to avoid a restart storm.
 */
export function startWakeWord(
  locale: string,
  names: string[],
  onWake: (heard: string) => void
): { stop: () => void } | null {
  const Ctor = srCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = locale === "zh-CN" ? "zh-CN" : "zh-HK";
  rec.continuous = true;
  rec.interimResults = true;
  const needles = names.map((n) => n.toLowerCase());
  let stopped = false;

  rec.onresult = (e) => {
    const last = e.results[e.results.length - 1];
    const text = (last?.[0]?.transcript ?? "").toLowerCase();
    if (needles.some((n) => text.includes(n))) {
      stopped = true;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      onWake(text);
    }
  };
  rec.onend = () => {
    if (stopped) return;
    setTimeout(() => {
      if (stopped) return;
      try {
        rec.start();
      } catch {
        stopped = true;
      }
    }, 300);
  };
  rec.onerror = () => {
    stopped = true;
  };

  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    stop: () => {
      stopped = true;
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    },
  };
}