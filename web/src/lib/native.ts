// native.ts — the ONE seam a native shell plugs into (Capacitor / React Native).
//
// Why this exists (honest platform ceilings of a web page):
//   (a) it cannot hear a wake word while backgrounded/locked,
//   (b) it cannot bring itself to the foreground,
//   (c) it cannot place cards on the OS home screen,
//   (d) a page timer is suspended in the background, so "wake me at 8am" needs
//       an OS alarm.
// A thin native shell can do all four. Everything below is a NO-OP on the web —
// the shell injects the `AuraNative` Capacitor plugin (or `window.__AuraNative`)
// and these calls start working.
//
// Every method degrades to a safe value when the shell is older/missing, so
// callers never need to feature-detect individually.

import type { AgentCard, CircadianDaily, ReminderItem } from "./types";

export interface HomeWidgetPayload {
  updatedAt: number;
  title: string;
  items: { text: string; done: boolean }[];
  topCard?: { kind: string; headline: string };
}

/** Why the app was brought forward — decides what the assistant says first. */
export type ForegroundReason = "widget" | "alarm" | "reminder" | "notification" | "boot";

export const FOREGROUND_REASONS: readonly ForegroundReason[] = [
  "widget",
  "alarm",
  "reminder",
  "notification",
  "boot",
] as const;

export interface NativeLocation {
  lat: number;
  lng: number;
  /** horizontal accuracy in metres */
  accuracy: number;
  at: number;
}

export interface ForegroundEvent {
  reason: ForegroundReason;
  at: number;
}

/** TTS timbre knobs, passed through unchanged to Android TextToSpeech. */
export interface VoiceProfile {
  /** 1.0 = engine default; >1 is higher/smaller. Android clamps at 2.0. */
  pitch: number;
  /** 1.0 = engine default; <1 is slower. */
  rate: number;
}

export interface NativeSpeechResult {
  ok: boolean;
  /** intentionally cancelled (barge-in) — the caller must NOT fall back */
  stopped?: boolean;
  reason?: string;
}

export interface AuraNativeBridge {
  startBackgroundWake(): Promise<boolean>;
  stopBackgroundWake(): Promise<void>;
  updateHomeWidget(p: HomeWidgetPayload): Promise<void>;
  /** `reason` reaches the WebView so the greeting matches the trigger. */
  bringToForeground(reason?: ForegroundReason): Promise<boolean>;
  /** Repeats every day; resolves false when the OS refused to schedule. */
  scheduleDaily(hour: number, minute: number): Promise<boolean>;
  cancelDaily(): Promise<void>;
  /** one-shot alarm at an absolute time; false when the OS refused it */
  scheduleOnce(atMs: number, label?: string): Promise<boolean>;
  cancelOnce(): Promise<void>;
  /**
   * Starts the screen/unlock/charging rollup. No permission needed, no JS timer:
   * SCREEN_ON/OFF are protected broadcasts a WebView cannot see once the screen
   * is off. Resolves false in a browser.
   */
  startCircadian(): Promise<boolean>;
  /** One day's rollup, or null when nothing was observed (NOT zeros). */
  getCircadian(day: string): Promise<CircadianDaily | null>;
  /** Opens the dialler prefilled. The call itself stays the senior's choice. */
  dial(phone: string): Promise<boolean>;
  /** Launches one whitelisted app ('wechat' | 'phone' | 'camera' | 'settings'). */
  openApp(key: string): Promise<boolean>;
  /** Foreground-only, last known fix. Resolves null when unavailable/denied. */
  getLocation(): Promise<NativeLocation | null>;
  /**
   * Native TTS. Resolves `ok:false` when the device has no engine/voice for the
   * locale — the caller then falls back to Web Speech. `stopped` is a barge-in,
   * not a failure, so the caller must not retry.
   */
  speak(text: string, locale: string, voice: VoiceProfile): Promise<NativeSpeechResult>;
  stopSpeak(): Promise<void>;
  /** Opens the system accessibility list so the senior's family can enable it.
   *  An accessibility service can NEVER be enabled programmatically. */
  openAccessibilitySettings(): Promise<boolean>;
  /**
   * Drains a launch reason that was buffered before the WebView had a listener
   * (cold start from a widget tap / alarm tap). Resolves null when none.
   * Not a capability — it exists so a cold start is not silently reason-less.
   */
  consumePendingReason(): Promise<ForegroundEvent | null>;
}

export function nativeAvailable(): boolean {
  return typeof window !== "undefined" && ("__AuraNative" in window || capacitorPlugin() !== null);
}

/** The Capacitor-registered `AuraNative` plugin, if the app runs inside the shell. */
function capacitorPlugin(): AuraNativePlugin | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, AuraNativePlugin> } }).Capacitor;
  return cap?.Plugins?.AuraNative ?? null;
}

/** The raw shape of the plugin methods (Capacitor returns a promise per call). */
interface AuraNativePlugin {
  startBackgroundWake(): Promise<{ started?: boolean }>;
  stopBackgroundWake(): Promise<void>;
  updateHomeWidget(p: HomeWidgetPayload): Promise<void>;
  bringToForeground(o?: { reason?: ForegroundReason }): Promise<{ ok?: boolean }>;
  scheduleDaily(o: { hour: number; minute: number }): Promise<{ ok?: boolean; exact?: boolean }>;
  cancelDaily(): Promise<void>;
  scheduleOnce(o: { at: number; label?: string }): Promise<{ ok?: boolean; exact?: boolean }>;
  cancelOnce(): Promise<void>;
  circadianStart(): Promise<{ ok?: boolean }>;
  getCircadian(o: { day: string }): Promise<Partial<CircadianDaily> | void>;
  dial(o: { phone: string }): Promise<{ ok?: boolean }>;
  openApp(o: { app: string }): Promise<{ ok?: boolean }>;
  getLocation(): Promise<Partial<NativeLocation> | void>;
  speak(o: { text: string; locale: string; pitch: number; rate: number }): Promise<
    { ok?: boolean; stopped?: boolean; reason?: string } | void
  >;
  stopSpeak(): Promise<void>;
  openAccessibilitySettings(): Promise<{ ok?: boolean }>;
  consumePendingReason(): Promise<{ reason?: string; at?: number; sos?: boolean } | void>;
  addListener?(
    event: string,
    cb: (data: ForegroundEvent) => void
  ): Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
}

/**
 * Fills in every method so a shell that predates (say) `scheduleDaily` behaves
 * exactly like the web: the call resolves to its safe value instead of throwing.
 */
function withDefaults(src: Partial<AuraNativeBridge>): AuraNativeBridge {
  return {
    startBackgroundWake: () =>
      Promise.resolve(src.startBackgroundWake?.()).then((v) => !!v).catch(() => false),
    stopBackgroundWake: () =>
      Promise.resolve(src.stopBackgroundWake?.()).then(() => undefined).catch(() => undefined),
    updateHomeWidget: (p) =>
      Promise.resolve(src.updateHomeWidget?.(p)).then(() => undefined).catch(() => undefined),
    bringToForeground: (reason) =>
      Promise.resolve(src.bringToForeground?.(reason)).then((v) => !!v).catch(() => false),
    scheduleDaily: (hour, minute) =>
      Promise.resolve(src.scheduleDaily?.(hour, minute)).then((v) => !!v).catch(() => false),
    cancelDaily: () =>
      Promise.resolve(src.cancelDaily?.()).then(() => undefined).catch(() => undefined),
    // A browser has no AlarmManager: report false rather than pretend an alarm
    // is armed. The executor then says "我設唔到鬧鐘" instead of lying.
    scheduleOnce: () => Promise.resolve(false),
    cancelOnce: () => Promise.resolve(),
    startCircadian: () => Promise.resolve(false),
    getCircadian: () => Promise.resolve(null),
    dial: () => Promise.resolve(false),
    openApp: () => Promise.resolve(false),
    getLocation: () =>
      Promise.resolve(src.getLocation?.())
        .then((r) => (r && typeof r.lat === "number" ? (r as NativeLocation) : null))
        .catch(() => null),
    // A browser has no native engine: report "cannot", and audio.ts falls back
    // to Web Speech. Never throw — a missing voice must not break a reminder.
    speak: (text, locale, voice) =>
      Promise.resolve(src.speak?.(text, locale, voice))
        .then((r) => ({ ok: !!r?.ok, stopped: !!r?.stopped, reason: r?.reason }))
        .catch(() => ({ ok: false })),
    stopSpeak: () =>
      Promise.resolve(src.stopSpeak?.()).then(() => undefined).catch(() => undefined),
    openAccessibilitySettings: () =>
      Promise.resolve(src.openAccessibilitySettings?.()).then((v) => !!v).catch(() => false),
    consumePendingReason: () =>
      Promise.resolve(src.consumePendingReason?.())
        .then((r) => (r && typeof r.reason === "string"
          ? { reason: r.reason as ForegroundReason, at: r.at ?? Date.now() }
          : null))
        .catch(() => null),
  };
}

/**
 * Returns the native bridge, or null on the plain web. Two sources, same shape:
 *   1. `window.__AuraNative` — anything that injects it (a WebView, a test stub);
 *   2. the Capacitor `AuraNative` plugin — the Android shell's own implementation.
 * Callers must null-check.
 */
export function bridge(): AuraNativeBridge | null {
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as { __AuraNative?: Partial<AuraNativeBridge> }).__AuraNative;
  if (injected) return withDefaults(injected);

  const p = capacitorPlugin();
  if (!p) return null;
  return withDefaults({
    startBackgroundWake: () => p.startBackgroundWake().then((r) => !!r?.started),
    stopBackgroundWake: () => p.stopBackgroundWake(),
    updateHomeWidget: (payload) => p.updateHomeWidget(payload),
    bringToForeground: (reason) => p.bringToForeground({ reason }).then((r) => !!r?.ok),
    // The plugin takes one options object, so wrap the two positional args.
    scheduleDaily: (hour, minute) => p.scheduleDaily({ hour, minute }).then((r) => !!r?.ok),
    cancelDaily: () => p.cancelDaily(),
    scheduleOnce: (atMs, label) => p.scheduleOnce({ at: atMs, label }).then((r) => !!r?.ok),
    cancelOnce: () => p.cancelOnce(),
    startCircadian: () => p.circadianStart().then((r) => !!r?.ok),
    dial: (phone) => p.dial({ phone }).then((r) => !!r?.ok),
    openApp: (key) => p.openApp({ app: key }).then((r) => !!r?.ok),
    getCircadian: async (day) => {
      const r = await p.getCircadian({ day });
      // Empty object = nothing observed that day; the caller must omit the row.
      return r && typeof r.firstActiveAt === "number" ? ({ ...r, day } as CircadianDaily) : null;
    },
    getLocation: async () => {
      const r = await p.getLocation();
      return r && typeof r.lat === "number" ? (r as NativeLocation) : null;
    },
    speak: async (text, locale, voice) => {
      const r = await p.speak({ text, locale, pitch: voice.pitch, rate: voice.rate });
      return { ok: !!r?.ok, stopped: !!r?.stopped, reason: r?.reason };
    },
    stopSpeak: () => p.stopSpeak(),
    openAccessibilitySettings: () => p.openAccessibilitySettings().then((r) => !!r?.ok),
    consumePendingReason: async () => {
      const r = await p.consumePendingReason();
      return r && typeof r.reason === "string"
        ? { reason: r.reason as ForegroundReason, at: r.at ?? Date.now() }
        : null;
    },
  });
}

/**
 * Subscribes to "the shell brought us forward, here's why".
 * Returns an unsubscribe function that is always safe to call.
 *
 * Sources, in order: the Capacitor plugin's `foreground` listener, then a DOM
 * event named `memomate:foreground` (what the injected stub / older shells use).
 */
export function onForeground(cb: (e: ForegroundEvent) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const unsubscribe = subscribeForeground(cb);

  // Cold start: a widget tap / alarm may have fired before this listener bound.
  const b = bridge();
  if (b) {
    void b
      .consumePendingReason()
      .then((pending) => {
        if (pending) cb(pending);
      })
      .catch(() => {});
  }

  return unsubscribe;
}

function subscribeForeground(cb: (e: ForegroundEvent) => void): () => void {
  const p = capacitorPlugin();
  if (p?.addListener) {
    let removed = false;
    const handle = p.addListener("foreground", (data) => {
      if (data && typeof data.reason === "string") cb(data);
    });
    return () => {
      if (removed) return;
      removed = true;
      void Promise.resolve(handle)
        .then((h) => h?.remove?.())
        .catch(() => {});
    };
  }

  // DOM path: MainActivity.triggerWindowJSEvent("memomate:foreground", json).
  // Capacitor inlines the JSON as an object literal, but a plain stub may pass a
  // string, so accept both.
  const handler = (e: Event) => {
    const raw = (e as CustomEvent<unknown>).detail;
    let detail: Partial<ForegroundEvent> | null = null;
    if (typeof raw === "string") {
      try {
        detail = JSON.parse(raw) as Partial<ForegroundEvent>;
      } catch {
        detail = null;
      }
    } else if (raw && typeof raw === "object") {
      detail = raw as Partial<ForegroundEvent>;
    }
    if (detail && typeof detail.reason === "string") {
      cb({ reason: detail.reason as ForegroundReason, at: detail.at ?? Date.now() });
    }
  };
  window.addEventListener("memomate:foreground", handler);
  return () => window.removeEventListener("memomate:foreground", handler);
}

/**
 * Builds the payload an OS home-screen widget renders. PURE (tested in
 * src/selfcheck.ts) so the shell and the web agree on one shape.
 *
 * `title` is displayed by the widget; the widget layout falls back to
 * `@string/app_name` when it is empty, so a future rename only touches strings.
 */
export function homeWidgetPayload(
  cards: AgentCard[],
  reminders: ReminderItem[],
  now = Date.now(),
  title = "忆伴"
): HomeWidgetPayload {
  const top = cards[0];
  return {
    updatedAt: now,
    title,
    items: reminders
      .filter((r) => r.status === "pending" || r.status === "taken")
      .slice(0, 4)
      .map((r) => ({ text: r.med?.name ?? r.title, done: r.status === "taken" })),
    topCard: top ? { kind: top.kind, headline: top.data?.headline ?? top.title } : undefined,
  };
}
