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

import type { AgentCard, CircadianDaily, DigitalSkillDaily, RecordEntry, ReminderItem } from "./types";

export interface HomeWidgetPayload {
  updatedAt: number;
  title: string;
  items: { text: string; done: boolean }[];
  topCard?: { kind: string; headline: string };
  /**
   * The last thing he *already did* today ("💊 08:12 食藥"). Rendered as its own
   * tappable row above the pending items, because "what is left to do" and
   * "what I have done" are two different questions for a forgetful person —
   * seeing the tick is what stops him taking a second dose.
   */
  record?: { text: string; at: number };
}

/**
 * Why the app was brought forward — decides what the assistant says first.
 *
 * `wake` is the odd one: nothing was "brought forward", the page was already in
 * front and the senior said the assistant's name WHILE it was talking. It exists
 * so the background listener has a way to interrupt a live reply instead of
 * relaunching the activity (which is what killed the listener before
 * 2026-10-25 — see WakeNames.java).
 */
export type ForegroundReason = "widget" | "alarm" | "reminder" | "notification" | "boot" | "wake";

export const FOREGROUND_REASONS: readonly ForegroundReason[] = [
  "widget",
  "alarm",
  "reminder",
  "notification",
  "boot",
  "wake",
] as const;

/**
 * A short-lived deep link carried alongside the reason: "open this for me".
 * `record` = the "今日記錄" card (the widget's record row). Deliberately a
 * closed set — an intent extra that names an arbitrary screen is an attack
 * surface on a locked phone (MainActivity is `showWhenLocked`).
 */
export type WidgetOpenTarget = "record";

export const WIDGET_OPEN_TARGETS: readonly WidgetOpenTarget[] = ["record"] as const;

const OPEN_TARGET_SET: ReadonlySet<string> = new Set<string>(WIDGET_OPEN_TARGETS);

/**
 * Validates the deep-link extra. An unknown value is DROPPED rather than passed
 * through: the shell's intent extras are an input from outside the app, and a
 * string that reaches a router unchecked is how a locked phone gets navigated
 * to a screen nobody chose.
 */
function asOpenTarget(v: unknown): WidgetOpenTarget | undefined {
  return typeof v === "string" && OPEN_TARGET_SET.has(v) ? (v as WidgetOpenTarget) : undefined;
}

/**
 * One armed one-shot alarm, as the OS holds it.
 *
 * `slot` is the identity: it is the record id (`rec-alarm-<dueAt>`) on this
 * device, and the shell derives its PendingIntent request code from it. Two
 * alarms at two different times are two slots and coexist — an earlier build
 * had ONE fixed request code, so a second 「叫我九點」 silently replaced the
 * first while the record store still listed both.
 */
export interface ArmedOnce {
  at: number;
  label: string;
  /** absent only on a shell older than multi-slot support */
  slot?: string;
}

/** What the shell's AlarmManager currently holds (see AlarmScheduler.java). */
export interface ScheduledAlarms {
  daily: { hour: number; minute: number; exact: boolean } | null;
  /** every armed one-shot, soonest first. Empty = nothing armed. */
  once: ArmedOnce[];
}

/**
 * One normaliser for the raw plugin shape: absent keys become `null`/`[]`.
 *
 * Accepts `once` as an ARRAY (current shell) or a single object (an older shell,
 * and the injected stub used by tests). Reading it as "some or one" is what lets
 * the web build and a not-yet-updated APK share this file.
 */
function normalizeAlarms(
  r:
    | {
        daily?: { hour?: number; minute?: number; exact?: boolean } | null;
        once?: { at?: number; label?: string; slot?: string } | { at?: number; label?: string; slot?: string }[] | null;
      }
    | void
): ScheduledAlarms {
  const raw = r?.once;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const once: ArmedOnce[] = [];
  for (const item of list) {
    if (!item || typeof item.at !== "number") continue;
    const entry: ArmedOnce = { at: item.at, label: typeof item.label === "string" ? item.label : "" };
    if (typeof item.slot === "string" && item.slot) entry.slot = item.slot;
    once.push(entry);
  }
  once.sort((a, b) => a.at - b.at);
  return {
    daily:
      r?.daily && typeof r.daily.hour === "number"
        ? { hour: r.daily.hour, minute: r.daily.minute ?? 0, exact: !!r.daily.exact }
        : null,
    once,
  };
}

/** One place that turns a raw bridge payload into a ForegroundEvent. */
function asForegroundEvent(
  r: { reason?: unknown; at?: unknown; open?: unknown } | null | void
): ForegroundEvent | null {
  if (!r || typeof r.reason !== "string") return null;
  const ev: ForegroundEvent = {
    reason: r.reason as ForegroundReason,
    at: typeof r.at === "number" ? r.at : Date.now(),
  };
  const open = asOpenTarget(r.open);
  if (open) ev.open = open;
  return ev;
}

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
  /** The widget row that was tapped, when there was one. */
  open?: WidgetOpenTarget;
}

/** What the shell's AlarmManager currently holds (see AlarmScheduler.java). */

/** Tone presets understood by the on-box neural voice (NeuralTts.java). */
export type VoicePreset = "warm" | "gentle" | "cheerful" | "urgent";

/** TTS timbre knobs, passed through unchanged to Android TextToSpeech. */
export interface VoiceProfile {
  /** 1.0 = engine default; >1 is higher/smaller. Android clamps at 2.0. */
  pitch: number;
  /** 1.0 = engine default; <1 is slower. */
  rate: number;
  /** Which tone to speak with; the neural voice honours it fully. */
  preset?: VoicePreset;
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
  /**
   * One-shot alarm at an absolute time; false when the OS refused it.
   *
   * `slot` names WHICH alarm this is (the record id). It is required when the
   * caller wants several alarms to coexist: the shell derives the PendingIntent
   * request code from it, so two different slots are two independent alarms.
   * Omitting it falls back to the legacy single slot, which is only correct for
   * a caller that can hold one alarm — the executor never does.
   */
  scheduleOnce(atMs: number, label?: string, slot?: string): Promise<boolean>;
  /** Cancels the alarm in `slot`, or the legacy single slot when omitted. */
  cancelOnce(slot?: string): Promise<void>;
  /**
   * What the OS currently holds, read back from the scheduler's own store.
   * `null` fields mean "nothing armed". Only the shell can answer this — a
   * browser returns both nulls, which is the truth there as well.
   */
  getScheduledAlarms(): Promise<ScheduledAlarms>;
  /**
   * Starts the screen/unlock/charging rollup. No permission needed, no JS timer:
   * SCREEN_ON/OFF are protected broadcasts a WebView cannot see once the screen
   * is off. Resolves false in a browser.
   */
  startCircadian(): Promise<boolean>;
  /** One day's rollup, or null when nothing was observed (NOT zeros). */
  getCircadian(day: string): Promise<CircadianDaily | null>;
  /**
   * Whether the senior's phone has granted PACKAGE_USAGE_STATS.
   *
   * Asked, never demanded: this is a special permission that can only be turned
   * on by hand in the system settings, and nagging a forgetful 78-year-old with
   * a settings screen is a net loss. A false answer simply means the
   * `digitalSkill` row is omitted from the upload.
   */
  hasUsageAccess(): Promise<boolean>;
  /** Opens the system usage-access screen so a FAMILY member can enable it. */
  openUsageAccessSettings(): Promise<boolean>;
  /**
   * One day's usage-stats proxy, or null when the permission is off / nothing
   * was seen. `opFailRate` is always null: it needs accessibility events, which
   * this app does not request, and a fabricated 0 would read as "no failures".
   */
  getDigitalSkill(day: string): Promise<DigitalSkillDaily | null>;
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
  /**
   * Asks the shell to load the neural voice for `locale` now, so the first
   * spoken line does not pay the model-load latency. No-op in a browser.
   */
  warmTts(locale: string): Promise<void>;
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
  scheduleOnce(o: { at: number; label?: string; slot?: string }): Promise<{ ok?: boolean; exact?: boolean }>;
  cancelOnce(o?: { slot?: string }): Promise<void>;
  getScheduledAlarms(): Promise<{
    daily?: { hour?: number; minute?: number; exact?: boolean } | null;
    /** current shell: an array. Older shell / stub: one object. */
    once?: { at?: number; label?: string; slot?: string } | { at?: number; label?: string; slot?: string }[] | null;
  } | void>;
  circadianStart(): Promise<{ ok?: boolean }>;
  getCircadian(o: { day: string }): Promise<Partial<CircadianDaily> | void>;
  hasUsageAccess(): Promise<{ ok?: boolean }>;
  openUsageAccessSettings(): Promise<{ ok?: boolean }>;
  getDigitalSkill(o: { day: string }): Promise<Partial<DigitalSkillDaily> | void>;
  dial(o: { phone: string }): Promise<{ ok?: boolean }>;
  openApp(o: { app: string }): Promise<{ ok?: boolean }>;
  getLocation(): Promise<Partial<NativeLocation> | void>;
  speak(o: { text: string; locale: string; pitch: number; rate: number; preset?: VoicePreset }): Promise<
    { ok?: boolean; stopped?: boolean; reason?: string } | void
  >;
  stopSpeak(): Promise<void>;
  warmTts(o: { locale: string }): Promise<void>;
  openAccessibilitySettings(): Promise<{ ok?: boolean }>;
  consumePendingReason(): Promise<{ reason?: string; at?: number; sos?: boolean; open?: string } | void>;
  addListener?(
    event: string,
    cb: (data: ForegroundEvent) => void
  ): Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
}

/**
 * Fills in every method so a shell that predates (say) `scheduleDaily` behaves
 * exactly like the web: the call resolves to its safe value instead of throwing.
 *
 * Exported because the defaults themselves are a contract worth testing: an
 * earlier version hard-returned `false` for `scheduleOnce`, which disabled
 * `set_alarm` on every real device while looking like a safe stub.
 */
export function withDefaults(src: Partial<AuraNativeBridge>): AuraNativeBridge {
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
    //
    // CRITICAL: this must still forward to `src` when the shell *did* provide
    // it. An earlier version hard-returned `false`, which silently disabled
    // `set_alarm` on every real device — the senior heard "設唔到鬧鐘" while
    // the native scheduler sat unused. Same for cancel: a hard stub left an
    // alarm ringing that he had explicitly asked to cancel.
    scheduleOnce: (atMs, label, slot) =>
      Promise.resolve(src.scheduleOnce?.(atMs, label, slot))
        .then((v) => !!v)
        .catch(() => false),
    cancelOnce: (slot) =>
      Promise.resolve(src.cancelOnce?.(slot)).then(() => undefined).catch(() => undefined),
    // A browser holds no alarms, so the honest answer is "nothing armed".
    getScheduledAlarms: () =>
      Promise.resolve(src.getScheduledAlarms?.())
        .then(normalizeAlarms)
        .catch(() => ({ daily: null, once: [] })),
    startCircadian: () => Promise.resolve(false),
    getCircadian: () => Promise.resolve(null),
    // A browser cannot inspect app usage. "No access" is true here, and it makes
    // the caller omit the row instead of inventing zeros.
    hasUsageAccess: () => Promise.resolve(src.hasUsageAccess?.() ?? false).then((v) => !!v).catch(() => false),
    openUsageAccessSettings: () =>
      Promise.resolve(src.openUsageAccessSettings?.()).then((v) => !!v).catch(() => false),
    getDigitalSkill: (day) =>
      Promise.resolve(src.getDigitalSkill?.(day))
        .then((r) => (r && typeof r.day === "string" ? (r as DigitalSkillDaily) : null))
        .catch(() => null),
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
    warmTts: () => Promise.resolve(),
    openAccessibilitySettings: () =>
      Promise.resolve(src.openAccessibilitySettings?.()).then((v) => !!v).catch(() => false),
    consumePendingReason: () =>
      Promise.resolve(src.consumePendingReason?.())
        .then((r) => asForegroundEvent(r))
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
    scheduleOnce: (atMs, label, slot) => p.scheduleOnce({ at: atMs, label, slot }).then((r) => !!r?.ok),
    cancelOnce: (slot) => p.cancelOnce({ slot }),
    getScheduledAlarms: async () => normalizeAlarms(await p.getScheduledAlarms()),
    startCircadian: () => p.circadianStart().then((r) => !!r?.ok),
    hasUsageAccess: () => p.hasUsageAccess().then((r) => !!r?.ok),
    openUsageAccessSettings: () => p.openUsageAccessSettings().then((r) => !!r?.ok),
    getDigitalSkill: async (day) => {
      const r = await p.getDigitalSkill({ day });
      // Empty object = permission off or nothing observed: the caller omits the
      // row. A row without `day` would be unattributable, so it is dropped too.
      return r && typeof r.day === "string" ? ({ ...r, day } as DigitalSkillDaily) : null;
    },
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
      const r = await p.speak({ text, locale, pitch: voice.pitch, rate: voice.rate, preset: voice.preset });
      return { ok: !!r?.ok, stopped: !!r?.stopped, reason: r?.reason };
    },
    stopSpeak: () => p.stopSpeak(),
    warmTts: (locale) => p.warmTts({ locale }).then(() => undefined),
    openAccessibilitySettings: () => p.openAccessibilitySettings().then((r) => !!r?.ok),
    consumePendingReason: async () => {
      const r = await p.consumePendingReason();
      return asForegroundEvent(r);
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
      const ev = asForegroundEvent(data);
      if (ev) cb(ev);
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
    if (detail) {
      const ev = asForegroundEvent(detail);
      if (ev) cb(ev);
    }
  };
  window.addEventListener("memomate:foreground", handler);
  return () => window.removeEventListener("memomate:foreground", handler);
}

/** Icons are the only part a 2x2 widget can use to be readable at a glance. */
const RECORD_ICON: Record<string, string> = {
  med: "💊",
  measure: "🩺",
  alarm: "⏰",
  card: "✅",
};

/** Truncates by code point so an emoji is never cut in half. */
function clipChars(s: string, max: number): string {
  const chars = Array.from(s.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

/** Local HH:MM — the widget lives on the senior's phone, so device time wins. */
function hhmm(at: number): string {
  const d = new Date(at);
  const h = `${d.getHours()}`.padStart(2, "0");
  const m = `${d.getMinutes()}`.padStart(2, "0");
  return `${h}:${m}`;
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

/**
 * The one "already done today" line the widget shows, or null.
 *
 * Why it exists: a senior who cannot remember whether he took his pill needs
 * to see *the tick*, not only the remaining tasks — the widget's item list
 * says "食藥" until 8pm either way, so it cannot answer "did I take it?".
 *
 * Picks the newest medication/measurement of the local day. `alarm` is
 * deliberately skipped when anything better exists: its `at` is when the alarm
 * was *set*, not when it rang, so "⏰ 20:15" next to "聽日八點" would be a lie.
 */
export function homeWidgetRecord(
  rows: RecordEntry[],
  now = Date.now()
): { text: string; at: number } | null {
  const today = rows.filter(
    (r) => typeof r.at === "number" && r.at <= now + 60_000 && sameLocalDay(r.at, now)
  );
  if (!today.length) return null;

  const meaningful = today.filter((r) => r.kind === "med" || r.kind === "measure");
  const pool = meaningful.length ? meaningful : today;
  const latest = pool.reduce((a, b) => (b.at > a.at ? b : a));

  const icon = RECORD_ICON[latest.kind] ?? "✅";
  const label = clipChars(latest.title || latest.detail || "", 5);
  // The leading ✓ is NOT decoration: the items below this row show pending
  // chores as "·" and done ones as "✓", so an unmarked "💊 09:00 食藥" would
  // read as one more thing still to do — and a double dose is the failure mode.
  return { text: `✓ ${icon} ${hhmm(latest.at)}${label ? ` ${label}` : ""}`, at: latest.at };
}

/**
 * Builds the payload an OS home-screen widget renders. PURE (tested in
 * src/selfcheck.ts) so the shell and the web agree on one shape.
 *
 * `title` is displayed by the widget; the widget layout falls back to
 * `@string/app_name` when it is empty, so a future rename only touches strings.
 *
 * `records` is optional so an older caller keeps working; when present, the
 * record row takes one of the three list slots — the widget is 2x2 and a fourth
 * line would push the SOS button off the bottom edge.
 */
export function homeWidgetPayload(
  cards: AgentCard[],
  reminders: ReminderItem[],
  now = Date.now(),
  title = "忆伴",
  records: RecordEntry[] = []
): HomeWidgetPayload {
  const top = cards[0];
  const record = homeWidgetRecord(records, now) ?? undefined;
  return {
    updatedAt: now,
    title,
    items: reminders
      .filter((r) => r.status === "pending" || r.status === "taken")
      .slice(0, record ? 2 : 3)
      .map((r) => ({ text: r.med?.name ?? r.title, done: r.status === "taken" })),
    topCard: top ? { kind: top.kind, headline: top.data?.headline ?? top.title } : undefined,
    record,
  };
}

/**
 * Every one-shot alarm the record store says should still ring, soonest first.
 *
 * `dueAt` is the epoch the alarm must ring at; `at` is only when the senior said
 * it. A record written before `dueAt` existed encodes the epoch in its id
 * (`rec-alarm-<epoch>`), so an old row still reconciles. Alarms already past are
 * dropped: they have rung (or were missed), and re-arming one would ring now.
 */
export function armedAlarmsFromRecords(rows: RecordEntry[], now = Date.now()): ArmedAlarmRecord[] {
  const out: ArmedAlarmRecord[] = [];
  for (const r of rows) {
    if (r.kind !== "alarm") continue;
    const due = r.dueAt ?? Number(/^rec-alarm-(\d+)$/.exec(r.id)?.[1] ?? NaN);
    if (!Number.isFinite(due) || due <= now) continue;
    out.push({ slot: r.id, dueAt: due, label: r.title || r.detail || "" });
  }
  out.sort((a, b) => a.dueAt - b.dueAt);
  return out;
}

/** One alarm the record store believes is armed. `slot` is the record id. */
export interface ArmedAlarmRecord {
  slot: string;
  dueAt: number;
  label: string;
}

/**
 * What to do after a restart / cold start, comparing the record store with what
 * the OS actually holds — for EVERY alarm, not just the next one.
 *
 * Matching is by `at` (the ringing moment), not by slot string: an older shell
 * reports no slot, and the moment is the thing the senior actually asked for.
 *
 * The asymmetry is deliberate and is the whole point of this function:
 *   - **missing alarm → arm it.** Arming the same slot twice is idempotent
 *     (the shell reuses the request code), so a redundant arm costs nothing.
 *   - **orphan alarm in the future → leave it alone.** A live alarm with no
 *     record may just mean the record was pruned; cancelling it silently is a
 *     missed dose, the one failure this product must not add.
 *   - **orphan alarm already past → cancel.** `at <= now` can never ring again,
 *     and a stale PendingIntent would make `getScheduledAlarms` lie.
 */
export interface AlarmReconcilePlan {
  arm: ArmedAlarmRecord[];
  /** slots to cancel (past, and no longer backed by a record) */
  cancel: string[];
  /** how many records the OS already agrees with — for the selfcheck + logs */
  agree: number;
}

export function reconcileAlarms(
  records: ArmedAlarmRecord[],
  armed: ArmedOnce[],
  now = Date.now()
): AlarmReconcilePlan {
  const byAt = new Map<number, ArmedOnce>();
  for (const a of armed) byAt.set(a.at, a);

  const plan: AlarmReconcilePlan = { arm: [], cancel: [], agree: 0 };
  const wantedAt = new Set<number>();

  for (const rec of records) {
    wantedAt.add(rec.dueAt);
    if (byAt.has(rec.dueAt)) plan.agree += 1;
    else plan.arm.push(rec);
  }

  for (const a of armed) {
    if (wantedAt.has(a.at)) continue;
    if (a.at <= now) {
      // Only a slot we can address may be cancelled. An older shell's alarm with
      // no slot is the legacy single one, and `cancelOnce()` still reaches it.
      if (a.slot) plan.cancel.push(a.slot);
    }
    // In the future and unbacked: leave it (see the asymmetry note above).
  }

  return plan;
}

