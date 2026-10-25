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
  /** when the current *accepted* state began (= departure time when outside) */
  since: number;
  /** last time an away-alert fired (0 = never) */
  lastAlertAt: number;
  pending: { inside: boolean; since: number } | null;
  /**
   * Id of the `exit` row already written for THIS outing, null when at home.
   * Persisted with the rest of `Presence`, so a cold start 40 minutes into a
   * walk does not open a second outing row.
   */
  exitId?: string | null;
  /** true once that exit was escalated to `alert: true` — never escalates twice. */
  exitAlerted?: boolean;
}

export function initialPresence(inside: boolean, at: number): Presence {
  return { inside, since: at, lastAlertAt: 0, pending: null, exitId: null, exitAlerted: false };
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
 *
 * NB: this is only the *threshold + cooldown* test. It says nothing about
 * whether this outing was already escalated — `stepFence` owns that guard via
 * `Presence.exitAlerted`, because "away 60 min" stays true for every sample of
 * a three-hour walk and would otherwise page the family every cooldown.
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
  /**
   * 0–2 events for this sample, `exit` always before `enter`. Two only on the
   * single sample that accepts his return home after leaving: the silent exit
   * bookkeeping and the closing `enter` are different facts about the same trip.
   */
  events: GeofenceEvent[];
}

/**
 * One sample -> updated presence + the events this sample owes.
 *
 * The rules, and why each one exists:
 *
 *  1. **Departure is reported silently, immediately** (`alert: false`). The
 *     weekly report needs every outing, not just the alarming ones; walking out
 *     less often is one of the earliest changes in Alzheimer's, and "0 outings"
 *     for someone who goes to the market daily is a false reading. Nobody's
 *     phone rings for it.
 *  2. **Escalation reuses the same id** (`gf-exit-<departure>`) with
 *     `alert: true` once `awayAlertMs` has passed. C's `/geofence/events`
 *     replaces the row and pages once, so the count stays one per outing and an
 *     outbox replay cannot page twice. The row's `at` stays the departure time.
 *  3. **Every return closes the loop** with an `enter` carrying `minutesAway`.
 *     Before this change only outings long enough to page the family had one, so
 *     "away minutes this week" silently covered a subset of outings.
 *  4. **`enter` is still only emitted on the transition itself** — ordinary
 *     samples while he is at home produce nothing at all.
 *  5. A first-ever sample (`prev === null`) never emits: with no baseline we do
 *     not know whether he is leaving or the fix is simply wrong.
 */
export function stepFence(
  prev: Presence | null,
  sample: { at: number; distanceM: number },
  policy: FencePolicy = FENCE_POLICY
): FenceStep {
  const observed = observe(prev, sample, policy);
  const distanceM = Math.max(0, Math.round(sample.distanceM));
  const events: GeofenceEvent[] = [];
  let presence = observed;

  // 1. The flip into "outside" has just survived the debounce window.
  if (prev !== null && prev.inside === true && observed.inside === false) {
    const id = `gf-exit-${observed.since}`;
    presence = { ...presence, exitId: id, exitAlerted: false };
    events.push({ id, at: observed.since, kind: "exit", distanceM, alert: false });
  }

  // 2. Same outing, now long enough that a caregiver should be told.
  if (presence.exitAlerted !== true && shouldAlert(presence, sample.at, policy)) {
    const id = presence.exitId ?? `gf-exit-${presence.since}`;
    presence = { ...markAlerted(presence, sample.at), exitId: id, exitAlerted: true };
    // `distanceM` here is how far he is NOW — the family wants "1.2 公里 away",
    // not "500 米, the instant he stepped over the fence".
    events.push({ id, at: presence.since, kind: "exit", distanceM, alert: true });
  }

  // 3. Back home: close the trip for the weekly report, on the transition only.
  if (prev !== null && prev.inside === false && observed.inside === true) {
    const minutesAway = Math.max(0, Math.round((sample.at - prev.since) / 60_000));
    events.push({
      id: `gf-enter-${sample.at}`,
      at: sample.at,
      kind: "enter",
      distanceM,
      minutesAway,
      alert: false,
    });
    presence = { ...presence, exitId: null, exitAlerted: false };
  }

  return { presence, events };
}

/**
 * The id the OUTBOX should queue this event under.
 *
 * WHY THIS IS NOT JUST `event.id`: `outboxStore.enqueue` is idempotent by queue
 * id and returns the pending row untouched when one already exists. The silent
 * departure row and its escalation deliberately share a payload id (so the
 * server replaces one row), so reusing that id here would make the escalation a
 * no-op whenever the silent copy is still queued — i.e. exactly when the phone
 * has been offline for the hour, which is when the page matters most. Suffixing
 * the queue id keeps both queued; the server's `alert` rule collapses them.
 *
 * Pure and stable, so replaying the same sample still de-duplicates.
 */
export function fenceQueueId(event: GeofenceEvent): string {
  return `${event.id}:${event.alert ? "alert" : "silent"}`;
}
