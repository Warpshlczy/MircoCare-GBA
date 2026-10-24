// geofence.ts — PURE geofence math and hysteresis. No DOM, no navigator.
//
// Why hysteresis instead of a bare `distance < radius`: GPS readings near the
// fence edge flip every few seconds. A naive comparison would fire an "went
// out" alert on a senior sitting still in the doorway. So we require
//   (a) the new state to persist for `debounceMs` before we accept it, and
//   (b) the senior to be outside for `awayAlertMs` before we alert at all.
//
// Tested in src/selfcheck.ts. Consumed by lib/tools.ts#locate (W2) and
// lib/geofenceStore.ts (W4 foreground watcher).

import type { GeofenceEvent } from "./types";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Geofence {
  center: LatLng;
  radiusM: number;
}

export interface FencePolicy {
  radiusM: number;
  /** a state flip must persist this long before it counts (GPS jitter) */
  debounceMs: number;
  /** only alert after being outside this long — not on the first stray sample */
  awayAlertMs: number;
  /** never alert twice inside this window */
  alertCooldownMs: number;
}

export const FENCE_POLICY: FencePolicy = {
  radiusM: 500,
  debounceMs: 5_000,
  awayAlertMs: 60 * 60 * 1000, // "离家 >60min" (docs/dev.md §3.4 B3)
  alertCooldownMs: 30 * 60 * 1000,
};

const EARTH_R = 6_371_000;

/**
 * Great-circle distance in metres (haversine). Accurate enough at 500m scale —
 * we never claim lane-level precision, and the card only says "1.2 公里".
 */
export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function inCircle(pt: LatLng, center: LatLng, radiusM: number): boolean {
  return haversineM(pt, center) <= radiusM;
}

/**
 * Presence is the small amount of state the fence needs. `pending` holds a
 * flip that has not yet survived the debounce window.
 */
export interface Presence {
  inside: boolean;
  /** when the current *accepted* state began */
  since: number;
  /** last time an away-alert fired (0 = never) */
  lastAlertAt: number;
  pending: { inside: boolean; since: number } | null;
}

export function initialPresence(inside: boolean, at: number): Presence {
  return { inside, since: at, lastAlertAt: 0, pending: null };
}

/**
 * Folds one GPS sample into the presence state. Idempotent given the same
 * `at`, so replaying a batch of samples is safe.
 */
export function observe(
  prev: Presence | null,
  sample: { at: number; distanceM: number },
  policy: FencePolicy = FENCE_POLICY
): Presence {
  const observed = sample.distanceM <= policy.radiusM;
  if (!prev) return initialPresence(observed, sample.at);
  if (observed === prev.inside) {
    // Back where we were — cancel any unconfirmed flip.
    return prev.pending ? { ...prev, pending: null } : prev;
  }
  if (prev.pending && prev.pending.inside === observed) {
    if (sample.at - prev.pending.since >= policy.debounceMs) {
      return { inside: observed, since: prev.pending.since, lastAlertAt: prev.lastAlertAt, pending: null };
    }
    return prev;
  }
  return { ...prev, pending: { inside: observed, since: sample.at } };
}

/**
 * True when the senior has been outside long enough that a caregiver should
 * hear about it. Pure: the caller records the alert with `markAlerted()`.
 */
export function shouldAlert(
  state: Presence,
  now: number,
  policy: FencePolicy = FENCE_POLICY
): boolean {
  if (state.inside) return false;
  if (state.pending) return false; // flip not yet accepted
  if (now - state.since < policy.awayAlertMs) return false;
  if (state.lastAlertAt !== 0 && now - state.lastAlertAt < policy.alertCooldownMs) return false;
  return true;
}

export function markAlerted(state: Presence, now: number): Presence {
  return { ...state, lastAlertAt: now };
}

/** Human-facing distance: "1.2 公里" / "340 米" — no false precision. */
export function formatDistance(distanceM: number): string {
  if (!Number.isFinite(distanceM) || distanceM < 0) return "—";
  if (distanceM < 1000) return `${Math.round(distanceM)} 米`;
  return `${(distanceM / 1000).toFixed(1)} 公里`;
}

export interface FenceStep {
  presence: Presence;
  /** the event to report for this sample, or null */
  event: GeofenceEvent | null;
}

/**
 * One sample -> updated presence + at most one event.
 *
 * Two deliberate rules:
 *  - An `enter` event is emitted ONLY when the matching `exit` was actually
 *    alerted (i.e. he was away long enough for the family to be paged). Paging
 *    someone about a 10-minute trip to the shop is noise, and noise is what
 *    makes families mute the app before the day it matters.
 *  - `enter` is emitted on the transition itself, so ordinary samples while he
 *    is at home produce nothing at all.
 */
export function stepFence(
  prev: Presence | null,
  sample: { at: number; distanceM: number },
  policy: FencePolicy = FENCE_POLICY
): FenceStep {
  const presence = observe(prev, sample, policy);
  const distanceM = Math.max(0, Math.round(sample.distanceM));

  if (shouldAlert(presence, sample.at, policy)) {
    return {
      presence: markAlerted(presence, sample.at),
      event: { id: `gf-exit-${sample.at}`, at: sample.at, kind: "exit", distanceM },
    };
  }

  // Back home, and the family was told he had left: close the loop for them.
  const wasOut = prev !== null && prev.inside === false;
  const exitWasAlerted = wasOut && prev.lastAlertAt >= prev.since;
  if (wasOut && exitWasAlerted && presence.inside) {
    const minutesAway = Math.max(0, Math.round((sample.at - prev.since) / 60_000));
    return {
      presence,
      event: { id: `gf-enter-${sample.at}`, at: sample.at, kind: "enter", distanceM, minutesAway },
    };
  }

  return { presence, event: null };
}
