// geofenceStore.ts — home point, presence state, and the FOREGROUND watcher.
//
// Split from geofence.ts (pure math + hysteresis) for the usual reason: the
// rules must stay runnable in Node, the sampling cannot.
//
// Three decisions worth stating out loud:
//
// 1. NOTHING is sampled until a home point exists. Asking for location
//    permission before the family has configured a fence is how an elder-care
//    app gets uninstalled — and a fix at the clinic would silently become
//    "home", so the first fix is never adopted automatically.
// 2. Foreground only (A's call, issue #1). Background tracking needs a
//    persistent foreground service plus WAKE_LOCK; the battery cost and the
//    "this app is always watching where I am" feeling are not worth a demo, and
//    a fence that only works while the app is open is honest about it.
// 3. Presence is PERSISTED. "Away for 60 minutes" must survive an app restart —
//    otherwise every cold start resets the clock and the alert never fires.
// 4. The FIX has two sources: the native shell first, the browser's geolocation
//    API second. A demo in Chrome has no `bridge()`, and a fence that silently
//    returns "no-native" there looks broken to everyone in the room.
//
// The event goes through the outbox (`enqueue("geofence")`), so an offline
// evening still reaches the family once the phone reconnects.

import { enqueue } from "./outboxStore.ts";
import { FENCE_POLICY, fenceQueueId, haversineM, initialPresence, stepFence } from "./geofence.ts";
import type { FencePolicy, Geofence, LatLng, Presence } from "./geofence.ts";
import { get, del, put } from "./db.ts";
import { bridge } from "./native.ts";
import type { GeofenceEvent } from "./types";

const HOME_KEY = "geofence.home";
const PRESENCE_KEY = "geofence.presence";

/** Foreground sampling cadence. Movement at walking speed is slow; 5min is plenty. */
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/**
 * A fix worse than this is not usable against a 500m fence: ±300m of noise
 * around the edge flaps the state machine and pages the family for nothing.
 */
export const MAX_ACCURACY_M = 150;

interface HomeDoc {
  id: string;
  center: LatLng;
  radiusM: number;
  at: number;
}

interface PresenceDoc {
  id: string;
  presence: Presence;
  at: number;
}

// --------------------------------------------------------------------------- //
// Home point
// --------------------------------------------------------------------------- //

export async function readHome(): Promise<Geofence | null> {
  const doc = await get<HomeDoc>("meta", HOME_KEY).catch(() => undefined);
  if (!doc) return null;
  const lat = doc.center?.lat;
  const lng = doc.center?.lng;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }
  return { center: { lat, lng }, radiusM: doc.radiusM > 0 ? doc.radiusM : FENCE_POLICY.radiusM };
}

/**
 * Sets the fence centre. Called by the family (caregiver screen) or by an
 * explicit "这是我屋企" confirmation — never inferred.
 */
export async function setHome(center: LatLng, now = Date.now(), radiusM = FENCE_POLICY.radiusM): Promise<void> {
  await put<HomeDoc>("meta", { id: HOME_KEY, center, radiusM, at: now });
  // A new centre invalidates any presence state computed around the old one.
  await put<PresenceDoc>("meta", { id: PRESENCE_KEY, presence: initialPresence(true, now), at: now });
}

export async function clearHome(): Promise<void> {
  await del("meta", HOME_KEY).catch(() => {});
  await put<PresenceDoc>("meta", { id: PRESENCE_KEY, presence: initialPresence(true, Date.now()), at: Date.now() });
}

export async function hasHome(): Promise<boolean> {
  return (await readHome()) !== null;
}

// --------------------------------------------------------------------------- //
// One sample
// --------------------------------------------------------------------------- //

async function readPresence(): Promise<Presence | null> {
  const doc = await get<PresenceDoc>("meta", PRESENCE_KEY).catch(() => undefined);
  return doc?.presence ?? null;
}

/**
 * Metres from home, or null when there is no home point or no usable fix.
 * Used by `navigate_home`; no accuracy gate here because a rough distance is
 * still actionable ("about a kilometre"), unlike a fence alert.
 */
export async function distanceFromHomeM(): Promise<number | null> {
  const home = await readHome();
  if (!home) return null;
  const api = bridge();
  if (!api) return null;
  const fix = await api.getLocation().catch(() => null);
  if (!fix || typeof fix.lat !== "number" || typeof fix.lng !== "number") return null;
  return haversineM({ lat: fix.lat, lng: fix.lng }, home.center);
}

export interface FenceSampleResult {
  /** empty when the sample was skipped (no home / no location source / bad fix) */
  events: GeofenceEvent[];
  skipped?: "no-home" | "no-native" | "no-fix" | "inaccurate";
  distanceM?: number;
  /** which source produced the fix — diagnostics only, never leaves the device */
  source?: "native" | "browser";
}

interface Fix {
  lat: number;
  lng: number;
  accuracy: number;
}

/**
 * Browser geolocation, shaped like the native call.
 *
 * WHY THIS EXISTS: A reported in issue #1 that `bridge()` is null in the
 * browser, so `sampleFence` returned `skipped: "no-native"` and a demo run on
 * Chrome produced zero fence events — which reads as "the fence is broken"
 * rather than "there is no shell". PWA/desktop is how the family screen gets
 * tested, and the fence math is identical either way.
 *
 * `maximumAge` is deliberately generous: a fix up to 4 minutes old is fine for
 * a 500m fence sampled every 5 minutes, and reusing one avoids waking the radio
 * for a cached position.
 */
function browserFix(timeoutMs = 10_000): Promise<Fix | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (fix: Fix | null) => {
      if (settled) return;
      settled = true;
      resolve(fix);
    };
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        done({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          // Older browsers report `null`; treat "unknown" as the accept limit so
          // a working fix is not discarded for missing a field we can live without.
          accuracy: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : MAX_ACCURACY_M,
        }),
      () => done(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 4 * 60 * 1000 }
    );
  });
}

/**
 * Takes one fix, folds it into the presence machine, and queues whatever the
 * sample owes (at most one `exit` + one `enter`). Safe to call at any cadence —
 * `stepFence` is idempotent per `at`, and every event id is derived from the
 * trip's own timestamps rather than from this call.
 */
export async function sampleFence(now = Date.now(), policy: FencePolicy = FENCE_POLICY): Promise<FenceSampleResult> {
  const home = await readHome();
  if (!home) return { events: [], skipped: "no-home" };

  const api = bridge();
  let fix: Fix | null = null;
  let source: "native" | "browser" = "native";
  if (api) {
    const got = await api.getLocation().catch(() => null);
    if (got && typeof got.lat === "number" && typeof got.lng === "number") {
      fix = { lat: got.lat, lng: got.lng, accuracy: typeof got.accuracy === "number" ? got.accuracy : MAX_ACCURACY_M };
    }
  }
  if (!fix) {
    // No shell, or the shell declined — try the browser before giving up.
    fix = await browserFix();
    source = "browser";
  }
  if (!fix) {
    return { events: [], skipped: api ? "no-fix" : "no-native" };
  }
  if (fix.accuracy > MAX_ACCURACY_M) {
    // Keep the previous presence untouched: a bad fix is not evidence of moving.
    return { events: [], skipped: "inaccurate" };
  }

  const distanceM = haversineM({ lat: fix.lat, lng: fix.lng }, home.center);
  const prev = await readPresence();
  const step = stepFence(prev, { at: now, distanceM }, policy);

  await put<PresenceDoc>("meta", { id: PRESENCE_KEY, presence: step.presence, at: now }).catch(() => {});

  // Queue id is NOT the payload id: the silent departure row and its escalation
  // share a payload id (server replaces one row), but `enqueue` de-duplicates by
  // queue id and would silently drop the escalation while the silent copy is
  // still pending — i.e. after an hour offline. See `fenceQueueId`.
  for (const event of step.events) {
    await enqueue("geofence", event, now, fenceQueueId(event));
  }
  return { events: step.events, distanceM, source };
}

// --------------------------------------------------------------------------- //
// Foreground watcher
// --------------------------------------------------------------------------- //

let stopWatch: (() => void) | null = null;

/**
 * Starts foreground sampling. Idempotent. Stops while the page is hidden —
 * a background tab must not keep waking the GPS radio.
 */
export function startFenceWatch(opts: { intervalMs?: number } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  if (stopWatch) return stopWatch;

  const intervalMs = opts.intervalMs ?? SAMPLE_INTERVAL_MS;
  let timer: number | null = null;

  const tick = () => {
    if (document.visibilityState !== "visible") return;
    // Deliberately samples even when offline: the fence is a local computation,
    // and the event simply waits in the outbox until the phone reconnects.
    void sampleFence(Date.now()).catch(() => {});
  };

  const start = () => {
    if (timer) return;
    tick();
    timer = window.setInterval(tick, intervalMs);
  };
  const stopTimer = () => {
    if (!timer) return;
    window.clearInterval(timer);
    timer = null;
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") start();
    else stopTimer();
  };

  start();
  document.addEventListener("visibilitychange", onVisibility);

  stopWatch = () => {
    stopTimer();
    document.removeEventListener("visibilitychange", onVisibility);
    stopWatch = null;
  };
  return stopWatch;
}
