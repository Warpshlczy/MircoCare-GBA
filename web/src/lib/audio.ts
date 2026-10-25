// TTS (native AuraNative.speak first, Web Speech fallback), STT, and Web Audio
// amplitude for the mic meter. No dependencies.

import { FRAMES_PER_CHAR, VISEME_FRAME_MS, visemeFromText } from "./viseme";
import { bridge, nativeAvailable } from "./native";
import type { VoicePreset, VoiceProfile } from "./native";
import { transcribeAudio } from "./api";
import type { Locale } from "./types";

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
  /** Stops without waiting for a final result — and releases the mic at once. */
  abort?(): void;
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

/**
 * Which recognizer to use. The Android shell also exposes Web Speech, but the
 * handset forwards it to the system ASR engine (cloud-backed on this ROM), so
 * inside the app we always take the on-box Whisper route instead. Plain
 * browsers keep Web Speech.
 */
export function usesBackendStt(): boolean {
  return nativeAvailable() || !sttSupported();
}

/** Voices that read younger/higher; used only to break ties within a locale. */
const YOUNG_VOICE = /child|kid|girl|female|woman|xiaoxiao|xiaoyi|huihui|tingting|yaoyao/i;

function pickVoice(locale: string): SpeechSynthesisVoice | undefined {
  if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
  const voices = window.speechSynthesis.getVoices();
  const wanted = locale.replace("_", "-").toLowerCase();
  const exact = voices.filter((v) => v.lang.replace("_", "-").toLowerCase() === wanted);
  const prefix = locale.slice(0, 2).toLowerCase();
  const candidates = exact.length ? exact : voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
  return candidates.find((v) => YOUNG_VOICE.test(v.name)) ?? candidates[0];
}

/**
 * The digital human is a small boy. On the handset the bundled neural voice
 * carries the timbre and the `preset` carries the tone; these pitch/rate values
 * are the Web Speech fallback, where pitch is the only portable timbre knob
 * (Android TextToSpeech clamps it to 0.5–2.0; Web Speech accepts 0–2).
 */
export const BOY_VOICE: VoiceProfile = { pitch: 1.35, rate: 0.9 };

/**
 * Web Speech cannot change tone, only pitch and rate. Mirrors NeuralTts.Preset
 * so a line sounds like the same character whichever engine speaks it.
 */
const PRESET_VOICE: Record<VoicePreset, VoiceProfile> = {
  warm: BOY_VOICE,
  gentle: { pitch: 1.3, rate: 0.84 },
  cheerful: { pitch: 1.45, rate: 1.02 },
  urgent: { pitch: 1.28, rate: 1.05 },
};

/** viseme frames are calibrated at rate 0.85; other rates stretch the timeline. */
function frameMsFor(rate: number): number {
  return Math.round(VISEME_FRAME_MS * (0.85 / (rate > 0 ? rate : 0.85)));
}

/**
 * Speaks one line and resolves when it ends (or is cancelled). `onViseme` gets
 * 0..1 mouth openness every frame, re-synced to the engine's `onboundary` char
 * index when the engine emits it (see viseme.ts).
 *
 * Native TTS is tried first on the Android shell: Web Speech inside a WebView is
 * frequently voice-less, and it cannot promise a Cantonese voice. When the
 * native engine reports "no engine/voice", we fall back to Web Speech with the
 * same BOY_VOICE, so the PWA demo keeps working.
 */
export function speak(
  text: string,
  locale: string,
  onViseme?: (v: number) => void,
  preset: VoicePreset = "warm"
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const voice = PRESET_VOICE[preset] ?? BOY_VOICE;
    const frames = visemeFromText(text);
    const frameMs = frameMsFor(voice.rate);
    let frame = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    let guard: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const startMouth = () => {
      if (!onViseme || !frames.length || timer !== null) return;
      onViseme(frames[frame++ % frames.length]);
      timer = setInterval(() => onViseme(frames[frame++ % frames.length]), frameMs);
    };
    const stopMouth = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      onViseme?.(0);
    };
    const finish = () => {
      if (done) return;
      done = true;
      stopMouth();
      if (guard !== null) clearTimeout(guard);
      resolve();
    };
    // Some Android engines never fire `onend` for long utterances; without this
    // guard the assistant would stay "speaking" and the senior would be locked out.
    guard = setTimeout(finish, frames.length * frameMs * 2 + 4000);

    const webSpeak = () => {
      if (!window.speechSynthesis) {
        finish();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = locale;
      u.rate = voice.rate;
      u.pitch = voice.pitch;
      const v = pickVoice(locale);
      if (v) u.voice = v;
      u.onstart = startMouth;
      u.onboundary = (e) => {
        frame = e.charIndex * FRAMES_PER_CHAR;
      };
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    };

    const native = bridge();
    if (!native) {
      webSpeak();
      return;
    }
    // The native call resolves only when the utterance finishes (or is stopped),
    // so the mouth timeline runs while we wait.
    startMouth();
    void native
      .speak(text, locale, voice)
      .then((r) => {
        if (done) return;
        if (r.ok || r.stopped) {
          finish();
          return;
        }
        stopMouth();
        frame = 0;
        webSpeak();
      })
      .catch(() => {
        if (done) return;
        stopMouth();
        frame = 0;
        webSpeak();
      });
  });
}

/** Stops whatever is being said. The pending `speak()` promise resolves. */
export function cancelSpeech(): void {
  if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  void bridge()?.stopSpeak().catch(() => {});
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
  return { stop: () => releaseRecognizer(rec) };
}

// --- microphone handover ---------------------------------------------------
// The continuous wake recognizer and the recorder share one hardware input.
// `stop()` may keep the input open until the engine finishes its final result,
// so starting MediaRecorder right after it used to fail with NotReadableError
// (or capture pure silence). `abort()` releases at once; the short grace window
// covers engines that do not implement it.
const MIC_HANDOVER_MS = 220;
let micReleasedAt = 0;

function releaseRecognizer(rec: SpeechRecognitionLike): void {
  try {
    if (rec.abort) rec.abort();
    else rec.stop();
  } catch {
    /* already stopped */
  }
  micReleasedAt = Date.now();
}

async function waitForMicHandover(): Promise<void> {
  const wait = MIC_HANDOVER_MS - (Date.now() - micReleasedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface Heard {
  /** "" when the senior stayed silent. */
  text: string;
  confidence: number;
  /** From "start listening" to the final result — the response time. */
  durationMs: number;
  /** Loudness 0..1 of the clip; only the backend-ASR path reports it. */
  peak?: number;
}

/** Errors that mean "voice cannot work here", as opposed to "nobody spoke". */
const VOICE_UNAVAILABLE = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);
const MAX_ANSWER_MS = 30_000;
/** RMS above this counts as speech (mic float samples, 0..1). */
const SPEECH_RMS = 0.02;

function audioCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Raw mono 16-bit WAV — the backend decodes this with the stdlib `wave` module. */
function encodeWav16k(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** MediaRecorder container (webm/opus on Android) -> mono 16 kHz WAV. */
async function toWav16k(blob: Blob): Promise<Blob | null> {
  const Ctx = audioCtor();
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
    }
    const target = 16_000;
    if (decoded.sampleRate === target) return encodeWav16k(mono, target);
    const ratio = decoded.sampleRate / target;
    const n = Math.floor(mono.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = mono[i0] ?? 0;
      const b = mono[i0 + 1] ?? a;
      out[i] = a + (b - a) * frac;
    }
    return encodeWav16k(out, target);
  } catch {
    return null;
  } finally {
    void ctx.close();
  }
}

export interface Recording {
  blob: Blob;
  /** Loudness 0..1 seen by the analyser; 0 when the analyser could not run. */
  peak: number;
  /**
   * `false` = the analyser positively saw no speech (skip the upload).
   * `null` = no working analyser, so silence could not be ruled out — the clip
   * must still be transcribed instead of being thrown away.
   */
  heardSpeech: boolean | null;
  durationMs: number;
}

/** getUserMedia with a short retry: the previous mic owner may still be letting go. */
async function openMic(): Promise<MediaStream | null> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  await waitForMicHandover();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      const busy = name === "NotReadableError" || name === "TrackStartError" || name === "AbortError";
      if (!busy || attempt === 2) return null;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 180 : 430));
    }
  }
  return null;
}

/**
 * Records one utterance and stops on end-of-speech (or the cap).
 *
 * - `silenceMs` : how much silence *after speech* ends the clip.
 * - `maxMs`     : hard cap for a long answer.
 * - `noSpeechMs`: how long to wait for the first word before giving up.
 *
 * Returns `null` ONLY when the microphone itself cannot be used. A silent clip
 * is a successful recording with `heardSpeech: false`, because "nobody spoke"
 * and "voice is broken" need completely different responses.
 */
export async function recordUtterance(
  silenceMs: number,
  maxMs: number,
  noSpeechMs: number = Math.min(8_000, maxMs)
): Promise<Recording | null> {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  const stream = await openMic();
  if (!stream) return null;
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m));
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }

  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  // A context created without a user gesture (wake-word path) starts "suspended"
  // and reports all-zero samples. That used to read as "nobody spoke", so a real
  // question was dropped. Resume first and, if it still won't run, record without
  // the gate instead of trusting a dead analyser.
  const Ctx = audioCtor();
  const ctx = Ctx ? new Ctx() : null;
  let vadLive = false;
  if (ctx) {
    try {
      if (ctx.state === "suspended") {
        await Promise.race([ctx.resume().catch(() => undefined), new Promise((r) => setTimeout(r, 400))]);
      }
      vadLive = ctx.state === "running";
    } catch {
      vadLive = false;
    }
  }
  const analyser = vadLive && ctx ? ctx.createAnalyser() : null;
  if (ctx && analyser) {
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
  }
  const buf = new Float32Array(analyser?.fftSize ?? 1024);
  let peak = 0;
  let spoke = false;
  let lastVoice = Date.now();
  const t0 = Date.now();

  const done = new Promise<Recording | null>((resolve) => {
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (ctx) void ctx.close();
      const durationMs = Date.now() - t0;
      if (!chunks.length) {
        resolve(null);
        return;
      }
      const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
      void toWav16k(blob).then((wav) =>
        resolve(wav ? { blob: wav, peak, heardSpeech: vadLive ? spoke : null, durationMs } : null)
      );
    };
  });

  try {
    rec.start();
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) void ctx.close();
    return null;
  }
  const timer = window.setInterval(() => {
    let rms = 0;
    if (analyser) {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      rms = Math.sqrt(sum / buf.length);
      if (rms > peak) peak = rms;
    }
    const now = Date.now();
    if (rms > SPEECH_RMS) {
      spoke = true;
      lastVoice = now;
    }
    const ended = spoke && now - lastVoice > silenceMs;
    // The first-word budget is the caller's answer budget, never a magic 6 s:
    // a slow senior pausing before the first word is not a broken microphone.
    const noSpeech = !spoke && now - t0 > noSpeechMs;
    const tooLong = now - t0 > maxMs;
    if (ended || noSpeech || tooLong) {
      window.clearInterval(timer);
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, 100);

  return done;
}

/**
 * No Web Speech here (Android WebView): record a clip and let the on-box
 * Whisper transcribe it via `/asr/transcribe`. Audio stays on the local network,
 * so the senior's speech never reaches a third-party cloud ASR.
 */
async function listenOnceBackend(locale: string, silenceMs: number): Promise<Heard | null> {
  const t0 = Date.now();
  // 1.5 s of trailing silence ends the clip; `silenceMs` is the first-word
  // budget (ANSWER_TIMEOUT_MS), not an end-of-speech window.
  const clip = await recordUtterance(1_500, Math.max(15_000, silenceMs + 7_000), silenceMs);
  if (!clip) return null; // mic refused -> caller fails open to buttons
  if (clip.heardSpeech === false) {
    return { text: "", confidence: 0, durationMs: Date.now() - t0, peak: clip.peak };
  }
  try {
    const r = await transcribeAudio(clip.blob, locale as Locale);
    return { text: (r.text ?? "").trim(), confidence: r.confidence ?? 0, durationMs: Date.now() - t0, peak: clip.peak };
  } catch {
    // One quick retry covers a hiccup, but a 30 s ASR timeout must not become a
    // 60 s "thinking" freeze for the senior — only retry a fast failure.
    if (Date.now() - t0 > 8_000) {
      return { text: "", confidence: 0, durationMs: Date.now() - t0, peak: clip.peak };
    }
  }
  try {
    const r = await transcribeAudio(clip.blob, locale as Locale);
    return { text: (r.text ?? "").trim(), confidence: r.confidence ?? 0, durationMs: Date.now() - t0, peak: clip.peak };
  } catch {
    // backend unreachable: report "nothing heard" instead of looping silently
    return { text: "", confidence: 0, durationMs: Date.now() - t0, peak: clip.peak };
  }
}

/**
 * One question → one answer. Resolves `{text: ""}` after `silenceMs` without
 * any speech, and `null` when voice is unavailable (no STT / mic refused) so
 * the caller can fail open to buttons instead of re-asking forever.
 */
export function listenOnce(locale: string, silenceMs: number): Promise<Heard | null> {
  // The Android shell goes to the on-box Whisper (see usesBackendStt): the
  // WebView's Web Speech would hand the audio to the handset's cloud ASR.
  if (usesBackendStt()) return listenOnceBackend(locale, silenceMs);
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
  if (typeof window === "undefined") return false;
  // The Android shell can speak even when the WebView has no speechSynthesis.
  return "speechSynthesis" in window || nativeAvailable();
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
      releaseRecognizer(rec); // hand the mic over before we start recording
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
      releaseRecognizer(rec);
    },
  };
}