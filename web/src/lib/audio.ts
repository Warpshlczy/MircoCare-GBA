// Web Speech (TTS + STT) and Web Audio (amplitude for lip-sync). No dependencies.

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

/** Slower rate (0.85) — seniors need it. Resolves when speech ends. */
export function speak(text: string, locale: string): Promise<void> {
  if (typeof window === "undefined" || !window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = locale;
    u.rate = 0.85;
    u.pitch = 1.0;
    const v = pickVoice(locale);
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

/** Wraps SpeechRecognition with graceful failure when unsupported. Returns null then. */
export function startListening(
  locale: string,
  onResult: (text: string, isFinal: boolean) => void,
  onEnd?: () => void
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
    onResult(r[0].transcript, r.isFinal);
  };
  rec.onend = () => onEnd?.();
  rec.onerror = () => onEnd?.();
  rec.start();
  return { stop: () => rec.stop() };
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